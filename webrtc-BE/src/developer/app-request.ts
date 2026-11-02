import { NextFunction, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import CustomRequest from "../types/customRequest";
import { recordUsage } from "./app.service";

/**
 * Shared by every route an app token can call (/v1 and the session routes), so an app has ONE
 * request budget, not one per router: its own quota per minute, keyed by app (many users / IPs share
 * it). Requests without an app context are not counted here.
 */
export const appRateLimit = rateLimit({
    windowMs: 60_000,
    limit: (req) => (req as CustomRequest).ctx?.app?.quotas.rateLimitPerMinute ?? 60,
    keyGenerator: (req) => `app:${(req as CustomRequest).ctx?.app?.appId}`,
    skip: (req) => !(req as CustomRequest).ctx?.app,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req: Request, res: Response) => {
        const message = "Too many requests. Please slow down and try again.";
        // Same envelope as the router the request belongs to
        if (/^\/(api\/)?v1\//.test(req.originalUrl)) {
            res.status(429).json({ error: { code: "RATE_LIMIT_ERROR", message } });
        } else {
            res.status(429).json({ success: false, message });
        }
    },
});

/** Usage: an authenticated app request that ends with status >= 400 (failures before the app is known are not attributable) */
export function countAppErrors(res: Response, appId: string): void {
    res.once("finish", () => {
        if (res.statusCode >= 400) recordUsage(appId, "apiErrors");
    });
}

/** Meter an authenticated app request (requests + errors), then apply the app's rate limit. */
export function meterAppRequest(req: Request, res: Response, next: NextFunction): void {
    const appId = (req as CustomRequest).ctx?.app?.appId;
    if (appId) {
        recordUsage(appId, "apiRequests");
        countAppErrors(res, appId);
    }
    appRateLimit(req, res, next);
}
