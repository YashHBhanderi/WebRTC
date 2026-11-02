import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";
import Call from "../src/models/callModel";
import { runAsSystem } from "../src/tenancy/context";
import { api, connect, enter, makeUser, newOrg, nextEvent, oid, Session, sleep, startSocketServer } from "./helpers";

/**
 * Phase 5C: an incoming call must survive the callee's socket (re)connecting. On every connect the
 * server sends `call:pending-rings` — the calls still ringing for that user, visible in that socket's
 * workspace — so the client can show a ring it missed and drop one cancelled / answered meanwhile.
 */
describe("incoming calls across socket reconnects", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    const sock = async (s: Session) => { const x = await connect(server.port, s); open.push(x); return x; };
    // Subscribe before the handshake completes: the list is sent right after connect
    const connectAndList = (s: Session) => new Promise<any[]>((resolve, reject) => {
        connect(server.port, s).then((x) => {
            open.push(x);
            nextEvent<any>(x, "call:pending-rings", 3000).then((p) => resolve(p ? p.calls : null as any));
        }, reject);
    });
    const dm = async (s: Session, other: any) => String((await api(s).post("/conversations").send({ receiverId: String(other._id) })).body.conversationId);

    async function ringing(caller: Session, callee: any) {
        const conv = await dm(caller, callee);
        const cs = await sock(caller);
        const started = nextEvent<any>(cs, "call:started", 3000);
        cs.emit("call:start", { groupId: conv, callType: "audio", mode: "ring" });
        const call = await started;
        return { conv, callId: String(call.callId), callerSocket: cs };
    }

    beforeAll(async () => { server = await startSocketServer(); });
    afterAll(async () => { open.forEach((s) => s.disconnect()); await server.close(); });

    it("a ring sent while the callee was offline is delivered when they connect", async () => {
        const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
        const { callId, conv } = await ringing({ user: alice }, bob);
        const calls = await connectAndList({ user: bob });
        expect(calls.map((c) => String(c.callId))).toEqual([callId]);
        expect(calls[0]).toMatchObject({ groupId: conv, mode: "ring", resent: true });
    });

    it("repeated reconnects each get the same single entry (no server-side duplicates)", async () => {
        const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
        const { callId } = await ringing({ user: alice }, bob);
        for (let i = 0; i < 3; i++) {
            const calls = await connectAndList({ user: bob });
            expect(calls.map((c) => String(c.callId))).toEqual([callId]);
            open.pop()!.disconnect();
            await sleep(100);
        }
    });

    it("a call cancelled while the callee was offline is not offered (empty list lets the client drop it)", async () => {
        const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
        const { callId, callerSocket } = await ringing({ user: alice }, bob);
        callerSocket.emit("call:leave", { callId });
        await sleep(500);
        expect(await connectAndList({ user: bob })).toEqual([]);
    });

    it("a call answered on another device, or expired, is not offered", async () => {
        const [alice, bob, carol] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        const answered = await ringing({ user: alice }, bob);
        await runAsSystem(() => Call.updateOne({ _id: answered.callId, "participants.userId": bob._id }, { $set: { "participants.$.status": "joined", callStatus: "active" } }), "test-fixture");
        expect(await connectAndList({ user: bob })).toEqual([]);
        const old = await ringing({ user: alice }, carol);
        // createdAt is immutable through Mongoose: age the call directly in the collection
        await Call.collection.updateOne({ _id: oid(old.callId) }, { $set: { createdAt: new Date(Date.now() - 10 * 60_000) } });
        expect(await connectAndList({ user: carol })).toEqual([]);
    });

    it("a workspace call is only offered to a socket in that workspace", async () => {
        const org = newOrg();
        const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: alice, org });
        await enter({ user: bob, org });
        const { callId } = await ringing({ user: alice, org }, bob);
        expect(await connectAndList({ user: bob })).toEqual([]); // personal context
        open.pop()!.disconnect();
        expect((await connectAndList({ user: bob, org })).map((c) => String(c.callId))).toEqual([callId]);
    });

    it("another user never receives someone else's pending ring", async () => {
        const [alice, bob, mallory] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        await ringing({ user: alice }, bob);
        expect(await connectAndList({ user: mallory })).toEqual([]);
    });
});
