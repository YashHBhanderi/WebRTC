import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";
import Call from "../src/models/callModel";
import mediasoupService from "../src/services/mediasoup.service";
import { runAsSystem } from "../src/tenancy/context";
import { ack, addMessage, api, connect, makeUser, oid, Session, sleep, startSocketServer } from "./helpers";

/** SEC-005: no ICE/DTLS allocation (create / connect / restart ICE) before the user is admitted to the call. */
describe("mediasoup transports require call admission (SEC-005)", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    const G = (u: any): Session => ({ user: u });
    const sock = async (s: Session) => {
        const socket = await connect(server.port, s);
        open.push(socket);
        await sleep(150);
        return socket;
    };

    async function activeCall(u: any, v: any) {
        const res = await api(G(v)).post("/conversations").send({ receiverId: String(u._id) });
        const chat = String(res.body?.data?._id ?? res.body?._id ?? res.body?.conversationId);
        await addMessage(chat, v);
        return runAsSystem(() => Call.create({
            conversationId: oid(chat), initiatedBy: v._id, callType: "audio", callStatus: "active",
            participants: [{ userId: v._id, status: "joined" }, { userId: u._id, status: "joined" }],
        } as any));
    }

    beforeAll(async () => {
        await mediasoupService.init();
        server = await startSocketServer();
    });

    afterAll(async () => {
        open.forEach((s) => s.disconnect());
        await server.close();
    });

    it("refuses create / connect / restartIce with NOT_JOINED before joinCall", async () => {
        const u = await makeUser();
        const s = await sock(G(u));
        for (const event of ["mediasoup:createSendTransport", "mediasoup:createRecvTransport"]) {
            expect(await ack<any>(s, event, {})).toMatchObject({ code: "NOT_JOINED" });
        }
        expect(await ack<any>(s, "mediasoup:connectTransport", { transportId: "x", dtlsParameters: {} })).toMatchObject({ code: "NOT_JOINED" });
        expect(await ack<any>(s, "mediasoup:restartIce", { transportId: "x" })).toMatchObject({ code: "NOT_JOINED" });
    });

    it("a non-participant whose join was refused still gets NOT_JOINED", async () => {
        const [u, v, outsider] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        const call = await activeCall(u, v);
        const s = await sock(G(outsider));
        expect((await ack<any>(s, "mediasoup:joinCall", { callId: String(call._id), callType: "audio" })).error).toBeTruthy();
        expect(await ack<any>(s, "mediasoup:createSendTransport", {})).toMatchObject({ code: "NOT_JOINED" });
    });

    it("allows transports after joining, and refuses them again once removed from the call", async () => {
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        const call = await activeCall(u, v);
        const s = await sock(G(u));
        const joined = await ack<any>(s, "mediasoup:joinCall", { callId: String(call._id), callType: "audio" });
        expect(joined.success).toBe(true);
        const send = await ack<any>(s, "mediasoup:createSendTransport", {});
        expect(send.error).toBeUndefined();
        expect(send.id).toBeTruthy();

        // Removed by the host while connected: the stale in-memory join no longer authorizes media
        await runAsSystem(() => Call.updateOne({ _id: call._id, "participants.userId": u._id }, { $set: { "participants.$.status": "removed" } }));
        expect(await ack<any>(s, "mediasoup:createRecvTransport", {})).toMatchObject({ code: "NOT_JOINED" });
        expect(await ack<any>(s, "mediasoup:restartIce", { transportId: send.id })).toMatchObject({ code: "NOT_JOINED" });
    });

    describe("mediasoup:syncProducers requires admission to that call", () => {
        it("refuses a user who is not a participant (no producer ids or user ids leak)", async () => {
            const [u, v, outsider] = await Promise.all([makeUser(), makeUser(), makeUser()]);
            const call = await activeCall(u, v);
            const s = await sock(G(outsider));
            const r = await ack<any>(s, "mediasoup:syncProducers", { callId: String(call._id) });
            expect(r).toMatchObject({ producers: [], code: "NOT_JOINED" });
        });

        it("refuses a participant of ANOTHER call asking about this one", async () => {
            const [u, v, w, x] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);
            const target = await activeCall(u, v);
            const mine = await activeCall(w, x);
            const s = await sock(G(w));
            expect((await ack<any>(s, "mediasoup:joinCall", { callId: String(mine._id), callType: "audio" })).success).toBe(true);
            const r = await ack<any>(s, "mediasoup:syncProducers", { callId: String(target._id) });
            expect(r).toMatchObject({ producers: [], code: "NOT_JOINED" });
        });

        it("answers a joined participant, and refuses them once removed from the call", async () => {
            const [u, v] = await Promise.all([makeUser(), makeUser()]);
            const call = await activeCall(u, v);
            const s = await sock(G(u));
            expect((await ack<any>(s, "mediasoup:joinCall", { callId: String(call._id), callType: "audio" })).success).toBe(true);
            const ok = await ack<any>(s, "mediasoup:syncProducers", { callId: String(call._id) });
            expect(ok.error).toBeUndefined();
            expect(Array.isArray(ok.producers)).toBe(true);

            await runAsSystem(() => Call.updateOne({ _id: call._id, "participants.userId": u._id }, { $set: { "participants.$.status": "removed" } }));
            const after = await ack<any>(s, "mediasoup:syncProducers", { callId: String(call._id) });
            expect(after).toMatchObject({ producers: [], code: "NOT_JOINED" });
        });
    });
});
