import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import ConversationUserState from "../models/conversationUserStateModel";
import Message from "../models/messageModel";
import User from "../models/userModel";
import { messageMedia } from "./file.service";
import { publicStatus } from "./presence.service";
import Meeting from "../models/meetingModel";
import { AppError } from "../utils/errors";
import { escapeRegExp, requireObjectId } from "../utils/validation";

export type SearchCategory = "users" | "chats" | "messages" | "files" | "meetings";
export const SEARCH_CATEGORIES: SearchCategory[] = ["users", "chats", "messages", "files", "meetings"];

export interface GlobalSearchOptions {
    q: unknown;
    types?: SearchCategory[];
    from?: unknown;
    to?: unknown;
    senderId?: unknown;
    limit?: number;
}

const MEDIA_TYPES = ["image", "video", "audio", "pdf", "file"];
const oid = (id: string) => new mongoose.Types.ObjectId(id);

function parseDate(value: unknown, name: string): Date | null {
    if (value === undefined || value === null || value === "") {
        return null;
    }
    const date = new Date(String(value));
    if (isNaN(date.getTime())) {
        throw new AppError(`Invalid ${name} date`);
    }
    return date;
}

/**
 * Global search across what the signed-in user can see: people, their chats, messages and files
 * in chats they belong to (respecting "clear chat" and deletions).
 *
 * Messages/files are bounded by the user's conversation ids + the {conversationId, createdAt}
 * index; the case-insensitive regex only runs on those. Fine for typical chat volumes — a very
 * large deployment would move this to a text index / search engine.
 */
class SearchService {
    async search(userId: string, opts: GlobalSearchOptions) {
        const q = typeof opts.q === "string" ? opts.q.trim() : "";
        if (q.length < 2) {
            throw new AppError("Type at least 2 characters to search");
        }
        if (q.length > 100) {
            throw new AppError("Search text is too long");
        }
        const types = new Set(opts.types?.length ? opts.types : SEARCH_CATEGORIES);
        const limit = Math.min(Math.max(opts.limit || 8, 1), 30);
        const from = parseDate(opts.from, "from");
        const to = parseDate(opts.to, "to");
        const senderId = opts.senderId ? requireObjectId(opts.senderId, "sender") : null;
        const pattern = { $regex: escapeRegExp(q), $options: "i" };

        const conversations = await Conversation.find({ members: oid(userId) })
            .select("_id isGroup groupName groupAvatar members")
            .populate({ path: "members", select: "username avatar isOnline status" })
            .lean();

        const [users, chats, messages, files, meetings] = await Promise.all([
            types.has("users") ? this.users(userId, pattern, limit) : [],
            types.has("chats") ? this.chats(userId, conversations, q, limit) : [],
            types.has("messages") ? this.messages(userId, conversations, pattern, { from, to, senderId }, limit, false) : [],
            types.has("files") ? this.messages(userId, conversations, pattern, { from, to, senderId }, limit, true) : [],
            types.has("meetings") ? this.meetings(userId, pattern, limit) : [],
        ]);
        return { users, chats, messages, files, meetings };
    }

    /** Meetings I organise or am invited to, by title (newest first). */
    private async meetings(userId: string, pattern: object, limit: number) {
        const docs = await Meeting.find({
            status: "scheduled",
            title: pattern,
            $or: [{ organizerId: oid(userId) }, { invitees: oid(userId) }],
        })
            .sort({ startAt: -1 })
            .limit(limit)
            .select("title startAt endAt recurrence conversationId code")
            .lean();
        return docs.map((m: any) => ({
            _id: m._id,
            title: m.title,
            startAt: m.startAt,
            endAt: m.endAt,
            recurring: !!m.recurrence,
            conversationId: m.conversationId,
            code: m.code,
        }));
    }

    private async users(userId: string, pattern: object, limit: number) {
        const docs = await User.find({ _id: { $ne: oid(userId) }, username: pattern })
            .select("username avatar isOnline lastSeen status statusMessage autoAway bio")
            .sort({ username: 1 })
            .limit(limit)
            .lean();
        return docs.map((u: any) => ({
            _id: u._id,
            username: u.username,
            avatar: u.avatar,
            isOnline: !!u.isOnline,
            lastSeen: u.lastSeen,
            status: publicStatus(u.status),
            statusMessage: u.statusMessage || "",
            autoAway: !!u.autoAway,
        }));
    }

    private chats(userId: string, conversations: any[], q: string, limit: number) {
        const needle = q.toLocaleLowerCase();
        const out: any[] = [];
        for (const c of conversations) {
            const members = (c.members || []).filter((m: any) => m && typeof m === "object");
            if (c.isGroup) {
                const nameHit = (c.groupName || "").toLocaleLowerCase().includes(needle);
                const memberHit = members.some((m: any) => String(m._id) !== userId && (m.username || "").toLocaleLowerCase().includes(needle));
                if (nameHit || memberHit) {
                    out.push({ _id: c._id, isGroup: true, title: c.groupName, avatar: c.groupAvatar, memberCount: members.length });
                }
            } else {
                const peer = members.find((m: any) => String(m._id) !== userId);
                if (peer && (peer.username || "").toLocaleLowerCase().includes(needle)) {
                    out.push({ _id: c._id, isGroup: false, title: peer.username, avatar: peer.avatar, peerId: peer._id, isOnline: !!peer.isOnline });
                }
            }
            if (out.length >= limit) {
                break;
            }
        }
        return out;
    }

    /**
     * Files shared in my chats (Files section), newest first. `kind` narrows to one media type;
     * `before` is the createdAt of the last item of the previous page.
     */
    async files(userId: string, opts: { kind?: unknown; before?: unknown; limit?: number } = {}) {
        const limit = Math.min(Math.max(opts.limit || 30, 1), 50);
        const kind = typeof opts.kind === "string" && MEDIA_TYPES.includes(opts.kind) ? opts.kind : null;
        const before = parseDate(opts.before, "before");
        const conversations = await Conversation.find({ members: oid(userId) })
            .select("_id isGroup groupName members")
            .populate({ path: "members", select: "username" })
            .lean();
        if (!conversations.length) {
            return { items: [], nextCursor: null };
        }
        const states = await ConversationUserState.find({ userId: oid(userId), clearedAt: { $ne: null } }).select("conversationId clearedAt").lean();
        const clearedAt = new Map(states.map((s: any) => [String(s.conversationId), s.clearedAt as Date]));
        const scopes = conversations.map((c) => {
            const cut = clearedAt.get(String(c._id));
            return cut ? { conversationId: c._id, createdAt: { $gt: cut } } : { conversationId: c._id };
        });
        const docs = await Message.find({
            $or: scopes,
            isDeleted: { $ne: true },
            type: kind ? kind : { $in: MEDIA_TYPES },
            "file.storageKey": { $exists: true },
            ...(before ? { createdAt: { $lt: before } } : {}),
        })
            .sort({ createdAt: -1, _id: -1 })
            .limit(limit + 1)
            .select("type createdAt userId conversationId file content")
            .populate({ path: "userId", select: "username avatar" })
            .lean();
        const page = docs.slice(0, limit);
        const byId = new Map(conversations.map((c) => [String(c._id), c]));
        const items = await Promise.all(page.map(async (m: any) => {
            const conv: any = byId.get(String(m.conversationId));
            const peer = conv && !conv.isGroup ? (conv.members || []).find((x: any) => x && String(x._id) !== userId) : null;
            return {
                _id: m._id,
                conversationId: m.conversationId,
                conversationTitle: conv?.isGroup ? conv.groupName : peer?.username || "Chat",
                type: m.type,
                createdAt: m.createdAt,
                user: m.userId && typeof m.userId === "object" ? { _id: m.userId._id, username: m.userId.username, avatar: m.userId.avatar } : null,
                ...(await messageMedia(m)),
            };
        }));
        return {
            items,
            nextCursor: docs.length > limit && page.length ? new Date(page[page.length - 1].createdAt).toISOString() : null,
        };
    }

    private async messages(
        userId: string,
        conversations: any[],
        pattern: object,
        filters: { from: Date | null; to: Date | null; senderId: string | null },
        limit: number,
        filesOnly: boolean,
    ) {
        if (!conversations.length) {
            return [];
        }
        const states = await ConversationUserState.find({ userId: oid(userId), clearedAt: { $ne: null } })
            .select("conversationId clearedAt")
            .lean();
        const clearedAt = new Map(states.map((s: any) => [String(s.conversationId), s.clearedAt as Date]));

        // One branch per chat so each user's "clear chat" cut-off applies to its own chat
        const scopes = conversations.map((c) => {
            const cut = clearedAt.get(String(c._id));
            return cut ? { conversationId: c._id, createdAt: { $gt: cut } } : { conversationId: c._id };
        });

        const created: Record<string, Date> = {};
        if (filters.from) created.$gte = filters.from;
        if (filters.to) created.$lte = filters.to;

        const filter: Record<string, any> = {
            $and: [
                { $or: scopes },
                ...(Object.keys(created).length ? [{ createdAt: created }] : []),
            ],
            isDeleted: { $ne: true },
            ...(filters.senderId ? { userId: oid(filters.senderId) } : {}),
        };
        if (filesOnly) {
            filter.type = { $in: MEDIA_TYPES };
            filter["file.originalName"] = pattern;
        } else {
            filter.content = pattern;
            // Text, or media with a real caption (uncaptioned media stores its type name as content)
            filter.$and.push({
                $or: [
                    { type: "text" },
                    { type: { $in: MEDIA_TYPES }, $expr: { $ne: ["$content", "$type"] } },
                ],
            });
        }

        const docs = await Message.find(filter)
            .sort({ createdAt: -1, _id: -1 })
            .limit(limit)
            .select("content type createdAt userId conversationId file fileUrl thumbnailUrl")
            .populate({ path: "userId", select: "username avatar" })
            .lean();

        const byId = new Map(conversations.map((c) => [String(c._id), c]));
        return Promise.all(docs.map(async (m: any) => {
            const conv = byId.get(String(m.conversationId));
            const peer = conv && !conv.isGroup
                ? (conv.members || []).find((x: any) => x && typeof x === "object" && String(x._id) !== userId)
                : null;
            return {
                _id: m._id,
                conversationId: m.conversationId,
                conversationTitle: conv?.isGroup ? conv.groupName : peer?.username || "Chat",
                isGroup: !!conv?.isGroup,
                content: m.content,
                type: m.type,
                createdAt: m.createdAt,
                user: m.userId && typeof m.userId === "object"
                    ? { _id: m.userId._id, username: m.userId.username, avatar: m.userId.avatar }
                    : { _id: m.userId },
                ...(filesOnly ? await messageMedia(m) : {}),
            };
        }));
    }
}

export default new SearchService();
