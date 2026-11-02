import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io-client";
import mongoose from "mongoose";
import * as sdk from "@matrix-org/matrix-sdk-crypto-wasm";
import Message from "../src/models/messageModel";
import { E2eeDevice, E2eeOneTimeKey, E2eeToDevice } from "../src/e2ee/models";
import { runAsSystem } from "../src/tenancy/context";
import { ack, api, connect, makeUser, nextEvent, sleep, startSocketServer, uniq } from "./helpers";

/**
 * End-to-end encryption with the REAL library (the same @matrix-org/matrix-sdk-crypto-wasm the browser
 * uses, in Node) against the real HTTP routes, Socket.IO gateway and database. Each Device below does
 * what webrtc-FE's E2eeService does: publish keys, share room keys over Olm, encrypt with Megolm,
 * sync device messages, decrypt. Every test message carries a unique marker; the marker must never
 * appear in a Socket.IO frame, an HTTP response, a database document or a log line, only in the
 * output of an authorized device's decryption.
 */
type U = Awaited<ReturnType<typeof makeUser>>;
const SERVER = "spreewe.local";
const mUser = (id: unknown) => `@${String(id)}:${SERVER}`;
const mRoom = (id: string) => `!${id}:${SERVER}`;

class Device {
    machine!: sdk.OlmMachine;
    readonly deviceId = uniq("D").toUpperCase().slice(0, 10);
    private ack: string | null = null;
    private since = 0;
    private shared = new Map<string, Set<string>>();
    constructor(readonly user: U) {}

    private call(method: "get" | "post", path: string, body?: unknown) {
        const s = api({ user: this.user });
        const r = method === "get" ? s.get(`/v1/e2ee${path}`) : s.post(`/v1/e2ee${path}`).send((body ?? {}) as object);
        return r.set("x-spreewe-device", this.deviceId);
    }
    private async data(method: "get" | "post", path: string, body?: unknown) {
        const r = await this.call(method, path, body);
        if (r.status >= 300) throw Object.assign(new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`), { status: r.status });
        return r.body.data;
    }

    async start(): Promise<this> {
        await this.data("post", "/devices", { displayName: "Node test device" });
        this.machine = await sdk.OlmMachine.initialize(new sdk.UserId(mUser(this.user._id)), new sdk.DeviceId(this.deviceId));
        await this.flush();
        return this;
    }

    private async answer(r: any): Promise<void> {
        let res: unknown = {};
        switch (r.type) {
            case sdk.RequestType.KeysUpload: res = await this.data("post", "/keys/upload", JSON.parse(r.body)); break;
            case sdk.RequestType.KeysQuery: res = await this.data("post", "/keys/query", JSON.parse(r.body)); break;
            case sdk.RequestType.KeysClaim: res = await this.data("post", "/keys/claim", JSON.parse(r.body)); break;
            case sdk.RequestType.ToDevice: res = await this.data("post", `/sendToDevice/${encodeURIComponent(r.event_type)}/${encodeURIComponent(r.txn_id)}`, JSON.parse(r.body)); break;
        }
        await this.machine.markRequestAsSent(r.id, r.type, JSON.stringify(res));
    }
    private async flush(): Promise<void> {
        for (let i = 0; i < 10; i++) {
            const rs = await this.machine.outgoingRequests();
            if (!rs.length) return;
            for (const r of rs as any[]) await this.answer(r);
        }
    }

    async sync(): Promise<void> {
        for (let page = 0; page < 20; page++) {
            const q = new URLSearchParams();
            if (this.ack) q.set("ack", this.ack);
            if (this.since) q.set("since", String(this.since));
            const res = await this.data("get", `/sync?${q}`);
            await this.machine.receiveSyncChanges(
                JSON.stringify(res.events.map((e: any) => ({ sender: e.sender, type: e.type, content: e.content }))),
                new sdk.DeviceLists((res.device_lists?.changed || []).map((u: string) => new sdk.UserId(u)), []),
                new Map(Object.entries(res.one_time_key_counts || {})),
                new Set(res.unused_fallback_keys || []),
            );
            this.since = res.now;
            if (res.next) this.ack = res.next;
            await this.flush();
            if (res.events.length < 100) return;
        }
    }

    async encrypt(conversationId: string, content: Record<string, unknown>) {
        const room = () => new sdk.RoomId(mRoom(conversationId));
        const { members } = await this.data("get", `/rooms/${conversationId}/members`);
        const now = new Set<string>(members);
        const before = this.shared.get(conversationId);
        if (before && [...before].some((m) => !now.has(m))) await this.machine.invalidateGroupSession(room());
        const users = () => members.map((m: string) => new sdk.UserId(m));
        await this.machine.updateTrackedUsers(users());
        await this.flush();
        await this.answer(this.machine.queryKeysForUsers(users())); // as the browser client does
        const claim = await this.machine.getMissingSessions(users());
        if (claim) await this.answer(claim);
        for (const s of await this.machine.shareRoomKey(room(), users(), new sdk.EncryptionSettings())) await this.answer(s);
        this.shared.set(conversationId, now);
        const e = JSON.parse(await this.machine.encryptRoomEvent(room(), "m.room.message", JSON.stringify({ msgtype: "spreewe.v1", ...content })));
        return { algorithm: "m.megolm.v1.aes-sha2", ciphertext: e.ciphertext, session_id: e.session_id, sender_key: e.sender_key, device_id: e.device_id };
    }

    /** Decrypt a message as the server delivers it (socket payload or history item). */
    async decrypt(m: any): Promise<{ ok: true; text: string; file?: any } | { ok: false; code: string }> {
        try {
            const event = { type: "m.room.encrypted", event_id: `$${m._id}`, sender: mUser(m.user?._id || m.userId), origin_server_ts: Date.now(), content: m.e2ee };
            const r: any = await this.machine.decryptRoomEvent(JSON.stringify(event), new sdk.RoomId(mRoom(String(m.conversationId))), new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted));
            const c = JSON.parse(r.event).content;
            return { ok: true, text: c.text, file: c.file };
        } catch (e: any) {
            return { ok: false, code: String(e?.code ?? e?.message ?? e) };
        }
    }
}

// ---------------------------------------------------------------------------------------------- harness

let server: Awaited<ReturnType<typeof startSocketServer>>;
const open: Socket[] = [];
/** Every log line written during the tests (to prove no marker is logged) */
const logged: string[] = [];
const frames: string[] = [];

beforeAll(async () => {
    await sdk.initAsync();
    await Promise.all([E2eeDevice, E2eeOneTimeKey, E2eeToDevice].map((m: any) => m.createIndexes()));
    server = await startSocketServer();
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
        const original = console[level].bind(console);
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
            logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
            original(...(args as []));
        });
    }
});
afterEach(() => { open.splice(0).forEach((s) => s.disconnect()); });
afterAll(async () => { vi.restoreAllMocks(); await server.close(); });

/** A connected socket that records every frame it receives. */
async function online(u: U): Promise<Socket> {
    const s = await connect(server.port, { user: u });
    s.onAny((event, ...args) => frames.push(`${event} ${JSON.stringify(args)}`));
    open.push(s);
    return s;
}
const dm = async (a: U, b: U) => String((await api({ user: a }).post("/conversations").send({ receiverId: String(b._id) })).body.conversationId);
const marker = (label: string) => `MARKER-${label}-${uniq("")}-${Math.random().toString(36).slice(2)}`;
const history = async (u: U, conversationId: string, page = 1, limit = 50) => {
    const r = await api({ user: u }).get(`/messages/${conversationId}?page=${page}&limit=${limit}`);
    return { status: r.status, items: (r.body?.data || []) as any[], raw: JSON.stringify(r.body) };
};
const allStored = async () => JSON.stringify(await runAsSystem(async () => ({
    messages: await Message.find({}).lean(),
    toDevice: await E2eeToDevice.find({}).lean(),
    devices: await E2eeDevice.find({}).lean(),
}), "test"));

/** Send through the real gateway: encrypt on the device, emit only ciphertext. Resolves with the relayed copy. */
async function send(from: Device, socket: Socket, observer: Socket, conversationId: string, content: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    const e2ee = await from.encrypt(conversationId, content);
    const outgoing = { user: { _id: String(from.user._id) }, conversationId, content: "", type: "text", e2ee, ...extra };
    frames.push(`OUT sendMessage ${JSON.stringify(outgoing)}`);
    const relayed = nextEvent(observer, "receiveMessage", 4000, (p) => p?.e2ee?.ciphertext === e2ee.ciphertext);
    socket.emit("sendMessage", outgoing);
    const got = await relayed;
    expect(got, "message was not relayed").not.toBeNull();
    return got;
}

function expectNowhere(secret: string, ...where: string[]) {
    for (const blob of [...where, frames.join("\n"), logged.join("\n")]) expect(blob.includes(secret)).toBe(false);
}

// ------------------------------------------------------------------------------------------------ tests

describe("E2EE with the real library through the real server", () => {
    it("1:1 — the recipient decrypts the exact text; socket frames, history, DB and logs carry only ciphertext", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        const conv = await dm(alice, bob);
        const [a, b] = [await new Device(alice).start(), await new Device(bob).start()];
        const [sa, sb] = [await online(alice), await online(bob)];
        await sleep(100);

        const secret = marker("dm");
        const relayed = await send(a, sa, sb, conv, { text: secret });
        expect(relayed.content).toBe("");
        expect(JSON.stringify(relayed).includes(secret)).toBe(false);

        await b.sync(); // room key arrives over Olm (to-device)
        expect(await b.decrypt(relayed)).toMatchObject({ ok: true, text: secret });
        // The sender reads its own message too (it receives the broadcast like everyone else)
        expect(await a.decrypt(relayed)).toMatchObject({ ok: true, text: secret });

        // History (the REST path the chat page loads) returns the ciphertext and decrypts identically
        const h = await history(bob, conv);
        const item = h.items.find((m) => String(m._id) === String(relayed._id));
        expect(item?.e2ee?.ciphertext).toBe(relayed.e2ee.ciphertext);
        expect(item?.conversationId).toBe(conv);
        expect(await b.decrypt(item)).toMatchObject({ ok: true, text: secret });

        expectNowhere(secret, h.raw, await allStored());
    });

    it("replies, edits, pins and saved messages stay encrypted and decrypt from every server path", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        const conv = await dm(alice, bob);
        const [a, b] = [await new Device(alice).start(), await new Device(bob).start()];
        const [sa, sb] = [await online(alice), await online(bob)];
        await sleep(100);

        const original = marker("orig");
        const first = await send(a, sa, sb, conv, { text: original });
        const reply = marker("reply");
        const second = await send(b, sb, sa, conv, { text: reply }, { replyTo: String(first._id) });
        await a.sync(); await b.sync();
        // The quoted message travels as ciphertext and decrypts like the message itself
        expect(second.replyTo?.e2ee?.ciphertext).toBe(first.e2ee.ciphertext);
        expect(await a.decrypt({ ...second.replyTo, conversationId: conv })).toMatchObject({ ok: true, text: original });
        const h = await history(alice, conv);
        const quoted = h.items.find((m) => String(m._id) === String(second._id))?.replyTo;
        expect(await a.decrypt({ ...quoted, conversationId: conv })).toMatchObject({ ok: true, text: original });

        // Edit: re-encrypted; the server stores and relays only the new ciphertext
        const edited = marker("edit");
        const updated = nextEvent(sb, "message:updated", 3000);
        const res: any = await ack(sa, "message:edit", { messageId: String(first._id), e2ee: await a.encrypt(conv, { text: edited }) });
        expect(res.success, JSON.stringify(res)).toBe(true);
        const upd: any = await updated;
        await b.sync();
        expect(await b.decrypt({ ...upd, _id: upd.messageId || upd._id, conversationId: conv, userId: String(alice._id) })).toMatchObject({ ok: true, text: edited });
        // A plaintext edit is refused
        const plainEdit: any = await ack(sa, "message:edit", { messageId: String(first._id), content: "plain edit" }).catch((e) => ({ error: String(e) }));
        expect(plainEdit.success).not.toBe(true);

        // Pins and saved messages hand out ciphertext, never text
        const pin: any = await ack(sa, "message:pin", { messageId: String(second._id), pinned: true });
        expect(pin.success, JSON.stringify(pin)).toBe(true);
        const pinned = (pin.pins || []).find((p: any) => p.messageId === String(second._id));
        expect(await a.decrypt({ _id: pinned.messageId, conversationId: pinned.conversationId, e2ee: pinned.e2ee, userId: pinned.user?._id })).toMatchObject({ ok: true, text: reply });
        expect((await api({ user: alice }).put(`/messages/${second._id}/save`).send({ saved: true })).status).toBe(200);
        const saved = await api({ user: alice }).get("/saved-messages");
        const item = saved.body.data.items.find((i: any) => i.messageId === String(second._id));
        expect(await a.decrypt({ _id: item.messageId, conversationId: item.conversationId, e2ee: item.e2ee, userId: item.user?._id })).toMatchObject({ ok: true, text: reply });

        // Conversation list preview: ciphertext only
        const list = await api({ user: bob }).get("/conversations");
        expectNowhere(original, h.raw, JSON.stringify(pin), saved.text, list.text, await allStored());
        expectNowhere(reply, h.raw, JSON.stringify(pin), saved.text, list.text, await allStored());
        expectNowhere(edited, list.text, await allStored());
    });

    it("group: members decrypt; a removed member cannot read anything sent after removal (key rotated)", async () => {
        const [alice, bob, carol] = [await makeUser(), await makeUser(), await makeUser()];
        const created = await api({ user: alice }).post("/conversations/group").field("groupName", "E2EE group").field("groupMembers", JSON.stringify([String(bob._id), String(carol._id)]));
        const conv = String(created.body?.data?._id ?? created.body?._id);
        expect(mongoose.isValidObjectId(conv), JSON.stringify(created.body)).toBe(true);
        const [a, b, c] = [await new Device(alice).start(), await new Device(bob).start(), await new Device(carol).start()];
        const [sa, sb] = [await online(alice), await online(bob)];
        await sleep(100);

        const before = marker("g-before");
        const m1 = await send(a, sa, sb, conv, { text: before });
        await b.sync(); await c.sync();
        expect(await b.decrypt(m1)).toMatchObject({ ok: true, text: before });
        expect(await c.decrypt(m1)).toMatchObject({ ok: true, text: before });

        const removed: any = await ack(sa, "group:remove-member", { groupId: conv, userId: String(carol._id) });
        expect(removed.success, JSON.stringify(removed)).toBe(true);

        const after = marker("g-after");
        const m2 = await send(a, sa, sb, conv, { text: after });
        await b.sync(); await c.sync();
        expect(await b.decrypt(m2)).toMatchObject({ ok: true, text: after });
        // Carol gets the ciphertext straight from the database (she can no longer load it) and still can't read it
        const raw = await runAsSystem(() => Message.findById(m2._id).lean(), "test");
        expect(await c.decrypt({ ...raw, conversationId: conv, user: { _id: String(alice._id) } })).toMatchObject({ ok: false });
        expect(m2.e2ee.session_id).not.toBe(m1.e2ee.session_id);
        // and the server no longer serves her the conversation
        expect([403, 404]).toContain((await history(carol, conv)).status);
        expectNowhere(after, await allStored());
    });

    it("outsiders: no history, no keys, and the ciphertext alone is useless", async () => {
        const [alice, bob, eve] = [await makeUser(), await makeUser(), await makeUser()];
        const conv = await dm(alice, bob);
        const [a, , e] = [await new Device(alice).start(), await new Device(bob).start(), await new Device(eve).start()];
        const [sa, sb] = [await online(alice), await online(bob)];
        const se = await online(eve);
        await sleep(100);
        const secret = marker("private");
        const leak = nextEvent(se, "receiveMessage", 1500);
        const m = await send(a, sa, sb, conv, { text: secret });
        expect(await leak).toBeNull();
        expect([403, 404]).toContain((await history(eve, conv)).status);
        expect((await api({ user: eve }).get(`/v1/e2ee/rooms/${conv}/members`).set("x-spreewe-device", e.deviceId)).status).toBe(404);
        await e.sync();
        expect(await e.decrypt(m)).toMatchObject({ ok: false });
    });

    it("offline recipient, pagination and reconnection: everything decrypts once the device syncs", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        const conv = await dm(alice, bob);
        const [a, b] = [await new Device(alice).start(), await new Device(bob).start()];
        const sa = await online(alice);
        await sleep(100);
        // Bob is offline: no socket. Alice's own socket observes the relay.
        const secrets = Array.from({ length: 5 }, (_, i) => marker(`off${i}`));
        for (const s of secrets) await send(a, sa, sa, conv, { text: s });

        // Bob comes online later: device sync (keys) + paginated history (2 per page)
        await b.sync();
        const read: string[] = [];
        for (let page = 1; page <= 3; page++) {
            const h = await history(bob, conv, page, 2);
            const texts: string[] = [];
            for (const m of h.items) {
                const d = await b.decrypt(m);
                expect(d.ok, JSON.stringify(d)).toBe(true);
                texts.push((d as any).text);
            }
            read.unshift(...texts); // pages are newest first, each oldest → newest
        }
        expect(read).toEqual(secrets);

        // Reconnect: a new socket, then a new message decrypts with the same session
        const sb = await online(bob);
        await sleep(100);
        const later = marker("reconnect");
        const m = await send(a, sa, sb, conv, { text: later });
        await b.sync();
        expect(await b.decrypt(m)).toMatchObject({ ok: true, text: later });
        expectNowhere(later, await allStored());
        for (const s of secrets) expectNowhere(s, await allStored());
    });

    it("tampering, wrong room, missing keys and a new unrelated device fail safely (never plaintext)", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        const conv = await dm(alice, bob);
        const other = await dm(alice, await makeUser());
        const [a, b] = [await new Device(alice).start(), await new Device(bob).start()];
        const [sa, sb] = [await online(alice), await online(bob)];
        await sleep(100);
        const secret = marker("tamper");
        const m = await send(a, sa, sb, conv, { text: secret });
        await b.sync();

        const bytes = Buffer.from(m.e2ee.ciphertext, "base64");
        bytes[bytes.length - 5] ^= 0x01;
        expect(await b.decrypt({ ...m, e2ee: { ...m.e2ee, ciphertext: bytes.toString("base64").replace(/=+$/, "") } })).toMatchObject({ ok: false });
        // Replayed into another conversation: refused (the session belongs to its room)
        expect(await b.decrypt({ ...m, conversationId: other })).toMatchObject({ ok: false });
        // Unknown session (key never received): refused
        expect(await b.decrypt({ ...m, e2ee: { ...m.e2ee, session_id: "AAAA" + m.e2ee.session_id.slice(4) } })).toMatchObject({ ok: false });
        // A device added later has no key for earlier messages (no key backup yet: documented limitation)
        const late = await new Device(bob).start();
        await late.sync();
        expect(await late.decrypt(m)).toMatchObject({ ok: false });
        // ...but receives keys for messages sent after it exists
        const next = marker("after-new-device");
        const m2 = await send(a, sa, sb, conv, { text: next });
        await late.sync();
        expect(await late.decrypt(m2)).toMatchObject({ ok: true, text: next });
    });

    it("no plaintext path: plaintext text, plaintext attachments and server-side forwards are refused", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        const conv = await dm(alice, bob);
        const [sa, sb] = [await online(alice), await online(bob)];
        await sleep(100);
        const secret = marker("plain");
        const rejected = nextEvent(sa, "message:rejected", 2000);
        const leaked = nextEvent(sb, "receiveMessage", 1200);
        sa.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, content: secret, type: "text" });
        expect((await rejected)?.reason).toBe("unencrypted");
        expect(await leaked).toBeNull();
        const up = await api({ user: alice }).post("/upload").field("purpose", "message").field("conversationId", conv).attach("file", Buffer.from(secret), "note.txt");
        expect(up.status).toBe(400);
        expectNowhere(secret, await allStored());
    });
});
