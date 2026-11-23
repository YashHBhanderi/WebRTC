import type { Unsubscribe } from "../store.js";

/**
 * Where the SDK gets the bearer token for REST calls and the Socket.IO handshake. Pick one:
 *
 * - `createOAuthClient()`        browser apps without a backend: OAuth 2.0 authorization code + PKCE,
 *                                with rotating refresh tokens. Issues developer-app user tokens.
 * - `backendTokenProvider()`     your backend holds the app credential and mints tokens with
 *                                POST /v1/app-tokens; the browser asks your backend for one.
 * - `sessionTokenProvider()`     the user is signed in to SpreeWe itself (Clerk session) in your client.
 *
 * Every provider must return a fresh, unexpired token. The SDK calls `getToken({ forceRefresh: true })`
 * once after a 401 and before reconnecting a socket the server closed.
 */
export interface TokenProvider {
    /** "app": developer-app user token (scoped); "session": the user's SpreeWe (Clerk) session token */
    readonly kind: "app" | "session";
    getToken(options?: { forceRefresh?: boolean }): Promise<string>;
    /** Optional: notified when the provider signs out (refresh revoked, user withdrew access …) */
    onSignedOut?(listener: (reason: SignedOutReason) => void): Unsubscribe;
}

export type SignedOutReason = "revoked" | "expired" | "signed-out" | "error";

/** A token plus its absolute expiry, as returned by the backend token exchange. */
export interface IssuedToken {
    accessToken: string;
    /** Absolute expiry: epoch ms, ISO string or Date. Optional when `expiresIn` or the JWT `exp` is available. */
    expiresAt?: number | string | Date;
    /** Seconds from now */
    expiresIn?: number;
}

/**
 * Storage for OAuth state. `window.sessionStorage` (the default in browsers) keeps tokens per tab
 * and survives reloads; `"memory"` keeps nothing across reloads. Anything with getItem / setItem /
 * removeItem works (e.g. an encrypted storage wrapper).
 */
export interface KeyValueStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
