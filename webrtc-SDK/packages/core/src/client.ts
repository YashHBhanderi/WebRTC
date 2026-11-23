import type { TokenProvider } from "./auth/types.js";
import { SpreeWeError } from "./errors.js";
import { HttpClient } from "./http.js";
import { decodeJwt } from "./jwt.js";
import { PeopleApi } from "./people.js";
import { RealtimeClient, type SocketFactory } from "./realtime.js";
import type { Scope } from "./scopes.js";
import { Store, type ReadableStore } from "./store.js";
import type { Me, PublicConfig } from "./types.js";

export interface SpreeWeClientOptions {
    /**
     * SpreeWe API base URL. The backend answers both with and without "/api", so
     * "https://api.example.com" and "https://example.com/api" both work.
     */
    baseUrl: string;
    /** Token source: createOAuthClient(), backendTokenProvider() or sessionTokenProvider() */
    auth: TokenProvider;
    socket?: {
        /** Default: origin of baseUrl */
        url?: string;
        /** Default "/socket.io" */
        path?: string;
        transports?: ("websocket" | "polling" | "webtransport")[];
        ackTimeoutMs?: number;
        factory?: SocketFactory;
    };
    fetch?: typeof fetch;
    /** REST timeout (default 30 000 ms) */
    timeoutMs?: number;
}

/**
 * Entry point. One client per signed-in user; every feature module and component takes it (or finds
 * it on the nearest <spreewe-provider>). Creating a client sends no request: REST calls happen when a
 * module asks for data, and the socket connects on the first `realtime.connect()`.
 */
export class SpreeWeClient {
    readonly http: HttpClient;
    readonly realtime: RealtimeClient;
    readonly auth: TokenProvider;
    readonly people: PeopleApi;
    readonly baseUrl: string;
    private readonly configStore = new Store<PublicConfig | null>(null);
    private configLoad: Promise<PublicConfig> | null = null;
    private readonly meStore = new Store<Me | null>(null);
    private meLoad: Promise<Me> | null = null;
    private readonly services = new Map<unknown, unknown>();
    private destroyed = false;

    constructor(options: SpreeWeClientOptions) {
        if (!options?.baseUrl) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "baseUrl is required" });
        if (!options.auth) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "auth (a TokenProvider) is required" });
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        this.auth = options.auth;
        this.http = new HttpClient({ baseUrl: this.baseUrl, auth: options.auth, fetch: options.fetch, timeoutMs: options.timeoutMs });
        this.realtime = new RealtimeClient({
            url: options.socket?.url || new URL(this.baseUrl).origin,
            path: options.socket?.path,
            transports: options.socket?.transports,
            ackTimeoutMs: options.socket?.ackTimeoutMs,
            socketFactory: options.socket?.factory,
            auth: options.auth,
        });
        this.people = new PeopleApi(this.http, this.realtime);
    }

    // ------------------------------------------------------------------ identity & scopes

    /** The signed-in user and context (GET /v1/me, scope profile:read). Loaded on first use. */
    get me(): ReadableStore<Me | null> {
        return this.meStore;
    }

    loadMe(options: { refresh?: boolean } = {}): Promise<Me> {
        if (!this.meLoad || options.refresh) {
            this.meLoad = this.http.get<Me>("/v1/me").then((me) => {
                this.meStore.set(me);
                return me;
            });
            this.meLoad.catch(() => (this.meLoad = null));
        }
        return this.meLoad;
    }

    /** The signed-in user's id (loads /v1/me once). */
    async userId(): Promise<string> {
        return String((await this.loadMe()).user._id);
    }

    /**
     * Scopes of the current app token, or `null` for a SpreeWe session token (which is limited by the
     * user's own permissions, not scopes). The server re-checks scopes on every request; use this
     * only to hide UI the token can't use.
     */
    async scopes(): Promise<ReadonlySet<string> | null> {
        if (this.auth.kind === "session") return null;
        const claims = decodeJwt(await this.auth.getToken());
        return new Set(Array.isArray(claims?.scp) ? claims!.scp : []);
    }

    /** True when the token carries every scope listed (always true for session tokens). */
    async hasScopes(...scopes: Scope[]): Promise<boolean> {
        const have = await this.scopes();
        return have === null || scopes.every((s) => have.has(s));
    }

    // ------------------------------------------------------------------ media

    /** Public configuration (GET /config, no auth): storage base URL for avatars and group photos. */
    get config(): ReadableStore<PublicConfig | null> {
        if (!this.configLoad) void this.loadConfig().catch(() => undefined);
        return this.configStore;
    }

    loadConfig(): Promise<PublicConfig> {
        if (!this.configLoad) {
            this.configLoad = this.http.get<PublicConfig>("/config", { anonymous: true }).then((c) => {
                this.configStore.set(c || {});
                return c || {};
            });
            this.configLoad.catch(() => (this.configLoad = null));
        }
        return this.configLoad;
    }

    /**
     * URL for a stored picture. The backend sends storage keys for public objects (avatars, group
     * photos) and full signed URLs for attachments; keys are resolved against the storage base URL
     * from /config (returns "" until it has loaded, so subscribe to `config` to re-render).
     */
    mediaUrl(value: string | null | undefined): string {
        const v = (value || "").trim();
        if (!v) return "";
        if (/^(?:https?:|data:|blob:)/i.test(v)) return v;
        if (v.startsWith("/")) return `${new URL(this.baseUrl).origin}${v}`;
        const base = (this.config.value?.s3BaseUrl || "").replace(/\/+$/, "");
        return base ? `${base}/${v.replace(/^\/+/, "")}` : "";
    }

    // ------------------------------------------------------------------ modules

    /** One instance of a module service per client (used by the feature packages). */
    service<T>(key: unknown, create: (client: SpreeWeClient) => T): T {
        if (this.destroyed) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "This SpreeWe client was destroyed." });
        if (!this.services.has(key)) this.services.set(key, create(this));
        return this.services.get(key) as T;
    }

    /** A module service if it was created (or registered), without creating it. */
    peekService<T>(key: unknown): T | null {
        return (this.services.get(key) as T | undefined) ?? null;
    }

    /** Disconnect and release every module service (call on sign-out). */
    destroy(): void {
        this.destroyed = true;
        for (const s of this.services.values()) (s as { destroy?: () => void })?.destroy?.();
        this.services.clear();
        this.realtime.disconnect();
    }
}

export function createClient(options: SpreeWeClientOptions): SpreeWeClient {
    return new SpreeWeClient(options);
}
