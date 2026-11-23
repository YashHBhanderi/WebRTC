/**
 * Read (never verify) a JWT's payload. Used only for client-side decisions such as "is this token
 * about to expire" and "which scopes does it carry"; the server verifies every token.
 */
export interface TokenClaims {
    sub?: string;
    exp?: number;
    iat?: number;
    /** App tokens: scopes */
    scp?: string[];
    /** App tokens: app id */
    app?: string;
    /** App tokens: tenant (workspace) id, null for global apps */
    tid?: string | null;
    [claim: string]: unknown;
}

export function decodeJwt(token: string): TokenClaims | null {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    try {
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const json = new TextDecoder().decode(bytes);
        const claims = JSON.parse(json);
        return claims && typeof claims === "object" ? (claims as TokenClaims) : null;
    } catch {
        return null;
    }
}

/** Developer-app tokens are JWS with kid "spreewe-app-v1" and an `scp` claim (Clerk tokens have neither). */
export function isAppToken(token: string): boolean {
    const header = token.split(".")[0];
    if (!header) return false;
    try {
        const h = JSON.parse(atob(header.replace(/-/g, "+").replace(/_/g, "/")));
        if (h?.kid === "spreewe-app-v1") return true;
    } catch {
        return false;
    }
    return Array.isArray(decodeJwt(token)?.scp);
}

/** Milliseconds until the token expires (negative when expired), or null without an `exp` claim. */
export function msUntilExpiry(token: string, now = Date.now()): number | null {
    const exp = decodeJwt(token)?.exp;
    return typeof exp === "number" ? exp * 1000 - now : null;
}
