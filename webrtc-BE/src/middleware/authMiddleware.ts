import { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";
import CustomRequest from "../types/customRequest";
import { isAuthConfigured } from "../config/auth";
import { resolveLocalUserId } from "../services/identity.service";
import { resolveContext } from "../tenancy/tenant.service";
import { runWithContext } from "../tenancy/context";
import { AppError, publicMessage } from "../utils/errors";

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
