import mongoose, { Schema, Document } from "mongoose";
import { IStoredFile, StoredFileSchema } from "./storedFile.schema";
import { tenantScopePlugin } from "../tenancy/scope";

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
    /**
     * Team channel (organization workspaces only; set by src/organizations/channel.service.ts, never from
     * input). members = everyone allowed to read it: all team members for standard channels, the
     * explicit list for private ones; shared channels are external conversations (scope "external").
     */
    teamId?: mongoose.Types.ObjectId | null;
    channelType?: "standard" | "private" | "shared" | null;
    /** Deleted channel: kept for history, nobody is a member any more */
    channelArchivedAt?: Date | null;
    /** Owning workspace (null = global). Set by the server from the creating context; never from input. */
    tenantId?: mongoose.Types.ObjectId | null;
    /** global | tenant (internal to tenantId) | external (tenantId + listed outside guests) */
    scope?: "global" | "tenant" | "external";
    /** Outside guests of an external conversation */
    externalParticipants?: mongoose.Types.ObjectId[];
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
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: "Team", default: null },
    channelType: { type: String, enum: ["standard", "private", "shared", null], default: null },
    channelArchivedAt: { type: Date, default: null },
});

// Chat lists ("my chats / my groups") and 1:1 lookup by member pair
ConversationSchema.index({ members: 1, isGroup: 1 });
// A team's channels
ConversationSchema.index({ teamId: 1 }, { partialFilterExpression: { teamId: { $type: "objectId" } } });

ConversationSchema.set("toJSON", {
    transform: (_doc: unknown, ret: Record<string, unknown>) => {
        delete ret.groupAvatarFile;
        return ret;
    },
});

ConversationSchema.plugin(tenantScopePlugin, { kind: "conversation" });
// Chat lists within a workspace
ConversationSchema.index({ tenantId: 1, members: 1, isGroup: 1 });

const Conversation = mongoose.model<IConversation>('Conversation', ConversationSchema);
export default Conversation;