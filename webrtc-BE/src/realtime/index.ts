import http from "http";
import { verifyToken } from "@clerk/express";
import { authConfig, isAuthConfigured } from "../config/auth";
import { resolveLocalUserId } from "../services/identity.service";
import { AuthedSocket, addAppSocket, createIo, installAppRoomShadows, removeAppSocket, socketContexts, useAppRooms } from "./io";
import { userRoom } from "./cluster";
import { looksLikeAppToken, tokenRejection, verifyAppTokenSignature } from "../developer/tokens";
import { consumeMessageQuota, recordUsage, verifyUserToken } from "../developer/app.service";
import { isActiveAppDevice } from "../e2ee/e2ee.service";
import { SOCKET_EVENT_SCOPES } from "../developer/scopes";
import { orgClaimsFromPayload, resolveContext } from "../tenancy/tenant.service";
import { runWithContext } from "../tenancy/context";
import { sharedSocketLimiter } from "./rate-limit";
import { startSocketRevalidation } from "./revalidate";
import { cleanUpCallPeerLater, registerPresenceEvents, registerPresenceGateway } from "./gateways/presence.gateway";
import { releaseScreenSharesOfSocket } from "../services/call-session.service";
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
    installAppRoomShadows(io);
    startSocketRevalidation();

    io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token;
        if (typeof token !== "string" || !token) {
            return next(new Error("Authentication error"));
        }
        // Developer-app user token (verified against live app / grant / tenant state)
        if (looksLikeAppToken(token)) {
            const origin = typeof socket.handshake.headers.origin === "string" ? socket.handshake.headers.origin : null;
            try {
                const ctx = await verifyUserToken(token, { origin });
                if (!ctx.app!.scopes.includes("realtime:connect")) {
                    return next(new Error("The token lacks the realtime:connect scope"));
                }
                socket.data.userId = ctx.userId;
                socket.data.ctx = ctx;
                socket.data.deviceId = socket.id;
                (socket.data as any).appToken = token;
                (socket.data as any).appTokenExp = verifyAppTokenSignature(token).exp;
                return next();
            } catch (error) {
                const rejection = tokenRejection(error, origin);
                return next(new Error(rejection.status === 403 ? rejection.message : "Invalid token"));
            }
        }
        if (!isAuthConfigured()) {
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
            // Workspace for this connection = active organization in the verified token
            socket.data.ctx = await resolveContext(socket.data.userId, payload.sub, orgClaimsFromPayload(payload as Record<string, any>), (payload as any).iat ?? null);
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
        const ctx = socket.data.ctx;
        // Every listener of this socket (events AND lifecycle such as "disconnect", which Socket.IO
        // emits outside any request) runs in the socket's workspace context. Without this, cleanup
        // code would run with no context and tenant-scoped queries would be refused (fail closed).
        const on = socket.on.bind(socket);
        (socket as any).on = (event: string, listener: (...args: any[]) => void) =>
            on(event, (...args: any[]) => runWithContext(ctx, () => listener(...args)));
        socketContexts.set(socket.id, ctx);
        // Cluster-wide "is this user connected anywhere" (presence); not used for authorization
        if (!ctx.app) void socket.join(userRoom(String(ctx.userId)));
        socket.on("disconnect", () => socketContexts.delete(socket.id));
        if (ctx.app) {
            return setUpAppSocket(socket, ctx);
        }
        // Abuse protection, then every event handler runs inside this socket's workspace context.
        // The budget is per USER (shared by all their connections): more sockets do not buy more events.
        const allow = sharedSocketLimiter(`user:${ctx.userId}`);
        let lastWarned = 0;
        socket.use((packet, next) => {
            if (!allow()) {
                // Dropped. Tell the client (at most once a second) so it can back off.
                if (Date.now() - lastWarned > 1000) {
                    lastWarned = Date.now();
                    socket.emit("rate-limited", { event: String(packet?.[0] || "").slice(0, 64) });
                }
                next(new Error("Too many requests"));
                return;
            }
            runWithContext(ctx, () => next());
        });
        socket.on("error", () => undefined);

        // Connect-time work (presence, resuming a call) also runs in the workspace context
        runWithContext(ctx, () => {
            registerPresenceGateway(socket);
            registerChatGateway(socket);
            registerMessageGateway(socket);
            registerGroupGateway(socket);
            registerCallGateway(socket);
            registerMediaGateway(socket);
        });
    });

    return io;
}

// ------------------------------------------------------------------ developer-app sockets

const MAX_SOCKETS_PER_APP_USER = 5;
const appConnections = new Map<string, number>();

/**
 * App sockets: no presence registration, no calls / media, no room membership; inbound events
 * limited to an allow-list per scope, outbound events filtered in io.ts. Disconnected when the
 * token expires (clients reconnect with a fresh token from their backend).
 */
function setUpAppSocket(socket: AuthedSocket, ctx: AuthedSocket["data"]["ctx"]): void {
    const app = ctx.app!;
    const userKey = `${app.appId}:${ctx.userId}`;
    // Connection caps (per instance, see docs): per app, and per user of the app
    const appCount = appConnections.get(app.appId) || 0;
    const userCount = appConnections.get(userKey) || 0;
    if (appCount >= app.quotas.maxConnections || userCount >= MAX_SOCKETS_PER_APP_USER) {
        socket.emit("rate-limited", { event: "connect", reason: "connection limit" });
        socket.disconnect(true);
        return;
    }
    appConnections.set(app.appId, appCount + 1);
    appConnections.set(userKey, userCount + 1);
    addAppSocket(ctx.userId, socket.id);
    recordUsage(app.appId, "socketConnections");
    const expiresInMs = (((socket.data as any).appTokenExp as number) * 1000) - Date.now();
    const expiry = setTimeout(() => socket.disconnect(true), Math.max(0, expiresInMs));
    socket.on("disconnect", () => {
        clearTimeout(expiry);
        removeAppSocket(ctx.userId, socket.id);
        // A call this socket took part in: same cleanup as for SpreeWe clients (after the reconnect grace)
        releaseScreenSharesOfSocket(socket.id, ctx.userId);
        cleanUpCallPeerLater(ctx.userId, socket.id);
        appConnections.set(app.appId, Math.max(0, (appConnections.get(app.appId) || 1) - 1));
        appConnections.set(userKey, Math.max(0, (appConnections.get(userKey) || 1) - 1));
    });
    // Rooms deliver un-filtered broadcasts: app sockets join per-scope shadow rooms instead (io.ts),
    // through the same handlers (joinConversation checks membership), plus the user's own room
    useAppRooms(socket, app.scopes);
    void socket.join(userRoom(String(ctx.userId)));

    const allow = sharedSocketLimiter(`app:${userKey}`);
    socket.use((packet, next) => {
        const event = String(packet?.[0] || "");
        const needed = SOCKET_EVENT_SCOPES[event];
        if (!needed || !app.scopes.includes(needed)) {
            return next(new Error("Not available to this app"));
        }
        if (!allow()) {
            socket.emit("rate-limited", { event: event.slice(0, 64) });
            return next(new Error("Too many requests"));
        }
        if (event === "sendMessage" || event === "message:edit") {
            // Apps send end-to-end encrypted content only from an encryption device they registered for
            // this user (e2ee:device; the gateway then applies the usual checks: membership, encrypted
            // payload, author-only edits). New messages count against the app's daily quota.
            const payload = (packet?.[1] || {}) as { conversationId?: unknown; e2ee?: { device_id?: unknown } };
            const reject = (reason: string, message: string) => {
                socket.emit("message:rejected", { conversationId: payload.conversationId ? String(payload.conversationId) : undefined, reason, message });
                next(new Error(message));
            };
            void (async () => {
                if (!(await isActiveAppDevice(ctx.userId, app.appId, payload.e2ee?.device_id))) {
                    return reject("e2ee", "Send from an encryption device this app registered for the user (e2ee:device)");
                }
                if (event === "sendMessage" && !(await consumeMessageQuota(app))) {
                    return reject("quota", "This app's daily message quota is used up");
                }
                runWithContext(ctx, () => next());
            })().catch(() => reject("error", "The message could not be sent"));
            return;
        }
        runWithContext(ctx, () => next());
    });
    socket.on("error", () => undefined);
    runWithContext(ctx, () => {
        registerPresenceEvents(socket);
        registerChatGateway(socket);
        registerMessageGateway(socket);
        registerGroupGateway(socket);
        // Calls: the same gateways as SpreeWe clients; the app joins as another device of the user
        // (one media session per user; mediasoup:joinCall checks participation and the lobby)
        registerCallGateway(socket);
        registerMediaGateway(socket);
    });
}
