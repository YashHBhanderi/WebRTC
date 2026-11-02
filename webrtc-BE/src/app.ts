import express from "express";
import oauthRouter from "./api/oauth.routes";
import path from "path";
import cors from "cors";
import router from "./routes/routes";
import { uploadSingle } from "./utils/multer";
import { requireUser } from "./middleware/authMiddleware";
import uploadFile from "./controllers/upload.controller";
import { logger } from "./utils/logger";
import { storageConfig } from "./config/storage";
import { clerkMiddleware } from "@clerk/express";
import { authConfig, isAuthConfigured } from "./config/auth";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { securityConfig } from "./config/security";
import tenantRouter from "./routes/tenant.routes";
import { clerkWebhookHandler } from "./integrations/clerk-webhooks";
import { liveness, readiness } from "./health";
import { serveLegacyFile } from "./services/legacy-files.service";
import { isAppOrigin } from "./developer/origins";
import { buildV1Router } from "./api/v1/registry";
import "./api/v1/routes";
import "./api/v1/developer.routes";
import "./api/v1/webhook.routes";
import "./api/v1/workspace.routes";
import "./api/v1/organization.routes";
import "./api/v1/team.routes";
import "./api/v1/contact.routes";
import "./api/v1/e2ee.routes";

/** Express app: middleware + REST routes. Socket.IO lives in ./realtime. */
export function createApp(corsOrigin: string[] | "*") {
    const app = express();

    app.set("trust proxy", securityConfig.trustProxy);
    app.disable("x-powered-by");

    app.use(logger);
    // Security headers. Media links are loaded by the web app from another origin.
    app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
    // First-party origins everywhere; registered developer-app origins too (their tokens are bound to
    // their own origins, session tokens to CLERK_AUTHORIZED_PARTIES, and nothing uses cookies).
    // Never with credentials (no cookies): tokens are sent in the Authorization header.
    const firstParty = (origin: string) => corsOrigin === "*" || corsOrigin.includes(origin);
    app.use(cors((req, callback) => {
        const origin = req.headers.origin;
        if (!origin || firstParty(origin)) {
            return callback(null, { origin: corsOrigin, credentials: false });
        }
        isAppOrigin(origin).then((ok) => callback(null, { origin: ok ? origin : false, credentials: false }), () => callback(null, { origin: false }));
    }));
    // Per-IP limits: everything, and a stricter one for expensive / abusable endpoints
    const limiterBase = { windowMs: securityConfig.rateWindowMs, standardHeaders: "draft-7" as const, legacyHeaders: false, message: { success: false, message: "Too many requests. Please slow down and try again." } };
    app.use(rateLimit({ ...limiterBase, limit: securityConfig.rateMax }));
    const sensitive = rateLimit({ ...limiterBase, limit: securityConfig.rateSensitiveMax });
    for (const prefix of ["", "/api"]) {
        app.post(`${prefix}/upload`, sensitive);
        app.get(`${prefix}/search`, sensitive);
        app.post(`${prefix}/conversations/group`, sensitive);
        app.post(`${prefix}/meetings`, sensitive);
        app.post(`${prefix}/meetings/code/:code/join`, sensitive);
        app.post(`${prefix}/tenant/external-conversations`, sensitive);
        app.patch(`${prefix}/tenant/current/policies`, sensitive);
    }
    // Clerk webhooks (Svix-signed): the signature covers the exact bytes, so this route gets the raw
    // body and is registered before the JSON parser. No session auth: the signature is the auth.
    app.post(["/webhooks/clerk", "/api/webhooks/clerk"], express.raw({ type: "*/*", limit: "1mb" }), clerkWebhookHandler);
    app.use(express.json({ limit: securityConfig.jsonLimit }));
    app.use(express.urlencoded({ extended: true, limit: securityConfig.jsonLimit }));
    // Reads the Clerk session token (Authorization: Bearer …); routes opt in via verifyToken
    if (isAuthConfigured()) {
        const base = { jwtKey: authConfig.jwtKey, clockSkewInMs: authConfig.clockSkewMs };
        // Website (browser): the token must come from one of our origins (azp check).
        const webAuth = clerkMiddleware({
            ...base,
            authorizedParties: authConfig.authorizedParties.length ? authConfig.authorizedParties : undefined,
        });
        // Mobile app: native tokens carry no azp, and Clerk forbids Origin + Authorization together.
        const appAuth = clerkMiddleware(base);
        app.use((req, res, next) => {
            const isApp = !req.headers.origin && !!req.headers.authorization?.startsWith("Bearer ");
            return (isApp ? appAuth : webAuth)(req, res, next);
        });
    }

    const api = express.Router();
    // Versioned API: every /v1 route is authenticated, context-scoped, validated (src/api/v1)
    api.use("/v1", buildV1Router());
    // OAuth 2.0 (authorization code + PKCE, refresh tokens) for developer apps: public endpoints
    api.use("/oauth", oauthRouter);
    api.use(router);
    api.use(tenantRouter);
    // Stored files (S3): upload needs a session; clients read straight from S3 (see file.service)
    api.post("/upload", requireUser("files:write"), uploadSingle("file"), uploadFile);
    // Public client settings (no secrets): bucket address for public pictures, Clerk publishable key
    // Load-balancer probes (unauthenticated, no internal details)
    api.get("/health/live", liveness);
    api.get("/health/ready", readiness);
    api.get("/config", (_req, res) => {
        res.json({ status: true, data: { s3BaseUrl: storageConfig.publicBaseUrl, clerkPublishableKey: authConfig.publishableKey }, message: "" });
    });

    // Every endpoint answers with and without the /api prefix, so it works whether the reverse
    // proxy strips the prefix (dev proxy.conf.js) or forwards /api/* unchanged (nginx on the server)
    app.use("/api", api);
    app.use("/", api);
    // Legacy on-disk uploads: no longer public. Only short-lived signed links (issued when an
    // authorized member reads the message that references the file) are served.
    app.get(["/uploads/:name", "/api/uploads/:name"], serveLegacyFile);

    return app;
}
