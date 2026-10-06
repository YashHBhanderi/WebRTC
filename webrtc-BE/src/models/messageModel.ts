import mongoose, { Schema, Document } from "mongoose";
import { IStoredFile, StoredFileSchema } from "./storedFile.schema";

export interface IMessage extends Document {
    userId: mongoose.Schema.Types.ObjectId;
    /** Owning conversation (denormalised from Conversation.messages for indexed history/search). */
    conversationId?: mongoose.Types.ObjectId;
    content: string;
    /** Attachment in object storage (image/video/audio/pdf). URLs are signed per response. */
    file?: IStoredFile | null;
    /** Legacy external media URL, or the join link of a "call" message. */
    fileUrl: string;
    thumbnailUrl: string;
    type: "text" | "image" | "video" | "audio" | "pdf" | "call" | "system";
    isRead: boolean;
    isDeleted: boolean;
    replyTo?: mongoose.Schema.Types.ObjectId;
    reactions: { userId: mongoose.Schema.Types.ObjectId, emoji: string }[];
    createdAt: Date;
}

const MessageSchema = new Schema<IMessage>({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true
    },
    conversationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Conversation",
    },
    content: {
        type: String,
        required: true
    },
    file: {
        type: StoredFileSchema,
        default: undefined,
    },
    fileUrl: {
        type: String,
    },
    thumbnailUrl: {
        type: String,
    },
    type: {
        type: String,
        // system = group events ("Alice added Bob"), rendered as a centred notice
        enum: ["text", "image", "video", "audio", "pdf", "call", "system"],
        default: "text",
        required: true
    },
    isRead: {
        type: Boolean,
        default: false
    },
    isDeleted: {
        type: Boolean,
        default: false
    },
    replyTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Message",
        default: null
    },
    reactions: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        emoji: { type: String }
    }],
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// History pages, clear-chat cut-off, search and jump-to-message all filter by chat + time
MessageSchema.index({ conversationId: 1, createdAt: -1 });
// Reference count before deleting a stored object (forwarded messages share the same object)
MessageSchema.index({ "file.storageKey": 1 }, { sparse: true });

const Message = mongoose.model<IMessage>("Message", MessageSchema);
export default Message;
