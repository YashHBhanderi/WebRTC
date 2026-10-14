import mongoose from "mongoose";
import Call from "../models/callModel";
import Conversation from "../models/conversationModel";
import { AppError } from "../utils/errors";

export type CallOutcome = "answered" | "missed" | "declined" | "cancelled" | "no-answer" | "failed" | "ongoing";

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** My calls (1:1 and group), newest first, with what happened from my point of view. */
class CallHistoryService {
    async list(userId: string, opts: { before?: unknown; filter?: unknown; limit?: number } = {}) {
        const limit = Math.min(Math.max(opts.limit || 30, 1), 50);
        const query: Record<string, unknown> = { "participants.userId": oid(userId) };
        if (opts.before) {
            const before = new Date(String(opts.before));
            if (isNaN(before.getTime())) {
                throw new AppError("Invalid cursor");
            }
            query.createdAt = { $lt: before };
        }
        if (opts.filter === "missed") {
            // Incoming calls I never joined that are over
            query.initiatedBy = { $ne: oid(userId) };
            query.callStatus = "missed";
        } else if (opts.filter === "incoming") {
            query.initiatedBy = { $ne: oid(userId) };
        } else if (opts.filter === "outgoing") {
            query.initiatedBy = oid(userId);
        }
        const calls = await Call.find(query).sort({ createdAt: -1 }).limit(limit + 1).lean();
        const page = calls.slice(0, limit);
        const conversations = await Conversation.find({ _id: { $in: page.map((c: any) => c.conversationId) } })
            .select("isGroup groupName groupAvatar members")
            .populate({ path: "members", select: "username avatar" })
            .lean();
        const convById = new Map(conversations.map((c: any) => [String(c._id), c]));

        const items = page.map((call: any) => {
            const conv: any = convById.get(String(call.conversationId));
            const me = (call.participants || []).find((p: any) => String(p.userId) === userId);
            const outgoing = String(call.initiatedBy) === userId;
            const peer = conv && !conv.isGroup ? (conv.members || []).find((m: any) => String(m._id) !== userId) : null;
            const caller = conv ? (conv.members || []).find((m: any) => String(m._id) === String(call.initiatedBy)) : null;
            const outcome = this.outcome(call, me, outgoing);
            const duration = outcome === "answered" ? this.seconds(call, me, outgoing) : 0;
            return {
                _id: call._id,
                conversationId: call.conversationId,
                isGroup: !!conv?.isGroup,
                isMeeting: call.mode === "meetNow",
                title: conv?.isGroup ? conv.groupName : peer?.username || "Unknown",
                avatar: conv?.isGroup ? conv.groupAvatar : peer?.avatar,
                peerId: peer?._id || null,
                callerName: caller?.username || null,
                // Everyone else on the call (names for group calls)
                participants: (call.participants || [])
                    .filter((p: any) => String(p.userId) !== userId)
                    .map((p: any) => {
                        const m = (conv?.members || []).find((x: any) => String(x._id) === String(p.userId));
                        return { _id: String(p.userId), username: m?.username || "", avatar: m?.avatar, joined: !!p.joinedAt };
                    }),
                callType: call.callType,
                direction: outgoing ? "outgoing" : "incoming",
                outcome,
                duration,
                createdAt: call.createdAt,
            };
        });
        return {
            items,
            nextCursor: calls.length > limit && page.length ? new Date((page[page.length - 1] as any).createdAt).toISOString() : null,
        };
    }

    private outcome(call: any, me: any, outgoing: boolean): CallOutcome {
        if (call.callStatus === "ringing" || call.callStatus === "active") {
            return "ongoing";
        }
        if (outgoing) {
            if (call.startedAt) return "answered";
            if (call.endReason === "cancelled") return "cancelled";
            if (call.endReason === "declined") return "declined";
            if (call.endReason === "failed") return "failed";
            return "no-answer";
        }
        if (me?.joinedAt) return "answered";
        if (me?.status === "rejected") return "declined";
        if (call.mode === "meetNow") return "missed";
        return "missed";
    }

    /** Talk time: the whole call for the caller, my own time in it for others. */
    private seconds(call: any, me: any, outgoing: boolean): number {
        const start = outgoing ? call.startedAt : me?.joinedAt || call.startedAt;
        const end = outgoing ? call.endedAt : me?.leftAt || call.endedAt;
        if (!start || !end) {
            return 0;
        }
        return Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
    }
}

export default new CallHistoryService();
