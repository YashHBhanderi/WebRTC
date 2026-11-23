import { SpreeWeError, errorFromResponse } from "./errors.js";
import type { Scope } from "./scopes.js";

/**
 * Server-side client for YOUR backend (Node.js 18+, Deno, Bun, edge runtimes). Import it from
 * "@spreewe/core/server".
 *
 * It holds the app's server credential (keyId + secret) and does the three things only a server may
 * do: register and manage the app's users, exchange the credential for short-lived user tokens, and
 * revoke them. Everything it does happens in the app's own tenant: the tenant comes from the
 * credential on the SpreeWe side and can't be chosen, so there is no tenant parameter anywhere.
 *
 * NEVER bundle this into a browser or mobile app: whoever holds the secret can act for every user
 * of your app. The constructor refuses to run where a DOM is present. Browsers use createClient()
 * with backendTokenProvider(), which asks your backend for a token.
 */
export interface SpreeWeServerClientOptions {
    /** SpreeWe API base URL, with or without "/api" (not including "/v1") */
    baseUrl: string;
    /** swk_live_… / swk_test_… */
    keyId: string;
    /** sws_… (shown once when the credential is created; load it from your secret store) */
    secret: string;
    fetch?: typeof fetch;
    /** Per-request timeout (default 30 000 ms; 0 disables it) */
    timeoutMs?: number;
    /** Reuse a user token until this long before it expires (default 60 000 ms) */
    tokenRefreshMarginMs?: number;
}

/** A user your app registered. `_id` is the SpreeWe user id used everywhere else in the API. */
export interface AppUser {
    _id: string;
    /** Your own id for this person; unique within your app */
    externalUserId: string;
    name: string;
    email: string | null;
    avatarUrl: string;
    status: "active" | "deactivated";
    /** Your app's tenant */
    tenantId: string;
    createdAt: string;
    deactivatedAt: string | null;
}

export interface RegisterAppUserInput {
    /** 1–200 characters: letters, digits and . _ : @ | - */
    externalUserId: string;
    /** Display name, 3–30 characters: letters, digits, spaces and . _ ' - */
    name: string;
    /** Optional. Lets your other users find this person by email; never used for sign-in */
    email?: string;
    /** Optional https URL of a picture you host */
    avatarUrl?: string;
}

export interface UpdateAppUserInput {
    name?: string;
    /** "" or null clears it */
    email?: string | null;
    /** "" or null clears it */
    avatarUrl?: string | null;
    /** false deactivates (tokens stop at once), true brings the user back */
    active?: boolean;
}

export interface ListAppUsersOptions {
    /** 1–100 (default 20) */
    limit?: number;
    /** `nextCursor` of the previous page */
    cursor?: string;
    status?: "active" | "deactivated";
}

export interface AppUserPage {
    items: AppUser[];
    nextCursor: string | null;
}

export interface UserTokenOptions {
    /** Subset of the app's scopes (default: all of them) */
    scopes?: Scope[];
    /** 60–900 by default on the server (default 600) */
    ttlSeconds?: number;
    /** Skip the cache and ask for a new token */
    forceRefresh?: boolean;
}

export interface UserToken {
    accessToken: string;
    tokenType: "Bearer";
    expiresIn: number;
    /** ISO time */
    expiresAt: string;
    scopes: string[];
    tokenId: string;
    /** Your app's tenant (null only for legacy apps without one) */
    tenantId: string | null;
}

const EXTERNAL_ID = /^[\w.:@|-]{1,200}$/;

function externalId(value: unknown): string {
    if (typeof value !== "string" || !EXTERNAL_ID.test(value)) {
        throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "externalUserId must be 1-200 characters: letters, digits and . _ : @ | -" });
    }
    return value;
}

export class SpreeWeServerClient {
    readonly baseUrl: string;
    private readonly authorization: string;
    private readonly fetchImpl: typeof fetch;
    private readonly timeoutMs: number;
    private readonly margin: number;
    private readonly tokens = new Map<string, UserToken>();
    private readonly inflight = new Map<string, Promise<UserToken>>();

    constructor(options: SpreeWeServerClientOptions) {
        if (typeof (globalThis as { document?: unknown }).document !== "undefined") {
            throw new SpreeWeError({
                code: "INVALID_ARGUMENT",
                message: "SpreeWeServerClient holds your app secret and must only run on your server, never in a browser.",
            });
        }
        if (!options?.baseUrl) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "baseUrl is required" });
        if (!/^swk_(live|test)_/.test(options.keyId || "") || !(options.secret || "").startsWith("sws_")) {
            throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "keyId (swk_…) and secret (sws_…) are required" });
        }
        this.baseUrl = options.baseUrl.replace(/\/+$/, "");
        const f = options.fetch || (globalThis.fetch as typeof fetch | undefined);
        if (!f) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "No fetch implementation available" });
        this.fetchImpl = f.bind(globalThis);
        this.timeoutMs = options.timeoutMs ?? 30_000;
        this.margin = options.tokenRefreshMarginMs ?? 60_000;
        this.authorization = `Basic ${btoa(`${options.keyId}:${options.secret}`)}`;
        // The secret is not kept as a readable property and never appears in errors
    }

    // ------------------------------------------------------------------ users

    /** Users of YOUR app. Another app's users can't be read, changed or listed with this credential. */
    readonly users = {
        /** Register a user (201). Rejects with status 409 (CONFLICT_ERROR) if the externalUserId already exists. */
        register: async (input: RegisterAppUserInput): Promise<AppUser> =>
            this.call<AppUser>("POST", "/v1/app-users", { ...input, externalUserId: externalId(input?.externalUserId) }),

        /**
         * Register the user, or return the existing one if the externalUserId is already registered
         * (safe to call on every sign-in). An existing user is returned as stored: use update() to
         * change it, and note that a deactivated user stays deactivated.
         */
        ensure: async (input: RegisterAppUserInput): Promise<AppUser> => {
            try {
                return await this.users.register(input);
            } catch (error) {
                if (error instanceof SpreeWeError && error.status === 409) return this.users.get(input.externalUserId);
                throw error;
            }
        },

        /** One user by your own id. Rejects with status 404 when your app has no such user. */
        get: async (externalUserId: string): Promise<AppUser> =>
            this.call<AppUser>("GET", `/v1/app-users/${encodeURIComponent(externalId(externalUserId))}`),

        /** One page of your users, oldest first. */
        list: async (options: ListAppUsersOptions = {}): Promise<AppUserPage> => {
            const query = new URLSearchParams();
            if (options.limit !== undefined) query.set("limit", String(options.limit));
            if (options.cursor) query.set("cursor", options.cursor);
            if (options.status) query.set("status", options.status);
            const qs = query.toString();
            const body = await this.raw("GET", `/v1/app-users${qs ? `?${qs}` : ""}`);
            return { items: (body?.data as AppUser[]) || [], nextCursor: (body?.page?.nextCursor as string | null) ?? null };
        },

        /** Every user, page by page: `for await (const user of spreewe.users.all()) …` */
        all: (options: Omit<ListAppUsersOptions, "cursor"> = {}): AsyncGenerator<AppUser, void, void> => {
            const list = this.users.list;
            return (async function* () {
                let cursor: string | undefined;
                do {
                    const page = await list({ limit: 100, ...options, cursor });
                    yield* page.items;
                    cursor = page.nextCursor || undefined;
                } while (cursor);
            })();
        },

        /** Change name, email or picture, or deactivate / reactivate (`active`). */
        update: async (externalUserId: string, patch: UpdateAppUserInput): Promise<AppUser> => {
            const body: Record<string, unknown> = { ...patch };
            // The API clears a field with an empty string
            if (patch.email === null) body.email = "";
            if (patch.avatarUrl === null) body.avatarUrl = "";
            return this.call<AppUser>("PATCH", `/v1/app-users/${encodeURIComponent(externalId(externalUserId))}`, body);
        },

        /**
         * Deactivate: the user's tokens stop working at once and they leave your directory. Their
         * messages stay. Cached tokens for them are dropped here too.
         */
        deactivate: async (externalUserId: string): Promise<void> => {
            await this.call("DELETE", `/v1/app-users/${encodeURIComponent(externalId(externalUserId))}`);
            this.forget(externalUserId);
        },

        reactivate: (externalUserId: string): Promise<AppUser> => this.users.update(externalUserId, { active: true }),
    };

    // ------------------------------------------------------------------ tokens

    /**
     * A short-lived token for one of your registered users, after YOUR backend authenticated them.
     * Hand `accessToken` + `expiresAt` to your frontend (backendTokenProvider). Cached per user and
     * scope set until shortly before expiry; concurrent calls share one request.
     */
    async userToken(externalUserId: string, options: UserTokenOptions = {}): Promise<UserToken> {
        const id = externalId(externalUserId);
        const key = `${id}|${[...(options.scopes || [])].sort().join(",")}|${options.ttlSeconds ?? ""}`;
        const hit = this.tokens.get(key);
        if (!options.forceRefresh && hit && new Date(hit.expiresAt).getTime() - Date.now() > this.margin) return hit;
        let pending = this.inflight.get(key);
        if (!pending) {
            pending = this.call<UserToken>("POST", "/v1/app-tokens", {
                externalUserRef: id,
                ...(options.scopes ? { scopes: options.scopes } : {}),
                ...(options.ttlSeconds !== undefined ? { ttlSeconds: options.ttlSeconds } : {}),
            }).then((token) => {
                this.tokens.set(key, token);
                return token;
            }).finally(() => this.inflight.delete(key));
            this.inflight.set(key, pending);
        }
        return pending;
    }

    /** Revoke one of your app's tokens (call it when your user signs out). */
    async revokeToken(accessToken: string): Promise<void> {
        await this.call("POST", "/v1/app-tokens/revoke", { token: accessToken });
        for (const [key, token] of this.tokens) if (token.accessToken === accessToken) this.tokens.delete(key);
    }

    private forget(externalUserId: string): void {
        for (const key of this.tokens.keys()) if (key.startsWith(`${externalUserId}|`)) this.tokens.delete(key);
    }

    // ------------------------------------------------------------------ transport

    private async call<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
        return (await this.raw(method, path, body))?.data as T;
    }

    private async raw(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
        const controller = new AbortController();
        const timer = this.timeoutMs > 0 ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
        let res: Response;
        try {
            res = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method,
                headers: { Authorization: this.authorization, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: controller.signal,
            });
        } catch (cause) {
            const timedOut = controller.signal.aborted;
            // The cause is kept for debugging; the message never contains the request (or the credential)
            throw new SpreeWeError({ code: timedOut ? "TIMEOUT" : "NETWORK_ERROR", message: timedOut ? "The SpreeWe request timed out" : "Could not reach SpreeWe", cause });
        } finally {
            if (timer) clearTimeout(timer);
        }
        const parsed = await res.json().catch(() => null);
        if (!res.ok) {
            const retryAfter = Number(res.headers.get("Retry-After"));
            throw errorFromResponse(res.status, parsed, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
        }
        return (parsed || {}) as Record<string, any>;
    }
}

export function createServerClient(options: SpreeWeServerClientOptions): SpreeWeServerClient {
    return new SpreeWeServerClient(options);
}
