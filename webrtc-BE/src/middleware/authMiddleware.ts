import { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";
import CustomRequest from "../types/customRequest";
import { isAuthConfigured } from "../config/auth";
import { resolveLocalUserId } from "../services/identity.service";
import { resolveContext } from "../tenancy/tenant.service";
import { runWithContext } from "../tenancy/context";
import { AppError, publicMessage } from "../utils/errors";
import { AppScope } from "../developer/scopes";
import { looksLikeAppToken, tokenRejection } from "../developer/tokens";
import { verifyUserToken } from "../developer/app.service";
import { meterAppRequest } from "../developer/app-request";

/** Writes an authentication failure. Legacy routes keep `{ success, message }`; /v1 uses its envelope. */
export type AuthFailure = (res: Response, status: number, message: string) => void;

const legacyFailure: AuthFailure = (res, status, message) => {
    res.status(status).json({ success: false, message });
};

/**
 * Requires a signed-in Clerk session (Authorization: Bearer <session token>, verified by
 * clerkMiddleware in app.ts) and sets req.userId to the matching app user's MongoDB id.
 * 401 tells the client to sign in again.
 */
export function createVerifyToken(fail: AuthFailure = legacyFailure) {
    return async function verifyToken(req: Request, res: Response, next: NextFunction): Promise<void> {
        if (!isAuthConfigured()) {
            fail(res, 503, "Sign-in is not configured on the server");
            return;
        }
        const auth = getAuth(req);
        if (!auth.isAuthenticated || !auth.userId) {
            logRejection(req, res);
            fail(res, 401, "Please sign in to continue.");
            return;
        }
        let ctx;
        try {
            const userId = await resolveLocalUserId(auth.userId);
            // Workspace = Clerk's active organization in the verified session (never a request parameter)
            ctx = await resolveContext(userId, auth.userId, { orgId: auth.orgId, orgRole: auth.orgRole, orgSlug: auth.orgSlug }, (auth as any).sessionClaims?.iat ?? null);
            // Clerk fva = [minutes since first-factor verification, second factor]; used for re-auth checks
            const fva = (auth as any).sessionClaims?.fva;
            ctx.authAgeMinutes = Array.isArray(fva) && Number.isFinite(fva[0]) && fva[0] >= 0 ? fva[0] : null;
            (req as CustomRequest).userId = userId;
            (req as CustomRequest).ctx = ctx;
        } catch (error) {
            if (!(error instanceof AppError)) {
                console.error("[auth] could not resolve the signed-in user:", error instanceof Error ? error.message : error);
            }
            fail(res, error instanceof AppError ? error.status : 500, publicMessage(error, "Could not load your account"));
            return;
        }
        // Everything downstream (controllers, services, queries) runs inside this context
        runWithContext(ctx, () => next());
    };
}

const verifyToken = createVerifyToken();

/**
 * Session routes that developer applications may also call: a Clerk session works exactly as with
 * verifyToken; a developer-app user token is verified against the live app / grant / tenant state and
 * must carry `scope`. The handler is the same either way (same membership / role checks), and app
 * requests are metered and limited by the app's quota. `scope: null` = SpreeWe sessions only.
 */
export function requireUser(scope: AppScope | null) {
    const middleware = async function userOrApp(req: Request, res: Response, next: NextFunction): Promise<void> {
        const token = /^Bearer (.+)$/.exec(req.headers.authorization || "")?.[1]?.trim() ?? null;
        if (!looksLikeAppToken(token)) {
            return verifyToken(req, res, next);
        }
        if (!scope) {
            legacyFailure(res, 403, "This endpoint needs a signed-in SpreeWe session");
            return;
        }
        let ctx;
        const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
        try {
            ctx = await verifyUserToken(token!, { origin });
        } catch (error) {
            // One answer for every token failure (expired, revoked, disabled app, removed member…),
            // except a browser origin missing from the app's allow-list (see tokenRejection)
            const rejection = tokenRejection(error, origin);
            legacyFailure(res, rejection.status, rejection.message);
            return;
        }
        if (!ctx.app!.scopes.includes(scope)) {
            legacyFailure(res, 403, `The token lacks the ${scope} scope`);
            return;
        }
        (req as CustomRequest).userId = ctx.userId;
        (req as CustomRequest).ctx = ctx;
        // Apps with their own encryption device (e2ee:device) get ciphertext to decrypt; others never do
        if (!ctx.app!.scopes.includes("e2ee:device")) withoutCiphertext(res);
        meterAppRequest(req, res, () => runWithContext(ctx, () => next()));
    };
    // Exposed so tests can check that every session route made an explicit app-access decision
    return Object.assign(middleware, { appScope: scope });
}

/**
 * Developer apps hold no encryption device, so message ciphertext is never sent to them (same rule
 * as for app sockets and /v1): any `e2ee` object in a JSON response (history, saved messages, pins,
 * replies, search…) is replaced by `encrypted: true` with `content: null`.
 */
function withoutCiphertext(res: Response): void {
    const json = res.json.bind(res);
    res.json = (body: unknown) => json(stripE2ee(body, 0));
}

function stripE2ee(value: unknown, depth: number): unknown {
    if (depth > 12 || value === null || typeof value !== "object") return value;
    if (value instanceof Date) return value;
    if (Array.isArray(value)) return value.map((v) => stripE2ee(v, depth + 1));
    const source = typeof (value as any).toJSON === "function" ? (value as any).toJSON() : value;
    if (source === null || typeof source !== "object" || source instanceof Date) return source;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(source as Record<string, unknown>)) {
        if (k === "e2ee") continue;
        out[k] = stripE2ee(v, depth + 1);
    }
    if ("e2ee" in (source as Record<string, unknown>) && (source as any).e2ee) {
        out.encrypted = true;
        out.content = null;
    }
    return out;
}

const lastLogged = new Map<string, number>();

/**
 * Why Clerk refused a token that was sent (clerkMiddleware puts the reason in x-clerk-auth-*
 * response headers). Logged once a minute per reason; requests without a token are not logged.
 */
function logRejection(req: Request, res: Response): void {
    if (!req.headers.authorization) {
        return;
    }
    // Clerk's fixed reason code (bounded set) keys the limiter; the message is only logged
    const reason = String(res.getHeader("x-clerk-auth-reason") || "unknown").slice(0, 64);
    const message = String(res.getHeader("x-clerk-auth-message") || "");
    const now = Date.now();
    if (now - (lastLogged.get(reason) || 0) > 60_000) {
        lastLogged.set(reason, now);
        console.warn(`[auth] session token rejected (${reason})${message ? `: ${message.slice(0, 300)}` : ""}`);
    }
}

export default verifyToken;
