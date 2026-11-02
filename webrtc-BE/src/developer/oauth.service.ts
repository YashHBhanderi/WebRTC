import crypto from "crypto";
import mongoose from "mongoose";
import { runAsSystem } from "../tenancy/context";
import { DeveloperApp, IDeveloperApp, IRefreshToken, OAuthCode, RefreshToken } from "./models";
import { authenticateCredential, createConsentRequest, mintUserToken } from "./app.service";
import { isScope } from "./scopes";

/**
 * OAuth 2.0 authorization-code flow with PKCE (S256) and rotating refresh tokens, for apps without a
 * backend (mobile, single-page) and for backends alike. Built on the existing consent request: the
 * user approves on the SpreeWe consent page, and the approval yields a one-time code instead of a grant
 * id. Access tokens are the usual app user tokens (short-lived, scoped, re-checked on every request).
 *
 *   GET  /oauth/authorize  response_type=code, client_id (app id), redirect_uri (exact match),
 *                          scope (space-separated), state, code_challenge, code_challenge_method=S256
 *   POST /oauth/token      grant_type=authorization_code | refresh_token
 *   POST /oauth/revoke     token=<refresh token>  (RFC 7009: always 200)
 *
 * Codes and refresh tokens are stored only as SHA-256 hashes. A refresh token works once: each use
 * returns a new one, and presenting a used token revokes its whole family (theft detection).
 *   OAUTH_REFRESH_TTL_DAYS  refresh-token lifetime, sliding on each refresh (default 30, 1–365)
 */
const CODE_TTL_MS = 2 * 60_000;
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("base64url");
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const sys = <T>(fn: () => Promise<T>, label: string) => runAsSystem(fn, label);

function refreshTtlMs(): number {
    const days = Number(process.env.OAUTH_REFRESH_TTL_DAYS);
    return (Number.isFinite(days) && days >= 1 && days <= 365 ? days : 30) * 86_400_000;
}

/** RFC 6749 error: `{ error, error_description }` */
export class OAuthError extends Error {
    constructor(readonly code: string, readonly description: string, readonly status = 400) {
        super(description);
    }
}

/** The app named by client_id, active. With client credentials (Basic), they must belong to it. */
async function clientApp(clientId: unknown, authorization?: string): Promise<IDeveloperApp> {
    if (typeof clientId !== "string" || !mongoose.isValidObjectId(clientId)) throw new OAuthError("invalid_client", "Unknown client_id", 401);
    const app = await sys(() => DeveloperApp.findById(clientId).lean<IDeveloperApp>(), "oauth-client");
    if (!app || app.status !== "active") throw new OAuthError("invalid_client", "Unknown or inactive client", 401);
    if (authorization?.startsWith("Basic ")) {
        let auth;
        try {
            auth = await authenticateCredential(authorization);
        } catch {
            throw new OAuthError("invalid_client", "Invalid client credentials", 401);
        }
        if (String(auth.app._id) !== String(app._id)) throw new OAuthError("invalid_client", "The credentials belong to another client", 401);
    }
    return app;
}

// ------------------------------------------------------------------ authorize

/**
 * Validates the request and creates a consent request carrying the PKCE challenge. Problems with
 * client_id / redirect_uri are answered directly (never redirect to an unverified URI); other problems
 * are sent back to the app's redirect_uri as `error`, as RFC 6749 §4.1.2.1 requires.
 */
export async function authorize(q: Record<string, unknown>): Promise<{ redirect: string }> {
    const app = await clientApp(q.client_id);
    const redirectUri = typeof q.redirect_uri === "string" ? q.redirect_uri : "";
    let normalized: string;
    try {
        normalized = new URL(redirectUri).toString();
    } catch {
        throw new OAuthError("invalid_request", "redirect_uri is not a valid URL");
    }
    if (!app.callbackUrls.includes(normalized)) throw new OAuthError("invalid_request", "redirect_uri must exactly match one of the app's redirect URLs");
    const state = typeof q.state === "string" ? q.state : "";
    const back = (error: string, description: string) => {
        const url = new URL(normalized);
        url.searchParams.set("error", error);
        url.searchParams.set("error_description", description);
        if (state) url.searchParams.set("state", state);
        return { redirect: url.toString() };
    };
    if (q.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
    if (q.code_challenge_method !== "S256" || typeof q.code_challenge !== "string" || !CHALLENGE.test(q.code_challenge)) {
        return back("invalid_request", "PKCE is required: code_challenge (base64url SHA-256) with code_challenge_method=S256");
    }
    if (state.length < 8 || state.length > 200 || !/^[!-~]+$/.test(state)) return back("invalid_request", "state must be 8–200 visible characters");
    const scopes = typeof q.scope === "string" ? q.scope.split(" ").filter(Boolean) : [];
    if (!scopes.length || scopes.some((s) => !isScope(s) || !app.scopes.includes(s))) return back("invalid_scope", "Request scopes the app has been configured with");
    const { consentUrl } = await createConsentRequest({ app }, { redirectUri: normalized, scopes, state, codeChallenge: q.code_challenge });
    return { redirect: consentUrl };
}

/** Called when the user approves an OAuth consent request: a one-time code bound to the PKCE challenge. */
export async function createAuthorizationCode(app: IDeveloperApp, userId: string, scopes: string[], redirectUri: string, codeChallenge: string): Promise<string> {
    const code = `swc_${crypto.randomBytes(32).toString("base64url")}`;
    await sys(() => OAuthCode.create({
        _id: hash(code), appId: app._id, userId: oid(userId), scopes, redirectUri, codeChallenge,
        expiresAt: new Date(Date.now() + CODE_TTL_MS), usedAt: null,
    }), "oauth-code");
    return code;
}

// ------------------------------------------------------------------ token

type TokenResponse = { access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string };

export async function token(body: Record<string, unknown>, authorization?: string): Promise<TokenResponse> {
    const app = await clientApp(body.client_id, authorization);
    if (body.grant_type === "authorization_code") return exchangeCode(app, body);
    if (body.grant_type === "refresh_token") return useRefreshToken(app, body);
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

async function exchangeCode(app: IDeveloperApp, body: Record<string, unknown>): Promise<TokenResponse> {
    const code = typeof body.code === "string" ? body.code : "";
    const verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
    if (!code || !VERIFIER.test(verifier)) throw new OAuthError("invalid_request", "code and a valid code_verifier are required");
    // One use only, claimed atomically
    const row = await sys(() => OAuthCode.findOneAndUpdate(
        // Only this client can consume its code (another client_id can't burn it)
        { _id: hash(code), appId: app._id, usedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { usedAt: new Date() } },
    ).lean(), "oauth-code");
    if (!row) throw new OAuthError("invalid_grant", "The code is invalid, expired or already used");
    if (body.redirect_uri !== row.redirectUri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match the authorization request");
    if (hash(verifier) !== row.codeChallenge) throw new OAuthError("invalid_grant", "code_verifier doesn't match the code_challenge");
    return issuePair(app, String(row.userId), row.scopes, crypto.randomUUID());
}

async function useRefreshToken(app: IDeveloperApp, body: Record<string, unknown>): Promise<TokenResponse> {
    const presented = typeof body.refresh_token === "string" ? body.refresh_token : "";
    if (!presented) throw new OAuthError("invalid_request", "refresh_token is required");
    const id = hash(presented);
    const row = await sys(() => RefreshToken.findOneAndUpdate(
        { _id: id, appId: app._id, usedAt: null, revokedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { usedAt: new Date() } },
    ).lean<IRefreshToken>(), "oauth-refresh");
    if (!row) {
        // A token that exists but was already used / revoked: assume theft, end the whole family
        const known = await sys(() => RefreshToken.findOne({ _id: id, appId: app._id }).lean<IRefreshToken>(), "oauth-refresh");
        if (known) await revokeFamily(known.familyId);
        throw new OAuthError("invalid_grant", "The refresh token is invalid, expired or already used");
    }
    const asked = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : row.scopes;
    if (asked.some((s) => !row.scopes.includes(s))) throw new OAuthError("invalid_scope", "A refresh can only narrow the scopes");
    return issuePair(app, String(row.userId), asked, row.familyId);
}

/** Access token (grant, scopes, user and membership re-checked) + a new refresh token in the family. */
async function issuePair(app: IDeveloperApp, userId: string, scopes: string[], familyId: string): Promise<TokenResponse> {
    let access;
    try {
        access = await mintUserToken(app, { userId, scopes });
    } catch (error: any) {
        // Grant withdrawn / narrowed, user removed from the workspace, scopes removed from the app…
        await revokeFamily(familyId);
        throw new OAuthError("invalid_grant", error?.message || "The user's authorization is no longer valid");
    }
    const refresh = `swr_${crypto.randomBytes(32).toString("base64url")}`;
    await sys(() => RefreshToken.create({
        _id: hash(refresh), familyId, appId: app._id, userId: oid(userId), scopes: access.scopes,
        expiresAt: new Date(Date.now() + refreshTtlMs()), usedAt: null, revokedAt: null,
    }), "oauth-refresh");
    return { access_token: access.accessToken, token_type: "Bearer", expires_in: access.expiresIn, refresh_token: refresh, scope: access.scopes.join(" ") };
}

async function revokeFamily(familyId: string): Promise<void> {
    await sys(() => RefreshToken.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } }), "oauth-refresh");
}

// ------------------------------------------------------------------ revoke

/** RFC 7009: revoke a refresh token (and its family). Unknown tokens are not an error. */
export async function revoke(body: Record<string, unknown>, authorization?: string): Promise<void> {
    const app = await clientApp(body.client_id, authorization);
    const presented = typeof body.token === "string" ? body.token : "";
    if (!presented) throw new OAuthError("invalid_request", "token is required");
    const row = await sys(() => RefreshToken.findOne({ _id: hash(presented), appId: app._id }).lean<IRefreshToken>(), "oauth-refresh");
    if (row) await revokeFamily(row.familyId);
}

/** All refresh tokens of an app (or of one user of it) stop working: used when grants / apps are revoked. */
export async function revokeRefreshTokens(appId: string, userId?: string): Promise<void> {
    await sys(() => RefreshToken.updateMany({ appId: oid(appId), revokedAt: null, ...(userId ? { userId: oid(userId) } : {}) }, { $set: { revokedAt: new Date() } }), "oauth-refresh");
}
