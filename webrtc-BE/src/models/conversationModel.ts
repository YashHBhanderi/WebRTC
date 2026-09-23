import mongoose, { Schema, Document } from "mongoose";

interface IConversation extends Document {
    members: mongoose.Schema.Types.ObjectId[];
    messages: mongoose.Schema.Types.ObjectId[];
    isGroup: boolean;
    groupName?: string;
    groupAdmin?: mongoose.Schema.Types.ObjectId;
    groupAvatar?: string;
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
    groupAvatar: {
        type: String,
    },
    groupDescription: {
        type: String,
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
});

const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);
export default Conversation;