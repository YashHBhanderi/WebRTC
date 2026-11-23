import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import mediasoupService from "../src/services/mediasoup.service";
import storage from "../src/services/storage.service";
import { UNAVAILABLE_SCOPES } from "../src/developer/scopes";
import { api, connect, makeUser, nextEvent, Session, sleep, startSocketServer, testApp, uniq, legacyGlobal } from "./helpers";

/**
 * Phase 2 of the third-party API: calls (signaling, media, screen sharing), host controls, recording
 * control and uploads for developer-app user tokens. Same gateways and checks as SpreeWe clients; the
 * app takes part as another device of the user.
 */
const basic = (keyId: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const http = () => request(testApp());

async function appToken(user: Session, scopes: string[]): Promise<string> {
    const owner: Session = { user: await makeUser() };
    const app = (await api(owner).post("/v1/apps").send({ name: uniq("Calls"), environment: "development", callbackUrls: ["https://example.com/cb"], scopes })).body.data;
    await legacyGlobal(app?._id);
    expect(app?._id, "app registration").toBeTruthy();
    const cred = (await api(owner).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name })).body.data;
    expect((await api(user).post(`/v1/apps/${app._id}/grants`).send({ scopes })).status).toBe(201);
    const tok = await http().post("/v1/app-tokens").set(basic(cred.credential.keyId, cred.secret)).send({ userId: String(user.user._id) });
    expect(tok.status, JSON.stringify(tok.body)).toBe(201);
    return tok.body.data.accessToken as string;
}

describe("calls scopes are available", () => {
    it("calls:write, calls:manage and recordings:write can be granted now", () => {
        for (const s of ["calls:write", "calls:manage", "recordings:write"]) expect(UNAVAILABLE_SCOPES.has(s), s).toBe(false);
    });
});

describe("calls through app sockets", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    const appSocket = (token: string) => new Promise<Socket>((resolve, reject) => {
        const s = ioClient(`http://localhost:${server.port}`, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
        open.push(s);
        s.once("connect", () => resolve(s));
        s.once("connect_error", reject);
    });
    const userSocket = async (s: Session) => {
        const sock = await connect(server.port, s);
        open.push(sock);
        await sleep(150);
        return sock;
    };
    const ackOf = <T = any>(s: Socket, event: string, payload: unknown, ms = 3000) =>
        Promise.race([new Promise<T>((resolve) => s.emit(event, payload, resolve)), sleep(ms).then(() => "no-answer" as unknown as T)]);
    async function direct(a: Session, b: Session): Promise<string> {
        return String((await api(a).post("/conversations").send({ receiverId: String(b.user._id) })).body.conversationId);
    }

    beforeAll(async () => {
        await mediasoupService.init();
        server = await startSocketServer();
    });

    afterAll(async () => {
        open.forEach((s) => s.disconnect());
        await server.close();
    });

    it("an app starts a call; the callee's client rings and accepts; the app sees the participant and gets media transports", async () => {
        const [alice, bob] = (await Promise.all([makeUser(), makeUser()])).map((user) => ({ user }));
        const conv = await direct(alice, bob);
        const app = await appSocket(await appToken(alice, ["realtime:connect", "calls:read", "calls:write"]));
        const bobSock = await userSocket(bob);

        const started = nextEvent(app, "call:started", 3000, (p) => String(p?.groupId) === conv);
        const ringing = nextEvent(bobSock, "call:incoming", 3000, (p) => String(p?.groupId) === conv);
        app.emit("call:start", { groupId: conv, callType: "audio", mode: "ring" });
        const call = await started;
        expect(call, "call:started").not.toBeNull();
        expect(await ringing).not.toBeNull();
        const callId = String(call.callId);

        const joined = nextEvent(app, "call:participant-joined", 3000, (p) => String(p?.callId) === callId);
        expect((await ackOf<any>(bobSock, "call:accept", { callId })).success).toBe(true);
        expect(String((await joined)?.userId)).toBe(String(bob.user._id));

        // Media: the app joins the SFU session (admission checked) and may then create transports
        expect((await ackOf<any>(app, "mediasoup:getRouterRtpCapabilities", {})).rtpCapabilities).toBeTruthy();
        expect((await ackOf<any>(app, "mediasoup:joinCall", { callId, callType: "audio" })).success).toBe(true);
        const transport = await ackOf<any>(app, "mediasoup:createSendTransport", {});
        expect(transport.error).toBeUndefined();
        expect(transport.id).toBeTruthy();
        expect(Array.isArray((await ackOf<any>(app, "mediasoup:syncProducers", { callId })).producers)).toBe(true);
        expect((await ackOf<any>(app, "call:getState", { callId })).error).toBeUndefined();

        const ended = nextEvent(bobSock, "call:ended", 3000, (p) => String(p?.callId) === callId);
        expect((await ackOf<any>(app, "call:end", { callId })).success).toBe(true);
        expect(await ended).not.toBeNull();
    });

    it("an app receives incoming calls for its user (calls:read) and can accept them; without calls:read it gets no ring", async () => {
        const [alice, bob] = (await Promise.all([makeUser(), makeUser()])).map((user) => ({ user }));
        const conv = await direct(alice, bob);
        const bobApp = await appSocket(await appToken(bob, ["realtime:connect", "calls:read", "calls:write"]));
        const bobNoCalls = await appSocket(await appToken(bob, ["realtime:connect", "messages:read"]));
        const aliceSock = await userSocket(alice);

        const ring = nextEvent(bobApp, "call:incoming", 3000, (p) => String(p?.groupId) === conv);
        const noRing = nextEvent(bobNoCalls, "call:incoming", 1500);
        aliceSock.emit("call:start", { groupId: conv, callType: "audio", mode: "ring" });
        const incoming = await ring;
        expect(incoming).not.toBeNull();
        expect(await noRing).toBeNull();

        const joined = nextEvent(aliceSock, "call:participant-joined", 3000, (p) => String(p?.callId) === String(incoming.callId));
        expect((await ackOf<any>(bobApp, "call:accept", { callId: String(incoming.callId) })).success).toBe(true);
        expect(String((await joined)?.userId)).toBe(String(bob.user._id));
    });

    it("refuses call events without their scope, and calls in conversations the user isn't in", async () => {
        const [alice, bob, carol] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
        const theirs = await direct(bob, carol);
        const readOnly = await appSocket(await appToken(alice, ["realtime:connect", "calls:read"]));
        const noStart = nextEvent(readOnly, "call:started", 1200);
        readOnly.emit("call:start", { groupId: await direct(alice, bob), callType: "audio" });
        expect(await noStart).toBeNull();
        expect(await ackOf(readOnly, "mediasoup:getRouterRtpCapabilities", {}, 800)).toBe("no-answer");

        const writer = await appSocket(await appToken(alice, ["realtime:connect", "calls:read", "calls:write"]));
        const error = nextEvent(writer, "call:error", 2000);
        writer.emit("call:start", { groupId: theirs, callType: "audio" });
        expect(await error).not.toBeNull();
    });

    it("host controls need calls:manage, and only work for the host of a group call", async () => {
        const [alice, bob, carol] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
        const created = await api(alice).post("/conversations/group").send({ groupName: uniq("Call"), groupMembers: JSON.stringify([String(bob.user._id), String(carol.user._id)]) });
        const groupId = String(created.body.data._id);
        // Alice (the group admin) runs the call from her app: signaling, media and host controls
        const hostApp = await appSocket(await appToken(alice, ["realtime:connect", "calls:read", "calls:write", "calls:manage"]));
        const started = nextEvent(hostApp, "call:started", 3000, (p) => String(p?.groupId) === groupId);
        hostApp.emit("call:start", { groupId, callType: "audio", mode: "ring" });
        const callId = String((await started).callId);
        expect((await ackOf<any>(hostApp, "mediasoup:joinCall", { callId, callType: "audio" })).success).toBe(true);
        const bobSock = await userSocket(bob);
        expect((await ackOf<any>(bobSock, "call:accept", { callId })).success).toBe(true);
        expect((await ackOf<any>(bobSock, "mediasoup:joinCall", { callId, callType: "audio" })).success).toBe(true);

        const forced = nextEvent(bobSock, "call:force-muted", 3000, (p) => String(p?.callId) === callId);
        expect((await ackOf<any>(hostApp, "call:mute-participant", { callId, userId: String(bob.user._id) })).success).toBe(true);
        expect(await forced).not.toBeNull();

        // Without calls:manage the request never reaches the handler
        const noManage = await appSocket(await appToken(alice, ["realtime:connect", "calls:write"]));
        expect(await ackOf(noManage, "call:mute-participant", { callId, userId: String(bob.user._id) }, 800)).toBe("no-answer");
        // Carol's app holds calls:manage, but Carol isn't a host of this call (and isn't in it)
        const carolApp = await appSocket(await appToken(carol, ["realtime:connect", "calls:manage"]));
        expect((await ackOf<any>(carolApp, "call:mute-participant", { callId, userId: String(bob.user._id) })).error).toBeTruthy();
    });

    it("recording control needs recordings:write (the server still decides whether recording can start)", async () => {
        const [alice, bob] = (await Promise.all([makeUser(), makeUser()])).map((user) => ({ user }));
        const conv = await direct(alice, bob);
        const aliceSock = await userSocket(alice);
        const started = nextEvent(aliceSock, "call:started", 3000, (p) => String(p?.groupId) === conv);
        aliceSock.emit("call:start", { groupId: conv, callType: "audio", mode: "ring" });
        const callId = String((await started).callId);

        const noScope = await appSocket(await appToken(alice, ["realtime:connect", "calls:write"]));
        expect(await ackOf(noScope, "call:record-start", { callId }, 800)).toBe("no-answer");
        const recorder = await appSocket(await appToken(alice, ["realtime:connect", "recordings:write"]));
        const answer = await ackOf<any>(recorder, "call:record-start", { callId });
        expect(answer).not.toBe("no-answer"); // reached the recording service (which answers success or a reason)
        expect(typeof answer).toBe("object");
    });
});

describe("uploads with app tokens", () => {
    it("files:write uploads encrypted attachments to the user's conversations only; plaintext is refused as for everyone", async () => {
        const [alice, bob, carol] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
        const conv = String((await api(alice).post("/conversations").send({ receiverId: String(bob.user._id) })).body.conversationId);
        const theirs = String((await api(bob).post("/conversations").send({ receiverId: String(carol.user._id) })).body.conversationId);
        const token = await appToken(alice, ["files:write", "files:read"]);
        const put = vi.spyOn(storage, "put").mockResolvedValue(undefined as any);
        try {
            const cipher = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) % 256));
            const upload = (conversationId: string, encrypted = true) => {
                const r = http().post("/upload").set(bearer(token)).field("purpose", "message").field("conversationId", conversationId);
                return (encrypted ? r.field("encrypted", "1").field("kind", "pdf") : r)
                    .attach("file", encrypted ? cipher : Buffer.from("%PDF-1.4 plain"), { filename: "doc.pdf", contentType: "application/pdf" });
            };
            const ok = await upload(conv);
            expect(ok.status, JSON.stringify(ok.body)).toBe(200);
            expect(ok.body).toMatchObject({ type: "pdf", encrypted: true });
            expect((await upload(conv, false)).status).toBe(400);
            const foreign = await upload(theirs);
            expect(foreign.status).not.toBe(200);
            expect(put).toHaveBeenCalledTimes(1);
            expect((await http().get("/files").set(bearer(token))).status).toBe(200);
            expect((await http().get(`/conversations/${conv}/media`).set(bearer(token))).status).toBe(200);
        } finally {
            put.mockRestore();
        }
    });
});
