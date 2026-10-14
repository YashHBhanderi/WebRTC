import mongoose, { Schema, Document } from "mongoose";
import { IStoredFile, StoredFileSchema } from "./storedFile.schema";

export interface IPinnedMessage {
    messageId: mongoose.Types.ObjectId;
    pinnedBy: mongoose.Types.ObjectId;
    pinnedAt: Date;
}

export interface IConversation extends Document {
    members: mongoose.Schema.Types.ObjectId[];
    /** Legacy: no longer written (messages carry conversationId). Kept so old data stays readable. */
    messages: mongoose.Schema.Types.ObjectId[];
    /** Pinned messages, newest first (capped). */
    pinnedMessages?: IPinnedMessage[];
    isGroup: boolean;
    groupName?: string;
    /** Original creator; kept for compatibility. Admin rights come from groupAdmins. */
    groupAdmin?: mongoose.Schema.Types.ObjectId;
    groupAdmins?: mongoose.Types.ObjectId[];
    /** Display URL of the group photo (stable link for stored files, or a legacy URL). */
    groupAvatar?: string;
    groupAvatarFile?: IStoredFile | null;
    groupDescription?: string;
    createdAt: Date;
}

const ConversationSchema = new Schema<IConversation>({
    members: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
            required: true,
        }
    ],
    messages: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'Message',
        }
    ],
    isGroup: {
        type: Boolean,
        default: false,
    },
    groupName: {
        type: String,
        required: function () {
            return this.isGroup;
        }
    },
    groupAdmin: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
    },
    groupAdmins: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        }
    ],
    groupAvatar: {
        type: String,
    },
    groupAvatarFile: {
        type: StoredFileSchema,
        default: undefined,
    },
    groupDescription: {
        type: String,
    },
    pinnedMessages: {
        type: [{
            _id: false,
            messageId: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', required: true },
            pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
            pinnedAt: { type: Date, default: Date.now },
        }],
        default: undefined,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

// Chat lists ("my chats / my groups") and 1:1 lookup by member pair
ConversationSchema.index({ members: 1, isGroup: 1 });

ConversationSchema.set("toJSON", {
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
        delete ret.groupAvatarFile;
        return ret;
    },
});

const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);
export default Conversation;