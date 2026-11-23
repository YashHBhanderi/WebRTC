import type { ManagerOptions, Socket, SocketOptions } from "socket.io-client";
import type { TokenProvider } from "./auth/types.js";
import { SpreeWeError, isSpreeWeError } from "./errors.js";
import { Store, type ReadableStore, type Unsubscribe } from "./store.js";

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "offline" | "failed";

export type SocketFactory = (url: string, options: Partial<ManagerOptions & SocketOptions>) => Socket;

export interface RealtimeOptions {
    /** Socket.IO server URL (origin). Defaults to the API base URL's origin. */
    url: string;
    /** Default "/socket.io" */
    path?: string;
    /** Default: Socket.IO's (WebSocket with long-polling fallback) */
    transports?: ("websocket" | "polling" | "webtransport")[];
    auth: TokenProvider;
    /** Ack timeout for request() (default 10 000 ms) */
    ackTimeoutMs?: number;
    /** For tests or custom transports; defaults to socket.io-client's io() (loaded on first connect) */
    socketFactory?: SocketFactory;
}

export interface RequestOptions {
    timeoutMs?: number;
    /** Resolve with the ack as it is, even when it carries `error` (default: reject on `{ error }`) */
    raw?: boolean;
}

/** Handshake errors that retrying can't fix */
const FATAL_CONNECT_ERRORS = [/lacks the realtime:connect scope/i, /not available to this app/i];

/**
 * One Socket.IO connection per client, shared by every feature module.
 *
 * - The handshake gets a fresh token on every connect and reconnect (`auth` callback).
 * - The server closes app sockets when their token expires, and closes any socket whose access is
 *   revoked. Socket.IO doesn't reconnect after a server-side close; this client does, with a
 *   force-refreshed token and exponential backoff, and stops for errors retrying can't fix.
 * - Room membership doesn't survive a reconnect: rooms joined with `joinConversation()` are
 *   re-joined on every connect, then `onConnect` handlers run (re-sync state there).
 * - Emits refused before reaching a handler (rate limit, missing scope) never get an ack, so
 *   `request()` always uses a timeout.
 */
export class RealtimeClient {
    private readonly opts: RealtimeOptions;
    private socket: Socket | null = null;
    private starting: Promise<void> | null = null;
    private readonly handlers = new Map<string, Set<(...args: any[]) => void>>();
    private readonly attached = new Set<string>();
    private readonly connectHandlers = new Set<() => void>();
    private readonly rooms = new Map<string, number>();
    private readonly stateStore = new Store<ConnectionState>("idle");
    private readonly errorStore = new Store<SpreeWeError | null>(null);
    private forceRefresh = false;
    private authFailure: unknown = null;
    private attempts = 0;
    private retryTimer: ReturnType<typeof setTimeout> | null = null;
    private stopped = false;

    constructor(options: RealtimeOptions) {
        this.opts = options;
    }

    get state(): ReadableStore<ConnectionState> {
        return this.stateStore;
    }

    /** Why the connection is offline or failed (null while healthy) */
    get lastError(): ReadableStore<SpreeWeError | null> {
        return this.errorStore;
    }

    get connected(): boolean {
        return !!this.socket?.connected;
    }

    get socketId(): string | undefined {
        return this.socket?.id;
    }

    /** Connect (idempotent). Resolves on the first successful connect; rejects on a fatal handshake error. */
    connect(): Promise<void> {
        if (this.socket?.connected) return Promise.resolve();
        if (this.starting) return this.starting;
        if (this.stopped || this.stateStore.value === "failed") this.attempts = 0;
        this.stopped = false;
        // Leave a previous "failed" / "idle" state before listening for the outcome
        this.stateStore.set(this.attempts ? "reconnecting" : "connecting");
        this.starting = new Promise<void>((resolve, reject) => {
            const cleanup: Unsubscribe[] = [];
            const done = (err?: unknown) => {
                cleanup.forEach((off) => off());
                this.starting = null;
                if (err) reject(err);
                else resolve();
            };
            cleanup.push(this.stateStore.subscribe((s) => {
                if (s === "connected") done();
                else if (s === "failed") done(this.errorStore.value || new SpreeWeError({ code: "SOCKET_UNAVAILABLE", message: "Couldn't connect to SpreeWe." }));
            }));
            void this.open().catch((e) => {
                this.fail(e);
            });
        });
        return this.starting;
    }

    /** Close the connection and stop reconnecting. Registered handlers and rooms are kept for the next connect(). */
    disconnect(): void {
        this.stopped = true;
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.socket?.disconnect();
        this.socket = null;
        this.attached.clear();
        this.stateStore.set("idle");
    }

    private async open(): Promise<void> {
        this.stateStore.set(this.attempts ? "reconnecting" : "connecting");
        if (!this.socket) {
            const factory = this.opts.socketFactory || (await loadIo());
            this.socket = factory(this.opts.url, {
                path: this.opts.path || "/socket.io",
                transports: this.opts.transports,
                autoConnect: false,
                // Socket.IO's own reconnection covers network drops; server-side closes are handled below
                reconnection: true,
                reconnectionDelay: 1000,
                reconnectionDelayMax: 10_000,
                auth: (cb: (data: object) => void) => {
                    const force = this.forceRefresh;
                    this.forceRefresh = false;
                    this.opts.auth.getToken({ forceRefresh: force }).then(
                        (token) => {
                            this.authFailure = null;
                            cb({ token });
                        },
                        (e) => {
                            // An empty token is refused by the server ("Authentication error"); the cause is kept
                            this.authFailure = e;
                            cb({ token: "" });
                        },
                    );
                },
            });
            this.wire(this.socket);
        }
        this.socket.connect();
    }

    private wire(socket: Socket): void {
        socket.on("connect", () => {
            this.attempts = 0;
            this.errorStore.set(null);
            for (const room of this.rooms.keys()) socket.emit("joinConversation", room);
            this.stateStore.set("connected");
            for (const h of [...this.connectHandlers]) safe(h);
        });
        socket.on("disconnect", (reason: string) => {
            if (this.stopped) return;
            if (reason === "io server disconnect") {
                // Token expired or access revoked: reconnect with a new token
                this.forceRefresh = true;
                this.scheduleReconnect();
            } else {
                // Network drop: Socket.IO reconnects by itself
                this.stateStore.set("reconnecting");
            }
        });
        socket.on("connect_error", (err: Error) => {
            if (this.stopped) return;
            if (this.authFailure && isSpreeWeError(this.authFailure, "SIGNED_OUT")) return this.fail(this.authFailure);
            const message = err?.message || "Connection failed";
            if (FATAL_CONNECT_ERRORS.some((re) => re.test(message))) {
                return this.fail(new SpreeWeError({ code: "MISSING_SCOPE", message, cause: err }));
            }
            const authProblem = /invalid token|authentication error/i.test(message);
            this.errorStore.set(new SpreeWeError({ code: authProblem ? "UNAUTHENTICATED" : "SOCKET_UNAVAILABLE", message, cause: this.authFailure || err }));
            if (authProblem) {
                this.forceRefresh = true;
                // Three refused handshakes in a row with fresh tokens: the token source is wrong
                if (this.attempts >= 3) return this.fail(this.errorStore.value);
            }
            // Middleware refusals aren't retried by Socket.IO (socket.active is false)
            if (!socket.active) this.scheduleReconnect();
            else this.stateStore.set("reconnecting");
            this.attempts++;
        });
        socket.on("rate-limited", (p: { event?: string; reason?: string }) => {
            if (p?.event === "connect") {
                this.errorStore.set(new SpreeWeError({ code: "RATE_LIMITED", message: p.reason || "Too many connections for this app and user." }));
            }
        });
        for (const event of this.handlers.keys()) this.attach(event);
    }

    private scheduleReconnect(): void {
        if (this.stopped || this.retryTimer) return;
        this.stateStore.set("offline");
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempts, 5)) * (0.75 + Math.random() * 0.5);
        this.attempts++;
        this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (!this.stopped) void this.open().catch((e) => this.fail(e));
        }, delay);
    }

    private fail(e: unknown): void {
        const err = isSpreeWeError(e) ? e : new SpreeWeError({ code: "SOCKET_UNAVAILABLE", message: e instanceof Error ? e.message : "Couldn't connect to SpreeWe.", cause: e });
        this.errorStore.set(err);
        this.stopped = true;
        this.socket?.disconnect();
        this.stateStore.set("failed");
    }

    // ------------------------------------------------------------------ events

    /** Listen to a server event. Handlers survive reconnects. */
    on<T = any>(event: string, handler: (payload: T, ...rest: any[]) => void): Unsubscribe {
        let set = this.handlers.get(event);
        if (!set) this.handlers.set(event, (set = new Set()));
        set.add(handler);
        this.attach(event);
        return () => set!.delete(handler);
    }

    /** Runs after every (re)connect, once rooms are re-joined. */
    onConnect(handler: () => void): Unsubscribe {
        this.connectHandlers.add(handler);
        return () => this.connectHandlers.delete(handler);
    }

    private attach(event: string): void {
        // `attached` tracks listeners on the current socket object (cleared when it's replaced)
        if (!this.socket || this.attached.has(event)) return;
        this.attached.add(event);
        this.socket.on(event, (...args: any[]) => {
            for (const h of [...(this.handlers.get(event) || [])]) safe(() => h(...args));
        });
    }

    /** Fire-and-forget emit (buffered by Socket.IO while reconnecting). */
    emit(event: string, ...args: unknown[]): void {
        if (!this.socket) throw new SpreeWeError({ code: "SOCKET_UNAVAILABLE", message: "Call connect() first." });
        this.socket.emit(event, ...args);
    }

    /**
     * Emit and wait for the server's ack. Rejects with ACK_TIMEOUT when no ack arrives (refused events
     * are never acked) and, unless `raw`, with SOCKET_REFUSED when the ack carries `{ error }`.
     */
    async request<T = any>(event: string, payload: unknown = {}, options: RequestOptions = {}): Promise<T> {
        if (!this.socket) throw new SpreeWeError({ code: "SOCKET_UNAVAILABLE", message: "Call connect() first." });
        if (!this.socket.connected) await this.connect();
        const timeout = options.timeoutMs ?? this.opts.ackTimeoutMs ?? 10_000;
        const socket = this.socket!;
        const res = await new Promise<any>((resolve, reject) => {
            socket.timeout(timeout).emit(event, payload, (err: Error | null, response: unknown) => {
                if (err) reject(new SpreeWeError({ code: "ACK_TIMEOUT", message: `No answer to "${event}" (refused, rate-limited or the connection dropped).`, cause: err }));
                else resolve(response);
            });
        });
        if (!options.raw && res && typeof res === "object" && typeof res.error === "string" && res.error) {
            throw new SpreeWeError({ code: "SOCKET_REFUSED", message: res.error, details: res });
        }
        return res as T;
    }

    // ------------------------------------------------------------------ rooms

    /**
     * Join a conversation's room (needed for typing, reactions and read events) until the returned
     * function is called. Reference-counted, so several components can share a room; re-joined after
     * every reconnect.
     */
    joinConversation(conversationId: string): Unsubscribe {
        const n = this.rooms.get(conversationId) || 0;
        this.rooms.set(conversationId, n + 1);
        if (n === 0 && this.socket?.connected) this.socket.emit("joinConversation", conversationId);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const left = (this.rooms.get(conversationId) || 1) - 1;
            // The server has no leave event: the room is simply not re-joined after the next reconnect
            if (left <= 0) this.rooms.delete(conversationId);
            else this.rooms.set(conversationId, left);
        };
    }

    get joinedRooms(): string[] {
        return [...this.rooms.keys()];
    }
}

let ioPromise: Promise<SocketFactory> | null = null;
function loadIo(): Promise<SocketFactory> {
    ioPromise ||= import("socket.io-client").then((m: any) => (m.io || m.default?.io || m.default) as SocketFactory);
    return ioPromise;
}

function safe(fn: () => void): void {
    try {
        fn();
    } catch (e) {
        queueMicrotask(() => {
            throw e;
        });
    }
}
