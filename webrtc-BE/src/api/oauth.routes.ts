import { Request, Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import { securityConfig } from "../config/security";
import { OAuthError, authorize, revoke, token } from "../developer/oauth.service";

/**
 * OAuth 2.0 endpoints (RFC 6749 + PKCE RFC 7636, revocation RFC 7009). Public: the client is identified
 * by client_id (the app id) and PKCE; apps with a backend may also send their client credentials
 * (HTTP Basic). See developer/oauth.service.ts.
 */
const router = Router();

const limited = rateLimit({
    windowMs: securityConfig.rateWindowMs,
    limit: securityConfig.rateSensitiveMax,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: "slow_down", error_description: "Too many requests. Please slow down and try again." }),
});

function fail(res: Response, error: unknown): void {
    if (error instanceof OAuthError) {
        res.status(error.status).json({ error: error.code, error_description: error.description });
        return;
    }
    console.error("[oauth]", error instanceof Error ? error.message : error);
    res.status(500).json({ error: "server_error", error_description: "Something went wrong. Please try again." });
}

const noStore = (res: Response) => res.set({ "Cache-Control": "no-store", Pragma: "no-cache" });

/** Browser navigation: on success, a redirect to the SpreeWe consent page (or back to the app with an error). */
router.get("/authorize", limited, async (req: Request, res: Response) => {
    try {
        res.redirect(302, (await authorize(req.query as Record<string, unknown>)).redirect);
    } catch (error) {
        fail(res, error);
    }
});

router.post("/token", limited, async (req: Request, res: Response) => {
    noStore(res);
    try {
        res.status(200).json(await token(req.body || {}, req.headers.authorization));
    } catch (error) {
        fail(res, error);
    }
});

router.post("/revoke", limited, async (req: Request, res: Response) => {
    noStore(res);
    try {
        await revoke(req.body || {}, req.headers.authorization);
        res.status(200).json({});
    } catch (error) {
        fail(res, error);
    }
});

export default router;
