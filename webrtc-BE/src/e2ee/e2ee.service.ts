import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import { RequestContext, runAsSystem } from "../tenancy/context";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";
import { notifyUserEverywhere } from "../realtime/io";
import { E2eeDevice, E2eeOneTimeKey, E2eeToDevice, IE2eeDevice } from "./models";

/**
 * Key directory and device-message relay for end-to-end encryption (protocol: Olm/Megolm via
 * @matrix-org/matrix-sdk-crypto-wasm on the clients). The server stores and relays PUBLIC keys and
 * opaque ciphertext; it can't decrypt anything and never receives private keys.
 *
 * Identifiers follow the library's format: user "@<SpreeWe user id>:spreewe.local", room
 * "!<conversation id>:spreewe.local". Every operation is bound to the caller (from the verified
 * session) and to one of THEIR registered, non-revoked devices; key lookups and device messages are
 * limited to people the caller shares a conversation with, so the directory can't be browsed.
 */
export const E2EE_SERVER_NAME = "spreewe.local";
const DEVICE_ID = /^[A-Za-z0-9_-]{4,64}$/;
const KEY_ID = /^[A-Za-z0-9_:+/=-]{1,128}$/;
const MAX_ONE_TIME_KEYS_PER_UPLOAD = 100;
const MAX_TO_DEVICE_CONTENT_BYTES = 64 * 1024;
const MAX_TO_DEVICE_RECIPIENTS = 1000;
/** Device-message types a client may send: Olm ciphertext, and the key-verification protocol. */
const ALLOWED_TO_DEVICE = /^(m\.room\.encrypted|m\.room_key_request|m\.key\.verification\.[a-z_.]+|m\.secret\.request|m\.dummy)$/;

const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id));
export const matrixUserId = (userId: unknown) => `@${String(userId)}:${E2EE_SERVER_NAME}`;
export const matrixRoomId = (conversationId: unknown) => `!${String(conversationId)}:${E2EE_SERVER_NAME}`;

/** "@<24 hex>:spreewe.local" → user id, or null (anything else is refused). */
export function userIdFromMatrix(id: unknown): string | null {
    const m = /^@([a-f0-9]{24}):spreewe\.local$/.exec(String(id || ""));
    return m ? m[1] : null;
}

export function requireDeviceId(raw: unknown): string {
    const id = String(raw || "");
    if (!DEVICE_ID.test(id)) throw new AppError("A valid encryption device id is required (X-SpreeWe-Device)", 400);
    return id;
}

function caller(ctx: RequestContext): string {
    if (ctx.app) throw new ForbiddenError("Apps can't take part in end-to-end encryption");
    return String(ctx.userId);
}

/** People the caller may exchange keys / device messages with: themself, or anyone they share a conversation with. */
async function peersAllowed(me: string, others: string[]): Promise<Set<string>> {
    const ok = new Set<string>(others.filter((o) => o === me));
    const rest = [...new Set(others.filter((o) => o !== me))];
    if (!rest.length) return ok;
    const rows = await runAsSystem(() => Conversation.find({ members: oid(me), $or: [{ channelArchivedAt: null }, { channelArchivedAt: { $exists: false } }] })
        .select("members").lean(), "e2ee-peers");
    const shared = new Set(rows.flatMap((c: any) => (c.members || []).map(String)));
    for (const o of rest) if (shared.has(o)) ok.add(o);
    return ok;
}

/** The caller's device, which must be registered and not revoked. */
async function activeDevice(userId: string, deviceId: string): Promise<IE2eeDevice> {
    const d = await runAsSystem(() => E2eeDevice.findOne({ userId: oid(userId), deviceId }).lean<IE2eeDevice>(), "e2ee-device");
    if (!d) throw new NotFoundError("This encryption device isn't registered");
    if (d.revokedAt) throw new ForbiddenError("This encryption device was removed from your account. Set it up again to send or read encrypted messages.");
    return d;
}

async function keyCounts(userId: string, deviceId: string) {
    const [otk, fallback] = await Promise.all([
        runAsSystem(() => E2eeOneTimeKey.countDocuments({ userId: oid(userId), deviceId, fallback: false }), "e2ee-keys"),
        runAsSystem(() => E2eeOneTimeKey.find({ userId: oid(userId), deviceId, fallback: true }).select("keyId").lean(), "e2ee-keys"),
    ]);
    return { one_time_key_counts: { signed_curve25519: otk }, unused_fallback_keys: fallback.map((k) => String(k.keyId).split(":")[0]) };
}

// ------------------------------------------------------------------ devices

/** Register (or touch) this device. A device id is bound to one identity key for its whole life. */
export async function registerDevice(ctx: RequestContext, deviceIdRaw: unknown, displayName?: unknown) {
    const me = caller(ctx);
    const deviceId = requireDeviceId(deviceIdRaw);
    const existing = await runAsSystem(() => E2eeDevice.findOne({ userId: oid(me), deviceId }).lean<IE2eeDevice>(), "e2ee-device");
    if (existing?.revokedAt) throw new ForbiddenError("This encryption device was removed from your account. Set it up again to get a new device.");
    await runAsSystem(() => E2eeDevice.updateOne(
        { userId: oid(me), deviceId },
        { $set: { lastSeenAt: new Date(), ...(typeof displayName === "string" ? { displayName: displayName.slice(0, 100) } : {}) }, $setOnInsert: { keys: null, ed25519: null, revokedAt: null } },
        { upsert: true },
    ), "e2ee-device");
    return { deviceId, userId: matrixUserId(me) };
}

export async function myDevices(ctx: RequestContext) {
    const me = caller(ctx);
    const rows = await runAsSystem(() => E2eeDevice.find({ userId: oid(me) }).sort({ createdAt: 1 }).lean<IE2eeDevice[]>(), "e2ee-device");
    return rows.map((d) => ({ deviceId: d.deviceId, displayName: d.displayName, ed25519: d.ed25519, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt, revoked: !!d.revokedAt }));
}

/**
 * Remove one of my devices (lost / signed out): it can no longer fetch device messages or publish
 * keys, its prekeys and pending messages are deleted, and contacts re-check my device list so new
 * room keys are no longer shared with it.
 */
export async function revokeDevice(ctx: RequestContext, deviceIdRaw: unknown) {
    const me = caller(ctx);
    const deviceId = requireDeviceId(deviceIdRaw);
    const res = await runAsSystem(() => E2eeDevice.updateOne({ userId: oid(me), deviceId, revokedAt: null }, { $set: { revokedAt: new Date() } }), "e2ee-device");
    if (!res.modifiedCount) throw new NotFoundError("Device not found (or already removed)");
    await Promise.all([
        runAsSystem(() => E2eeOneTimeKey.deleteMany({ userId: oid(me), deviceId }), "e2ee-device"),
        runAsSystem(() => E2eeToDevice.deleteMany({ recipientUserId: oid(me), recipientDeviceId: deviceId }), "e2ee-device"),
    ]);
    await announceDeviceChange(me);
    return { revoked: true };
}

/** My device list changed: everyone I share a conversation with re-queries my keys. */
async function announceDeviceChange(me: string): Promise<void> {
    const rows = await runAsSystem(() => Conversation.find({ members: oid(me) }).select("members").limit(5000).lean(), "e2ee-peers");
    const peers = new Set(rows.flatMap((c: any) => (c.members || []).map(String)));
    peers.add(me);
    for (const p of peers) notifyUserEverywhere(p, "e2ee:devices-changed", { users: [matrixUserId(me)] });
}

// ------------------------------------------------------------------ keys

function assertKeyObject(value: unknown, what: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError(`${what} must be an object`);
    return value as Record<string, unknown>;
}

/** POST keys/upload: my device's signed identity keys and new one-time / fallback prekeys. */
export async function uploadKeys(ctx: RequestContext, deviceIdRaw: unknown, body: Record<string, unknown>) {
    const me = caller(ctx);
    const deviceId = requireDeviceId(deviceIdRaw);
    const device = await activeDevice(me, deviceId);
    if (body.device_keys !== undefined) {
        const dk = assertKeyObject(body.device_keys, "device_keys");
        if (dk.user_id !== matrixUserId(me) || dk.device_id !== deviceId) throw new ForbiddenError("Device keys must be for your own account and this device");
        const keys = assertKeyObject(dk.keys, "device_keys.keys");
        assertKeyObject(dk.signatures, "device_keys.signatures");
        const ed25519 = String(keys[`ed25519:${deviceId}`] || "");
        if (!ed25519 || !keys[`curve25519:${deviceId}`]) throw new AppError("Device keys must include curve25519 and ed25519 keys");
        // A device's identity never changes silently: a new identity needs a new device (contacts are warned)
        if (device.ed25519 && device.ed25519 !== ed25519) throw new ForbiddenError("This device already has a different identity key. Register a new device instead.");
        await runAsSystem(() => E2eeDevice.updateOne({ _id: device._id }, { $set: { keys: dk, ed25519, lastSeenAt: new Date() } }), "e2ee-keys");
        if (!device.ed25519) await announceDeviceChange(me);
    }
    for (const [field, fallback] of [["one_time_keys", false], ["fallback_keys", true]] as const) {
        if (body[field] === undefined) continue;
        const entries = Object.entries(assertKeyObject(body[field], field));
        if (entries.length > MAX_ONE_TIME_KEYS_PER_UPLOAD) throw new AppError(`At most ${MAX_ONE_TIME_KEYS_PER_UPLOAD} keys per upload`);
        if (fallback && entries.length) await runAsSystem(() => E2eeOneTimeKey.deleteMany({ userId: oid(me), deviceId, fallback: true }), "e2ee-keys");
        for (const [keyId, key] of entries) {
            if (!KEY_ID.test(keyId)) throw new AppError("Invalid key id");
            await runAsSystem(() => E2eeOneTimeKey.updateOne({ userId: oid(me), deviceId, keyId }, { $setOnInsert: { key, fallback } }, { upsert: true }), "e2ee-keys");
        }
    }
    return keyCounts(me, deviceId);
}

/** POST keys/query: device keys of people I share a conversation with (others come back empty). */
export async function queryKeys(ctx: RequestContext, body: Record<string, unknown>) {
    const me = caller(ctx);
    const requested = Object.keys(assertKeyObject(body.device_keys, "device_keys")).slice(0, 1000);
    const ids = requested.map((m) => [m, userIdFromMatrix(m)] as const);
    const allowed = await peersAllowed(me, ids.map(([, id]) => id).filter((x): x is string => !!x));
    const devices = await runAsSystem(() => E2eeDevice.find({ userId: { $in: [...allowed].map(oid) }, revokedAt: null, keys: { $ne: null } }).lean<IE2eeDevice[]>(), "e2ee-keys");
    const out: Record<string, Record<string, unknown>> = {};
    const failures: Record<string, unknown> = {};
    for (const [m, id] of ids) {
        if (!id || !allowed.has(id)) {
            failures[m] = { status: 403 };
            continue;
        }
        out[m] = {};
        for (const d of devices.filter((x) => String(x.userId) === id)) out[m][d.deviceId] = d.keys;
    }
    return { device_keys: out, failures, master_keys: {}, self_signing_keys: {}, user_signing_keys: {} };
}

/** POST keys/claim: one one-time prekey per requested device (consumed), or its fallback key. */
export async function claimKeys(ctx: RequestContext, body: Record<string, unknown>) {
    const me = caller(ctx);
    const request = assertKeyObject(body.one_time_keys, "one_time_keys");
    const ids = Object.keys(request).slice(0, 1000).map((m) => [m, userIdFromMatrix(m)] as const);
    const allowed = await peersAllowed(me, ids.map(([, id]) => id).filter((x): x is string => !!x));
    const out: Record<string, Record<string, Record<string, unknown>>> = {};
    const failures: Record<string, unknown> = {};
    for (const [m, id] of ids) {
        if (!id || !allowed.has(id)) {
            failures[m] = { status: 403 };
            continue;
        }
        for (const deviceId of Object.keys(assertKeyObject(request[m], "one_time_keys entry")).slice(0, 100)) {
            const live = await runAsSystem(() => E2eeDevice.exists({ userId: oid(id), deviceId, revokedAt: null }), "e2ee-keys");
            if (!live) continue;
            // Atomic: a one-time key is handed out exactly once; the fallback key is reused until replaced
            const key = await runAsSystem(() => E2eeOneTimeKey.findOneAndDelete({ userId: oid(id), deviceId, fallback: false }, { sort: { createdAt: 1 } }).lean(), "e2ee-keys")
                ?? await runAsSystem(() => E2eeOneTimeKey.findOne({ userId: oid(id), deviceId, fallback: true }).lean(), "e2ee-keys");
            if (key) ((out[m] ||= {})[deviceId] ||= {})[key.keyId] = key.key;
        }
    }
    return { one_time_keys: out, failures };
}

// ------------------------------------------------------------------ device messages

/** PUT sendToDevice: queue device messages (ciphertext) for people I share a conversation with. */
export async function sendToDevice(ctx: RequestContext, deviceIdRaw: unknown, eventType: unknown, txnIdRaw: unknown, body: Record<string, unknown>) {
    const me = caller(ctx);
    const deviceId = requireDeviceId(deviceIdRaw);
    await activeDevice(me, deviceId);
    const type = String(eventType || "");
    if (!ALLOWED_TO_DEVICE.test(type)) throw new AppError("This device message type isn't allowed");
    const txnId = String(txnIdRaw || "");
    if (!/^[A-Za-z0-9._~-]{1,128}$/.test(txnId)) throw new AppError("Invalid transaction id");
    const messages = assertKeyObject(body.messages, "messages");
    const users = Object.keys(messages).slice(0, MAX_TO_DEVICE_RECIPIENTS).map((m) => [m, userIdFromMatrix(m)] as const);
    const allowed = await peersAllowed(me, users.map(([, id]) => id).filter((x): x is string => !!x));
    const docs: Record<string, unknown>[] = [];
    const notify = new Set<string>();
    for (const [m, id] of users) {
        if (!id || !allowed.has(id)) throw new ForbiddenError("You can only send encryption data to people you share a conversation with");
        const perDevice = assertKeyObject(messages[m], "messages entry");
        const targets = Object.keys(perDevice);
        const devices = targets.includes("*")
            ? (await runAsSystem(() => E2eeDevice.find({ userId: oid(id), revokedAt: null }).select("deviceId").lean(), "e2ee-send")).map((d) => d.deviceId)
            : targets;
        for (const target of devices) {
            const content = perDevice[target] ?? perDevice["*"];
            if (!DEVICE_ID.test(target) || !content || typeof content !== "object") continue;
            // Olm payloads are ciphertext; never accept a plaintext room key on this channel
            if (type === "m.room.encrypted" && !(content as any).ciphertext) throw new AppError("Encrypted device messages must carry ciphertext");
            if (JSON.stringify(content).length > MAX_TO_DEVICE_CONTENT_BYTES) throw new AppError("Device message too large");
            docs.push({ recipientUserId: oid(id), recipientDeviceId: target, senderUserId: oid(me), senderDeviceId: deviceId, txnId, type, content });
            notify.add(id);
        }
    }
    if (docs.length) {
        // Retried transactions don't duplicate (unique per sender device + txn + recipient device)
        await runAsSystem(() => E2eeToDevice.insertMany(docs, { ordered: false }).catch((e: any) => {
            if (!(e?.code === 11000 || e?.writeErrors?.every((w: any) => w.code === 11000))) throw e;
        }), "e2ee-send");
    }
    for (const u of notify) notifyUserEverywhere(u, "e2ee:to-device", {});
    return {};
}

/**
 * GET sync: my device's pending device messages (oldest first), key counts, and which of my contacts'
 * device lists changed since `since` (ms). Delivered messages are deleted once acknowledged with
 * `ack` = the last id received, so delivery survives reconnects and is at-least-once.
 */
export async function syncDevice(ctx: RequestContext, deviceIdRaw: unknown, opts: { ack?: string; since?: number; limit?: number }) {
    const me = caller(ctx);
    const deviceId = requireDeviceId(deviceIdRaw);
    await activeDevice(me, deviceId);
    await runAsSystem(() => E2eeDevice.updateOne({ userId: oid(me), deviceId }, { $set: { lastSeenAt: new Date() } }), "e2ee-sync");
    if (opts.ack && mongoose.isValidObjectId(opts.ack)) {
        await runAsSystem(() => E2eeToDevice.deleteMany({ recipientUserId: oid(me), recipientDeviceId: deviceId, _id: { $lte: oid(opts.ack) } }), "e2ee-sync");
    }
    const limit = Math.min(Math.max(opts.limit || 100, 1), 500);
    const rows = await runAsSystem(() => E2eeToDevice.find({ recipientUserId: oid(me), recipientDeviceId: deviceId }).sort({ _id: 1 }).limit(limit).lean(), "e2ee-sync");
    const since = Number.isFinite(opts.since) && opts.since! > 0 ? new Date(opts.since!) : null;
    let changed: string[] = [];
    if (since) {
        const convs = await runAsSystem(() => Conversation.find({ members: oid(me) }).select("members").limit(5000).lean(), "e2ee-sync");
        const peers = [...new Set(convs.flatMap((c: any) => (c.members || []).map(String)))];
        const moved = await runAsSystem(() => E2eeDevice.find({ userId: { $in: peers.map(oid) }, updatedAt: { $gt: since } }).select("userId").lean(), "e2ee-sync");
        changed = [...new Set(moved.map((d) => matrixUserId(d.userId)))];
    }
    return {
        events: rows.map((r) => ({ id: String(r._id), sender: matrixUserId(r.senderUserId), type: r.type, content: r.content })),
        next: rows.length ? String(rows[rows.length - 1]._id) : opts.ack || null,
        device_lists: { changed, left: [] },
        now: Date.now(),
        ...(await keyCounts(me, deviceId)),
    };
}

/**
 * Members of a conversation, as encryption identities, for sharing its room key. Only for its
 * members; the server's membership is the authority (a client never decides who may read).
 */
export async function roomMembers(ctx: RequestContext, conversationId: unknown) {
    const me = caller(ctx);
    if (!mongoose.isValidObjectId(String(conversationId))) throw new NotFoundError("Conversation not found");
    // Read in the caller's workspace context: a conversation outside it is "not found"
    const conv = await Conversation.findOne({ _id: oid(conversationId), members: oid(me) }).select("members").lean();
    if (!conv) throw new NotFoundError("Conversation not found");
    return { roomId: matrixRoomId(conversationId), members: (conv.members || []).map(matrixUserId) };
}
