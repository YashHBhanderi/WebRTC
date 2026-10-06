import http from "http";
import { Server, Socket } from "socket.io";
import { AppError, publicMessage } from "../utils/errors";

/**
 * Socket.IO server instance + the userId → socketId registry.
 * Gateways and services emit through these helpers instead of holding their own `io`.
 */
let ioServer: Server | null = null;

/** One active socket per user (latest connection wins), as before the refactor. */
export const userSockets = new Map<string, string>();

export function createIo(server: http.Server, corsOrigin: string[] | "*"): Server {
    ioServer = new Server(server, {
        cors: {
            origin: corsOrigin,
            methods: ["GET", "POST"],
            allowedHeaders: ["Content-Type", "Authorization"],
        },
        maxHttpBufferSize: 1e8,
    });
    return ioServer;
}

export function io(): Server {
    if (!ioServer) {
        throw new Error("Socket.IO is not initialised");
    }
    return ioServer;
}

export function emitToUser(userId: string, event: string, payload: unknown): void {
    const socketId = userSockets.get(String(userId));
    if (socketId) {
        io().to(socketId).emit(event, payload);
    }
}

/** Emit to each listed user's live socket (e.g. all members of a conversation). */
export function emitToUsers(userIds: unknown[] | undefined, event: string, payload: unknown, skipUserId?: string): void {
    (userIds || []).forEach((member) => {
        const memberId = String(member);
        if (skipUserId && memberId === String(skipUserId)) {
            return;
        }
        emitToUser(memberId, event, payload);
    });
}

/** Make a user's socket leave a room (e.g. removed from a group → no more room broadcasts). */
export function removeUserFromRoom(userId: string, room: string): void {
    const socketId = userSockets.get(String(userId));
    if (socketId) {
        io().in(socketId).socketsLeave(String(room));
    }
}

export type AuthedSocket = Socket & { data: { userId: string } };
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
                console.error(`[socket] ${event} failed:`, error);
            }
            ack?.({ error: publicMessage(error) });
        }
    });
}
