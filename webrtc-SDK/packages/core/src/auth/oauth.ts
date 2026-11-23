import { SpreeWeError, errorFromResponse } from "../errors.js";
import { Emitter, Store, type ReadableStore, type Unsubscribe } from "../store.js";
import type { Scope } from "../scopes.js";
import { createPkcePair, randomString } from "./pkce.js";
import { readJson, resolveStorage, writeJson } from "./storage.js";
import type { KeyValueStorage, SignedOutReason, TokenProvider } from "./types.js";

export interface OAuthClientOptions {
    /** SpreeWe API base URL, e.g. "https://api.spreewe.example" (with or without "/api") */
    baseUrl: string;
    /** The app's id (OAuth client_id) shown in the Developer Portal. Not the swk_… credential key id. */
    clientId: string;
    /** Must exactly match one of the app's registered callback URLs */
    redirectUri: string;
    /** Scopes to request (space-joined into the `scope` parameter). Ask only for what you integrate. */
    scopes: readonly Scope[];
    /**
     * Where tokens are kept. Default "session" (sessionStorage: per tab, survives reloads).
     * "local" shares one session between tabs (refreshes are then serialised with the Web Locks API).
     * "memory" keeps nothing across reloads. Any object with getItem/setItem/removeItem also works.
     */
    storage?: "session" | "local" | "memory" | KeyValueStorage;
    /** Prefix for storage keys (default "spreewe.oauth"); use different ones for different apps on one origin */
    storageKey?: string;
    /** Refresh this long before the access token expires (default 60 000 ms) */
    refreshMarginMs?: number;
    fetch?: typeof fetch;
}

export interface OAuthTokens {
    accessToken: string;
    refreshToken: string;
    /** Epoch ms */
    expiresAt: number;
    /** Scopes actually granted (may be fewer than requested: the user can untick scopes) */
    scopes: string[];
}

interface PendingAuthorization {
    state: string;
    verifier: string;
    redirectUri: string;
    createdAt: number;
}

export type OAuthStatus = "signed-out" | "signed-in" | "refreshing";

/**
 * OAuth 2.0 authorization code + PKCE (S256) client for browser apps without a backend secret
 * (RFC 6749 / 7636, as implemented by SpreeWe's /oauth endpoints).
 *
 * Security notes (read before production):
 * - Refresh tokens rotate on every use; presenting a used one revokes the whole family. With
 *   `storage: "local"` two tabs share one token, so refreshes are serialised with navigator.locks.
 *   Browsers without the Web Locks API fall back to a per-tab session.
 * - Tokens in Web Storage are readable by any script on your origin. A strict Content Security
 *   Policy and no third-party scripts on pages that hold tokens are your main protection.
 */
export class OAuthClient implements TokenProvider {
    readonly kind = "app" as const;
    private readonly opts: Required<Pick<OAuthClientOptions, "refreshMarginMs" | "storageKey">> & OAuthClientOptions;
    private readonly storage: KeyValueStorage;
    /** Pending authorizations must survive the redirect even when tokens are kept in memory */
    private readonly pendingStorage: KeyValueStorage;
    private readonly shared: boolean;
    private readonly fetchImpl: typeof fetch;
    private refreshing: Promise<string> | null = null;
    private readonly statusStore: Store<OAuthStatus>;
    private readonly events = new Emitter<{ signedOut: SignedOutReason }>();

    constructor(options: OAuthClientOptions) {
        if (!options.clientId) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "clientId is required" });
        if (!options.redirectUri) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "redirectUri is required" });
        this.opts = { refreshMarginMs: 60_000, storageKey: "spreewe.oauth", ...options, baseUrl: options.baseUrl.replace(/\/+$/, "") };
        const resolved = resolveStorage(options.storage);
        this.storage = resolved.storage;
        this.shared = resolved.shared;
        this.pendingStorage = options.storage === "memory" || typeof options.storage === "object" ? resolveStorage("session").storage : this.storage;
        const f = options.fetch || (globalThis.fetch as typeof fetch | undefined);
        if (!f) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "No fetch implementation available" });
        this.fetchImpl = f.bind(globalThis);
        this.statusStore = new Store<OAuthStatus>(this.tokens ? "signed-in" : "signed-out");
    }

    /** "signed-in" while a refresh token is held */
    get status(): ReadableStore<OAuthStatus> {
        return this.statusStore;
    }

    get isSignedIn(): boolean {
        return !!this.tokens;
    }

    /** Scopes the user actually granted (empty when signed out) */
    get grantedScopes(): string[] {
        return this.tokens?.scopes ?? [];
    }

    private get tokenKey(): string {
        return `${this.opts.storageKey}:${this.opts.clientId}:tokens`;
    }

    private get pendingKey(): string {
        return `${this.opts.storageKey}:${this.opts.clientId}:pending`;
    }

    private get tokens(): OAuthTokens | null {
        return readJson<OAuthTokens>(this.storage, this.tokenKey);
    }

    private saveTokens(tokens: OAuthTokens | null): void {
        writeJson(this.storage, this.tokenKey, tokens);
        this.statusStore.set(tokens ? "signed-in" : "signed-out");
    }

    // ------------------------------------------------------------------ authorize

    /**
     * Build the authorization URL and remember the PKCE verifier and state for the callback.
     * Pass the result to `location.assign()` (or use `signIn()`, which does it for you).
     */
    async createAuthorizeUrl(options: { state?: string } = {}): Promise<string> {
        const state = options.state ?? randomString(32);
        if (state.length < 8 || state.length > 200 || !/^[!-~]+$/.test(state)) {
            throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "state must be 8–200 visible ASCII characters" });
        }
        const { verifier, challenge } = await createPkcePair();
        const pending: PendingAuthorization = { state, verifier, redirectUri: this.opts.redirectUri, createdAt: Date.now() };
        writeJson(this.pendingStorage, this.pendingKey, pending);
        const q = new URLSearchParams({
            response_type: "code",
            client_id: this.opts.clientId,
            redirect_uri: this.opts.redirectUri,
            scope: this.opts.scopes.join(" "),
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
        });
        return `${this.opts.baseUrl}/oauth/authorize?${q}`;
    }

    /** Redirect the browser to SpreeWe's consent page. */
    async signIn(options: { state?: string } = {}): Promise<void> {
        const url = await this.createAuthorizeUrl(options);
        (globalThis as { location?: Location }).location?.assign(url);
    }

    /** True when `url` is an OAuth callback (has `code` or `error`, and `state`). */
    isRedirectCallback(url: string = currentUrl()): boolean {
        const q = new URL(url).searchParams;
        return q.has("state") && (q.has("code") || q.has("error"));
    }

    /**
     * Finish sign-in on your redirect page: checks `state`, exchanges the one-time code (valid for 2
     * minutes) and stores the tokens. By default removes `code` and `state` from the address bar.
     */
    async handleRedirectCallback(url: string = currentUrl(), options: { replaceUrl?: boolean } = {}): Promise<OAuthTokens> {
        const parsed = new URL(url);
        const q = parsed.searchParams;
        const pending = readJson<PendingAuthorization>(this.pendingStorage, this.pendingKey);
        const state = q.get("state");
        if (!pending || !state || state !== pending.state) {
            throw new SpreeWeError({ code: "OAUTH_STATE_MISMATCH", message: "This sign-in response doesn't match a sign-in started here. Start again." });
        }
        writeJson(this.pendingStorage, this.pendingKey, null);
        if (options.replaceUrl !== false) stripCallbackParams(parsed);
        const error = q.get("error");
        if (error) {
            throw new SpreeWeError({
                code: "OAUTH_ERROR",
                message: error === "access_denied" ? "Access was not granted." : q.get("error_description") || error,
                details: { error, error_description: q.get("error_description") },
            });
        }
        const code = q.get("code");
        if (!code) throw new SpreeWeError({ code: "OAUTH_ERROR", message: "The sign-in response has no code." });
        const tokens = await this.tokenRequest({
            grant_type: "authorization_code",
            client_id: this.opts.clientId,
            code,
            redirect_uri: pending.redirectUri,
            code_verifier: pending.verifier,
        });
        this.saveTokens(tokens);
        return tokens;
    }

    // ------------------------------------------------------------------ tokens

    async getToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
        const t = this.tokens;
        if (!t) throw new SpreeWeError({ code: "SIGNED_OUT", message: "Not signed in to SpreeWe." });
        if (!options.forceRefresh && t.expiresAt - Date.now() > this.opts.refreshMarginMs) return t.accessToken;
        return this.refresh(t.refreshToken, !!options.forceRefresh);
    }

    private refresh(usedRefreshToken: string, force: boolean): Promise<string> {
        if (this.refreshing) return this.refreshing;
        const run = async () => {
            // Another tab may have rotated the token while we waited for the lock
            const latest = this.tokens;
            if (!latest) throw new SpreeWeError({ code: "SIGNED_OUT", message: "Not signed in to SpreeWe." });
            if (latest.refreshToken !== usedRefreshToken && (!force || latest.expiresAt - Date.now() > this.opts.refreshMarginMs)) {
                return latest.accessToken;
            }
            if (!force && latest.expiresAt - Date.now() > this.opts.refreshMarginMs) return latest.accessToken;
            this.statusStore.set("refreshing");
            try {
                const next = await this.tokenRequest({ grant_type: "refresh_token", client_id: this.opts.clientId, refresh_token: latest.refreshToken });
                this.saveTokens(next);
                return next.accessToken;
            } catch (e) {
                if (e instanceof SpreeWeError && e.status && e.status >= 400 && e.status < 500 && e.code !== "RATE_LIMITED") {
                    // invalid_grant: revoked, expired, reused or the user withdrew the app
                    this.saveTokens(null);
                    this.events.emit("signedOut", "revoked");
                    throw new SpreeWeError({ code: "SIGNED_OUT", message: "Your SpreeWe session ended. Sign in again.", status: e.status, details: e.details, cause: e });
                }
                this.statusStore.set(this.tokens ? "signed-in" : "signed-out");
                throw e;
            }
        };
        const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
        const task = this.shared && locks ? locks.request(`${this.tokenKey}:refresh`, run) : run();
        this.refreshing = Promise.resolve(task).finally(() => (this.refreshing = null));
        return this.refreshing;
    }

    private async tokenRequest(params: Record<string, string>): Promise<OAuthTokens> {
        let res: Response;
        try {
            res = await this.fetchImpl(`${this.opts.baseUrl}/oauth/token`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
                body: new URLSearchParams(params).toString(),
                cache: "no-store",
            });
        } catch (cause) {
            throw new SpreeWeError({ code: "NETWORK_ERROR", message: "Couldn't reach SpreeWe to sign in.", cause });
        }
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw errorFromResponse(res.status, body);
        if (!body?.access_token || !body?.refresh_token) throw new SpreeWeError({ code: "OAUTH_ERROR", message: "The token response is incomplete.", status: res.status });
        return {
            accessToken: String(body.access_token),
            refreshToken: String(body.refresh_token),
            expiresAt: Date.now() + Number(body.expires_in || 0) * 1000,
            scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
        };
    }

    /** Revoke the refresh token family on the server (best effort) and forget the tokens. */
    async signOut(): Promise<void> {
        const t = this.tokens;
        this.saveTokens(null);
        if (t) {
            await this.fetchImpl(`${this.opts.baseUrl}/oauth/revoke`, {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({ client_id: this.opts.clientId, token: t.refreshToken }).toString(),
            }).catch(() => undefined);
        }
        this.events.emit("signedOut", "signed-out");
    }

    onSignedOut(listener: (reason: SignedOutReason) => void): Unsubscribe {
        return this.events.on("signedOut", listener);
    }
}

export function createOAuthClient(options: OAuthClientOptions): OAuthClient {
    return new OAuthClient(options);
}

function currentUrl(): string {
    const href = (globalThis as { location?: Location }).location?.href;
    if (!href) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "Pass the callback URL (no window.location here)." });
    return href;
}

function stripCallbackParams(url: URL): void {
    const h = (globalThis as { history?: History }).history;
    if (!h?.replaceState) return;
    for (const k of ["code", "state", "error", "error_description"]) url.searchParams.delete(k);
    try {
        h.replaceState(h.state, "", url.toString());
    } catch {
        // cross-origin or sandboxed: leave the URL as it is
    }
}
