import Call from "../models/callModel";
import mongoose from "mongoose";

interface CreateCallParams {
    conversationId: mongoose.Types.ObjectId;
    initiatedBy: mongoose.Types.ObjectId;
    callType: "audio" | "video";
    participantIds: mongoose.Schema.Types.ObjectId[];
    mode?: "ring" | "meetNow";
}

class CallService {
    async createCall({
        conversationId,
        initiatedBy,
        callType,
        participantIds,
        mode = "ring",
    }: CreateCallParams) {
        const isMeetNow = mode === "meetNow";

        const participants = participantIds.map((userId) => {
            const isInitiator =
                userId.toString() === initiatedBy.toString();

            return {
                userId,
                status: isInitiator
                    ? "joined"
                    : isMeetNow
                        ? "invited"
                        : "ringing",
                ...(isInitiator && {
                    joinedAt: new Date(),
                }),
            };
        });

        const call = await Call.create({
            conversationId,
            initiatedBy,
            callType,
            mode,
            callStatus: isMeetNow ? "active" : "ringing",
            participants,
            ...(isMeetNow && { startedAt: new Date() }),
        });

        return call;
    }

    async getActiveCall(conversationId: string | mongoose.Types.ObjectId) {
        const call = await Call.findOne({
            conversationId,
            callStatus: { $in: ["ringing", "active"] },
        }).sort({ createdAt: -1 });

        if (!call) {
            return null;
        }

        const joined = call.participants.filter(
            (participant) => participant.status === "joined"
        );

        // Nobody left in the call → treat as ended (clears sticky Join)
        if (joined.length === 0) {
            call.callStatus = "ended";
            call.endedAt = new Date();
            await call.save();
            return null;
        }

        const createdAt = (call as any).createdAt
            ? new Date((call as any).createdAt).getTime()
            : Date.now();
        const ageMs = Date.now() - createdAt;

        // Unanswered ring expires after 3 minutes
        if (call.callStatus === "ringing" && ageMs > 3 * 60 * 1000) {
            call.callStatus = "missed";
            call.endedAt = new Date();
            await call.save();
            return null;
        }

        // Abandoned active meetings expire after 2 hours
        if (call.callStatus === "active" && ageMs > 2 * 60 * 60 * 1000) {
            call.callStatus = "ended";
            call.endedAt = new Date();
            await call.save();
            return null;
        }

        return call;
    }

    async upgradeCallType(
        callId: mongoose.Types.ObjectId | string,
        callType: "audio" | "video" = "video"
    ) {
        const call = await Call.findById(callId);
        if (!call) {
            throw new Error("Call not found");
        }
        if (call.callStatus === "ended") {
            throw new Error("Call already ended");
        }
        call.callType = callType;
        await call.save();
        return call;
    }

    async acceptCall(callId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId) {
        const call = await Call.findById(callId);

        if (!call) {
            throw new Error("Call not found");
        }

        if (call.callStatus === "ended") {
            throw new Error("Call already ended");
        }

        const participant = call.participants.find(
            (participant) => participant.userId.toString() === userId.toString()
        );

        if (!participant) {
            throw new Error("User is not a participant of this call");
        }

        participant.status = "joined";
        participant.joinedAt = new Date();

        if (call.callStatus === "ringing") {
            call.callStatus = "active";
            call.startedAt = new Date();
        }

        await call.save();

        return call;
    }

    async rejectCall(callId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId) {
        const call = await Call.findById(callId);

        if (!call) {
            throw new Error("Call not found");
        }

        const participant = call.participants.find(
            (participant) => participant.userId.toString() === userId.toString()
        );

        if (!participant) {
            throw new Error("User is not a participant of this call");
        }

        participant.status = "rejected";

        await call.save();

        return call;
    }

    async leaveCall(callId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId) {
        const call = await Call.findById(callId);

        if (!call) {
            throw new Error("Call not found");
        }

        const participant = call.participants.find(
            (participant) => participant.userId.toString() === userId.toString()
        );

        if (!participant) {
            throw new Error("User is not a participant of this call");
        }

        // Only mark this member left — meeting ends only when server confirms
        // no remaining joined members / media peers (last person out).
        if (participant.status !== "left") {
            participant.status = "left";
            participant.leftAt = new Date();
            await call.save();
        }

        return call;
    }

    /** True when the user is listed on a call that is still ringing/active. */
    async isActiveParticipant(callId: string, userId: string): Promise<boolean> {
        if (!mongoose.isValidObjectId(callId)) {
            return false;
        }
        const call = await Call.findById(callId).select('callStatus participants.userId').lean();
        if (!call || (call.callStatus !== 'ringing' && call.callStatus !== 'active')) {
            return false;
        }
        return call.participants.some((p) => p.userId.toString() === userId.toString());
    }

    countJoined(call: { participants: { status: string }[] }): number {
        return call.participants.filter((p) => p.status === "joined").length;
    }

    async endCall(callId: mongoose.Types.ObjectId) {
        const call = await Call.findById(callId);

        if (!call) {
            throw new Error("Call not found");
        }

        call.callStatus = "ended";
        call.endedAt = new Date();

        call.participants.forEach((participant) => {
            if (participant.status === "joined") {
                participant.status = "left";
                participant.leftAt = new Date();
            }
        });

        await call.save();

        return call;
    }
}

export default new CallService();
