import Conversation from "../../models/conversationModel";
import callService from "../../services/call.service";
import callRoom, { CALL_REACTIONS } from "../../services/call-room.service";
import mediasoupService from "../../services/mediasoup.service";
import blockService from "../../services/block.service";
import { directPeerId, isMember } from "../../services/authorization.service";
import {
    announceCallEnded,
    callSessionElsewhere,
    emitToCall,
    endIfEmpty,
    getScreenSharer,
    hostIdsOf,
    isCallHost,
    peerInCall,
    releaseScreenShare,
    setScreenSharer,
    startRingTimer,
    takeOverCallSession,
} from "../../services/call-session.service";
import { AuthedSocket, emitToUsers, io, userSockets } from "../io";
import meetingControls from "../../services/meeting-controls.service";
import meetingService from "../../services/meeting.service";
import recordingService from "../../services/recording.service";
import { publicMessage } from "../../utils/errors";

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

/**
 * Call / meeting lifecycle (ring, join, leave, end), screen-share lock, in-call state
 * (mic/camera, hands, reactions, host controls).
 * Event names are unchanged from the original server.ts.
 */
export function registerCallGateway(socket: AuthedSocket): void {
    const me = () => String(socket.data.userId);

    // ---------------------------------------------------------------- lifecycle
    socket.on("call:start", async (data: any) => {
        try {
            const { groupId, callType } = data || {};
            const mode: "ring" | "meetNow" =
                data?.mode === "meetNow" || data?.mode === "ring"
                    ? data.mode
                    : callType === "video"
                        ? "meetNow"
                        : "ring";

            const group = await Conversation.findById(groupId).select("-messages");
            if (!group || !isMember(group, me())) {
                socket.emit("call:error", { message: "Conversation not found" });
                return;
            }
            // Blocked contacts cannot call each other (either direction)
            const peerId = directPeerId(group, me());
            if (peerId && (await blockService.isBlockedEitherWay(me(), peerId))) {
                socket.emit("call:error", { message: "You can't call this contact" });
                return;
            }

            const existing = await callService.getActiveCall(groupId);
            if (existing) {
                socket.emit("call:started", {
                    callId: existing._id,
                    groupId,
                    callType: existing.callType,
                    mode: (existing as any).mode || "ring",
                    initiatedBy: existing.initiatedBy,
                    resumed: true,
                });
                return;
            }

            const call = await callService.createCall({
                conversationId: groupId,
                initiatedBy: socket.data.userId as any,
                callType,
                mode,
                participantIds: group.members ?? [],
            });
            // A scheduled meeting's call starts with that meeting's lobby setting
            if (group.isGroup && (await meetingService.lobbyDefaultFor(String(groupId)))) {
                (call as any).settings = { ...(call as any).settings?.toObject?.(), lobby: true };
                await call.save();
            }

            socket.join(String(groupId));
            socket.join(call._id.toString());

            const payload = { callId: call._id, groupId, callType, mode, initiatedBy: me() };
            socket.emit("call:started", payload);

            // Meet Now: soft Join state for everyone (no ring popup). Ring: incoming-call screen.
            if (mode === "meetNow") {
                emitToUsers(group.members, "call:meeting-active", payload);
            } else {
                emitToUsers(group.members, "call:incoming", payload, me());
                startRingTimer(call._id.toString());
            }

            console.log(`Group call started for ${groupId} by ${me()} (${mode})`);
        } catch (error) {
            console.error("Error starting call:", error);
            socket.emit("call:error", { message: errorMessage(error, "Failed to start call") });
        }
    });

    socket.on("call:getActive", async ({ groupId } = {} as any, callback) => {
        try {
            if (!groupId) {
                return callback?.({ call: null });
            }
            const member = await Conversation.exists({ _id: groupId, members: me() });
            if (!member) {
                return callback?.({ call: null });
            }
            const call = await callService.getActiveCall(groupId);
            if (!call) {
                return callback?.({ call: null });
            }
            callback?.({
                call: {
                    callId: call._id,
                    groupId: call.conversationId,
                    callType: call.callType,
                    mode: (call as any).mode || "ring",
                    callStatus: call.callStatus,
                    initiatedBy: call.initiatedBy,
                },
            });
        } catch (error) {
            callback?.({ call: null, error: errorMessage(error, "Failed to get active call") });
        }
    });

    socket.on("call:upgrade", async ({ callId, callType = "video" } = {} as any, callback) => {
        try {
            if (!(await callService.isActiveParticipant(String(callId), me()))) {
                throw new Error("Not a participant of this call");
            }
            const call = await callService.upgradeCallType(callId, callType);
            const payload = { callId: call._id, groupId: call.conversationId, callType: call.callType };
            io().to(call._id.toString()).emit("call:media-updated", payload);
            callback?.({ success: true, ...payload });
        } catch (error) {
            callback?.({ error: errorMessage(error, "Failed to upgrade call") });
        }
    });

    /** Before joining: is this user live in a call on another device? (stale sessions don't count) */
    socket.on("call:session", (_: unknown, callback) => {
        const other = callSessionElsewhere(me(), socket.data.deviceId);
        callback?.(other && other.alive ? { elsewhere: true, callId: other.callId } : { elsewhere: false });
    });

    /** "End call on other device & join here": move the session to this device. */
    socket.on("call:takeover", async ({ callId } = {} as any, callback) => {
        try {
            await takeOverCallSession(me(), socket.data.deviceId, callId ? String(callId) : undefined);
            if (!mediasoupService.createPeer(me(), socket.id, socket.data.deviceId)) {
                return callback?.({ error: "Could not move the call to this device" });
            }
            callback?.({ success: true });
        } catch (error) {
            console.error("Error taking over call session:", error);
            callback?.({ error: errorMessage(error, "Could not move the call to this device") });
        }
    });

    socket.on("call:accept", async ({ callId } = {} as any, callback) => {
        try {
            const call = await callService.acceptCall(callId, socket.data.userId as any);

            socket.join(call.conversationId.toString());
            socket.join(call._id.toString());
            if (call.callStatus === "active") {
                // Someone picked up — stop the no-answer timer
                callRoom.clearRingTimer(call._id.toString());
            }

            // Someone headed for the lobby is not announced until a host / co-host admits them
            const group = await Conversation.findById(call.conversationId).select("isGroup groupAdmin groupAdmins");
            if (!meetingControls.mustWait(call, group, me())) {
                io().to(call._id.toString()).emit("call:participant-joined", { callId: call._id, userId: me() });
            }
            callback?.({ success: true, callId: call._id });
        } catch (error) {
            console.error("Error accepting call:", error);
            const message = errorMessage(error, "Failed to accept call");
            socket.emit("call:error", { message });
            callback?.({ error: message });
        }
    });

    socket.on("call:reject", async ({ callId } = {} as any) => {
        try {
            const call = await callService.rejectCall(callId, socket.data.userId as any);
            io().to(call._id.toString()).emit("call:participant-rejected", { callId: call._id, userId: me() });

            // 1:1 decline (or every invitee declined a group ring) ends the ring
            if (callService.allOthersRejected(call)) {
                const ended = await callService.endIfUnanswered(call._id as any, "declined");
                if (ended) {
                    await announceCallEnded(ended, { reason: "declined", endedBy: me() });
                }
            }
        } catch (error) {
            console.error("Error rejecting call:", error);
            socket.emit("call:error", { message: errorMessage(error, "Failed to reject call") });
        }
    });

    socket.on("call:leave", async ({ callId } = {} as any) => {
        try {
            // Leave media first so remaining-peer count is accurate
            mediasoupService.leaveCall(socket.id);
            meetingControls.leaveLobby(String(callId), me());
            releaseScreenShare(String(callId), me());

            const call = await callService.leaveCall(callId, socket.data.userId as any);
            callRoom.clearUser(call._id.toString(), me());
            io().to(call._id.toString()).emit("call:participant-left", { callId: call._id, userId: me() });

            // Meet stays up until the LAST member leaves (DB + live media)
            await endIfEmpty(call, me());
        } catch (error) {
            console.error("Error leaving call:", error);
            socket.emit("call:error", { message: errorMessage(error, "Failed to leave call") });
        }
    });

    socket.on("call:end", async ({ callId } = {} as any, callback) => {
        try {
            const existing = await callService.getCall(callId);
            if (!existing) {
                throw new Error("Call not found");
            }
            // Group meetings: only the host may end for everyone. 1:1 calls: either side.
            const group = await Conversation.findById(existing.conversationId).select("isGroup groupAdmin groupAdmins members");
            if (!group || !isMember(group, me())) {
                throw new Error("Call not found");
            }
            if (group.isGroup && !isCallHost(existing, group, me())) {
                throw new Error("Only the host can end the meeting for everyone");
            }

            const call = await callService.endCall(callId);
            mediasoupService.leaveCall(socket.id);
            await announceCallEnded(call, { endedBy: me() });
            callback?.({ success: true });
        } catch (error) {
            const message = errorMessage(error, "Failed to end call");
            callback?.({ error: message });
            console.error("Error ending call:", error);
            socket.emit("call:error", { message });
        }
    });

    // ---------------------------------------------------------------- screen share lock
    socket.on("screen:join", ({ callId } = {} as any) => {
        if (callId) {
            socket.join(callId.toString());
        }
    });

    socket.on("screen:start", async ({ callId } = {} as any, callback) => {
        try {
            if (!callId) {
                return callback?.({ error: "callId is required" });
            }
            const rule = await meetingControls.mayProduce(String(callId), me(), "video", "screen");
            if (!rule.allowed) {
                return callback?.({ error: "The organizer has turned off screen sharing for attendees" });
            }
            const key = callId.toString();
            const existing = getScreenSharer(key);
            if (existing && existing.userId !== me()) {
                return callback?.({ error: "Someone else is already sharing their screen", sharerUserId: existing.userId });
            }
            setScreenSharer(key, { userId: me(), socketId: socket.id });
            socket.join(key);
            io().to(key).emit("screen:started", { callId: key, userId: me() });
            callback?.({ success: true });
        } catch (error) {
            callback?.({ error: errorMessage(error, "Failed to start screen share") });
        }
    });

    socket.on("screen:stop", ({ callId } = {} as any, callback) => {
        try {
            if (!callId) {
                return callback?.({ error: "callId is required" });
            }
            releaseScreenShare(callId.toString(), me());
            callback?.({ success: true });
        } catch (error) {
            callback?.({ error: errorMessage(error, "Failed to stop screen share") });
        }
    });

    socket.on("screen:getState", ({ callId } = {} as any, callback) => {
        const current = callId ? getScreenSharer(callId.toString()) : undefined;
        callback?.({ sharerUserId: current?.userId || null });
    });

    // ---------------------------------------------------------------- in-call state for the meeting UI
    socket.on("call:getState", async (data: any, callback) => {
        try {
            const callId = data?.callId;
            const call = await callService.getCall(callId);
            if (!call || !call.participants.some((p) => p.userId.toString() === me() && p.status !== "removed")) {
                return callback?.({ error: "Not a participant of this call" });
            }
            const group = await Conversation.findById(call.conversationId).select("isGroup groupAdmin groupAdmins groupName");
            const key = call._id.toString();

            const inCall = new Set<string>(
                call.participants.filter((p) => p.status === "joined").map((p) => p.userId.toString())
            );
            mediasoupService.getPeersByCallId(key).forEach((p) => inCall.add(p.userId));
            // Waiting in the lobby is not being in the meeting
            meetingControls.lobbyOf(key).forEach((w) => inCall.delete(w.userId));

            const moderator = meetingControls.isModerator(call, group, me());
            callback?.({
                callId: key,
                myRole: meetingControls.roleOf(call, group, me()),
                settings: meetingControls.settingsOf(call),
                cohostIds: meetingControls.cohostIds(call),
                lobby: moderator ? meetingControls.lobbyOf(key) : [],
                recording: recordingService.activeFor(key),
                recordingAvailable: recordingService.enabled,
                groupId: call.conversationId.toString(),
                callType: call.callType,
                mode: (call as any).mode || "ring",
                callStatus: call.callStatus,
                startedAt: call.startedAt || null,
                // Clients' clocks can be minutes off from the server's: they derive the start time
                // from this (their clock − elapsed) instead of comparing their clock to startedAt
                elapsedMs: call.startedAt ? Math.max(0, Date.now() - new Date(call.startedAt).getTime()) : null,
                isGroup: !!group?.isGroup,
                groupName: group?.groupName || null,
                hostIds: hostIdsOf(call, group),
                participants: [...inCall],
                screenSharerUserId: getScreenSharer(key)?.userId || null,
                ...callRoom.snapshot(key),
            });
        } catch (error) {
            callback?.({ error: errorMessage(error, "Failed to get call state") });
        }
    });

    socket.on("call:media-state", (data: any) => {
        const { callId, audio, video } = data || {};
        const peer = peerInCall(socket.id, callId);
        if (!peer) {
            return;
        }
        const state = { audio: !!audio, video: !!video };
        callRoom.setMedia(peer.callId!, peer.userId, state);
        recordingService.mediaState(peer.callId!, peer.userId, state);
        emitToCall(peer.callId!, "call:media-state", { callId: peer.callId, userId: peer.userId, ...state }, peer.userId);
    });

    socket.on("call:reaction", (data: any) => {
        const { callId, emoji } = data || {};
        const peer = peerInCall(socket.id, callId);
        if (!peer || !CALL_REACTIONS.has(emoji) || !callRoom.allowReaction(peer.userId)) {
            return;
        }
        emitToCall(peer.callId!, "call:reaction", { callId: peer.callId, userId: peer.userId, emoji }, peer.userId);
    });

    socket.on("call:hand", (data: any) => {
        const { callId, raised } = data || {};
        const peer = peerInCall(socket.id, callId);
        if (!peer) {
            return;
        }
        callRoom.setHand(peer.callId!, peer.userId, !!raised);
        emitToCall(peer.callId!, "call:hand", { callId: peer.callId, userId: peer.userId, raised: !!raised }, peer.userId);
    });

    /** Host asks a participant's client to mute. Cooperative: the target client applies it. */
    socket.on("call:mute-participant", async (data: any, callback) => {
        try {
            const { callId, userId: targetId } = data || {};
            const mine = peerInCall(socket.id, callId);
            if (!mine) {
                throw new Error("You are not in this call");
            }
            const call = await callService.getCall(callId);
            const group = call && await Conversation.findById(call.conversationId).select("isGroup groupAdmin groupAdmins");
            if (!call || !group?.isGroup || !meetingControls.isModerator(call, group, mine.userId)) {
                throw new Error("Only the host or a co-host can mute participants");
            }
            const target = mediasoupService.getPeerByUserId(String(targetId));
            if (!target || target.callId !== mine.callId) {
                throw new Error("Participant is not in this call");
            }
            io().to(target.socketId).emit("call:force-muted", { callId: mine.callId, by: mine.userId });
            callback?.({ success: true });
        } catch (error) {
            callback?.({ error: errorMessage(error, "Failed to mute participant") });
        }
    });

    /** Host removes a participant; status "removed" blocks rejoining this call. */
    socket.on("call:remove-participant", async (data: any, callback) => {
        try {
            const { callId, userId: targetId } = data || {};
            const mine = peerInCall(socket.id, callId);
            if (!mine) {
                throw new Error("You are not in this call");
            }
            const call = await callService.getCall(callId);
            const group = call && await Conversation.findById(call.conversationId).select("isGroup groupAdmin groupAdmins");
            if (!call || !group?.isGroup || !meetingControls.isModerator(call, group, mine.userId)) {
                throw new Error("Only the host or a co-host can remove participants");
            }
            const target = String(targetId || "");
            // Co-hosts remove attendees only; hosts remove attendees and co-hosts
            const targetRole = target ? meetingControls.roleOf(call, group, target) : "host";
            const myRole = meetingControls.roleOf(call, group, mine.userId);
            if (!target || target === mine.userId || targetRole === "host" || (targetRole === "cohost" && myRole !== "host")) {
                throw new Error("This participant cannot be removed");
            }

            await callService.removeParticipant(call._id as any, target);
            const key = call._id.toString();
            const targetPeer = mediasoupService.getPeerByUserId(target);
            if (targetPeer && targetPeer.callId === key) {
                io().to(targetPeer.socketId).emit("call:removed", { callId: key, by: mine.userId });
                // Closing their producers notifies everyone else via mediasoup:producerClosed
                mediasoupService.leaveCall(targetPeer.socketId);
                io().in(targetPeer.socketId).socketsLeave(key);
            }
            releaseScreenShare(key, target);
            callRoom.clearUser(key, target);
            io().to(key).emit("call:participant-left", { callId: key, userId: target, removed: true });
            callback?.({ success: true });
        } catch (error) {
            callback?.({ error: errorMessage(error, "Failed to remove participant") });
        }
    });

    // ---------------------------------------------------------------- meeting controls (server-enforced)
    const ack = (callback: any, work: () => Promise<unknown>, fallback: string) => {
        work()
            .then((result) => callback?.({ success: true, ...(result && typeof result === "object" ? result : {}) }))
            .catch((error) => callback?.({ error: publicMessage(error, fallback) }));
    };

    socket.on("call:settings", (data: any, callback) => ack(callback, async () => ({
        settings: await meetingControls.updateSettings(data?.callId, me(), {
            lobby: data?.lobby,
            allowUnmute: data?.allowUnmute,
            allowShare: data?.allowShare,
        }),
    }), "We couldn't change the meeting options. Please try again."));

    socket.on("call:mute-all", (data: any, callback) => ack(callback, () => meetingControls.muteAll(data?.callId, me()), "We couldn't mute everyone. Please try again."));

    socket.on("call:admit", (data: any, callback) => ack(callback, async () => ({
        admitted: await meetingControls.admit(data?.callId, me(), data?.all ? "all" : data?.userId),
    }), "We couldn't admit this person. Please try again."));

    socket.on("call:deny", (data: any, callback) => ack(callback, () => meetingControls.deny(data?.callId, me(), data?.userId), "Please try again."));

    socket.on("call:set-cohost", (data: any, callback) => ack(callback, () => meetingControls.setCohost(data?.callId, me(), data?.userId, data?.cohost !== false), "We couldn't change the role. Please try again."));

    // ---------------------------------------------------------------- recording (host / co-host; visible to everyone)
    socket.on("call:record-start", (data: any, callback) => ack(callback, () => recordingService.start(data?.callId, me()), "We couldn't start recording. Please try again."));
    socket.on("call:record-stop", (data: any, callback) => ack(callback, () => recordingService.stop(data?.callId, me()), "We couldn't stop recording. Please try again."));
}
