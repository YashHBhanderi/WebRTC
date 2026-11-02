import http from "http";
import { Server, Socket } from "socket.io";
import { AppError, publicMessage } from "../utils/errors";
import { RequestContext } from "../tenancy/context";
import { securityConfig } from "../config/security";
import { isAppOrigin } from "../developer/origins";
import { DELIVERED_EVENT_SCOPES } from "../developer/scopes";
import { ScopeInfo, cachedConversationScope, conversationScope, visibleIn } from "../tenancy/scope";
import { safeError } from "../utils/safe-log";
import { onCluster, publish, userRoom } from "./cluster";

/**
 * Socket.IO server instance + the userId → socketId registry.
 * Gateways and services emit through these helpers instead of holding their own `io`.
 */
let ioServer: Server | null = null;

/** One active socket per user (latest connection wins), as before the refactor. */
export const userSockets = new Map<string, string>();

/**
 * Workspace of each connected socket (fixed at handshake from the verified session). Switching
 * workspace on the client means reconnecting with a token for the new organization.
 */
export const socketContexts = new Map<string, RequestContext>();

export function createIo(server: http.Server, corsOrigin: string[] | "*"): Server {
    ioServer = new Server(server, {
        cors: {
            // First-party origins, plus origins registered by active developer apps (their tokens are
            // still checked against their own app's allow-list at the handshake). No credentials.
            origin: (origin, callback) => {
                if (!origin || corsOrigin === "*" || corsOrigin.includes(origin)) return callback(null, origin || true);
                isAppOrigin(origin).then((ok) => callback(null, ok ? origin : false), () => callback(null, false));
            },
            credentials: false,
            methods: ["GET", "POST"],
            allowedHeaders: ["Content-Type", "Authorization"],
        },
        maxHttpBufferSize: securityConfig.socketMaxBufferBytes,
    });
    return ioServer;
}

export function io(): Server {
    if (!ioServer) {
        throw new Error("Socket.IO is not initialised");
    }
    return ioServer;
}

export interface EmitOptions {
    /** Conversation the event is about; defaults to payload.conversationId / payload.groupId */
    conversationId?: unknown;
    /** Event is not about any conversation (presence, own notification counts…) */
    unscoped?: boolean;
    /** Explicit scope (records that carry their own tenantId / scope, e.g. notifications) */
    scope?: ScopeInfo;
}

function conversationOf(payload: unknown, options?: EmitOptions): string | null {
    if (options?.unscoped) {
        return null;
    }
    const p = payload as Record<string, unknown> | null;
    const id = options?.conversationId ?? p?.conversationId ?? p?.groupId;
    return id ? String(id) : null;
}

/** Developer-app sockets only receive allow-listed events their scopes cover; first-party sockets everything. */
export function appMayReceive(ctx: RequestContext | undefined, event: string): boolean {
    if (!ctx?.app) return true;
    const scope = DELIVERED_EVENT_SCOPES[event];
    return !!scope && ctx.app.scopes.includes(scope);
}

/** Developer-app sockets never get ciphertext of end-to-end encrypted messages (they can't decrypt it). */
function forSocket(ctx: RequestContext | undefined, payload: unknown): unknown {
    const p = payload as Record<string, unknown> | null;
    return ctx?.app && p && typeof p === "object" && p.e2ee ? { ...p, e2ee: undefined, content: null, encrypted: true } : payload;
}

function deliver(socketId: string, userId: string, info: ScopeInfo | null, event: string, payload: unknown): void {
    // Unknown (e.g. just deleted) conversation: nothing left to protect, the event only names its id
    const ctx = socketContexts.get(socketId);
    if (!appMayReceive(ctx, event)) {
        return;
    }
    if (info && !visibleIn(info, ctx?.tenantId ?? null, userId)) {
        return;
    }
    io().to(socketId).emit(event, forSocket(ctx, payload));
}

/**
 * Emit to a user's live socket. Events about a conversation are delivered only when that socket's
 * workspace can see the conversation, so a socket in workspace A never receives workspace B (or
 * global) chat data. Order is preserved: the first lookup is shared and later emits reuse the cache.
 */
/**
 * Developer-app sockets of each user (several allowed). Kept apart from userSockets so an app
 * connection never replaces the user's own SpreeWe connection.
 */
export const appSocketsByUser = new Map<string, Set<string>>();

/** All live sockets of a user: their SpreeWe connection and developer-app connections. */
export function socketIdsOf(userId: string): string[] {
    const primary = userSockets.get(String(userId));
    return [...(primary ? [primary] : []), ...(appSocketsByUser.get(String(userId)) || [])];
}

export function addAppSocket(userId: string, socketId: string): void {
    const set = appSocketsByUser.get(userId) || new Set<string>();
    set.add(socketId);
    appSocketsByUser.set(userId, set);
}

export function removeAppSocket(userId: string, socketId: string): void {
    const set = appSocketsByUser.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (!set.size) appSocketsByUser.delete(userId);
}

function emitToSocket(socketId: string, userId: string, event: string, payload: unknown, options?: EmitOptions): void {
    if (options?.scope) {
        deliver(socketId, userId, options.scope, event, payload);
        return;
    }
    const conversationId = conversationOf(payload, options);
    if (!conversationId) {
        const ctx = socketContexts.get(socketId);
        if (appMayReceive(ctx, event)) {
            io().to(socketId).emit(event, forSocket(ctx, payload));
        }
        return;
    }
    const cached = cachedConversationScope(conversationId);
    if (cached !== undefined) {
        deliver(socketId, userId, cached, event, payload);
        return;
    }
    conversationScope(conversationId)
        .then((info) => deliver(socketId, userId, info, event, payload))
        .catch((error) => console.error(`[socket] scope lookup for ${event} failed:`, error instanceof Error ? error.message : error));
}

/**
 * Emit to a user's live sockets (their SpreeWe connection and any developer-app connections).
 * Events about a conversation are delivered only when that socket's workspace can see the
 * conversation; app sockets additionally only get events their scopes cover.
 */
export function emitToUser(userId: string, event: string, payload: unknown, options?: EmitOptions): void {
    deliverToUserLocally(String(userId), event, payload, options);
    // Other instances deliver to their own sockets of this user, after the same checks
    publish({ kind: "user", userId: String(userId), event, payload, options });
}

function deliverToUserLocally(id: string, event: string, payload: unknown, options?: EmitOptions): void {
    const primary = userSockets.get(id);
    if (primary) emitToSocket(primary, id, event, payload, options);
    for (const appSocket of appSocketsByUser.get(id) || []) {
        emitToSocket(appSocket, id, event, payload, options);
    }
}

/** Emit to each listed user's live socket (e.g. all members of a conversation). */
export function emitToUsers(userIds: unknown[] | undefined, event: string, payload: unknown, skipUserId?: string, options?: EmitOptions): void {
    (userIds || []).forEach((member) => {
        const memberId = String(member);
        if (skipUserId && memberId === String(skipUserId)) {
            return;
        }
        emitToUser(memberId, event, payload, options);
    });
}

/** Emit to every connected socket in the global context (e.g. a new public directory entry). */
export function emitToGlobalSockets(event: string, payload: unknown): void {
    emitToGlobalSocketsLocally(event, payload);
    publish({ kind: "global", event, payload });
}

function emitToGlobalSocketsLocally(event: string, payload: unknown): void {
    for (const [socketId, ctx] of socketContexts) {
        if (!ctx.tenantId && appMayReceive(ctx, event)) {
            io().to(socketId).emit(event, payload);
        }
    }
}

/**
 * Who in a workspace receives an event: anyone whose user id is listed OR whose (live) role is listed.
 * Omit both to reach everyone in the workspace. Roles are read from each socket's context, which is
 * kept current when a role changes (see realtime/workspace-sync.ts).
 */
export interface WorkspaceAudience {
    userIds?: unknown[];
    roles?: string[];
}

/**
 * Emit to every SpreeWe (first-party) socket whose verified workspace is `tenantId` and that matches
 * the audience: all of a recipient's tabs in that workspace, never their sockets in another context,
 * never developer-app sockets. One cross-instance message per event (not one per recipient).
 * Payloads must stay ids-only: clustered messages are stored in MongoDB for up to an hour.
 */
export function emitToWorkspace(tenantId: string, event: string, payload: unknown, audience: WorkspaceAudience = {}): void {
    const userIds = audience.userIds ? [...new Set(audience.userIds.map(String))] : null;
    const roles = audience.roles ? [...audience.roles] : null;
    if (userIds && !userIds.length && (!roles || !roles.length)) {
        return;
    }
    emitToWorkspaceLocally(String(tenantId), event, payload, userIds, roles);
    publish({ kind: "workspace", tenantId: String(tenantId), event, payload, userIds, roles });
}

function emitToWorkspaceLocally(tenantId: string, event: string, payload: unknown, userIds: string[] | null, roles: string[] | null): void {
    if (!ioServer) {
        return;
    }
    const everyone = !userIds && !roles;
    const ids = new Set(userIds || []);
    for (const [socketId, ctx] of socketContexts) {
        if (ctx.app || ctx.tenantId !== tenantId) continue;
        if (everyone || ids.has(String(ctx.userId)) || (!!ctx.role && !!roles?.includes(ctx.role))) {
            ioServer.to(socketId).emit(event, payload);
        }
    }
}

/**
 * Notice about the recipient's OWN membership (joined, removed, invited...), on all of their SpreeWe
 * sockets in any context (personal or another organization), so every open tab can react.
 */
export function notifyUserEverywhere(userId: unknown, event: string, payload: unknown): void {
    if (!ioServer) {
        return;
    }
    // userRoom holds first-party sockets only; with the cluster adapter this reaches every instance
    ioServer.to(userRoom(String(userId))).emit(event, payload);
}

/** Make every socket of these users leave these rooms, on every instance (removed from a channel/team). */
export function leaveRooms(userIds: unknown[], rooms: unknown[]): void {
    const list = [...new Set(rooms.map(String))];
    if (!ioServer || !list.length) {
        return;
    }
    for (const userId of new Set(userIds.map(String))) {
        ioServer.in(userRoom(userId)).socketsLeave(list);
    }
}

/** Empty these rooms on every instance (channel deleted, team archived). */
export function closeRooms(rooms: unknown[]): void {
    const list = [...new Set(rooms.map(String))];
    if (!ioServer || !list.length) {
        return;
    }
    ioServer.in(list).socketsLeave(list);
}

/** Make a user's socket leave a room (e.g. removed from a group → no more room broadcasts). */
export function removeUserFromRoom(userId: string, room: string): void {
    removeUserFromRoomLocally(String(userId), String(room));
    publish({ kind: "leave-room", userId: String(userId), room: String(room) });
}

function removeUserFromRoomLocally(userId: string, room: string): void {
    // EVERY socket of the user (each tab / device), not only the latest: a removed member's other
    // connections must stop receiving the room's broadcasts too (userRoom holds all first-party sockets)
    io().in(userRoom(String(userId))).socketsLeave(String(room));
}

export type AuthedSocket = Socket & { data: { userId: string; deviceId: string; ctx: RequestContext } };
type Ack = (response: Record<string, unknown>) => void;

/**
 * Register a request/response event. The handler's return value is sent as
 * `{ success: true, ...result }`; thrown AppErrors become `{ error }`, other errors are logged
 * and reported generically. Null/missing payloads arrive as `{}` (never crash a handler).
 */
export function onAck(
    socket: AuthedSocket,
    event: string,
    handler: (data: Record<string, any>) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
): void {
    socket.on(event, async (data: unknown, callback?: Ack) => {
        const ack = typeof callback === "function" ? callback : undefined;
        try {
            const payload = data && typeof data === "object" ? (data as Record<string, any>) : {};
            const result = await handler(payload);
            ack?.({ success: true, ...(result || {}) });
        } catch (error) {
            if (!(error instanceof AppError)) {
                console.error(`[socket] ${event} failed:`, safeError(error));
            }
            ack?.({ error: publicMessage(error) });
        }
    });
}

/**
 * Disconnect live sockets matching a workspace (and optionally a user): used when Clerk removes a
 * membership or deletes an organization, so access ends now rather than at reconnect.
 */
export function disconnectWorkspaceSockets(tenantId: string | null, userId?: string): number {
    // Other instances disconnect their matching sockets now (their revalidation sweep is the fallback)
    publish({ kind: "disconnect", tenantId, userId: userId ?? null });
    return disconnectWorkspaceSocketsLocally(tenantId, userId);
}

function disconnectWorkspaceSocketsLocally(tenantId: string | null, userId?: string): number {
    if (!ioServer) {
        return 0;
    }
    let count = 0;
    for (const [socketId, ctx] of socketContexts) {
        const tenantMatch = tenantId === null ? true : ctx.tenantId === tenantId;
        if (tenantMatch && (!userId || ctx.userId === userId)) {
            ioServer.sockets.sockets.get(socketId)?.disconnect(true);
            count++;
        }
    }
    return count;
}

// Messages published by other instances: applied to this instance's sockets only
onCluster("user", (m) => deliverToUserLocally(String(m.userId), String(m.event), m.payload, m.options as EmitOptions | undefined));
onCluster("global", (m) => emitToGlobalSocketsLocally(String(m.event), m.payload));
onCluster("workspace", (m) => emitToWorkspaceLocally(String(m.tenantId), String(m.event), m.payload, (m.userIds as string[] | null) ?? null, (m.roles as string[] | null) ?? null));
onCluster("leave-room", (m) => removeUserFromRoomLocally(String(m.userId), String(m.room)));
onCluster("disconnect", (m) => { disconnectWorkspaceSocketsLocally((m.tenantId as string | null) ?? null, (m.userId as string | null) ?? undefined); });
