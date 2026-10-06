import Conversation from "../models/conversationModel";
import callService from "./call.service";
import callRoom from "./call-room.service";
import mediasoupService from "./mediasoup.service";
import MessageService from "./message.service";
import { adminIds } from "./authorization.service";
import { emitToUsers, io } from "../realtime/io";

/** Unanswered ring → missed call after this long (CALL_RING_TIMEOUT_MS, default 45 s) */
export const RING_TIMEOUT_MS = Number(process.env.CALL_RING_TIMEOUT_MS) > 0 ? Number(process.env.CALL_RING_TIMEOUT_MS) : 45_000;

/** One screen sharer per call room key */
const screenShareByCall = new Map<string, { userId: string; socketId: string }>();

/** Calls already announced as ended (several exit paths can race: timeout, last leave, host end). */
const announcedCalls = new Set<string>();

export function getScreenSharer(callKey: string) {
    return screenShareByCall.get(String(callKey));
}

export function setScreenSharer(callKey: string, sharer: { userId: string; socketId: string }) {
    screenShareByCall.set(String(callKey), sharer);
}

export function releaseScreenShare(callKey: string, userId?: string, broadcast = true) {
    const current = screenShareByCall.get(callKey);
    if (!current) {
        return;
    }
    if (userId && current.userId !== userId) {
        return;
    }
    screenShareByCall.delete(callKey);
    if (broadcast) {
        io().to(callKey).emit("screen:stopped", { callId: callKey, userId: current.userId });
    }
}

/** A dropped socket must not keep holding the screen-share lock. */
export function releaseScreenSharesOfSocket(socketId: string, userId: string) {
    for (const [callKey, sharer] of screenShareByCall.entries()) {
        if (sharer.socketId === socketId) {
            releaseScreenShare(callKey, userId);
        }
    }
}

/**
 * Emit to every peer that joined this call's media, directly by socket id.
 * Unlike the socket room, this still reaches peers whose socket reconnected.
 */
export function emitToCall(callId: string, event: string, payload: Record<string, unknown>, skipUserId?: string) {
    mediasoupService.getPeersByCallId(callId).forEach((peer) => {
        if (skipUserId && peer.userId === skipUserId) {
            return;
        }
        io().to(peer.socketId).emit(event, payload);
    });
}

/** The socket's mediasoup peer, only when it is currently in this call. */
export function peerInCall(socketId: string, callId: unknown) {
    const peer = mediasoupService.getPeer(socketId);
    return peer && callId && peer.callId === String(callId) ? peer : undefined;
}

/** Organizer of the call, or an admin of the group it belongs to. */
export function isCallHost(call: { initiatedBy: any }, group: { groupAdmin?: any; groupAdmins?: any[] } | null, userId: string) {
    if (String(call.initiatedBy) === String(userId)) {
        return true;
    }
    return !!group && adminIds(group as any).has(String(userId));
}

export function hostIdsOf(call: { initiatedBy: any }, group: { groupAdmin?: any; groupAdmins?: any[] } | null): string[] {
    return [...new Set([String(call.initiatedBy), ...(group ? [...adminIds(group as any)] : [])])];
}

/** One place that tells everyone a call is over and releases its in-memory state. Runs once per call. */
export async function announceCallEnded(call: any, extra: { endedBy?: string; reason?: string } = {}) {
    const callId = call._id.toString();
    if (announcedCalls.has(callId)) {
        return;
    }
    announcedCalls.add(callId);
    setTimeout(() => announcedCalls.delete(callId), 10 * 60 * 1000);
    const groupId = call.conversationId.toString();
    releaseScreenShare(callId, undefined, true);
    callRoom.dispose(callId);
    // Peers that never sent call:leave (they just got call:ended) must not keep transports/producers
    // bound to a dead call — the next call would otherwise inherit them.
    mediasoupService.getPeersByCallId(callId).forEach((peer) => mediasoupService.leaveCall(peer.socketId));

    const payload = { callId, groupId, callStatus: call.callStatus, ...extra };
    io().to(callId).emit("call:ended", payload);
    const group = await Conversation.findById(call.conversationId).select("members");
    emitToUsers(group?.members, "call:ended", payload);

    if (call.callStatus === "missed" && group) {
        const content = extra.reason === "declined"
            ? `Declined ${call.callType} call`
            : `Missed ${call.callType} call`;
        try {
            const message = await MessageService.postServiceMessage(groupId, String(call.initiatedBy), "call", content);
            broadcastMessage(groupId, group.members, message);
        } catch (error) {
            console.error("Failed to post missed-call message:", error);
        }
    }
}

/** receiveMessage to the conversation room and to each member's socket (clients de-duplicate by _id). */
export function broadcastMessage(conversationId: string, memberIds: unknown[] | undefined, payload: unknown) {
    io().to(String(conversationId)).emit("receiveMessage", payload);
    emitToUsers(memberIds, "receiveMessage", payload);
}

/** End a ring nobody answered after RING_TIMEOUT_MS. */
export function startRingTimer(callKey: string) {
    callRoom.setRingTimer(callKey, setTimeout(async () => {
        try {
            const missed = await callService.endIfUnanswered(callKey);
            if (missed) {
                await announceCallEnded(missed, { reason: "no-answer" });
            }
        } catch (error) {
            console.error("Ring timeout handling failed:", error);
        }
    }, RING_TIMEOUT_MS));
}

/** Last person out ends the meeting (DB "joined" count and live media peers both empty). */
export async function endIfEmpty(call: any, excludeUserId?: string) {
    const remainingMedia = mediasoupService
        .getPeersByCallId(call._id.toString())
        .filter((p) => !excludeUserId || p.userId !== excludeUserId);
    const remainingJoined = callService.countJoined(call);
    if (remainingJoined === 0 && remainingMedia.length === 0) {
        const ended = await callService.endCall(call._id);
        await announceCallEnded(ended);
    }
}
