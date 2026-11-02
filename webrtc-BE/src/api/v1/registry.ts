import { NextFunction, Request, Response, Router } from "express";
import { rateLimit } from "express-rate-limit";
import { createVerifyToken } from "../../middleware/authMiddleware";
import CustomRequest from "../../types/customRequest";
import { RequestContext, runWithContext } from "../../tenancy/context";
import { AppError, errorCodeFor, publicMessage } from "../../utils/errors";
import { securityConfig } from "../../config/security";
import { AppScope } from "../../developer/scopes";
import { looksLikeAppToken } from "../../developer/tokens";
import { authenticateCredential, recordUsage, verifyUserToken } from "../../developer/app.service";
import { IAppCredential, IDeveloperApp } from "../../developer/models";
import { Schema, ValidationError, validate } from "./schema";

/**
 * /v1 route registry. Every route registered here gets, in this order:
 *   1. authentication — mandatory, by auth mode (there is no "public" mode):
 *        "user"          Clerk session, or a developer-app user token IF the route names a `scope`
 *        "firstParty"    Clerk session only (app tokens refused)
 *        "appCredential" developer app server credential (Basic keyId:secret) — token exchange
 *   2. the trusted context (workspace from the session / app binding — never from the request)
 *   3. scope check for app tokens, CSRF guard for cookie-authenticated writes
 *   4. rate limits: per IP (app level), per app / per credential, stricter on `sensitive` routes
 *   5. validation of params, query and body (unknown fields rejected)
 *   6. the standard success / error envelope
 * The same definitions generate docs/api/openapi.yaml (npm run openapi).
 */
export type Method = "get" | "post" | "patch" | "delete";
export type AuthMode = "user" | "firstParty" | "appCredential";

export interface RouteInput {
    params: any;
    query: any;
    body: any;
    /** Set for "user" / "firstParty" routes */
    ctx: RequestContext;
    /** Set for "appCredential" routes */
    appAuth?: { app: IDeveloperApp; credential: IAppCredential };
    /** Request headers (read-only), e.g. the end-to-end encryption device id */
    headers: Record<string, string | string[] | undefined>;
}

export interface Paged<T> {
    items: T[];
    nextCursor: string | null;
}

export interface RouteDef {
    method: Method;
    /** Express-style path relative to /v1, e.g. /conversations/:conversationId/messages */
    path: string;
    summary: string;
    tag: string;
    description?: string;
    /** Default "user" */
    auth?: AuthMode;
    /** Scope an app token needs. Without it, app tokens can't use the route at all. */
    scope?: AppScope;
    sensitive?: boolean;
    /** Requires an active workspace (organization) in the context */
    workspace?: boolean;
    params?: Schema;
    query?: Schema;
    body?: Schema;
    /** Shape of `data` (or of each page item when paginated) */
    response: Schema;
    paginated?: boolean;
    /** Documented non-2xx statuses besides the common 400/401/403/429/500 */
    errors?: number[];
    handler: (input: RouteInput) => Promise<unknown>;
}

export const routes: RouteDef[] = [];

export function defineRoute(def: RouteDef): RouteDef {
    if (def.auth === "appCredential" && def.scope) {
        throw new Error(`${def.path}: appCredential routes don't take user scopes`);
    }
    routes.push(def);
    return def;
}

export const authModeOf = (def: RouteDef): AuthMode => def.auth || "user";

/** Error body shared by every /v1 failure. */
export function sendV1Error(res: Response, error: unknown): void {
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500) {
        console.error("[api:v1]", res.req?.method, res.req?.originalUrl?.split("?")[0], error instanceof Error ? error.message : error);
    }
    res.status(status).json({
        error: {
            code: errorCodeFor(status),
            message: publicMessage(error, "Something went wrong. Please try again."),
            ...(error instanceof ValidationError ? { details: error.details } : {}),
        },
    });
}

const bearer = (req: Request) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    return m ? m[1].trim() : null;
};

const clerkAuth = createVerifyToken((res, status, message) => sendV1Error(res, new AppError(message, status)));

/** Clerk session, or a developer-app user token (verified against live app / grant / tenant state). */
function userAuth(allowAppTokens: boolean) {
    return async (req: Request, res: Response, next: NextFunction) => {
        const token = bearer(req);
        if (!looksLikeAppToken(token)) {
            return clerkAuth(req, res, next);
        }
        if (!allowAppTokens) {
            return sendV1Error(res, new AppError("This endpoint needs a signed-in SpreeWe session", 403));
        }
        let ctx: RequestContext;
        try {
            ctx = await verifyUserToken(token!, { origin: typeof req.headers.origin === "string" ? req.headers.origin : null });
        } catch {
            // One answer for every token failure (expired, revoked, suspended app, removed member…)
            return sendV1Error(res, new AppError("Invalid or expired token", 401));
        }
        (req as CustomRequest).userId = ctx.userId;
        (req as CustomRequest).ctx = ctx;
        recordUsage(ctx.app!.appId, "apiRequests");
        runWithContext(ctx, () => next());
    };
}

async function credentialAuth(req: Request, res: Response, next: NextFunction) {
    try {
        (req as any).appAuth = await authenticateCredential(req.headers.authorization);
        recordUsage(String((req as any).appAuth.app._id), "apiRequests");
        next();
    } catch (error) {
        sendV1Error(res, error);
    }
}

export function buildV1Router(defs: RouteDef[] = routes): Router {
    const router = Router();
    const tooMany = (_req: Request, res: Response) => sendV1Error(res, new AppError("Too many requests. Please slow down and try again.", 429));
    const sensitive = rateLimit({
        windowMs: securityConfig.rateWindowMs, limit: securityConfig.rateSensitiveMax,
        standardHeaders: "draft-7", legacyHeaders: false, handler: tooMany,
    });
    // Per app (app tokens): the app's own quota; keyed by app so many users / IPs share it
    const perApp = rateLimit({
        windowMs: 60_000,
        limit: (req) => (req as CustomRequest).ctx?.app?.quotas.rateLimitPerMinute ?? 60,
        keyGenerator: (req) => `app:${(req as CustomRequest).ctx?.app?.appId}`,
        skip: (req) => !(req as CustomRequest).ctx?.app,
        standardHeaders: "draft-7", legacyHeaders: false, handler: tooMany,
    });
    // Per credential (token exchange / revoke)
    const perCredential = rateLimit({
        windowMs: 60_000,
        limit: () => Number(process.env.APP_CREDENTIAL_RATE_PER_MIN) > 0 ? Number(process.env.APP_CREDENTIAL_RATE_PER_MIN) : 120,
        keyGenerator: (req) => `cred:${(req as any).appAuth?.credential?.keyId}`,
        standardHeaders: "draft-7", legacyHeaders: false, handler: tooMany,
    });

    for (const def of defs) {
        const mode = authModeOf(def);
        const chain: ((req: Request, res: Response, next: NextFunction) => unknown)[] = [];
        if (mode === "appCredential") {
            chain.push(credentialAuth, perCredential);
        } else {
            chain.push(userAuth(mode === "user" && !!def.scope), perApp);
        }
        if (def.sensitive) chain.push(sensitive);
        chain.push(async (req, res) => {
            try {
                const ctx = (req as CustomRequest).ctx;
                if (mode !== "appCredential") {
                    if (!ctx) throw new AppError("Please sign in to continue.", 401);
                    if (ctx.app) {
                        if (!def.scope) throw new AppError("This endpoint needs a signed-in SpreeWe session", 403);
                        if (!ctx.app.scopes.includes(def.scope)) throw new AppError(`The token lacks the ${def.scope} scope`, 403);
                    } else if (def.method !== "get" && !req.headers.authorization && req.headers.cookie) {
                        // Cookie-authenticated browser writes could be forged cross-site (CSRF): require the header
                        throw new AppError("Send the session token in the Authorization header", 403);
                    }
                    if (def.workspace && !ctx.tenantId) throw new AppError("This endpoint needs an active workspace", 400);
                }
                const input: RouteInput = {
                    ctx: ctx as RequestContext,
                    appAuth: (req as any).appAuth,
                    headers: req.headers,
                    params: def.params ? validate(def.params, req.params) : {},
                    query: def.query ? validate(def.query, req.query) : {},
                    body: def.body ? validate(def.body, req.body ?? {}) : {},
                };
                const result = await def.handler(input);
                if (def.paginated) {
                    const page = result as Paged<unknown>;
                    res.status(200).json({ data: page.items, page: { nextCursor: page.nextCursor } });
                } else {
                    res.status(def.method === "post" ? 201 : 200).json({ data: result });
                }
            } catch (error) {
                sendV1Error(res, error);
            }
        });
        router[def.method](def.path, ...(chain as any));
    }

    // Unknown /v1 paths: authenticate first (401 before 404), then 404
    router.use(userAuth(false), (_req: Request, res: Response) => sendV1Error(res, new AppError("Not found", 404)));
    return router;
}
