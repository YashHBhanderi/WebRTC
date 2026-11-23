import mongoose, { Schema } from "mongoose";

/** Platform-level records (authorized explicitly in webhooks/service.ts, like the developer models). */
export interface IWebhookSecret {
    id: string;
    /** AES-256-GCM encrypted (webhooks/crypto.ts) */
    enc: string;
    hint: string;
    createdAt: Date;
    /** Old secrets stay valid until this time after a rotation; null = current */
    expiresAt: Date | null;
}

export interface IWebhookEndpoint {
    _id: mongoose.Types.ObjectId;
    appId: mongoose.Types.ObjectId;
    url: string;
    description: string;
    events: string[];
    /** pending_verification → active (challenge answered) → disabled (owner / too many failures); deleted */
    status: "pending_verification" | "active" | "disabled" | "deleted";
    secrets: IWebhookSecret[];
    consecutiveFailures: number;
    disabledReason: string | null;
    disabledAt: Date | null;
    verifiedAt: Date | null;
    createdBy: mongoose.Types.ObjectId;
    createdAt: Date;
    updatedAt: Date;
}

const EndpointSchema = new Schema<IWebhookEndpoint>({
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", required: true },
    url: { type: String, required: true, maxlength: 500 },
    description: { type: String, default: "", maxlength: 200 },
    events: { type: [String], default: [] },
    status: { type: String, enum: ["pending_verification", "active", "disabled", "deleted"], default: "pending_verification" },
    secrets: {
        type: [{ _id: false, id: String, enc: String, hint: String, createdAt: Date, expiresAt: { type: Date, default: null } }],
        default: [],
    },
    consecutiveFailures: { type: Number, default: 0 },
    disabledReason: { type: String, default: null },
    disabledAt: { type: Date, default: null },
    verifiedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
}, { timestamps: true });
EndpointSchema.index({ appId: 1, status: 1 });
EndpointSchema.index({ status: 1, events: 1 });

export const WebhookEndpoint = mongoose.model<IWebhookEndpoint>("WebhookEndpoint", EndpointSchema, "webhook_endpoints");

export type DeliveryStatus = "pending" | "delivering" | "retrying" | "succeeded" | "dead" | "cancelled";

export interface IWebhookDelivery {
    _id: mongoose.Types.ObjectId;
    endpointId: mongoose.Types.ObjectId;
    appId: mongoose.Types.ObjectId;
    /** One event fans out to many endpoints; (endpointId, eventId) is unique → idempotent enqueue */
    eventId: string;
    eventType: string;
    /** JSON body; removed once the delivery is final (privacy) */
    payload: string | null;
    status: DeliveryStatus;
    attempts: number;
    nextAttemptAt: Date;
    lockedUntil: Date | null;
    lastStatusCode: number | null;
    /** Safe category only (timeout, http_500, blocked_destination…) — never response bodies */
    lastError: string | null;
    deliveredAt: Date | null;
    /** Records are deleted 7 days after creation */
    expireAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const DeliverySchema = new Schema<IWebhookDelivery>({
    endpointId: { type: Schema.Types.ObjectId, ref: "WebhookEndpoint", required: true },
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    payload: { type: String, default: null },
    status: { type: String, enum: ["pending", "delivering", "retrying", "succeeded", "dead", "cancelled"], default: "pending" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lockedUntil: { type: Date, default: null },
    lastStatusCode: { type: Number, default: null },
    lastError: { type: String, default: null },
    deliveredAt: { type: Date, default: null },
    expireAt: { type: Date, required: true },
}, { timestamps: true });
DeliverySchema.index({ endpointId: 1, eventId: 1 }, { unique: true });
DeliverySchema.index({ status: 1, nextAttemptAt: 1 });
DeliverySchema.index({ appId: 1, status: 1 });
DeliverySchema.index({ endpointId: 1, createdAt: -1 });
DeliverySchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const WebhookDelivery = mongoose.model<IWebhookDelivery>("WebhookDelivery", DeliverySchema, "webhook_deliveries");
