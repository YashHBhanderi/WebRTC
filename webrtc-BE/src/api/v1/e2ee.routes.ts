import { defineRoute } from "./registry";
import { S } from "./schema";
import * as e2ee from "../../e2ee/e2ee.service";

/**
 * End-to-end encryption: device registration, public key directory and device-message relay.
 * First-party sessions only; the caller's device is named by the X-SpreeWe-Device header. Bodies follow
 * the Olm/Megolm client library's request formats; the server only ever handles PUBLIC keys and
 * ciphertext. See docs/security/end-to-end-encryption.md.
 */
const base = { tag: "Encryption", auth: "firstParty" as const };
const device = (h: Record<string, unknown>) => h["x-spreewe-device"];
const obj = { type: "object", additionalProperties: true };

defineRoute({
    ...base, method: "post", path: "/e2ee/devices", sensitive: true, errors: [400, 403],
    summary: "Register (or touch) this browser's encryption device",
    body: S.object({ displayName: S.string({ optional: true, max: 100 }) }),
    response: S.doc({ type: "object", properties: { deviceId: { type: "string" }, userId: { type: "string" } } }),
    handler: ({ ctx, headers, body }) => e2ee.registerDevice(ctx, device(headers), body.displayName),
});

defineRoute({
    ...base, method: "get", path: "/e2ee/devices",
    summary: "My encryption devices (public identity key fingerprints; revoked ones marked)",
    response: S.doc({ type: "array", items: { type: "object", properties: { deviceId: { type: "string" }, displayName: { type: "string" }, ed25519: { type: "string", nullable: true }, revoked: { type: "boolean" } } } }),
    handler: ({ ctx }) => e2ee.myDevices(ctx),
});

defineRoute({
    ...base, method: "post", path: "/e2ee/devices/:deviceId/revoke", sensitive: true, errors: [404],
    summary: "Remove one of my devices: it stops receiving keys and device messages; contacts are told",
    params: S.object({ deviceId: S.string({ max: 64 }) }),
    response: S.doc({ type: "object", properties: { revoked: { type: "boolean" } } }),
    handler: ({ ctx, params }) => e2ee.revokeDevice(ctx, params.deviceId),
});

defineRoute({
    ...base, method: "post", path: "/e2ee/keys/upload", errors: [400, 403, 404],
    summary: "Publish this device's signed identity keys and one-time / fallback prekeys (public keys only)",
    body: S.json({ maxBytes: 128 * 1024 }),
    response: S.doc(obj),
    handler: ({ ctx, headers, body }) => e2ee.uploadKeys(ctx, device(headers), body),
});

defineRoute({
    ...base, method: "post", path: "/e2ee/keys/query",
    summary: "Device keys of people I share a conversation with (others are listed as failures)",
    body: S.json({ maxBytes: 64 * 1024 }),
    response: S.doc(obj),
    handler: ({ ctx, body }) => e2ee.queryKeys(ctx, body),
});

defineRoute({
    ...base, method: "post", path: "/e2ee/keys/claim", sensitive: true,
    summary: "Claim one one-time prekey per device (consumed) to start an encrypted session",
    body: S.json({ maxBytes: 64 * 1024 }),
    response: S.doc(obj),
    handler: ({ ctx, body }) => e2ee.claimKeys(ctx, body),
});

defineRoute({
    ...base, method: "post", path: "/e2ee/sendToDevice/:eventType/:txnId", errors: [400, 403],
    summary: "Send device messages (Olm ciphertext / verification) to people I share a conversation with",
    params: S.object({ eventType: S.string({ max: 128 }), txnId: S.string({ max: 128 }) }),
    body: S.json({ maxBytes: 2 * 1024 * 1024 }),
    response: S.doc(obj),
    handler: ({ ctx, headers, params, body }) => e2ee.sendToDevice(ctx, device(headers), params.eventType, params.txnId, body),
});

defineRoute({
    ...base, method: "get", path: "/e2ee/sync",
    summary: "Pending device messages for this device (acknowledge with ack), key counts and contacts' device-list changes",
    query: S.object({ ack: S.string({ optional: true, max: 64 }), since: S.int({ optional: true, min: 0 }), limit: S.int({ optional: true, min: 1, max: 500 }) }),
    response: S.doc(obj),
    handler: ({ ctx, headers, query }) => e2ee.syncDevice(ctx, device(headers), query),
});

defineRoute({
    ...base, method: "get", path: "/e2ee/rooms/:conversationId/members",
    summary: "Members of a conversation I belong to, as encryption identities (who its room key is shared with)",
    params: S.object({ conversationId: S.objectId() }),
    response: S.doc({ type: "object", properties: { roomId: { type: "string" }, members: { type: "array", items: { type: "string" } } } }),
    handler: ({ ctx, params }) => e2ee.roomMembers(ctx, params.conversationId),
});
