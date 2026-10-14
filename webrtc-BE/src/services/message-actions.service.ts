import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import Message from "../models/messageModel";
import SavedMessage from "../models/savedMessageModel";
import { getConversationForMember } from "./authorization.service";
import { messageMedia } from "./file.service";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";
import { requireObjectId } from "../utils/validation";

export const MAX_MESSAGE_LENGTH = 4000;
const MAX_PINS = 25;
const MAX_MENTIONS = 50;

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** Message text from a client: trimmed, required, bounded. */
export function validateMessageText(value: unknown): string {
    const text = typeof value === "string" ? value.trim() : "";
    if (!text) {
        throw new AppError("Message can't be empty");
    }
    if (text.length > MAX_MESSAGE_LENGTH) {
        throw new AppError(`Messages can be up to ${MAX_MESSAGE_LENGTH} characters`);
    }
    return text;
}

/** @mentions: only real members of the chat (never the author), de-duplicated, capped. */
export function validMentions(value: unknown, memberIds: string[], authorId: string): mongoose.Types.ObjectId[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const members = new Set(memberIds.map(String));
    const ids = [...new Set(value.map(String))]
        .filter((id) => id !== String(authorId) && members.has(id) && mongoose.isValidObjectId(id))
        .slice(0, MAX_MENTIONS);
    return ids.map(oid);
}

/** A visible message that belongs to a chat the user is a member of. */
async function messageForMember(messageId: unknown, userId: string) {
    const id = requireObjectId(messageId, "messageId");
    const message = await Message.findById(id);
    if (!message || message.isDeleted || !message.conversationId) {
        throw new NotFoundError("Message not found");
    }
    const conversation = await getConversationForMember(String(message.conversationId), userId);
    return { message, conversation };
}

/** Edit, pin and save. Every rule is enforced here, not in the client. */
class MessageActionsService {
    async edit(messageId: unknown, userId: string, content: unknown, mentions: unknown) {
        const { message, conversation } = await messageForMember(messageId, userId);
        if (String(message.userId) !== userId) {
            throw new ForbiddenError("You can only edit your own messages");
        }
        if (message.type !== "text") {
            throw new AppError("Only text messages can be edited");
        }
        const text = validateMessageText(content);
        const before = new Set((message.mentions || []).map(String));
        message.content = text;
        message.editedAt = new Date();
        message.mentions = validMentions(mentions, conversation.members.map(String), userId);
        await message.save();
        return {
            message,
            conversation,
            /** Newly mentioned by this edit (they get a notification). */
            addedMentions: (message.mentions || []).map(String).filter((id) => !before.has(id)),
        };
    }

    async setPinned(messageId: unknown, userId: string, pinned: boolean) {
        const { message, conversation } = await messageForMember(messageId, userId);
        if (message.type === "system") {
            throw new AppError("This message can't be pinned");
        }
        const conversationId = String(conversation._id);
        if (pinned) {
            await Conversation.updateOne({ _id: conversation._id }, { $pull: { pinnedMessages: { messageId: message._id } } });
            await Conversation.updateOne(
                { _id: conversation._id },
                {
                    $push: {
                        pinnedMessages: {
                            $each: [{ messageId: message._id, pinnedBy: oid(userId), pinnedAt: new Date() }],
                            $position: 0,
                            $slice: MAX_PINS,
                        },
                    },
                },
            );
        } else {
            await Conversation.updateOne({ _id: conversation._id }, { $pull: { pinnedMessages: { messageId: message._id } } });
        }
        return { conversationId, members: conversation.members.map(String), pins: await this.pins(conversationId) };
    }

    /** Pinned messages with what the pinned bar needs to show (deleted ones are skipped). */
    async pins(conversationId: string) {
        const conversation = await Conversation.findById(conversationId).select("pinnedMessages").lean();
        const entries = conversation?.pinnedMessages || [];
        if (!entries.length) {
            return [];
        }
        const messages = await Message.find({ _id: { $in: entries.map((p) => p.messageId) }, isDeleted: { $ne: true } })
            .select("content type userId createdAt file")
            .populate({ path: "userId", select: "username avatar" })
            .lean();
        const byId = new Map(messages.map((m: any) => [String(m._id), m]));
        return entries
            .filter((p) => byId.has(String(p.messageId)))
            .map((p) => {
                const m: any = byId.get(String(p.messageId));
                return {
                    messageId: String(p.messageId),
                    pinnedBy: String(p.pinnedBy),
                    pinnedAt: p.pinnedAt,
                    content: m.content,
                    type: m.type,
                    fileName: m.file?.originalName,
                    createdAt: m.createdAt,
                    user: m.userId && typeof m.userId === "object" ? { _id: m.userId._id, username: m.userId.username } : null,
                };
            });
    }

    /** A deleted message no longer stays pinned. */
    async unpinDeleted(conversationId: string, messageId: string) {
        await Conversation.updateOne({ _id: oid(conversationId) }, { $pull: { pinnedMessages: { messageId: oid(messageId) } } });
    }

    async setSaved(messageId: unknown, userId: string, saved: boolean) {
        const { message } = await messageForMember(messageId, userId);
        if (saved) {
            await SavedMessage.updateOne(
                { userId: oid(userId), messageId: message._id },
                { $setOnInsert: { conversationId: message.conversationId, createdAt: new Date() } },
                { upsert: true },
            );
        } else {
            await SavedMessage.deleteOne({ userId: oid(userId), messageId: message._id });
        }
        return { messageId: String(message._id), saved };
    }

    /** Ids among `messageIds` this user saved (for history pages). */
    async savedAmong(userId: string, messageIds: unknown[]): Promise<Set<string>> {
        if (!messageIds.length) {
            return new Set();
        }
        const rows = await SavedMessage.find({ userId: oid(userId), messageId: { $in: messageIds } }).select("messageId").lean();
        return new Set(rows.map((r) => String(r.messageId)));
    }

    /** My saved messages, newest saved first; only from chats I'm still in and still visible. */
    async listSaved(userId: string, before?: unknown, limit = 30) {
        const safeLimit = Math.min(Math.max(limit, 1), 50);
        const filter: Record<string, unknown> = { userId: oid(userId) };
        if (before) {
            const date = new Date(String(before));
            if (isNaN(date.getTime())) {
                throw new AppError("Invalid cursor");
            }
            filter.createdAt = { $lt: date };
        }
        const rows = await SavedMessage.find(filter).sort({ createdAt: -1 }).limit(safeLimit + 1).lean();
        const page = rows.slice(0, safeLimit);
        const conversations = await Conversation.find({ _id: { $in: page.map((r) => r.conversationId) }, members: oid(userId) })
            .select("isGroup groupName members")
            .populate({ path: "members", select: "username" })
            .lean();
        const convById = new Map(conversations.map((c: any) => [String(c._id), c]));
        const messages = await Message.find({ _id: { $in: page.map((r) => r.messageId) }, isDeleted: { $ne: true } })
            .populate({ path: "userId", select: "username avatar" })
            .lean();
        const msgById = new Map(messages.map((m: any) => [String(m._id), m]));

        const items = [];
        for (const r of page) {
            const m: any = msgById.get(String(r.messageId));
            const c: any = convById.get(String(r.conversationId));
            if (!m || !c) {
                continue;
            }
            const peer = !c.isGroup ? (c.members || []).find((x: any) => String(x._id) !== userId) : null;
            items.push({
                messageId: String(m._id),
                conversationId: String(c._id),
                conversationTitle: c.isGroup ? c.groupName : peer?.username || "Chat",
                content: m.content,
                type: m.type,
                createdAt: m.createdAt,
                savedAt: r.createdAt,
                user: m.userId && typeof m.userId === "object" ? { _id: m.userId._id, username: m.userId.username, avatar: m.userId.avatar } : null,
                ...(await messageMedia(m)),
            });
        }
        return {
            items,
            nextCursor: rows.length > safeLimit ? new Date(page[page.length - 1].createdAt).toISOString() : null,
        };
    }
}

export default new MessageActionsService();
