import mongoose, { Schema } from "mongoose";

/**
 * Deduplication ledger for Clerk (Svix) webhook deliveries, keyed by the signed `svix-id`.
 * Only metadata is stored — never the payload (it contains personal data).
 */
export interface IClerkWebhookEvent {
    _id: string;
    type: string;
    status: "processing" | "done" | "failed";
    attempts: number;
    /** Event time (ms) used for ordering */
    eventAt: number;
    startedAt: Date;
    processedAt?: Date | null;
    /** Short outcome ("applied", "stale", "skipped:user-not-provisioned", error class name) */
    outcome?: string;
}

const ClerkWebhookEventSchema = new Schema<IClerkWebhookEvent>({
    _id: { type: String, required: true },
    type: { type: String, required: true, maxlength: 100 },
    status: { type: String, enum: ["processing", "done", "failed"], required: true },
    attempts: { type: Number, default: 1 },
    eventAt: { type: Number, required: true },
    startedAt: { type: Date, required: true },
    processedAt: { type: Date, default: null },
    outcome: { type: String, default: "", maxlength: 120 },
}, { versionKey: false });

// Ledger rows are only needed while Svix may still retry (days); keep 30 days
ClerkWebhookEventSchema.index({ startedAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

const ClerkWebhookEvent = mongoose.model<IClerkWebhookEvent>("ClerkWebhookEvent", ClerkWebhookEventSchema, "clerk_webhook_events");
export default ClerkWebhookEvent;
