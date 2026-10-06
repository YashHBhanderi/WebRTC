import User from "../../models/userModel";
import mediasoupService from "../../services/mediasoup.service";
import callService from "../../services/call.service";
import callRoom from "../../services/call-room.service";
import { endIfEmpty, releaseScreenSharesOfSocket } from "../../services/call-session.service";
import { AuthedSocket, io, userSockets } from "../io";

/** Grace period: socket.io reconnects often mid-call; don't kill media immediately. */
const CALL_RECONNECT_GRACE_MS = 12_000;

/**
 * Connection bookkeeping: socket registry, online/offline presence, and call cleanup when a
 * user does not come back. Must be registered before the other gateways.
 */
export function registerPresenceGateway(socket: AuthedSocket): void {
    const userId = socket.data.userId;

    mediasoupService.createPeer(userId, socket.id);
    console.log(`User connected: ${userId} (Socket ID: ${socket.id})`);
    userSockets.set(userId, socket.id);
    // Not awaited: handlers must be registered synchronously, otherwise events the
    // client emits right after connecting (e.g. call:accept) arrive before any listener and are dropped.
    User.findByIdAndUpdate(userId, { isOnline: true }).catch((error) =>
        console.error(`Failed to mark ${userId} online:`, error)
    );
    // Live presence for chat lists/headers. Broadcast to all sockets: fine at this app's
    // scale; switch to contact-scoped rooms if the user base grows large.
    socket.broadcast.emit("user:presence", { userId, isOnline: true });

    socket.on("disconnect", async () => {
        const disconnectedSocketId = socket.id;
        console.log(`User disconnected: ${userId} (Socket ID: ${disconnectedSocketId})`);
        const lastSeen = new Date();
        await User.findByIdAndUpdate(userId, { isOnline: false, lastSeen }).catch((error) =>
            console.error(`Failed to mark ${userId} offline:`, error)
        );

        releaseScreenSharesOfSocket(disconnectedSocketId, userId);

        // Only clear mapping if this socket is still the active one
        if (userSockets.get(userId) === disconnectedSocketId) {
            userSockets.delete(userId);
            io().emit("user:presence", { userId, isOnline: false, lastSeen });
        }

        setTimeout(async () => {
            const currentSocketId = userSockets.get(userId);
            if (currentSocketId && currentSocketId !== disconnectedSocketId) {
                // Reconnected on a new socket — peer already rebound in the connection handler
                console.log(`User ${userId} reconnected; keeping mediasoup peer`);
                return;
            }
            if (currentSocketId === disconnectedSocketId) {
                return;
            }

            console.log(`User ${userId} did not reconnect — cleaning mediasoup peer`);
            const peer = mediasoupService.getPeer(disconnectedSocketId);
            // Only clean THIS socket's peer — never the rebound live peer
            if (!peer || peer.socketId !== disconnectedSocketId) {
                return;
            }
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
