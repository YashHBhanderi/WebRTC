import mongoose, { Schema, Document } from "mongoose";

/**
 * Per-user view of a conversation: archive and "clear chat" only affect the user who did them.
 * Absent document = defaults (not archived, nothing cleared), so no backfill is needed.
 */
export interface IConversationUserState extends Document {
    userId: mongoose.Types.ObjectId;
    conversationId: mongoose.Types.ObjectId;
    isArchived: boolean;
    archivedAt?: Date | null;
    /** Messages created at or before this instant are hidden for this user. */
    clearedAt?: Date | null;
}

const ConversationUserStateSchema = new Schema<IConversationUserState>(
    {
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        conversationId: { type: Schema.Types.ObjectId, ref: "Conversation", required: true },
        isArchived: { type: Boolean, default: false },
        archivedAt: { type: Date, default: null },
        clearedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

// One state per (user, chat); the userId prefix also serves "all my chat states" in list queries
ConversationUserStateSchema.index({ userId: 1, conversationId: 1 }, { unique: true });

const ConversationUserState = mongoose.model<IConversationUserState>(
    "ConversationUserState",
    ConversationUserStateSchema,
    "conversation_user_states"
);
export default ConversationUserState;
