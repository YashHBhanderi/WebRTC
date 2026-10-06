import http from "http";
import { JwtUtills } from "../utils/jwtUtiils";
import { AuthedSocket, createIo } from "./io";
import { registerPresenceGateway } from "./gateways/presence.gateway";
import { registerChatGateway } from "./gateways/chat.gateway";
import { registerMessageGateway } from "./gateways/message.gateway";
import { registerGroupGateway } from "./gateways/group.gateway";
import { registerCallGateway } from "./gateways/call.gateway";
import { registerMediaGateway } from "./gateways/media.gateway";

/**
 * Socket.IO bootstrap: JWT handshake auth, then one gateway per domain.
 * All handlers are attached synchronously in the connection callback, so events a client
 * emits right after connecting are never dropped.
 */
export function startRealtime(server: http.Server, corsOrigin: string[] | "*") {
    const io = createIo(server, corsOrigin);

    io.use((socket, next) => {
        const token = socket.handshake.query.token;
        if (!token) {
            return next(new Error("Authentication error"));
        }
        try {
            const decoded = JwtUtills.verifyToken(token as string) as { userId: string };
            socket.data.userId = decoded.userId;
            next();
        } catch {
            next(new Error("Invalid token"));
        }
    });

    io.on("connection", (rawSocket) => {
        const socket = rawSocket as AuthedSocket;
        if (!socket.data.userId) {
            socket.disconnect();
            return;
        }
        registerPresenceGateway(socket);
        registerChatGateway(socket);
        registerMessageGateway(socket);
        registerGroupGateway(socket);
        registerCallGateway(socket);
        registerMediaGateway(socket);
    });

    return io;
}
