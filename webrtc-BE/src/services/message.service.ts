import mongoose from "mongoose";
import Message from "../models/messageModel";
import Conversation from "../models/conversationModel";
import User from "../models/userModel";
import chatState from "./chat-state.service";
import { getConversationForMember } from "./authorization.service";
import { messageMedia, releaseMessageFiles } from "./file.service";
import { AppError, NotFoundError } from "../utils/errors";
import { escapeRegExp, PUBLIC_USER_FIELDS, requireObjectId } from "../utils/validation";

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const MEDIA_TYPES = ["image", "video", "audio", "pdf"];

/** Messages this user can see in a chat: not deleted, and after their "clear chat" point. */
function visibleFilter(conversationId: string, clearedAt: Date | null): Record<string, unknown> {
    return {
        conversationId: oid(conversationId),
        isDeleted: { $ne: true },
        ...(clearedAt ? { createdAt: { $gt: clearedAt } } : {}),
    };
}

export interface SearchCursor {
    before?: string;
    beforeId?: string;
}

export default class MessageService {
    public static async deleteMessageById(messageId: string, userId: string) {
        const message = await Message.findById(messageId);

        if (!message) {
            throw new Error("Message not found");
        }

        if (message.userId.toString() !== userId) {
            throw new Error("Unauthorized to delete this message");
        }
        message.isDeleted = true;
        await message.save();
        // Remove the stored attachment unless a forwarded copy still shows it
        await releaseMessageFiles([message.file?.storageKey]);
        return { success: true, message: "Message deleted successfully" };
    }

    /**
     * One history page, oldest → newest, newest page first. Same response shape as the
     * previous aggregation so clients are unaffected; uses the {conversationId, createdAt} index.
     */
    public static async history(conversationId: string, userId: string, page = 1, limit = 20) {
        await getConversationForMember(conversationId, userId);
        const safeLimit = Math.min(Math.max(limit, 1), 2000);
        const safePage = Math.max(page, 1);
        const clearedAt = await chatState.clearedAt(userId, conversationId);

        const docs = await Message.find(visibleFilter(conversationId, clearedAt))
            .sort({ createdAt: -1, _id: -1 })
            .skip((safePage - 1) * safeLimit)
            .limit(safeLimit)
            .populate({ path: "userId", select: "username email avatar isOnline lastSeen" })
            .populate({ path: "replyTo", select: "content type userId" })
            .lean();

        return Promise.all(docs.reverse().map(async (m: any) => {
            const author = m.userId && typeof m.userId === "object" ? m.userId : null;
            return {
                _id: m._id,
                content: m.content,
                type: m.type,
                ...(await messageMedia(m)),
                isDeleted: m.isDeleted,
                isRead: m.isRead,
                createdAt: m.createdAt,
                userId: author ? author._id : m.userId,
                reactions: m.reactions,
                user: author
                    ? {
                        _id: author._id,
                        username: author.username,
                        email: author.email,
                        avatar: author.avatar,
                        isOnline: author.isOnline,
                        lastSeen: author.lastSeen,
                    }
                    : {},
                replyTo: m.replyTo ? { _id: m.replyTo._id, content: m.replyTo.content, type: m.replyTo.type, userId: m.replyTo.userId } : null,
            };
        }));
    }

    /**
     * Partial, case-insensitive search inside ONE chat. The {conversationId, createdAt} index
     * bounds the scan to that chat's messages; the regex only runs on those (never the whole
     * collection). Cursor = (createdAt, _id) of the last result, newest first.
     */
    public static async search(conversationId: string, userId: string, query: unknown, cursor: SearchCursor = {}, limit = 30) {
        await getConversationForMember(conversationId, userId);
        const q = typeof query === "string" ? query.trim() : "";
        if (q.length < 2) {
            throw new AppError("Type at least 2 characters to search");
        }
        if (q.length > 100) {
            throw new AppError("Search text is too long");
        }
        const safeLimit = Math.min(Math.max(limit, 1), 50);
        const clearedAt = await chatState.clearedAt(userId, conversationId);

        const filter: Record<string, any> = {
            ...visibleFilter(conversationId, clearedAt),
            content: { $regex: escapeRegExp(q), $options: "i" },
            // Text, or media with a real caption (uncaptioned media stores its type name as content)
            $or: [
                { type: "text" },
                { type: { $in: MEDIA_TYPES }, $expr: { $ne: ["$content", "$type"] } },
            ],
        };
        if (cursor.before) {
            const before = new Date(cursor.before);
            if (isNaN(before.getTime())) {
                throw new AppError("Invalid cursor");
            }
            const beforeId = cursor.beforeId ? requireObjectId(cursor.beforeId, "beforeId") : null;
            filter.$and = [
                {
                    $or: [
                        { createdAt: { $lt: before } },
                        ...(beforeId ? [{ createdAt: before, _id: { $lt: oid(beforeId) } }] : []),
                    ],
                },
            ];
        }

        const docs = await Message.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .limit(safeLimit + 1)
            .select("content type createdAt userId")
            .populate({ path: "userId", select: "username avatar" })
            .lean();

        const hasMore = docs.length > safeLimit;
        const page = docs.slice(0, safeLimit);
        const last = page[page.length - 1] as any;
        return {
            results: page.map((m: any) => ({
                _id: m._id,
                content: m.content,
                type: m.type,
                createdAt: m.createdAt,
                user: m.userId && typeof m.userId === "object"
                    ? { _id: m.userId._id, username: m.userId.username, avatar: m.userId.avatar }
                    : { _id: m.userId },
            })),
            nextCursor: hasMore && last ? { before: new Date(last.createdAt).toISOString(), beforeId: String(last._id) } : null,
        };
    }

    /** How many visible messages are newer than this one — lets the client load exactly enough pages. */
    public static async position(conversationId: string, userId: string, messageId: unknown) {
        await getConversationForMember(conversationId, userId);
        const id = requireObjectId(messageId, "messageId");
        const clearedAt = await chatState.clearedAt(userId, conversationId);
        const target = await Message.findOne({ _id: oid(id), ...visibleFilter(conversationId, clearedAt) })
            .select("createdAt")
            .lean();
        if (!target) {
            throw new NotFoundError("Message not found");
        }
        const newerCount = await Message.countDocuments({
            ...visibleFilter(conversationId, clearedAt),
            createdAt: { $gt: target.createdAt },
        });
        return { messageId: id, newerCount };
    }

    public static async sharedMedia(conversationId: string, userId: string) {
        await getConversationForMember(conversationId, userId);
        const clearedAt = await chatState.clearedAt(userId, conversationId);
        const docs = await Message.find({ ...visibleFilter(conversationId, clearedAt), type: { $in: MEDIA_TYPES } })
            .sort({ createdAt: -1 })
            .limit(300)
            .select("file fileUrl thumbnailUrl type createdAt")
            .lean();
        return Promise.all(docs.map(async (m: any) => ({
            _id: m._id,
            ...(await messageMedia(m)),
            type: m.type,
            createdAt: m.createdAt,
        })));
    }

    /**
     * Server-authored entry (call log or group notice). Returns the receiveMessage payload;
     * the caller decides who to emit it to.
     */
    public static async postServiceMessage(conversationId: string, authorId: string, type: "call" | "system", content: string) {
        const message = await Message.create({
            userId: oid(authorId),
            conversationId: oid(conversationId),
            content,
            type,
            fileUrl: "",
            thumbnailUrl: "",
            createdAt: new Date(),
        });
        await Conversation.updateOne({ _id: oid(conversationId) }, { $push: { messages: message._id } });
        const author = await User.findById(authorId).select(PUBLIC_USER_FIELDS).lean();
        return {
            ...message.toObject(),
            user: author,
            conversationId: String(conversationId),
        };
    }
}
