import type * as Sdk from "@matrix-org/matrix-sdk-crypto-wasm";
import {
    E2EE_SERVICE,
    Emitter,
    SpreeWeError,
    Store,
    isSpreeWeError,
    type Decrypted,
    type E2eeEngine,
    type E2eeStatus,
    type EncryptedPayload,
    type ReadableStore,
    type SecureContent,
    type SecureFile,
    type SpreeWeClient,
    type Unsubscribe,
} from "@spreewe/core";
import { decryptFile, encryptFile } from "./attachments.js";
import { KeyVault, newDeviceId } from "./key-vault.js";

/** Same identifiers as the SpreeWe apps and the backend (webrtc-BE/src/e2ee) */
export const E2EE_SERVER = "spreewe.local";
export const matrixUser = (id: string) => `@${id}:${E2EE_SERVER}`;
export const matrixRoom = (conversationId: string) => `!${conversationId}:${E2EE_SERVER}`;

export interface E2eeOptions {
    /**
     * Where the device's keys live:
     * - "indexeddb" (default in browsers): keys survive reloads; the same browser stays the same device.
     * - "memory": a new device on every start (tests, short-lived bots, server-side processes).
     */
    storage?: "indexeddb" | "memory";
    /** IndexedDB name prefix (default "spreewe-e2ee"). Use one per app when several apps share an origin. */
    namespace?: string;
    /**
     * URL of matrix_sdk_crypto_wasm_bg.wasm. By default the library resolves it next to its own
     * module (works with Vite, webpack 5 and Rollup asset handling). Set it when you serve the file yourself.
     */
    wasmUrl?: string | URL;
    /** Label shown in the user's device list. Ignored for developer apps (the server uses "<app name> (app)"). */
    displayName?: string;
    /** Safety-net sync interval (default 60 000 ms); `e2ee:to-device` events trigger syncs immediately */
    syncIntervalMs?: number;
    /**
     * Before each message, members' device lists are re-queried so a device added meanwhile gets the
     * room key too. Within this window (default 30 000 ms) and with unchanged members the cached lists
     * are used; device changes still arrive through e2ee:devices-changed and sync. 0 = query every time
     * (what the SpreeWe web app does). Each query is one request against the app's per-minute quota.
     */
    deviceListMaxAgeMs?: number;
    /** Override how the crypto library is loaded (e.g. a CDN build) */
    loadSdk?: () => Promise<typeof Sdk>;
}

interface Device {
    deviceId: string;
    displayName: string;
    ed25519: string | null;
    revoked: boolean;
    current: boolean;
    lastSeenAt?: string;
}

/**
 * An end-to-end encryption device for the signed-in user (Olm/Megolm, matrix-sdk-crypto-wasm), using
 * the same protocol as the SpreeWe apps:
 *
 * - Private keys are created and kept on this device; the server only receives public keys and ciphertext.
 * - Each conversation is a Megolm room. The sender's session key is shared (over Olm, per device) with
 *   the devices of the conversation's CURRENT members as listed by the server; when someone leaves,
 *   the session is replaced before the next message.
 * - No plaintext fallback: if a message can't be encrypted, encrypt() throws.
 * - Decryption checks that the sending device key belongs to the claimed sender, otherwise the message is not shown.
 *
 * For developer apps this needs the `e2ee:device` scope; the device is listed in the user's devices
 * as "<app name> (app)" and the user can revoke it. A new device can't read messages sent before it existed.
 */
export class E2eeDevice implements E2eeEngine {
    private readonly client: SpreeWeClient;
    private readonly opts: E2eeOptions;
    private readonly statusStore = new Store<E2eeStatus>("idle");
    private readonly events = new Emitter<{ keys: void }>();
    private message = "";
    private sdk: typeof Sdk | null = null;
    private machine: Sdk.OlmMachine | null = null;
    private vault: KeyVault | null = null;
    private userId = "";
    private device = "";
    private storeName = "";
    private ack: string | null = null;
    private since = 0;
    private starting: Promise<void> | null = null;
    private requestLock: Promise<void> = Promise.resolve();
    private readonly roomLocks = new Map<string, Promise<unknown>>();
    private readonly sharedWith = new Map<string, Set<string>>();
    /**
     * Sessions this device created, with the members who had NO encryption device when the key was
     * shared. Only those people may ask for the key later (their first device appeared after the
     * message was sent). A new device of someone who already had one never gets older history.
     * Kept in memory: after a reload this device answers such requests with "unavailable".
     */
    private readonly undelivered = new Map<string, { conversationId: string; users: Set<string> }>();
    /** Key requests this device sent: session id -> sender user id */
    private readonly requested = new Map<string, string>();
    /** Sessions whose sender said the key can't be shared with this device */
    private readonly unavailable = new Set<string>();
    /** When each room's members' device lists were last force-queried */
    private readonly queriedAt = new Map<string, { at: number; members: string }>();
    private readonly cache = new Map<string, Decrypted>();
    private syncTimer: ReturnType<typeof setInterval> | null = null;
    private syncing: Promise<void> | null = null;
    private syncAgain = false;
    private releaseTabLock: (() => void) | null = null;
    private readonly offs: Unsubscribe[] = [];

    constructor(client: SpreeWeClient, options: E2eeOptions = {}) {
        this.client = client;
        this.opts = options;
    }

    get status(): ReadableStore<E2eeStatus> {
        return this.statusStore;
    }

    get statusMessage(): string {
        return this.message;
    }

    get deviceId(): string {
        return this.device;
    }

    get ready(): boolean {
        return this.statusStore.value === "ready";
    }

    /** Start (idempotent). Rejects when this environment can't run the device or the app lacks e2ee:device. */
    start(): Promise<void> {
        if (this.starting) return this.starting;
        this.starting = this.boot().catch((e) => {
            const s = this.statusStore.value;
            if (s !== "unsupported" && s !== "revoked") this.statusStore.set("error");
            this.message = this.message || (e instanceof Error ? e.message : "Encryption could not start.");
            this.starting = null;
            this.releaseTabLock?.();
            this.releaseTabLock = null;
            throw e;
        });
        return this.starting;
    }

    private get persistent(): boolean {
        return (this.opts.storage ?? (typeof indexedDB !== "undefined" ? "indexeddb" : "memory")) === "indexeddb";
    }

    private async boot(): Promise<void> {
        this.statusStore.set("starting");
        this.message = "";
        if (!globalThis.crypto?.subtle || typeof WebAssembly === "undefined" || (this.persistent && typeof indexedDB === "undefined")) {
            this.statusStore.set("unsupported");
            this.message = "This environment can't keep encryption keys (IndexedDB, WebCrypto or WebAssembly is unavailable).";
            throw new SpreeWeError({ code: "E2EE_UNAVAILABLE", message: this.message });
        }
        if (!(await this.client.hasScopes("e2ee:device"))) {
            this.statusStore.set("unsupported");
            this.message = "This app wasn't given the e2ee:device permission, so it can't read or send encrypted messages.";
            throw new SpreeWeError({ code: "MISSING_SCOPE", message: this.message });
        }
        const sdk = this.opts.loadSdk ? await this.opts.loadSdk() : await import("@matrix-org/matrix-sdk-crypto-wasm");
        await sdk.initAsync(this.opts.wasmUrl);
        this.sdk = sdk;
        this.userId = await this.client.userId();
        const ns = this.opts.namespace || "spreewe-e2ee";
        this.storeName = `${ns}-${this.userId}`;
        if (this.persistent) {
            this.vault = new KeyVault(`${ns}-vault`);
            await this.lockTab();
        }
        await this.openDevice();
        this.wireRealtime();
        this.statusStore.set("ready");
        await this.sync();
        // Messages rendered while encryption was still starting showed "waiting for key": decrypt them now
        this.retryPending();
        if (!this.syncTimer) this.syncTimer = setInterval(() => void this.sync().catch(() => undefined), this.opts.syncIntervalMs ?? 60_000);
    }

    /**
     * Two tabs must not drive the same crypto store at once (their Olm state would diverge), so the
     * first tab holds a Web Lock for its lifetime. Other tabs report an error state instead.
     */
    private async lockTab(): Promise<void> {
        const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
        if (!locks) return;
        // Wait a little: on a page reload the previous page can still hold the lock for a moment
        const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(8000) : undefined;
        await new Promise<void>((resolve, reject) => {
            const busy = () => {
                this.message = "Encryption is already active for this account in another tab. Close it or use that tab.";
                reject(new SpreeWeError({ code: "E2EE_UNAVAILABLE", message: this.message }));
            };
            locks
                .request(`${this.storeName}:device`, signal ? { signal } : { ifAvailable: true }, (lock) => {
                    if (!lock) {
                        busy();
                        return undefined;
                    }
                    resolve();
                    return new Promise<void>((release) => (this.releaseTabLock = release));
                })
                .catch(busy);
        });
    }

    private async openDevice(): Promise<void> {
        const sdk = this.sdk!;
        let passphrase: string | undefined;
        if (this.vault) {
            const local = await this.vault.deviceFor(this.userId);
            this.device = local.deviceId;
            this.ack = local.ack;
            passphrase = local.passphrase;
        } else {
            this.device = newDeviceId();
            this.ack = null;
        }
        try {
            await this.api("POST", "/devices", this.opts.displayName ? { displayName: this.opts.displayName } : {});
        } catch (e) {
            if (!(isSpreeWeError(e) && e.status === 403)) throw e;
            // This device was revoked (from SpreeWe or by the user): start over as a NEW device.
            // Contacts are told about the change; messages sent before stay unreadable here.
            if (!this.vault) throw e;
            await this.vault.forget(this.userId, this.storeName);
            return this.openDevice();
        }
        this.machine?.close();
        this.machine = this.vault
            ? await sdk.OlmMachine.initialize(new sdk.UserId(matrixUser(this.userId)), new sdk.DeviceId(this.device), this.storeName, passphrase)
            : await sdk.OlmMachine.initialize(new sdk.UserId(matrixUser(this.userId)), new sdk.DeviceId(this.device));
        await this.processRequests();
    }

    private wireRealtime(): void {
        if (this.offs.length) return;
        const rt = this.client.realtime;
        this.offs.push(rt.on("e2ee:to-device", () => void this.sync().catch(() => undefined)));
        this.offs.push(
            rt.on("e2ee:devices-changed", () => {
                // Someone's devices changed: re-query before the next message in every room
                this.queriedAt.clear();
                void this.sync().catch(() => undefined);
            }),
        );
        // These events aren't replayed: catch up after every reconnect
        this.offs.push(rt.onConnect(() => void this.sync().catch(() => undefined)));
    }

    /** Stop and keep the keys (sign-out). */
    stop(): void {
        if (this.syncTimer) clearInterval(this.syncTimer);
        this.syncTimer = null;
        this.offs.splice(0).forEach((off) => off());
        this.machine?.close();
        this.machine = null;
        this.starting = null;
        this.cache.clear();
        this.sharedWith.clear();
        this.undelivered.clear();
        this.requested.clear();
        this.unavailable.clear();
        this.releaseTabLock?.();
        this.releaseTabLock = null;
        this.statusStore.set("idle");
    }

    destroy(): void {
        this.stop();
        this.events.clear();
    }

    // ------------------------------------------------------------------ server I/O

    private async api<T = any>(method: "GET" | "POST", path: string, body?: unknown, query?: Record<string, string | number | undefined>): Promise<T> {
        try {
            return await this.client.http.request<T>(method, `/v1/e2ee${path}`, {
                body: method === "POST" ? body ?? {} : undefined,
                query,
                headers: { "X-SpreeWe-Device": this.device },
            });
        } catch (e) {
            if (isSpreeWeError(e) && e.status === 403 && path !== "/devices" && this.statusStore.value === "ready") {
                // Revoked while running (user removed the device, or withdrew e2ee:device)
                this.statusStore.set("revoked");
                this.message = "This encryption device was removed. Restart to set up a new one.";
            }
            throw e;
        }
    }

    /** Send everything the library wants to send (key uploads, queries, claims, device messages), one at a time. */
    private processRequests(): Promise<void> {
        const run = async () => {
            for (let round = 0; round < 10 && this.machine; round++) {
                const requests = await this.machine.outgoingRequests();
                if (!requests.length) return;
                for (const r of requests as any[]) await this.answer(r);
            }
        };
        const next = this.requestLock.then(run, run);
        this.requestLock = next.catch(() => undefined);
        return next;
    }

    private async answer(r: any): Promise<void> {
        const sdk = this.sdk!;
        let response: unknown = {};
        switch (r.type) {
            case sdk.RequestType.KeysUpload:
                response = await this.api("POST", "/keys/upload", JSON.parse(r.body));
                break;
            case sdk.RequestType.KeysQuery:
                response = await this.api("POST", "/keys/query", JSON.parse(r.body));
                break;
            case sdk.RequestType.KeysClaim:
                response = await this.api("POST", "/keys/claim", JSON.parse(r.body));
                break;
            case sdk.RequestType.ToDevice:
                response = await this.api("POST", `/sendToDevice/${encodeURIComponent(r.event_type)}/${encodeURIComponent(r.txn_id)}`, JSON.parse(r.body));
                break;
            default:
                // Signature upload / key backup: not used by SpreeWe (no key backup)
                response = {};
        }
        await this.machine!.markRequestAsSent(r.id, r.type, JSON.stringify(response));
    }

    /** Fetch device messages (room keys) and contacts' device changes; at-least-once delivery. */
    sync(): Promise<void> {
        if (!this.machine) return Promise.resolve();
        if (this.syncing) {
            this.syncAgain = true;
            return this.syncing;
        }
        this.syncing = (async () => {
            do {
                this.syncAgain = false;
                for (let page = 0; page < 20 && this.machine; page++) {
                    const res = await this.api<any>("GET", "/sync", undefined, { ack: this.ack || undefined, since: this.since || undefined });
                    const sdk = this.sdk!;
                    const changed = (res.device_lists?.changed || []).map((u: string) => new sdk.UserId(u));
                    const processed = await this.machine!.receiveSyncChanges(
                        JSON.stringify((res.events || []).map((e: any) => ({ sender: e.sender, type: e.type, content: e.content }))),
                        new sdk.DeviceLists(changed, []),
                        new Map(Object.entries(res.one_time_key_counts || {})),
                        new Set(res.unused_fallback_keys || []),
                    );
                    await this.handleProcessed(processed as any[]);
                    this.since = res.now;
                    if (res.next && res.next !== this.ack) {
                        this.ack = res.next;
                        await this.vault?.saveAck(this.userId, this.ack);
                    }
                    await this.processRequests();
                    if ((res.events || []).length) this.retryPending();
                    if ((res.events || []).length < 100) break;
                }
            } while (this.syncAgain);
        })().finally(() => (this.syncing = null));
        return this.syncing;
    }

    // ------------------------------------------------------------------ encrypt

    async encrypt(conversationId: string, content: SecureContent): Promise<EncryptedPayload> {
        await this.requireReady();
        return this.inRoom(conversationId, async () => {
            const sdk = this.sdk!;
            const machine = this.machine!;
            // wasm-bindgen: several calls take ownership of identifier objects, so each call gets fresh ones
            const room = () => new sdk.RoomId(matrixRoom(conversationId));
            // Who may read is the server's membership list, never a client-side one
            const { members } = await this.api<{ members: string[] }>("GET", `/rooms/${encodeURIComponent(conversationId)}/members`);
            const now = new Set(members);
            const before = this.sharedWith.get(conversationId);
            if (before && [...before].some((m) => !now.has(m))) await machine.invalidateGroupSession(room());
            const users = () => members.map((m) => new sdk.UserId(m));
            await machine.updateTrackedUsers(users());
            await this.processRequests();
            // Fresh device lists before sharing, so a device added since gets this message's key too
            const key = [...now].sort().join(",");
            const last = this.queriedAt.get(conversationId);
            const maxAge = this.opts.deviceListMaxAgeMs ?? 30_000;
            if (!last || last.members !== key || Date.now() - last.at >= maxAge) {
                await this.answer(machine.queryKeysForUsers(users()));
                this.queriedAt.set(conversationId, { at: Date.now(), members: key });
            }
            const claim = await machine.getMissingSessions(users());
            if (claim) await this.answer(claim);
            // Members with no device yet can't receive this key now; remember them (see `undelivered`)
            const deviceless: string[] = [];
            for (const m of members) {
                const devs = await machine.getUserDevices(new sdk.UserId(m));
                if (!devs.devices().length) deviceless.push(m);
            }
            const shares = await machine.shareRoomKey(room(), users(), new sdk.EncryptionSettings());
            for (const s of shares) await this.answer(s);
            this.sharedWith.set(conversationId, now);
            const encrypted = JSON.parse(await machine.encryptRoomEvent(room(), "m.room.message", JSON.stringify({ msgtype: "spreewe.v1", ...content })));
            if (deviceless.length) {
                const entry = this.undelivered.get(encrypted.session_id) || { conversationId, users: new Set<string>() };
                deviceless.forEach((u) => entry.users.add(u));
                this.undelivered.set(encrypted.session_id, entry);
            }
            return {
                algorithm: "m.megolm.v1.aes-sha2",
                ciphertext: encrypted.ciphertext,
                session_id: encrypted.session_id,
                sender_key: encrypted.sender_key,
                device_id: encrypted.device_id,
            };
        });
    }

    private inRoom<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
        const prev = this.roomLocks.get(conversationId) || Promise.resolve();
        const next = prev.then(run, run);
        this.roomLocks.set(conversationId, next.catch(() => undefined));
        return next;
    }

    private async requireReady(): Promise<void> {
        if (this.starting) await this.starting.catch(() => undefined);
        if (!this.ready || !this.machine) {
            throw new SpreeWeError({ code: "E2EE_UNAVAILABLE", message: this.message || "Encryption isn't ready on this device." });
        }
    }

    // ------------------------------------------------------------------ decrypt

    async decrypt(message: { _id: string; conversationId: string; e2ee?: EncryptedPayload; userId?: string; user?: { _id?: string }; createdAt?: string }): Promise<Decrypted> {
        if (!message.e2ee) return { state: "ok" };
        const e = message.e2ee;
        const cacheKey = `${message._id}:${e.session_id}:${e.ciphertext.length}:${e.ciphertext.slice(-16)}`;
        const hit = this.cache.get(cacheKey);
        if (hit && hit.state !== "pending") return hit;
        try {
            await this.requireReady();
            const sdk = this.sdk!;
            const sender = String(message.user?._id || message.userId || "");
            const event = {
                type: "m.room.encrypted",
                event_id: `$${message._id}`,
                sender: matrixUser(sender),
                origin_server_ts: message.createdAt ? new Date(message.createdAt).getTime() : Date.now(),
                content: e,
            };
            const result: any = await this.machine!.decryptRoomEvent(
                JSON.stringify(event),
                new sdk.RoomId(matrixRoom(String(message.conversationId))),
                new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted),
            );
            const content = JSON.parse(result.event).content || {};
            // Megolm binds a session to the sending DEVICE key, not to a user id: make sure that key
            // belongs to the person the server says sent the message
            if (!(await this.deviceKeyBelongsTo(sender, result.senderCurve25519Key))) {
                const out: Decrypted = { state: "failed", warning: "This message's sender couldn't be confirmed, so it isn't shown." };
                this.cache.set(cacheKey, out);
                return out;
            }
            // SpreeWe doesn't use cross-signing, so every device is "unsigned by its owner"; that alone isn't
            // a warning. Warn only when the sender's identity changed after being verified, or the key
            // doesn't match the claimed sender.
            const shield = result.shieldState(false);
            const S = sdk.ShieldStateCode;
            const serious = shield.code === S.VerificationViolation || shield.code === S.MismatchedSender;
            const warning = serious ? shield.message || "This message's sender couldn't be confirmed." : undefined;
            const out: Decrypted = { state: "ok", content: { text: content.text, file: content.file, forwardedFrom: content.forwardedFrom }, warning };
            this.cache.set(cacheKey, out);
            return out;
        } catch (err: any) {
            const missingKey = err?.code === this.sdk?.DecryptionErrorCode.MissingRoomKey || err?.code === this.sdk?.DecryptionErrorCode.UnknownMessageIndex;
            if (missingKey && this.unavailable.has(e.session_id)) {
                const out: Decrypted = { state: "failed", warning: "This message was sent before this device was set up, so it can't be read here." };
                this.cache.set(cacheKey, out);
                return out;
            }
            const out: Decrypted = { state: missingKey || !this.ready ? "pending" : "failed" };
            this.cache.set(cacheKey, out);
            if (missingKey && this.ready) {
                const sender = String(message.user?._id || message.userId || "");
                void this.requestKey(sender, String(message.conversationId), e).catch(() => undefined);
            }
            return out;
        }
    }

    private async deviceKeyBelongsTo(userId: string, curve25519: string): Promise<boolean> {
        const sdk = this.sdk!;
        const has = async () => (await this.machine!.getUserDevices(new sdk.UserId(matrixUser(userId)))).devices().some((d) => d.curve25519Key?.toBase64() === curve25519);
        if (await has()) return true;
        await this.machine!.updateTrackedUsers([new sdk.UserId(matrixUser(userId))]);
        await this.processRequests();
        return has();
    }

    // ------------------------------------------------------------------ key re-share (first device only)

    private toDevice(type: string, messages: Record<string, Record<string, unknown>>): Promise<unknown> {
        const txn = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
        return this.api("POST", `/sendToDevice/${encodeURIComponent(type)}/${txn}`, { messages });
    }

    private async requestKey(sender: string, conversationId: string, e: EncryptedPayload): Promise<void> {
        if (!sender || sender === this.userId || this.requested.has(e.session_id)) return;
        this.requested.set(e.session_id, sender);
        await this.toDevice("m.room_key_request", {
            [matrixUser(sender)]: {
                "*": {
                    action: "request",
                    requesting_device_id: this.device,
                    request_id: `spreewe-${e.session_id}`,
                    body: { algorithm: e.algorithm, room_id: matrixRoom(conversationId), sender_key: e.sender_key, session_id: e.session_id },
                },
            },
        });
    }

    private async handleProcessed(events: any[]): Promise<void> {
        const sdk = this.sdk!;
        for (const ev of events || []) {
            try {
                const raw = JSON.parse(ev.rawEvent || "{}");
                if ((ev.type === sdk.ProcessedToDeviceEventType.PlainText || ev.type === sdk.ProcessedToDeviceEventType.Invalid) && raw.type === "m.room_key_request") {
                    await this.onKeyRequest(raw);
                } else if (ev.type === sdk.ProcessedToDeviceEventType.Decrypted && raw.type === "spreewe.room_key") {
                    await this.onForwardedKey(raw.content, ev.encryptionInfo?.senderCurve25519Key);
                }
            } catch {
                // A malformed device message must never break sync
            }
        }
    }

    /** Sender side: someone asks for a key this device created. */
    private async onKeyRequest(raw: any): Promise<void> {
        const sdk = this.sdk!;
        const machine = this.machine!;
        const c = raw.content || {};
        const requester = String(raw.sender || "");
        const requesterId = requester.replace(/^@/, "").replace(`:${E2EE_SERVER}`, "");
        if (c.action === "spreewe.unavailable") {
            if (c.session_id && this.requested.get(c.session_id) === requesterId) {
                this.unavailable.add(c.session_id);
                this.retryPending();
            }
            return;
        }
        const body = c.body || {};
        if (c.action !== "request" || !body.session_id || !c.requesting_device_id) return;
        if (body.sender_key !== machine.identityKeys.curve25519.toBase64()) return; // not my session
        const decline = () =>
            this.toDevice("m.room_key_request", { [requester]: { [c.requesting_device_id]: { action: "spreewe.unavailable", session_id: body.session_id } } });
        const entry = this.undelivered.get(body.session_id);
        if (!entry || !entry.users.has(requester) || body.room_id !== matrixRoom(entry.conversationId)) return void (await decline());
        // Still a member right now (server's list), and the device really belongs to the requester
        const { members } = await this.api<{ members: string[] }>("GET", `/rooms/${encodeURIComponent(entry.conversationId)}/members`);
        if (!members.includes(requester)) return void (await decline());
        await machine.updateTrackedUsers([new sdk.UserId(requester)]);
        await this.answer(machine.queryKeysForUsers([new sdk.UserId(requester)]));
        const device = await machine.getDevice(new sdk.UserId(requester), new sdk.DeviceId(c.requesting_device_id));
        if (!device) return;
        const claim = await machine.getMissingSessions([new sdk.UserId(requester)]);
        if (claim) await this.answer(claim);
        const exported = JSON.parse(await machine.exportRoomKeys((s) => s.sessionId === body.session_id));
        if (!exported.length) return void (await decline());
        const content = JSON.parse(await device.encryptToDeviceEvent("spreewe.room_key", { room_id: body.room_id, session_id: body.session_id, exported }));
        await this.toDevice("m.room.encrypted", { [requester]: { [c.requesting_device_id]: content } });
        // One hand-off per person: their later devices are treated like any new device
        entry.users.delete(requester);
        if (!entry.users.size) this.undelivered.delete(body.session_id);
    }

    /** Receiver side: the key we asked for, Olm-encrypted by the sender's device. */
    private async onForwardedKey(content: any, fromCurve: string | undefined): Promise<void> {
        const sessionId = content?.session_id;
        const exported = Array.isArray(content?.exported) ? content.exported : [];
        if (!sessionId || !this.requested.has(sessionId) || exported.length !== 1) return;
        const key = exported[0];
        // Only the device that created the session may hand it out
        if (key.session_id !== sessionId || !fromCurve || key.sender_key !== fromCurve || key.room_id !== content.room_id) return;
        if (!(await this.deviceKeyBelongsTo(this.requested.get(sessionId)!, fromCurve))) return;
        await this.machine!.importExportedRoomKeys(JSON.stringify([key]), () => undefined);
        this.requested.delete(sessionId);
        this.retryPending();
    }

    private retryPending(): void {
        for (const [k, v] of this.cache) if (v.state === "pending") this.cache.delete(k);
        this.events.emit("keys", undefined);
    }

    onKeysChanged(listener: () => void): Unsubscribe {
        return this.events.on("keys", listener);
    }

    // ------------------------------------------------------------------ attachments

    encryptFile(file: Blob & { name?: string }) {
        return encryptFile(file);
    }

    decryptFile(ciphertext: ArrayBuffer, info: SecureFile): Promise<Blob> {
        return decryptFile(ciphertext, info);
    }

    // ------------------------------------------------------------------ devices & verification

    /** The user's encryption devices (apps see the devices they may manage). */
    async devices(): Promise<Device[]> {
        await this.requireReady();
        const list = await this.api<Omit<Device, "current">[]>("GET", "/devices");
        return list.map((d) => ({ ...d, current: d.deviceId === this.device }));
    }

    /** Revoke a device (apps: only their own). Revoking this one forgets its keys. */
    async revokeDevice(deviceId: string): Promise<void> {
        await this.api("POST", `/devices/${encodeURIComponent(deviceId)}/revoke`);
        if (deviceId === this.device) {
            await this.vault?.forget(this.userId, this.storeName);
            this.stop();
        }
    }

    /** A contact's devices with fingerprints and whether this device verified them (compare out of band). */
    async contactDevices(userId: string): Promise<{ deviceId: string; fingerprint: string; verified: boolean }[]> {
        await this.requireReady();
        const sdk = this.sdk!;
        await this.machine!.updateTrackedUsers([new sdk.UserId(matrixUser(userId))]);
        await this.processRequests();
        const devices = await this.machine!.getUserDevices(new sdk.UserId(matrixUser(userId)));
        return devices.devices().map((d) => ({ deviceId: d.deviceId.toString(), fingerprint: fingerprint(d.ed25519Key?.toBase64() || ""), verified: d.isLocallyTrusted() }));
    }

    async setDeviceVerified(userId: string, deviceId: string, verified: boolean): Promise<void> {
        await this.requireReady();
        const sdk = this.sdk!;
        const device = await this.machine!.getDevice(new sdk.UserId(matrixUser(userId)), new sdk.DeviceId(deviceId));
        if (!device) throw new SpreeWeError({ code: "NOT_FOUND", message: "Device not found" });
        await device.setLocalTrust(verified ? sdk.LocalTrust.Verified : sdk.LocalTrust.Unset);
        this.retryPending();
    }

    /** This device's fingerprint, to read out to a contact who verifies it. */
    async ownFingerprint(): Promise<string> {
        await this.requireReady();
        return fingerprint(this.machine!.identityKeys.ed25519.toBase64());
    }
}

/** Human-comparable fingerprint: the ed25519 key in groups of 4. */
export function fingerprint(key: string): string {
    return key.replace(/[^A-Za-z0-9+/]/g, "").match(/.{1,4}/g)?.join(" ") || "";
}

/**
 * Create the client's encryption device and register it, so @spreewe/chat and @spreewe/files can
 * decrypt and send. Idempotent per client. Call `start()` (or let chat start it) after sign-in.
 */
export function enableE2ee(client: SpreeWeClient, options: E2eeOptions = {}): E2eeDevice {
    return client.service(E2EE_SERVICE, (c) => new E2eeDevice(c, options));
}
