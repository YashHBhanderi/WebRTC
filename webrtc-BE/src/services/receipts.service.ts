import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import ConversationUserState from "../models/conversationUserStateModel";
import { emitToUsers } from "../realtime/io";

export type MessageStatus = "sent" | "delivered" | "seen";

export interface MemberReceipt {
    userId: string;
    readAt: Date | null;
    deliveredAt: Date | null;
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/**
 * Read / delivery state as one cursor per (user, chat) instead of a flag per message: marking a
 * chat read is a single write, unread counts are "messages from others after my cursor", and a
 * message's status is derived from the other members' cursors (works the same for groups).
 */
class ReceiptsService {
    /** Everything up to `at` is read (and therefore delivered). Cursors only move forward. */
    async markRead(userId: string, conversationId: string, at = new Date()): Promise<void> {
        await ConversationUserState.updateOne(
            { userId: oid(userId), conversationId: oid(conversationId) },
            { $max: { lastReadAt: at, lastDeliveredAt: at } },
            { upsert: true },
        );
        const conversation = await Conversation.findById(conversationId).select("members").lean();
        emitToUsers(conversation?.members, "receipts:updated", {
            conversationId,
            userId,
            readAt: at.toISOString(),
            deliveredAt: at.toISOString(),
        });
    }

    /** Messages up to `at` reached this user's device, in these chats. */
    async markDelivered(userId: string, conversationIds: string[], at = new Date()): Promise<void> {
        const ids = [...new Set(conversationIds.filter((id) => mongoose.isValidObjectId(id)))];
        if (!ids.length) {
            return;
        }
        await ConversationUserState.bulkWrite(ids.map((id) => ({
            updateOne: {
                filter: { userId: oid(userId), conversationId: oid(id) },
                update: { $max: { lastDeliveredAt: at } },
                upsert: true,
            },
        })));
        const conversations = await Conversation.find({ _id: { $in: ids.map(oid) } }).select("members").lean();
        for (const c of conversations) {
            emitToUsers(c.members, "receipts:updated", {
                conversationId: String(c._id),
                userId,
                deliveredAt: at.toISOString(),
            }, userId);
        }
    }

    /** Coming online: everything sent to me so far has now reached a device. */
    async markAllDelivered(userId: string): Promise<void> {
        const conversations = await Conversation.find({ members: oid(userId) }).select("_id").lean();
        await this.markDelivered(userId, conversations.map((c) => String(c._id)));
    }

    /** Cursors of every member of a chat (absent state = nothing read / delivered). */
    async forConversation(conversationId: string, memberIds: string[]): Promise<MemberReceipt[]> {
        const states = await ConversationUserState.find({ conversationId: oid(conversationId), userId: { $in: memberIds.map(oid) } })
            .select("userId lastReadAt lastDeliveredAt")
            .lean();
        const byUser = new Map(states.map((s: any) => [String(s.userId), s]));
        return memberIds.map((id) => ({
            userId: id,
            readAt: byUser.get(id)?.lastReadAt || null,
            deliveredAt: byUser.get(id)?.lastDeliveredAt || null,
        }));
    }

    /** Status of a message from `authorId`, given every member's cursors. */
    statusOf(createdAt: Date, authorId: string, receipts: MemberReceipt[]): MessageStatus {
        const others = receipts.filter((r) => r.userId !== String(authorId));
        if (!others.length) {
            return "sent";
        }
        const t = new Date(createdAt).getTime();
        if (others.every((r) => r.readAt && new Date(r.readAt).getTime() >= t)) {
            return "seen";
        }
        if (others.every((r) => (r.deliveredAt && new Date(r.deliveredAt).getTime() >= t) || (r.readAt && new Date(r.readAt).getTime() >= t))) {
            return "delivered";
        }
        return "sent";
    }
}

export default new ReceiptsService();
