import mongoose, { Schema, Document } from "mongoose";

export interface IMessage extends Document {
    userId: mongoose.Schema.Types.ObjectId;
    content: string;
    fileUrl: string;
    thumbnailUrl: string;
    type: "text" | "image" | "video" | "audio" | "pdf" | "call";
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
    content: {
        type: String,
        required: true
    },
    fileUrl: {
        type: String, 
    },
    thumbnailUrl: {
        type: String,
    },
    type: {
        type: String,
        enum: ["text", "image", "video", "audio", "pdf", "call"],
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

const Message = mongoose.model<IMessage>("Message", MessageSchema);
export default Message;
