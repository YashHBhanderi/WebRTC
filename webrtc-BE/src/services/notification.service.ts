import mongoose from "mongoose";
import Notification, { NotificationType } from "../models/notificationModel";
import { emitToUser } from "../realtime/io";
import { AppError } from "../utils/errors";
import { requireObjectId } from "../utils/validation";

export interface NewNotification {
    userId: string;
    type: NotificationType;
    actorId?: string | null;
    conversationId?: string | null;
    messageId?: string | null;
    callId?: string | null;
    meetingId?: string | null;
    recordingId?: string | null;
    text?: string;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);
const PREVIEW_MAX = 140;

function preview(text: string | undefined): string {
    const clean = (text || "").replace(/\s+/g, " ").trim();
    return clean.length > PREVIEW_MAX ? `${clean.slice(0, PREVIEW_MAX - 1)}…` : clean;
}

/** Activity feed: stores entries and pushes `notification:new` to the recipient's live socket. */
class NotificationService {
    /** Never throws: a failed notification must not break the action that caused it. */
    async notify(entries: NewNotification | NewNotification[]): Promise<void> {
        const list = (Array.isArray(entries) ? entries : [entries])
            .filter((n) => n.userId && (!n.actorId || String(n.actorId) !== String(n.userId)));
        if (!list.length) {
            return;
        }
        try {
            const docs = await Notification.insertMany(list.map((n) => ({
                userId: oid(n.userId),
                type: n.type,
                actorId: n.actorId ? oid(n.actorId) : null,
                conversationId: n.conversationId ? oid(n.conversationId) : null,
                messageId: n.messageId ? oid(n.messageId) : null,
                callId: n.callId ? oid(n.callId) : null,
                meetingId: n.meetingId ? oid(n.meetingId) : null,
                recordingId: n.recordingId ? oid(n.recordingId) : null,
                text: preview(n.text),
            })));
            const populated = await Notification.find({ _id: { $in: docs.map((d) => d._id) } })
                .populate({ path: "actorId", select: "username avatar" })
                .lean();
            populated.forEach((n: any) => emitToUser(String(n.userId), "notification:new", this.present(n)));
        } catch (error) {
            console.error("[notifications] failed to store notification", error);
        }
    }

    /** Feed page. `view`: "unread" (not read yet) or "mentions" (@mentions only); anything else = all. */
    async list(userId: string, before?: unknown, limit = 30, view?: unknown) {
        const safeLimit = Math.min(Math.max(limit, 1), 50);
        const filter: Record<string, unknown> = { userId: oid(userId) };
        if (view === "unread") {
            filter.readAt = null;
        } else if (view === "mentions") {
            filter.type = "mention";
        }
        if (before) {
            const date = new Date(String(before));
            if (isNaN(date.getTime())) {
                throw new AppError("Invalid cursor");
            }
            filter.createdAt = { $lt: date };
        }
        const docs = await Notification.find(filter)
            .sort({ createdAt: -1 })
            .limit(safeLimit + 1)
            .populate({ path: "actorId", select: "username avatar" })
            .lean();
        const page = docs.slice(0, safeLimit);
        return {
            items: page.map((n) => this.present(n)),
            nextCursor: docs.length > safeLimit ? new Date(page[page.length - 1].createdAt).toISOString() : null,
        };
    }

    unreadCount(userId: string): Promise<number> {
        return Notification.countDocuments({ userId: oid(userId), readAt: null });
    }

    /** Mark some (ids) or all of the user's notifications read. Only ever touches the user's own. */
    async markRead(userId: string, ids?: unknown): Promise<number> {
        const filter: Record<string, unknown> = { userId: oid(userId), readAt: null };
        if (Array.isArray(ids)) {
            if (ids.length > 200) {
                throw new AppError("Too many notifications in one request");
            }
            filter._id = { $in: ids.map((id) => oid(requireObjectId(id, "notification id"))) };
        }
        const res = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
        emitToUser(userId, "notification:read", { unread: await this.unreadCount(userId) });
        return res.modifiedCount;
    }

    /** Opening a chat clears its activity (replies / reactions / mentions there). */
    async markConversationRead(userId: string, conversationId: string): Promise<void> {
        try {
            const res = await Notification.updateMany(
                { userId: oid(userId), conversationId: oid(conversationId), readAt: null, type: { $in: ["mention", "reply", "reaction"] } },
                { $set: { readAt: new Date() } },
            );
            if (res.modifiedCount) {
                emitToUser(userId, "notification:read", { unread: await this.unreadCount(userId) });
            }
        } catch (error) {
            console.error("[notifications] failed to mark conversation read", error);
        }
    }

    private present(n: any) {
        const actor = n.actorId && typeof n.actorId === "object" ? n.actorId : null;
        return {
            _id: n._id,
            type: n.type,
            actor: actor ? { _id: actor._id, username: actor.username, avatar: actor.avatar } : null,
            conversationId: n.conversationId,
            messageId: n.messageId,
            callId: n.callId,
            meetingId: n.meetingId,
            recordingId: n.recordingId,
            text: n.text,
            read: !!n.readAt,
            createdAt: n.createdAt,
        };
    }
}

export default new NotificationService();
