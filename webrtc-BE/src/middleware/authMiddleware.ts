import { NextFunction, Request, Response } from "express";
import { getAuth } from "@clerk/express";
import CustomRequest from "../types/customRequest";
import { isAuthConfigured } from "../config/auth";
import { resolveLocalUserId } from "../services/identity.service";
import { AppError, publicMessage } from "../utils/errors";

/**
 * Requires a signed-in Clerk session (Authorization: Bearer <session token>, verified by
 * clerkMiddleware in app.ts) and sets req.userId to the matching app user's MongoDB id.
 * 401 tells the client to sign in again.
 */
async function verifyToken(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!isAuthConfigured()) {
        res.status(503).json({ success: false, message: "Sign-in is not configured on the server" });
        return;
    }
    const auth = getAuth(req);
    if (!auth.isAuthenticated || !auth.userId) {
        logRejection(req, res);
        res.status(401).json({ success: false, message: "Please sign in to continue." });
        return;
    }
    try {
        (req as CustomRequest).userId = await resolveLocalUserId(auth.userId);
        next();
    } catch (error) {
        if (!(error instanceof AppError)) {
            console.error("[auth] could not resolve the signed-in user:", error instanceof Error ? error.message : error);
        }
        res.status(error instanceof AppError ? error.status : 500).json({ success: false, message: publicMessage(error, "Could not load your account") });
    }
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
