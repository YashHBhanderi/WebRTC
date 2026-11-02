import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import * as sdk from "@matrix-org/matrix-sdk-crypto-wasm";
import Message from "../src/models/messageModel";
import { E2eeDevice, E2eeOneTimeKey, E2eeToDevice } from "../src/e2ee/models";
import { runAsSystem } from "../src/tenancy/context";
import { api, connect, makeUser, nextEvent, Session, sleep, startSocketServer, testApp, uniq } from "./helpers";

/**
 * Phase 3 of the third-party API: a developer app takes part in end-to-end encryption through its own
 * encryption device (e2ee:device), registered with the user's consent and labelled with the app's
 * name. Real Olm / Megolm on both sides (the same library as SpreeWe clients). The server only relays
 * public keys and ciphertext; an app can only use devices it registered.
 */
const SERVER = "spreewe.local";
const mUser = (id: unknown) => `@${String(id)}:${SERVER}`;
const mRoom = (id: string) => `!${id}:${SERVER}`;
const basic = (keyId: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const http = () => request(testApp());

type Auth = { session: Session } | { token: string };

/** An Olm machine talking to /v1/e2ee as a SpreeWe session or as a developer-app token. */
class Device {
    machine!: sdk.OlmMachine;
    private ack: string | null = null;
    private since = 0;
    constructor(readonly userId: string, readonly auth: Auth, readonly deviceId = uniq("D").toUpperCase().slice(0, 10)) {}

    call(method: "get" | "post", path: string, body?: unknown) {
        const url = `/v1/e2ee${path}`;
        const req = "session" in this.auth
            ? (method === "get" ? api(this.auth.session).get(url) : api(this.auth.session).post(url).send((body ?? {}) as object))
            : (method === "get" ? http().get(url) : http().post(url).send((body ?? {}) as object)).set(bearer(this.auth.token));
        return req.set("x-spreewe-device", this.deviceId);
    }
    async data(method: "get" | "post", path: string, body?: unknown) {
        const r = await this.call(method, path, body);
        if (r.status >= 300) throw Object.assign(new Error(`${path} → ${r.status} ${JSON.stringify(r.body)}`), { status: r.status });
        return r.body.data;
    }
    async start(displayName = "Test device"): Promise<this> {
        await this.data("post", "/devices", { displayName });
        this.machine = await sdk.OlmMachine.initialize(new sdk.UserId(mUser(this.userId)), new sdk.DeviceId(this.deviceId));
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
    }
    async encrypt(conversationId: string, text: string) {
        const room = () => new sdk.RoomId(mRoom(conversationId));
        const { members } = await this.data("get", `/rooms/${conversationId}/members`);
        const users = () => members.map((m: string) => new sdk.UserId(m));
        await this.machine.updateTrackedUsers(users());
        await this.flush();
        await this.answer(this.machine.queryKeysForUsers(users()));
        const claim = await this.machine.getMissingSessions(users());
        if (claim) await this.answer(claim);
        for (const s of await this.machine.shareRoomKey(room(), users(), new sdk.EncryptionSettings())) await this.answer(s);
        const e = JSON.parse(await this.machine.encryptRoomEvent(room(), "m.room.message", JSON.stringify({ msgtype: "spreewe.v1", text })));
        return { algorithm: "m.megolm.v1.aes-sha2", ciphertext: e.ciphertext, session_id: e.session_id, sender_key: e.sender_key, device_id: e.device_id };
    }
    async decrypt(m: any): Promise<string | null> {
        try {
            const event = { type: "m.room.encrypted", event_id: `$${m._id}`, sender: mUser(m.user?._id || m.userId?._id || m.userId), origin_server_ts: Date.now(), content: m.e2ee };
            const r: any = await this.machine.decryptRoomEvent(JSON.stringify(event), new sdk.RoomId(mRoom(String(m.conversationId))), new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted));
            return JSON.parse(r.event).content.text;
        } catch {
            return null;
        }
    }
}

describe("end-to-end encrypted messaging for developer apps (e2ee:device)", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    const appSocket = (token: string) => new Promise<Socket>((resolve, reject) => {
        const s = ioClient(`http://localhost:${server.port}`, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
        open.push(s);
        s.once("connect", () => resolve(s));
        s.once("connect_error", reject);
    });

    /** App owned by someone else; `user` grants `scopes`; returns the app, a user token and credentials. */
    async function app(user: Session, scopes: string[]) {
        const owner: Session = { user: await makeUser() };
        const created = (await api(owner).post("/v1/apps").send({ name: uniq("Chat app"), environment: "development", callbackUrls: ["https://example.com/cb"], scopes })).body.data;
        expect(created?._id, "app registration").toBeTruthy();
        const cred = (await api(owner).post(`/v1/apps/${created._id}/credentials`).send({ confirm: created.name })).body.data;
        expect((await api(user).post(`/v1/apps/${created._id}/grants`).send({ scopes })).status).toBe(201);
        const tok = await http().post("/v1/app-tokens").set(basic(cred.credential.keyId, cred.secret)).send({ userId: String(user.user._id) });
        expect(tok.status, JSON.stringify(tok.body)).toBe(201);
        return { app: created, owner, token: tok.body.data.accessToken as string };
    }
    const ALL = ["realtime:connect", "conversations:read", "messages:read", "messages:write", "messages:edit", "e2ee:device"];

    beforeAll(async () => {
        await sdk.initAsync();
        await Promise.all([E2eeDevice, E2eeOneTimeKey, E2eeToDevice].map((m: any) => m.createIndexes()));
        server = await startSocketServer();
    });

    afterAll(async () => {
        open.forEach((s) => s.disconnect());
        await server.close();
    });

    it("an app device reads and sends encrypted messages with a SpreeWe user; the server never sees plaintext", async () => {
        const [alice, bob] = (await Promise.all([makeUser(), makeUser()])).map((user) => ({ user }));
        const conv = String((await api(alice).post("/conversations").send({ receiverId: String(bob.user._id) })).body.conversationId);
        const { app: aliceApp, token } = await app(alice, ALL);

        // The app's device, registered with the app token, is labelled with the app's name for Alice
        const appDev = await new Device(String(alice.user._id), { token }).start("ignored for apps");
        const bobDev = await new Device(String(bob.user._id), { session: bob }).start();
        const listed = (await api(alice).get("/v1/e2ee/devices").set("x-spreewe-device", "ANYDEVICE1")).body.data ?? [];
        const mine = listed.find((d: any) => d.deviceId === appDev.deviceId);
        expect(mine).toMatchObject({ displayName: `${aliceApp.name} (app)`, appId: aliceApp._id, revoked: false });

        // Bob → Alice: the app decrypts it (ciphertext is delivered to apps with e2ee:device)
        const secret = `bob-secret-${uniq("")}`;
        const bobSock = await connect(server.port, bob); open.push(bobSock);
        const appSock = await appSocket(token);
        appSock.emit("joinConversation", conv);
        bobSock.emit("joinConversation", conv);
        await sleep(250);
        const got = nextEvent(appSock, "receiveMessage", 4000, (m) => String(m?.conversationId) === conv);
        bobSock.emit("sendMessage", { user: { _id: String(bob.user._id) }, conversationId: conv, content: "", type: "text", e2ee: await bobDev.encrypt(conv, secret) });
        const delivered = await got;
        expect(delivered?.e2ee?.ciphertext).toBeTruthy();
        await appDev.sync();
        expect(await appDev.decrypt(delivered)).toBe(secret);
        // History over REST carries the ciphertext too, and decrypts
        const history = await http().get(`/v1/conversations/${conv}/messages`).set(bearer(token));
        expect(history.status).toBe(200);
        expect(await appDev.decrypt({ ...history.body.data.find((m: any) => m.e2ee), conversationId: conv })).toBe(secret);

        // Alice's app → Bob: Bob's SpreeWe device decrypts it
        const reply = `app-reply-${uniq("")}`;
        const atBob = nextEvent(bobSock, "receiveMessage", 4000, (m) => String(m?.conversationId) === conv && String(m?.user?._id || m?.userId) === String(alice.user._id));
        appSock.emit("sendMessage", { user: { _id: String(alice.user._id) }, conversationId: conv, content: "", type: "text", e2ee: await appDev.encrypt(conv, reply) });
        const fromApp = await atBob;
        expect(fromApp, "message from the app").not.toBeNull();
        await bobDev.sync();
        expect(await bobDev.decrypt(fromApp)).toBe(reply);

        // Only ciphertext was stored
        const stored = await runAsSystem(() => Message.find({ conversationId: conv }).lean(), "test");
        expect(JSON.stringify(stored)).not.toContain(secret);
        expect(JSON.stringify(stored)).not.toContain(reply);
    });

    it("an app can only use its own devices, and SpreeWe clients can't use an app's device", async () => {
        const [alice, bob] = (await Promise.all([makeUser(), makeUser()])).map((user) => ({ user }));
        const conv = String((await api(alice).post("/conversations").send({ receiverId: String(bob.user._id) })).body.conversationId);
        const { token } = await app(alice, ALL);
        const own = await new Device(String(alice.user._id), { session: alice }).start();
        const appDev = await new Device(String(alice.user._id), { token }).start();

        // App acting as Alice's own browser device: refused (could otherwise consume its key deliveries)
        expect((await http().get("/v1/e2ee/sync").set(bearer(token)).set("x-spreewe-device", own.deviceId)).status).toBe(403);
        expect((await http().post("/v1/e2ee/devices").set(bearer(token)).set("x-spreewe-device", own.deviceId).send({})).status).toBe(403);
        // Alice's SpreeWe session acting as the app's device: refused
        expect((await api(alice).get("/v1/e2ee/sync").set("x-spreewe-device", appDev.deviceId)).status).toBe(403);
        // An app can't revoke Alice's own device; Alice can revoke the app's
        expect((await http().post(`/v1/e2ee/devices/${own.deviceId}/revoke`).set(bearer(token)).set("x-spreewe-device", appDev.deviceId).send({})).status).toBe(404);

        // Sending with the payload claiming Alice's own device: refused before the gateway
        const appSock = await appSocket(token);
        const rejected = nextEvent(appSock, "message:rejected", 3000, (r) => r?.reason === "e2ee");
        const forged = await own.encrypt(conv, "pretending to be Alice's browser");
        appSock.emit("sendMessage", { user: { _id: String(alice.user._id) }, conversationId: conv, content: "", type: "text", e2ee: forged });
        expect(await rejected).not.toBeNull();
        expect(await runAsSystem(() => Message.countDocuments({ conversationId: conv }), "test")).toBe(0);
    });

    it("without e2ee:device an app can't register a device and never receives ciphertext", async () => {
        const [alice, bob] = (await Promise.all([makeUser(), makeUser()])).map((user) => ({ user }));
        const conv = String((await api(alice).post("/conversations").send({ receiverId: String(bob.user._id) })).body.conversationId);
        const { token } = await app(alice, ["realtime:connect", "messages:read"]);
        expect((await http().post("/v1/e2ee/devices").set(bearer(token)).set("x-spreewe-device", "NODEVICE01").send({})).status).toBe(403);
        const bobDev = await new Device(String(bob.user._id), { session: bob }).start();
        await runAsSystem(() => Message.create({ conversationId: conv, userId: bob.user._id, content: "", type: "text", e2ee: { ...(undefined as any), algorithm: "m.megolm.v1.aes-sha2", ciphertext: "QUJD", session_id: "c2Vzc2lvbg", sender_key: "c2VuZGVya2V5", device_id: bobDev.deviceId } } as any), "test");
        const history = await http().get(`/v1/conversations/${conv}/messages`).set(bearer(token));
        expect(JSON.stringify(history.body)).not.toContain("ciphertext");
        const legacy = await http().get(`/messages/${conv}`).set(bearer(token));
        expect(JSON.stringify(legacy.body)).not.toContain("ciphertext");
    });

    it("withdrawing the grant, removing e2ee:device, or deleting the app revokes the app's devices", async () => {
        const alice: Session = { user: await makeUser() };
        const deviceOf = async (token: string) => (await new Device(String(alice.user._id), { token }).start()).deviceId;
        const revoked = async (deviceId: string) => !!(await runAsSystem(() => E2eeDevice.findOne({ deviceId }).lean(), "test"))?.revokedAt;

        // 1) The user withdraws the grant
        const a = await app(alice, ALL);
        const d1 = await deviceOf(a.token);
        const grant = (await api(alice).get("/v1/me/app-grants")).body.data.find((g: any) => String(g.appId ?? g.app?._id) === a.app._id);
        expect(grant, "grant listed").toBeTruthy();
        expect((await api(alice).delete(`/v1/me/app-grants/${grant._id ?? grant.grantId}`)).status).toBe(200);
        expect(await revoked(d1)).toBe(true);

        // 2) The developer removes e2ee:device from the app
        const b = await app(alice, ALL);
        const d2 = await deviceOf(b.token);
        expect((await api(b.owner).patch(`/v1/apps/${b.app._id}`).send({ scopes: ALL.filter((s) => s !== "e2ee:device") })).status).toBe(200);
        expect(await revoked(d2)).toBe(true);

        // 3) The app is deleted
        const c = await app(alice, ALL);
        const d3 = await deviceOf(c.token);
        expect((await api(c.owner).post(`/v1/apps/${c.app._id}/revoke`).send({ confirm: c.app.name })).status).toBe(201);
        expect(await revoked(d3)).toBe(true);
    });
});
