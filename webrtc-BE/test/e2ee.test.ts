import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import storage from "../src/services/storage.service";
import Message from "../src/models/messageModel";
import Notification from "../src/models/notificationModel";
import { E2eeDevice, E2eeOneTimeKey, E2eeToDevice } from "../src/e2ee/models";
import { matrixUserId } from "../src/e2ee/e2ee.service";
import { runAsSystem } from "../src/tenancy/context";
import { api, connect, enc, makeUser, nextEvent, oid, sleep, startSocketServer, uniq } from "./helpers";

/**
 * End-to-end encryption, server side: the key directory and device-message relay only handle PUBLIC
 * keys and ciphertext, only between people who share a conversation; messages and attachments are
 * never accepted (or stored) in plaintext. The cryptography itself runs in browsers and is tested
 * there (webrtc-FE: e2ee specs).
 */
type U = Awaited<ReturnType<typeof makeUser>>;
const dev = (u: U, device: string) => {
    const s = api({ user: u });
    const h = { "x-spreewe-device": device };
    return {
        get: (p: string) => s.get(p).set(h),
        post: (p: string, body: unknown = {}) => s.post(p).set(h).send(body as object),
    };
};
/** Public device keys as the client library publishes them (the server checks shape and ownership only). */
const deviceKeys = (u: U, device: string, ed = `ed-${device}`) => ({
    user_id: matrixUserId(u._id), device_id: device, algorithms: ["m.olm.v1.curve25519-aes-sha2", "m.megolm.v1.aes-sha2"],
    keys: { [`curve25519:${device}`]: `cv-${device}`, [`ed25519:${device}`]: ed }, signatures: { [matrixUserId(u._id)]: { [`ed25519:${device}`]: "sig" } },
});
async function setUpDevice(u: U, device: string, otks = 2) {
    expect((await dev(u, device).post("/v1/e2ee/devices", { displayName: "Test browser" })).status).toBe(201);
    const one_time_keys = Object.fromEntries(Array.from({ length: otks }, (_, i) => [`signed_curve25519:K${device}${i}`, { key: `otk${i}`, signatures: {} }]));
    const r = await dev(u, device).post("/v1/e2ee/keys/upload", { device_keys: deviceKeys(u, device), one_time_keys, fallback_keys: { [`signed_curve25519:F${device}`]: { key: "fb", fallback: true, signatures: {} } } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.data;
}
const chat = async (a: U, b: U) => String((await api({ user: a }).post("/conversations").send({ receiverId: String(b._id) })).body.conversationId);

beforeAll(() => Promise.all([E2eeDevice, E2eeOneTimeKey, E2eeToDevice].map((m: any) => m.createIndexes())));

describe("key directory: public keys only, own device only", () => {
    it("publishes my device's keys; refuses keys for another account or device, and a silent identity change", async () => {
        const [alice, mallory] = [await makeUser(), await makeUser()];
        const counts = await setUpDevice(alice, "ALICE1");
        expect(counts.one_time_key_counts.signed_curve25519).toBe(2);
        expect(counts.unused_fallback_keys).toEqual(["signed_curve25519"]);
        // Keys claiming to be someone else's / another device's are refused
        await dev(mallory, "MALL01").post("/v1/e2ee/devices");
        expect((await dev(mallory, "MALL01").post("/v1/e2ee/keys/upload", { device_keys: deviceKeys(alice, "MALL01") })).status).toBe(403);
        expect((await dev(alice, "ALICE1").post("/v1/e2ee/keys/upload", { device_keys: deviceKeys(alice, "OTHER1") })).status).toBe(403);
        // A device's identity key never changes silently (a new identity needs a new device id)
        expect((await dev(alice, "ALICE1").post("/v1/e2ee/keys/upload", { device_keys: deviceKeys(alice, "ALICE1", "ed-DIFFERENT") })).status).toBe(403);
        // Keys can't be published from a device that isn't registered
        expect((await dev(alice, "NOTREG").post("/v1/e2ee/keys/upload", { device_keys: deviceKeys(alice, "NOTREG") })).status).toBe(404);
        // Nothing private is ever stored: only the fields the protocol publishes
        const stored = await runAsSystem(() => E2eeDevice.findOne({ userId: alice._id, deviceId: "ALICE1" }).lean(), "test");
        expect(Object.keys(stored!.keys!).sort()).toEqual(["algorithms", "device_id", "keys", "signatures", "user_id"]);
    });

    it("keys are served only for people I share a conversation with (no directory browsing)", async () => {
        const [alice, bob, stranger] = [await makeUser(), await makeUser(), await makeUser()];
        await setUpDevice(bob, "BOB001");
        await setUpDevice(stranger, "STR001");
        await chat(alice, bob);
        const q = await api({ user: alice }).post("/v1/e2ee/keys/query").send({ device_keys: { [matrixUserId(bob._id)]: [], [matrixUserId(stranger._id)]: [], "@notauser:evil.example": [] } });
        expect(Object.keys(q.body.data.device_keys[matrixUserId(bob._id)])).toEqual(["BOB001"]);
        expect(q.body.data.device_keys[matrixUserId(stranger._id)]).toBeUndefined();
        expect(Object.keys(q.body.data.failures).sort()).toEqual(["@notauser:evil.example", matrixUserId(stranger._id)].sort());
        const claim = await api({ user: alice }).post("/v1/e2ee/keys/claim").send({ one_time_keys: { [matrixUserId(stranger._id)]: { STR001: "signed_curve25519" } } });
        expect(claim.body.data.one_time_keys).toEqual({});
    });

    it("a one-time key is handed out exactly once (also under concurrent claims); then the fallback key", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        await setUpDevice(bob, "BOB002", 3);
        await chat(alice, bob);
        const claimOnce = () => api({ user: alice }).post("/v1/e2ee/keys/claim").send({ one_time_keys: { [matrixUserId(bob._id)]: { BOB002: "signed_curve25519" } } });
        const got = (await Promise.all([claimOnce(), claimOnce(), claimOnce(), claimOnce()])).map((r) => Object.keys(r.body.data.one_time_keys[matrixUserId(bob._id)]?.BOB002 || {})[0]);
        const oneTime = got.filter((k) => k && !k.includes("FBOB002"));
        expect(new Set(oneTime).size).toBe(oneTime.length); // never the same one-time key twice
        expect(oneTime.length).toBe(3);
        expect(got.filter((k) => k?.includes("FBOB002")).length).toBe(1); // pool empty → fallback
    });
});

describe("device messages: ciphertext only, between people who talk", () => {
    it("queues Olm ciphertext for a peer's device, delivers it once (ack), and refuses strangers, plaintext and odd types", async () => {
        const [alice, bob, stranger] = [await makeUser(), await makeUser(), await makeUser()];
        await setUpDevice(alice, "ALI003");
        await setUpDevice(bob, "BOB003");
        await setUpDevice(stranger, "STR003");
        await chat(alice, bob);
        const olm = { algorithm: "m.olm.v1.curve25519-aes-sha2", sender_key: "cv", ciphertext: { cvBOB: { type: 0, body: "c2VjcmV0" } } };
        const send = (to: U, device: string, type = "m.room.encrypted", content: unknown = olm, txn = uniq("t")) =>
            dev(alice, "ALI003").post(`/v1/e2ee/sendToDevice/${type}/${txn}`, { messages: { [matrixUserId(to._id)]: { [device]: content } } });
        expect((await send(bob, "BOB003", "m.room.encrypted", olm, "txn-1")).status).toBe(201);
        expect((await send(bob, "BOB003", "m.room.encrypted", olm, "txn-1")).status).toBe(201); // retry: stored once
        expect((await send(stranger, "STR003")).status).toBe(403);
        expect((await send(bob, "BOB003", "m.room.encrypted", { algorithm: "x", body: "plaintext room key" })).status).toBe(400);
        expect((await send(bob, "BOB003", "m.room_key")).status).toBe(400); // a plaintext room key type: never relayed

        const first = await dev(bob, "BOB003").get("/v1/e2ee/sync");
        expect(first.body.data.events).toHaveLength(1);
        expect(first.body.data.events[0]).toMatchObject({ sender: matrixUserId(alice._id), type: "m.room.encrypted" });
        // Not acknowledged → delivered again (at-least-once across reconnects); acknowledged → gone
        expect((await dev(bob, "BOB003").get("/v1/e2ee/sync")).body.data.events).toHaveLength(1);
        expect((await dev(bob, "BOB003").get(`/v1/e2ee/sync?ack=${first.body.data.next}`)).body.data.events).toHaveLength(0);
        // Another device of bob's can't read this device's queue
        await setUpDevice(bob, "BOB004");
        expect((await dev(bob, "BOB004").get("/v1/e2ee/sync")).body.data.events).toHaveLength(0);
    });

    it("a revoked device stops receiving keys and device messages and can't publish; contacts are told", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        await setUpDevice(alice, "ALI005");
        await setUpDevice(bob, "BOB005");
        await chat(alice, bob);
        expect((await api({ user: bob }).post("/v1/e2ee/devices/BOB005/revoke")).status).toBe(201);
        const q = await api({ user: alice }).post("/v1/e2ee/keys/query").send({ device_keys: { [matrixUserId(bob._id)]: [] } });
        expect(q.body.data.device_keys[matrixUserId(bob._id)]).toEqual({});
        expect((await dev(bob, "BOB005").get("/v1/e2ee/sync")).status).toBe(403);
        expect((await dev(bob, "BOB005").post("/v1/e2ee/keys/upload", { one_time_keys: {} })).status).toBe(403);
        expect((await dev(bob, "BOB005").post("/v1/e2ee/devices")).status).toBe(403); // can't be revived
        expect(await runAsSystem(() => E2eeOneTimeKey.countDocuments({ userId: bob._id, deviceId: "BOB005" }), "test")).toBe(0);
        const list = (await api({ user: bob }).get("/v1/e2ee/devices")).body.data;
        expect(list.find((d: any) => d.deviceId === "BOB005").revoked).toBe(true);
    });

    it("room members for key sharing come from the server, only for members, only in the conversation's context", async () => {
        const [alice, bob, eve] = [await makeUser(), await makeUser(), await makeUser()];
        const conv = await chat(alice, bob);
        const r = await api({ user: alice }).get(`/v1/e2ee/rooms/${conv}/members`);
        expect(r.body.data.members.sort()).toEqual([matrixUserId(alice._id), matrixUserId(bob._id)].sort());
        expect((await api({ user: eve }).get(`/v1/e2ee/rooms/${conv}/members`)).status).toBe(404);
    });
});

describe("messages and attachments are never accepted in plaintext", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    beforeAll(async () => { server = await startSocketServer(); });
    afterAll(async () => { open.forEach((s) => s.disconnect()); await server.close(); });
    afterEach(() => vi.restoreAllMocks());

    it("a plaintext message is refused (no fallback); an encrypted one is stored and relayed without any plaintext", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        const conv = await chat(alice, bob);
        const sa = await connect(server.port, { user: alice });
        const sb = await connect(server.port, { user: bob });
        open.push(sa, sb);
        await sleep(150);
        const refused = nextEvent(sa, "message:rejected", 2000, (p) => p?.reason === "unencrypted");
        const leaked = nextEvent(sb, "receiveMessage", 1000);
        sa.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, content: "top secret plaintext", type: "text" });
        expect(await refused).not.toBeNull();
        expect(await leaked).toBeNull();
        expect(await runAsSystem(() => Message.exists({ conversationId: oid(conv) }), "test")).toBeNull();

        const got = nextEvent(sb, "receiveMessage", 2000);
        sa.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, e2ee: { ...enc("x"), extra: "dropped" }, mentions: [String(bob._id)], type: "text" });
        const m: any = await got;
        expect(m.e2ee).toEqual(enc("x"));
        expect(m.content).toBe("");
        const stored = await runAsSystem(() => Message.findOne({ conversationId: oid(conv) }).lean(), "test");
        expect(stored!.content).toBe("");
        expect(Object.keys(stored!.e2ee!).sort()).toEqual(["algorithm", "ciphertext", "device_id", "sender_key", "session_id"]);
        // Activity entries never carry message text
        await sleep(300);
        const notes = await runAsSystem(() => Notification.find({ userId: bob._id }).lean(), "test");
        expect(notes.every((n: any) => !n.text || n.text === "New message")).toBe(true);
    });

    it("server-side forwarding is refused (the server can't read the source); edits must be encrypted too", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        const conv = await chat(alice, bob);
        const sa = await connect(server.port, { user: alice });
        open.push(sa);
        await sleep(150);
        const got = nextEvent(sa, "receiveMessage", 2000);
        sa.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, e2ee: enc("original"), type: "text" });
        const sent: any = await got;
        const fwd = nextEvent(sa, "message:rejected", 2000, (p) => p?.reason === "forward");
        sa.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, forwardOf: String(sent._id), type: "text", e2ee: enc("f") });
        expect(await fwd).not.toBeNull();
        const plainEdit: any = await new Promise((r) => sa.emit("message:edit", { messageId: String(sent._id), content: "edited in clear" }, r));
        expect(plainEdit.error).toBeTruthy();
        const encEdit: any = await new Promise((r) => sa.emit("message:edit", { messageId: String(sent._id), e2ee: enc("edited") }, r));
        expect(encEdit.success).toBe(true);
        const stored = await runAsSystem(() => Message.findById(sent._id).lean(), "test");
        expect(stored!.e2ee!.ciphertext).toBe(enc("edited").ciphertext);
        expect(stored!.content).toBe("");
    });

    it("attachments: plaintext uploads are refused; encrypted ones are stored as opaque ciphertext without their name", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        const conv = await chat(alice, bob);
        const put = vi.spyOn(storage, "put").mockResolvedValue(undefined as any);
        const plain = await api({ user: alice }).post("/upload").field("purpose", "message").field("conversationId", conv)
            .attach("file", Buffer.from("%PDF-1.4 secret contract"), { filename: "contract.pdf", contentType: "application/pdf" });
        expect(plain.status).toBe(400);
        expect(put).not.toHaveBeenCalled();
        const cipher = Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) % 256));
        const ok = await api({ user: alice }).post("/upload").field("purpose", "message").field("conversationId", conv).field("encrypted", "1").field("kind", "pdf")
            .attach("file", cipher, { filename: "contract.pdf", contentType: "application/pdf" });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect(ok.body).toMatchObject({ type: "pdf", encrypted: true });
        const args = put.mock.calls[0][0] as any;
        expect(args.contentType).toBe("application/octet-stream");
        expect(args.metadata["original-name"]).toBe("encrypted"); // the real name lives inside the encrypted message
        expect(args.key).toMatch(/\.bin$/);
        expect(JSON.stringify(ok.body)).not.toContain("contract");
    });
});
