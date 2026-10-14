import User from "../../models/userModel";
import mediasoupService from "../../services/mediasoup.service";
import callService from "../../services/call.service";
import callRoom from "../../services/call-room.service";
import { endIfEmpty, releaseScreenSharesOfSocket } from "../../services/call-session.service";
import { AuthedSocket, io, userSockets } from "../io";
import receiptsService from "../../services/receipts.service";
import presenceService from "../../services/presence.service";
import meetingControls from "../../services/meeting-controls.service";
import { publicMessage } from "../../utils/errors";

/** Grace period: socket.io reconnects often mid-call; don't kill media immediately. */
const CALL_RECONNECT_GRACE_MS = 12_000;

/**
 * Connection bookkeeping: socket registry, online/offline presence, and call cleanup when a
 * user does not come back. Must be registered before the other gateways.
 */
// "In a call" presence follows joining / leaving a media session (registered once)
mediasoupService.onCallMembershipChange = (userId: string) => {
    presenceService.publish(userId).catch((error) => console.error(`Failed to publish in-call presence for ${userId}:`, error));
};

export function registerPresenceGateway(socket: AuthedSocket): void {
    const userId = socket.data.userId;

    if (!mediasoupService.createPeer(userId, socket.id, socket.data.deviceId)) {
        // The user is in a call on another device. If this tab was in that call before it lost
        // its connection, it must not continue (the call has moved).
        const other = mediasoupService.getPeerByUserId(userId);
        if (other?.callId) {
            socket.emit("call:force-leave", { callId: other.callId, reason: "other-device" });
        }
    }
    console.log(`User connected: ${userId} (Socket ID: ${socket.id})`);
    userSockets.set(userId, socket.id);
    // Not awaited: handlers must be registered synchronously, otherwise events the
    // client emits right after connecting (e.g. call:accept) arrive before any listener and are dropped.
    // Live presence goes to people who share a chat with this user (presence.service)
    presenceService.connected(userId).catch((error) => console.error(`Failed to mark ${userId} online:`, error));
    // Messages sent while this user was away have now reached a device
    receiptsService.markAllDelivered(userId).catch((error) => console.error(`Failed to mark deliveries for ${userId}:`, error));

    // Status picker (Available / Busy / Do not disturb / Away / Appear offline) and status message
    socket.on("presence:set", async (data: { status?: unknown; statusMessage?: unknown }, ack?: (r: unknown) => void) => {
        try {
            const presence = await presenceService.setStatus(userId, data?.status, data?.statusMessage);
            ack?.({ success: true, presence });
        } catch (error) {
            ack?.({ error: publicMessage(error, "We couldn't update your status. Please try again.") });
        }
    });

    // The client reports when the user has been idle (no input) for a while, and when they are back
    socket.on("presence:idle", (data: { idle?: unknown }) => {
        presenceService.setIdle(userId, data?.idle === true).catch((error) =>
            console.error(`Failed to update idle state for ${userId}:`, error)
        );
    });

    socket.on("disconnect", async () => {
        const disconnectedSocketId = socket.id;
        console.log(`User disconnected: ${userId} (Socket ID: ${disconnectedSocketId})`);
        releaseScreenSharesOfSocket(disconnectedSocketId, userId);
        if (userSockets.get(userId) === disconnectedSocketId) {
            meetingControls.dropFromLobbies(userId);
        }

        // Only the user's active socket going away makes them offline (another tab/device may be newer)
        if (userSockets.get(userId) === disconnectedSocketId) {
            userSockets.delete(userId);
            await presenceService.disconnected(userId).catch((error) =>
                console.error(`Failed to mark ${userId} offline:`, error)
            );
        }

        setTimeout(async () => {
            // Decide on the peer, not on "does the user have any socket": another device of the
            // same user being online does not mean this device's call session came back.
            const peer = mediasoupService.getPeerByUserId(userId);
            if (!peer || peer.socketId !== disconnectedSocketId) {
                // Same device reconnected (peer rebound to its new socket) or already cleaned
                if (peer) {
                    console.log(`User ${userId} reconnected; keeping mediasoup peer`);
                }
                return;
            }

            console.log(`User ${userId} did not reconnect — cleaning mediasoup peer`);
            const callId = peer.callId;

            mediasoupService.leaveCall(disconnectedSocketId);
            mediasoupService.removePeer(disconnectedSocketId);

            if (callId) {
                try {
                    const call = await callService.leaveCall(callId as any, userId as any);
                    callRoom.clearUser(callId.toString(), userId);
                    io().to(callId.toString()).emit("call:participant-left", { callId, userId });
                    await endIfEmpty(call);
                } catch (error) {
                    console.error("Error leaving call after disconnect:", error);
                }
            }
        }, CALL_RECONNECT_GRACE_MS);
    });
}
