import { SpreeWeError } from "../errors.js";
import { msUntilExpiry } from "../jwt.js";
import type { IssuedToken, TokenProvider } from "./types.js";

export interface BackendTokenProviderOptions {
    /**
     * Ask YOUR backend for a token. Your backend authenticates its own user, then calls SpreeWe's
     * POST /v1/app-tokens with the app credential (HTTP Basic, never in the browser) and returns
     * `{ accessToken, expiresAt }`. Return the whole IssuedToken or just the token string.
     */
    fetchToken: () => Promise<IssuedToken | string>;
    /** Fetch a new token this long before expiry (default 60 000 ms; app tokens live 60–900 s) */
    refreshMarginMs?: number;
}

/** Tokens minted by your backend through the server-to-server exchange (no refresh token). */
export function backendTokenProvider(options: BackendTokenProviderOptions): TokenProvider {
    const margin = options.refreshMarginMs ?? 60_000;
    let cached: { token: string; expiresAt: number } | null = null;
    let inflight: Promise<string> | null = null;
    return {
        kind: "app",
        getToken({ forceRefresh } = {}) {
            if (!forceRefresh && cached && cached.expiresAt - Date.now() > margin) return Promise.resolve(cached.token);
            if (inflight) return inflight;
            inflight = (async () => {
                const issued = await options.fetchToken();
                const t = typeof issued === "string" ? { accessToken: issued } : issued;
                if (!t?.accessToken) throw new SpreeWeError({ code: "UNAUTHENTICATED", message: "fetchToken returned no accessToken" });
                cached = { token: t.accessToken, expiresAt: expiryOf(t) };
                return t.accessToken;
            })().finally(() => (inflight = null));
            return inflight;
        },
    };
}

/**
 * The user's own SpreeWe session (Clerk) token, e.g. `() => clerk.session?.getToken()`. These live
 * about 60 seconds, so the SDK asks for one right before every request and socket (re)connect.
 */
export function sessionTokenProvider(getToken: () => Promise<string | null | undefined>): TokenProvider {
    return {
        kind: "session",
        async getToken() {
            const t = await getToken();
            if (!t) throw new SpreeWeError({ code: "SIGNED_OUT", message: "Not signed in to SpreeWe." });
            return t;
        },
    };
}

function expiryOf(t: IssuedToken): number {
    if (t.expiresAt !== undefined) {
        const ms = t.expiresAt instanceof Date ? t.expiresAt.getTime() : typeof t.expiresAt === "number" ? t.expiresAt : Date.parse(t.expiresAt);
        if (Number.isFinite(ms)) return ms;
    }
    if (typeof t.expiresIn === "number") return Date.now() + t.expiresIn * 1000;
    const fromJwt = msUntilExpiry(t.accessToken);
    // Unknown expiry: treat as short-lived so it's re-fetched soon
    return Date.now() + (fromJwt ?? 120_000);
}
