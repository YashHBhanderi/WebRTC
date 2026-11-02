import mongoose, { Schema, Types } from "mongoose";

/**
 * End-to-end encryption: PUBLIC key material and opaque ciphertext only. Nothing in these collections
 * can decrypt a message: private keys never leave the user's device (see
 * docs/security/end-to-end-encryption.md). Not tenant-scoped: a person has one set of devices across
 * workspaces; which conversations they can read is still decided by conversation membership.
 */

/** A registered device of a user, with its public identity keys (as published by the client). */
export interface IE2eeDevice {
    _id: Types.ObjectId;
    userId: Types.ObjectId;
    deviceId: string;
    /** Signed device keys: algorithms, curve25519 / ed25519 public keys, signatures */
    keys: Record<string, unknown> | null;
    /** ed25519 identity key, fixed for the lifetime of the device id (a new identity needs a new device) */
    ed25519: string | null;
    displayName: string;
    revokedAt: Date | null;
    lastSeenAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const DeviceSchema = new Schema<IE2eeDevice>({
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    deviceId: { type: String, required: true, maxlength: 64 },
    keys: { type: Schema.Types.Mixed, default: null },
    ed25519: { type: String, default: null, maxlength: 128 },
    displayName: { type: String, default: "", maxlength: 100 },
    revokedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: "e2ee_devices" });
DeviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });
DeviceSchema.index({ userId: 1, updatedAt: -1 });

/** One-time (consumed on claim) and fallback (reused until replaced) public prekeys. */
export interface IE2eeOneTimeKey {
    userId: Types.ObjectId;
    deviceId: string;
    keyId: string;
    key: unknown;
    fallback: boolean;
    createdAt: Date;
}

const OneTimeKeySchema = new Schema<IE2eeOneTimeKey>({
    userId: { type: Schema.Types.ObjectId, required: true },
    deviceId: { type: String, required: true, maxlength: 64 },
    keyId: { type: String, required: true, maxlength: 128 },
    key: { type: Schema.Types.Mixed, required: true },
    fallback: { type: Boolean, default: false },
}, { timestamps: { createdAt: true, updatedAt: false }, collection: "e2ee_one_time_keys" });
OneTimeKeySchema.index({ userId: 1, deviceId: 1, keyId: 1 }, { unique: true });
OneTimeKeySchema.index({ userId: 1, deviceId: 1, fallback: 1, createdAt: 1 });

/** Device-to-device message waiting for its recipient device (always Olm ciphertext or verification protocol data). */
export interface IE2eeToDevice {
    _id: Types.ObjectId;
    recipientUserId: Types.ObjectId;
    recipientDeviceId: string;
    senderUserId: Types.ObjectId;
    senderDeviceId: string;
    txnId: string;
    type: string;
    content: Record<string, unknown>;
    createdAt: Date;
}

/** Undelivered device messages expire (a device offline this long re-establishes its sessions). */
export const TO_DEVICE_TTL_SECONDS = 30 * 24 * 3600;

const ToDeviceSchema = new Schema<IE2eeToDevice>({
    recipientUserId: { type: Schema.Types.ObjectId, required: true },
    recipientDeviceId: { type: String, required: true, maxlength: 64 },
    senderUserId: { type: Schema.Types.ObjectId, required: true },
    senderDeviceId: { type: String, required: true, maxlength: 64 },
    txnId: { type: String, required: true, maxlength: 128 },
    type: { type: String, required: true, maxlength: 128 },
    content: { type: Schema.Types.Mixed, required: true },
}, { timestamps: { createdAt: true, updatedAt: false }, collection: "e2ee_to_device" });
ToDeviceSchema.index({ recipientUserId: 1, recipientDeviceId: 1, _id: 1 });
ToDeviceSchema.index({ createdAt: 1 }, { expireAfterSeconds: TO_DEVICE_TTL_SECONDS });
// A retried send (same transaction) is stored once per recipient device
ToDeviceSchema.index({ senderUserId: 1, senderDeviceId: 1, txnId: 1, recipientUserId: 1, recipientDeviceId: 1 }, { unique: true });

export const E2eeDevice = mongoose.model<IE2eeDevice>("E2eeDevice", DeviceSchema);
export const E2eeOneTimeKey = mongoose.model<IE2eeOneTimeKey>("E2eeOneTimeKey", OneTimeKeySchema);
export const E2eeToDevice = mongoose.model<IE2eeToDevice>("E2eeToDevice", ToDeviceSchema);
