import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";
import Call from "../src/models/callModel";
import { runAsSystem } from "../src/tenancy/context";
import { ack, addMessage, api, connect, enter, makeUser, newOrg, nextEvent, oid, Session, sleep, startSocketServer, enc, plainOf } from "./helpers";

const idOf = (body: any): string => String(body?.data?._id ?? body?._id ?? body?.conversationId);

async function dm(s: Session, other: any): Promise<string> {
    const res = await api(s).post("/conversations").send({ receiverId: String(other._id) });
    expect(res.status).toBe(200);
    const id = idOf(res.body);
    await addMessage(id, s.user);
    return id;
}

describe("Socket.IO tenant isolation (req. 7 and 9)", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    const org = newOrg();
    const W = (u: any): Session => ({ user: u, org });
    const G = (u: any): Session => ({ user: u });
    const sock = async (s: Session) => {
        const socket = await connect(server.port, s);
        open.push(socket);
        await sleep(150); // let connect-time work (presence) settle
        return socket;
    };

    beforeAll(async () => {
        server = await startSocketServer();
    });

    afterAll(async () => {
        open.forEach((s) => s.disconnect());
        await server.close();
    });

    it("rejects connections without a valid session", async () => {
        const result = await new Promise<string>((resolve) => {
            import("socket.io-client").then(({ io }) => {
                const s = io(`http://localhost:${server.port}`, { auth: { token: "garbage" }, transports: ["websocket"], forceNew: true, reconnection: false });
                s.once("connect", () => { s.disconnect(); resolve("connected"); });
                s.once("connect_error", (e) => resolve(e.message));
            });
        });
        expect(result).not.toBe("connected");
    });

    it("a socket in the wrong context cannot join a workspace conversation room or receive its typing", async () => {
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        await enter(W(u));
        await enter(W(v));
        const conversationId = await dm(W(v), u);

        const uGlobal = await sock(G(u));
        const vWork = await sock(W(v));
        uGlobal.emit("joinConversation", conversationId);
        vWork.emit("joinConversation", conversationId);
        await sleep(200);

        const typing = nextEvent(uGlobal, "userTyping", 700);
        vWork.emit("typing", conversationId);
        expect(await typing).toBeNull();
    });

    it("chat events reach a socket only in the context that owns the conversation (switching)", async () => {
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        await enter(W(u));
        await enter(W(v));
        const globalChat = await dm(G(v), u);

        // u is "in the workspace": a global chat message must not reach this socket
        const uWork = await sock(W(u));
        const vGlobal = await sock(G(v));
        const leaked = nextEvent(uWork, "receiveMessage", 1000, (m) => String(m?.conversationId) === globalChat);
        vGlobal.emit("sendMessage", { user: { _id: String(v._id) }, conversationId: globalChat, e2ee: enc("hi from global"), type: "text" });
        expect(await leaked).toBeNull();
        uWork.disconnect();

        // u switches back to the global context (new connection, new token): now it arrives
        const uGlobal = await sock(G(u));
        const arrives = nextEvent(uGlobal, "receiveMessage", 2000, (m) => String(m?.conversationId) === globalChat);
        vGlobal.emit("sendMessage", { user: { _id: String(v._id) }, conversationId: globalChat, e2ee: enc("hi again"), type: "text" });
        expect(await arrives).not.toBeNull();
    });

    it("cannot send into a workspace conversation from another context", async () => {
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        await enter(W(u));
        await enter(W(v));
        const workChat = await dm(W(v), u);
        const vWork = await sock(W(v));
        vWork.emit("joinConversation", workChat);
        const uGlobal = await sock(G(u));

        const got = nextEvent(vWork, "receiveMessage", 1000, (m) => String(m?.conversationId) === workChat);
        uGlobal.emit("sendMessage", { user: { _id: String(u._id) }, conversationId: workChat, e2ee: enc("sneaky"), type: "text" });
        expect(await got).toBeNull();
        const history = await api(W(v)).get(`/messages/${workChat}`);
        expect(JSON.stringify(history.body)).not.toContain("sneaky");
    });

    it("cannot start a call or join media for a workspace conversation from another context", async () => {
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        await enter(W(u));
        await enter(W(v));
        const workChat = await dm(W(v), u);
        const uGlobal = await sock(G(u));

        const error = nextEvent(uGlobal, "call:error", 1500);
        uGlobal.emit("call:start", { groupId: workChat, callType: "audio", mode: "ring" });
        expect(await error).not.toBeNull();

        // A running call in that chat, with u on its participant list
        const call = await runAsSystem(() => Call.create({
            conversationId: oid(workChat), initiatedBy: v._id, callType: "audio", callStatus: "active",
            participants: [{ userId: v._id, status: "joined" }, { userId: u._id, status: "joined" }],
        } as any));
        const joined = await ack<any>(uGlobal, "mediasoup:joinCall", { callId: String(call._id), callType: "audio" });
        expect(joined.error).toBe("Not a participant of this call");
        // Forged / random ids are rejected the same way
        const forged = await ack<any>(uGlobal, "mediasoup:joinCall", { callId: "0123456789abcdef01234567", callType: "audio" });
        expect(forged.error).toBeTruthy();
        // Without joining a call there is no peer: consuming any producer is refused
        const consume = await ack<any>(uGlobal, "mediasoup:consume", { producerId: "anything", rtpCapabilities: {} });
        expect(consume.error).toBeTruthy();
    });

    it("screen:join / screen:getState only work for participants of that call (was unchecked)", async () => {
        const [u, v, outsider] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        await enter(W(u));
        await enter(W(v));
        const workChat = await dm(W(v), u);
        const call = await runAsSystem(() => Call.create({
            conversationId: oid(workChat), initiatedBy: v._id, callType: "audio", callStatus: "active",
            participants: [{ userId: v._id, status: "joined" }, { userId: u._id, status: "joined" }],
        } as any), "test-fixture");
        const callId = String(call._id);
        const spy = await sock(G(outsider));
        const member = await sock(W(u));
        expect((await ack<any>(spy, "screen:join", { callId })).error).toBeTruthy();
        expect((await ack<any>(spy, "screen:getState", { callId })).error).toBeTruthy();
        expect((await ack<any>(member, "screen:join", { callId })).success).toBe(true);
        const { io } = await import("../src/realtime/io");
        const leaked = nextEvent(spy, "probe", 600);
        const delivered = nextEvent(member, "probe", 1500);
        io().to(callId).emit("probe", { callId });
        expect(await leaked).toBeNull();
        expect(await delivered).not.toBeNull();
    });

    it("throttles an event flood from one socket (events beyond the budget are dropped)", async () => {
        const u = await makeUser();
        const s = await sock(G(u));
        const warned = nextEvent(s, "rate-limited", 2000);
        let answered = 0;
        for (let i = 0; i < 400; i++) {
            s.emit("ice:getServers", null, () => { answered++; });
        }
        await sleep(800);
        expect(await warned).not.toBeNull();
        // Default budget: 120 burst + ~30/s refill, far below 400
        expect(answered).toBeGreaterThan(50);
        expect(answered).toBeLessThan(250);
    });
});
