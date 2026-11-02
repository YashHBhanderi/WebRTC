import crypto from "crypto";

/**
 * Scoped user tokens for developer apps: compact JWS (HS256), signed with PLATFORM_TOKEN_SECRET.
 * Only the server ever holds the key. Verification is strict: exact header (alg HS256, kid),
 * signature (timing-safe), issuer, audience = the app named in the token, lifetime bounds.
 * Database-backed checks (app status, versions, revocation, membership) happen in app.service.
 *
 *   PLATFORM_TOKEN_SECRET          32+ chars; required in production, shared by all instances
 *   APP_TOKEN_DEFAULT_TTL_SECONDS  default 600
 *   APP_TOKEN_MAX_TTL_SECONDS      upper bound (60–3600, default 900)
 */
export const TOKEN_ISSUER = "spreewe";
export const TOKEN_KID = "spreewe-app-v1";
const CLOCK_SKEW_S = 30;

export interface AppTokenClaims {
    iss: string;
    aud: string;
    /** SpreeWe (local) user id */
    sub: string;
    app: string;
    env: "development" | "production";
    /** Tenant the token is bound to, or null (global app) */
    tid: string | null;
    scp: string[];
    jti: string;
    iat: number;
    exp: number;
    /** App token version at issue time */
    tv: number;
    /** Grant id + version at issue time */
    gid: string;
    gv: number;
}

let ephemeral: string | null = null;

function key(): string {
    const configured = process.env.PLATFORM_TOKEN_SECRET;
    if (configured && configured.length >= 32) return configured;
    if (process.env.NODE_ENV === "production") {
        throw new Error("PLATFORM_TOKEN_SECRET (32+ characters) must be set in production");
    }
    ephemeral = ephemeral || crypto.randomBytes(48).toString("base64url");
    return ephemeral;
}

export function maxTtlSeconds(): number {
    const n = Number(process.env.APP_TOKEN_MAX_TTL_SECONDS);
    return Number.isFinite(n) && n > 0 ? Math.min(3600, Math.max(60, Math.floor(n))) : 900;
}

export function defaultTtlSeconds(): number {
    const n = Number(process.env.APP_TOKEN_DEFAULT_TTL_SECONDS);
    return Math.min(maxTtlSeconds(), Number.isFinite(n) && n >= 60 ? Math.floor(n) : 600);
}

export const audienceFor = (appId: string) => `spreewe:app:${appId}`;

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const sign = (input: string) => crypto.createHmac("sha256", key()).update(input).digest("base64url");

export function signAppToken(claims: Omit<AppTokenClaims, "iss" | "aud" | "iat" | "exp" | "jti">, ttlSeconds: number, nowMs = Date.now()): { token: string; claims: AppTokenClaims } {
    const iat = Math.floor(nowMs / 1000);
    const full: AppTokenClaims = {
        ...claims,
        iss: TOKEN_ISSUER,
        aud: audienceFor(claims.app),
        iat,
        exp: iat + Math.min(maxTtlSeconds(), Math.max(60, Math.floor(ttlSeconds))),
        jti: crypto.randomBytes(16).toString("base64url"),
    };
    const head = b64({ alg: "HS256", typ: "JWT", kid: TOKEN_KID });
    const body = b64(full);
    return { token: `${head}.${body}.${sign(`${head}.${body}`)}`, claims: full };
}

/** Cheap check used to route a bearer token to app-token verification instead of Clerk. */
export function looksLikeAppToken(token: string | undefined | null): boolean {
    if (!token || token.split(".").length !== 3) return false;
    try {
        const head = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
        return head?.kid === TOKEN_KID;
    } catch {
        return false;
    }
}

export class AppTokenError extends Error {
    constructor(public readonly reason: string) {
        super("Invalid or expired token");
        this.name = "AppTokenError";
    }
}

/** Signature and claim checks only (no database). Throws AppTokenError. */
export function verifyAppTokenSignature(token: string, nowMs = Date.now()): AppTokenClaims {
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 4096) throw new AppTokenError("format");
    let head: any;
    let claims: any;
    try {
        head = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch {
        throw new AppTokenError("format");
    }
    // Exact header: no alg "none", no algorithm switching, no foreign keys
    if (head?.alg !== "HS256" || head?.kid !== TOKEN_KID || Object.keys(head).some((k) => !["alg", "typ", "kid"].includes(k))) {
        throw new AppTokenError("header");
    }
    const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
    const given = Buffer.from(parts[2]);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        throw new AppTokenError("signature");
    }
    const now = Math.floor(nowMs / 1000);
    const str = (v: unknown) => typeof v === "string" && v.length > 0 && v.length < 200;
    if (claims?.iss !== TOKEN_ISSUER || !str(claims.app) || claims.aud !== audienceFor(claims.app)) throw new AppTokenError("audience");
    if (!str(claims.sub) || !str(claims.jti) || !str(claims.gid) || !Array.isArray(claims.scp) || !claims.scp.every(str)) throw new AppTokenError("claims");
    if (claims.env !== "development" && claims.env !== "production") throw new AppTokenError("claims");
    if (claims.tid !== null && !str(claims.tid)) throw new AppTokenError("claims");
    if (!Number.isInteger(claims.iat) || !Number.isInteger(claims.exp) || !Number.isInteger(claims.tv) || !Number.isInteger(claims.gv)) throw new AppTokenError("claims");
    if (claims.iat > now + CLOCK_SKEW_S) throw new AppTokenError("not-yet-valid");
    if (claims.exp <= now) throw new AppTokenError("expired");
    if (claims.exp - claims.iat > maxTtlSeconds()) throw new AppTokenError("lifetime");
    return claims as AppTokenClaims;
}
