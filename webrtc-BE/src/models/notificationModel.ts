import mongoose, { Schema, Document } from "mongoose";

export type NotificationType = "mention" | "reply" | "reaction" | "missed-call" | "meeting-invite" | "meeting-reminder" | "recording";
export const NOTIFICATION_TYPES: NotificationType[] = ["mention", "reply", "reaction", "missed-call", "meeting-invite", "meeting-reminder", "recording"];

/**
 * Activity feed entry for one recipient. Ordinary new messages are not stored here (the chat list
 * already shows them as unread); only things addressed to the user are.
 */
export interface INotification extends Document {
    userId: mongoose.Types.ObjectId;
    type: NotificationType;
    actorId?: mongoose.Types.ObjectId | null;
    conversationId?: mongoose.Types.ObjectId | null;
    messageId?: mongoose.Types.ObjectId | null;
    callId?: mongoose.Types.ObjectId | null;
    meetingId?: mongoose.Types.ObjectId | null;
    recordingId?: mongoose.Types.ObjectId | null;
    /** Short preview (message excerpt, emoji, call type). Never the whole message. */
    text: string;
    readAt?: Date | null;
    createdAt: Date;
}

const NotificationSchema = new Schema<INotification>({
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", default: null },
    messageId: { type: Schema.Types.ObjectId, ref: "Message", default: null },
    callId: { type: Schema.Types.ObjectId, ref: "Call", default: null },
    meetingId: { type: Schema.Types.ObjectId, default: null },
    recordingId: { type: Schema.Types.ObjectId, default: null },
    text: { type: String, default: "", maxlength: 200 },
    readAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
});

// Feed pages (newest first) and the unread badge
NotificationSchema.index({ userId: 1, createdAt: -1 });
NotificationSchema.index({ userId: 1, readAt: 1 });
// Activity is kept for 90 days
NotificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const Notification = mongoose.model<INotification>("Notification", NotificationSchema);
export default Notification;
