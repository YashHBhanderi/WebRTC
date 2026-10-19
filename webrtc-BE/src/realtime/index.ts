import http from "http";
import { verifyToken } from "@clerk/express";
import { authConfig, isAuthConfigured } from "../config/auth";
import { resolveLocalUserId } from "../services/identity.service";
import { AuthedSocket, createIo } from "./io";
import { registerPresenceGateway } from "./gateways/presence.gateway";
import { registerChatGateway } from "./gateways/chat.gateway";
import { registerMessageGateway } from "./gateways/message.gateway";
import { registerGroupGateway } from "./gateways/group.gateway";
import { registerCallGateway } from "./gateways/call.gateway";
import { registerMediaGateway } from "./gateways/media.gateway";

/**
 * Socket.IO bootstrap: Clerk session-token handshake auth, then one gateway per domain.
 * The client sends a fresh token on every (re)connect (`auth.token`); tokens are short-lived,
 * so they are only checked when connecting.
 * All handlers are attached synchronously in the connection callback, so events a client
 * emits right after connecting are never dropped.
 */
const lastLogged = new Map<string, number>();
/**
 * Why a socket token was refused (e.g. clock drift), once a minute per reason. Keyed on Clerk's
 * fixed reason codes (never on message text, which echoes attacker-supplied token headers).
 */
function logRejection(error: unknown): void {
    const reason = typeof (error as { reason?: unknown })?.reason === "string"
        ? String((error as { reason: string }).reason).slice(0, 64)
        : (error as Error)?.name || "other";
    const now = Date.now();
    if (now - (lastLogged.get(reason) || 0) > 60_000) {
        lastLogged.set(reason, now);
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[auth] socket session token rejected (${reason}): ${message.slice(0, 300)}`);
    }
}

export function startRealtime(server: http.Server, corsOrigin: string[] | "*") {
    const io = createIo(server, corsOrigin);

    io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token;
        if (!isAuthConfigured() || typeof token !== "string" || !token) {
            return next(new Error("Authentication error"));
        }
        try {
            const payload = await verifyToken(token, {
                secretKey: authConfig.secretKey,
                jwtKey: authConfig.jwtKey,
                // Browsers always send Origin (keep the azp check); the native app doesn't (no azp in its tokens)
                authorizedParties: authConfig.authorizedParties.length && socket.handshake.headers.origin ? authConfig.authorizedParties : undefined,
                clockSkewInMs: authConfig.clockSkewMs,
            });
            socket.data.userId = await resolveLocalUserId(payload.sub);
            // Per-tab id from the client (sessionStorage): reconnects of the same tab keep their call
            const deviceId = socket.handshake.auth?.deviceId;
            socket.data.deviceId = typeof deviceId === "string" && /^[\w-]{8,64}$/.test(deviceId) ? deviceId : socket.id;
            next();
        } catch (error) {
            logRejection(error);
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
