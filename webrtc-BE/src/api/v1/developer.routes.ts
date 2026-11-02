import {
    adminListApps, appAudit, appUsage, createApp, createConsentRequest, createCredential, decideConsentRequest, getApp, grantApp, issueToken, listCredentials,
    listMyApps, listMyGrants, revokeAllTokens, revokeCredential, revokeMyGrant, revokeToken, rotateCredential, scopeCatalog, setAppStatus, updateApp, viewConsentRequest,
} from "../../developer/app.service";
import { ALL_SCOPES } from "../../developer/scopes";
import { defineRoute } from "./registry";
import { S } from "./schema";

/**
 * Developer platform endpoints.
 *   - Management (apps, credentials, usage, audit): first-party SpreeWe sessions only, owner in the
 *     app's own context; platform admins may read metadata and suspend / reactivate.
 *   - Consent (grants): the user themselves, first-party session.
 *   - Token exchange / revoke: the app's server credential (never a browser).
 * High-impact actions require `confirm` = the app's exact name (and a recent sign-in when the
 * session carries Clerk's fva claim).
 */
const scopeList = S.array(S.enum(ALL_SCOPES), { max: ALL_SCOPES.length });
const appIdParams = S.object({ appId: S.objectId() });
const confirm = S.string({ max: 80, description: "The app's exact name (confirmation of a high-impact action)" });
const quotas = S.object({
    rateLimitPerMinute: S.int({ optional: true, min: 1, max: 6000 }),
    maxConnections: S.int({ optional: true, min: 1, max: 10_000 }),
    messagesPerDay: S.int({ optional: true, min: 0, max: 1_000_000 }),
}, { optional: true, description: "Development apps have lower caps (120 / 20 / 2000)" } as any);

const appDoc = S.doc({
    type: "object",
    properties: {
        _id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, websiteUrl: { type: "string" }, environment: { type: "string", enum: ["development", "production"] },
        status: { type: "string", enum: ["active", "suspended", "revoked"] }, tenantId: { type: "string", nullable: true },
        scopes: { type: "array", items: { type: "string", enum: [...ALL_SCOPES] } },
        allowedOrigins: { type: "array", items: { type: "string" } }, callbackUrls: { type: "array", items: { type: "string" } },
        quotas: { type: "object", properties: { rateLimitPerMinute: { type: "integer" }, maxConnections: { type: "integer" }, messagesPerDay: { type: "integer" } } },
    },
});
const credentialDoc = { type: "object", properties: { _id: { type: "string" }, keyId: { type: "string" }, hint: { type: "string" }, status: { type: "string", enum: ["active", "rotated", "revoked"] }, graceUntil: { type: "string", nullable: true }, expiresAt: { type: "string", nullable: true }, lastUsedAt: { type: "string", nullable: true } } };

// ------------------------------------------------------------------ apps

defineRoute({
    method: "get", path: "/scopes", tag: "Developer apps", auth: "firstParty",
    summary: "Permissions (scopes) an app can request, with descriptions",
    description: "`sensitive` scopes are highlighted on the consent screen; `available: false` scopes exist but currently grant nothing.",
    response: S.doc({ type: "array", items: { type: "object", properties: { scope: { type: "string" }, description: { type: "string" }, sensitive: { type: "boolean" }, available: { type: "boolean" } } } }),
    handler: async () => scopeCatalog(),
});


defineRoute({
    method: "post", path: "/apps", tag: "Developer apps", auth: "firstParty", sensitive: true,
    summary: "Register an app (global from the personal context, or bound to the active workspace)",
    description: "tenantBound apps need the workspace owner/admin role and act only in that workspace. Scopes default to none.",
    body: S.object({
        name: S.string({ min: 2, max: 80 }),
        description: S.string({ optional: true, max: 500 }),
        websiteUrl: S.string({ optional: true, max: 300, description: "Absolute http(s) URL, or empty" }),
        environment: S.enum(["development", "production"] as const),
        tenantBound: S.bool({ optional: true }),
        scopes: S.array(S.enum(ALL_SCOPES), { optional: true, max: ALL_SCOPES.length }),
        allowedOrigins: S.array(S.string({ max: 300 }), { optional: true, max: 20 }),
        callbackUrls: S.array(S.string({ max: 300 }), { optional: true, max: 20 }),
        quotas,
    }),
    response: appDoc,
    handler: ({ ctx, body }) => createApp(ctx, body),
});

defineRoute({
    method: "get", path: "/apps", tag: "Developer apps", auth: "firstParty",
    summary: "My apps in the active context", response: S.doc({ type: "array", items: appDoc.openapi() }),
    handler: ({ ctx }) => listMyApps(ctx),
});

defineRoute({
    method: "get", path: "/apps/:appId", tag: "Developer apps", auth: "firstParty", errors: [404],
    summary: "App configuration (owner, or platform admin)", params: appIdParams, response: appDoc,
    handler: ({ ctx, params }) => getApp(ctx, params.appId),
});

defineRoute({
    method: "patch", path: "/apps/:appId", tag: "Developer apps", auth: "firstParty", sensitive: true, errors: [404, 409],
    summary: "Update name, description, website, scopes, origins, callback URLs or quotas (owner)",
    params: appIdParams,
    body: S.object({
        name: S.string({ optional: true, min: 2, max: 80 }),
        description: S.string({ optional: true, max: 500 }),
        websiteUrl: S.string({ optional: true, max: 300, description: "Absolute http(s) URL, or empty to clear" }),
        scopes: S.array(S.enum(ALL_SCOPES), { optional: true, max: ALL_SCOPES.length }),
        allowedOrigins: S.array(S.string({ max: 300 }), { optional: true, max: 20 }),
        callbackUrls: S.array(S.string({ max: 300 }), { optional: true, max: 20 }),
        quotas,
    }, { minProperties: 1 }),
    response: appDoc,
    handler: ({ ctx, params, body }) => updateApp(ctx, params.appId, body),
});

for (const action of ["suspend", "reactivate"] as const) {
    defineRoute({
        method: "post", path: `/apps/:appId/${action}`, tag: "Developer apps", auth: "firstParty", sensitive: true, errors: [404, 409],
        summary: action === "suspend" ? "Suspend: credentials and tokens stop working until reactivated (owner or platform admin)" : "Reactivate a suspended app (owner or platform admin)",
        params: appIdParams, response: appDoc,
        handler: ({ ctx, params }) => setAppStatus(ctx, params.appId, action),
    });
}

defineRoute({
    method: "post", path: "/apps/:appId/revoke", tag: "Developer apps", auth: "firstParty", sensitive: true, errors: [404, 409],
    summary: "Permanently revoke the app (owner; confirmation)", params: appIdParams,
    body: S.object({ confirm }), response: appDoc,
    handler: ({ ctx, params, body }) => setAppStatus(ctx, params.appId, "revoke", body.confirm),
});

defineRoute({
    method: "post", path: "/apps/:appId/tokens/revoke-all", tag: "Developer apps", auth: "firstParty", sensitive: true, errors: [404],
    summary: "Invalidate every user token issued so far (owner; confirmation)", params: appIdParams,
    body: S.object({ confirm }), response: S.doc({ type: "object", properties: { revoked: { type: "boolean" } } }),
    handler: ({ ctx, params, body }) => revokeAllTokens(ctx, params.appId, body.confirm),
});

defineRoute({
    method: "get", path: "/apps/:appId/usage", tag: "Developer apps", auth: "firstParty", errors: [404],
    summary: "Daily usage counters (owner, or platform admin)", params: appIdParams,
    query: S.object({ days: S.int({ optional: true, min: 1, max: 90, default: 30 }) }),
    response: S.doc({ type: "array", items: { type: "object", properties: { day: { type: "string" }, apiRequests: { type: "integer" }, apiErrors: { type: "integer", description: "Authenticated requests answered with status >= 400" }, tokensIssued: { type: "integer" }, messagesSent: { type: "integer" }, socketConnections: { type: "integer" } } } }),
    handler: ({ ctx, params, query }) => appUsage(ctx, params.appId, query.days),
});

defineRoute({
    method: "get", path: "/apps/:appId/audit", tag: "Developer apps", auth: "firstParty", errors: [404],
    summary: "Audit trail of sensitive actions (owner, or platform admin)", params: appIdParams,
    response: S.doc({ type: "array", items: { type: "object", properties: { action: { type: "string" }, actorKind: { type: "string" }, actorUserId: { type: "string", nullable: true }, at: { type: "string", format: "date-time" } } } }),
    handler: ({ ctx, params }) => appAudit(ctx, params.appId),
});

// ------------------------------------------------------------------ credentials

defineRoute({
    method: "get", path: "/apps/:appId/credentials", tag: "Developer apps", auth: "firstParty", errors: [404],
    summary: "List credentials (never the secrets)", params: appIdParams, response: S.doc({ type: "array", items: credentialDoc }),
    handler: ({ ctx, params }) => listCredentials(ctx, params.appId),
});

defineRoute({
    method: "post", path: "/apps/:appId/credentials", tag: "Developer apps", auth: "firstParty", sensitive: true, errors: [404, 409],
    summary: "Create a server credential — the secret is shown ONLY in this response (owner; confirmation)",
    params: appIdParams,
    body: S.object({ confirm, expiresInDays: S.int({ optional: true, min: 1, max: 365, default: 180 }) }),
    response: S.doc({ type: "object", properties: { credential: credentialDoc, secret: { type: "string", description: "Store it on your server; it can't be shown again" } } }),
    handler: ({ ctx, params, body }) => createCredential(ctx, params.appId, body),
});

defineRoute({
    method: "post", path: "/apps/:appId/credentials/:credentialId/rotate", tag: "Developer apps", auth: "firstParty", sensitive: true, errors: [404],
    summary: "Rotate: new secret now; the old one keeps working for the grace period (default 1 h) (owner; confirmation)",
    params: S.object({ appId: S.objectId(), credentialId: S.objectId() }),
    body: S.object({ confirm, expiresInDays: S.int({ optional: true, min: 1, max: 365, default: 180 }) }),
    response: S.doc({ type: "object", properties: { credential: credentialDoc, secret: { type: "string" }, previous: { type: "object", properties: { keyId: { type: "string" }, validUntil: { type: "string", nullable: true } } } } }),
    handler: ({ ctx, params, body }) => rotateCredential(ctx, params.appId, params.credentialId, body),
});

defineRoute({
    method: "post", path: "/apps/:appId/credentials/:credentialId/revoke", tag: "Developer apps", auth: "firstParty", sensitive: true, errors: [404],
    summary: "Revoke a credential immediately (owner; confirmation)",
    params: S.object({ appId: S.objectId(), credentialId: S.objectId() }), body: S.object({ confirm }),
    response: S.doc({ type: "object", properties: { revoked: { type: "boolean" } } }),
    handler: ({ ctx, params, body }) => revokeCredential(ctx, params.appId, params.credentialId, body.confirm),
});

// ------------------------------------------------------------------ consent

defineRoute({
    method: "post", path: "/apps/:appId/grants", tag: "App consent", auth: "firstParty", sensitive: true, errors: [404, 409],
    summary: "Authorise an app for MYSELF with a subset of its scopes (the signed-in user only)",
    description: "Workspace apps: from inside that workspace. Global apps: from the personal context. Linking the app's own user id (externalUserRef) is only possible through an app-initiated consent request.",
    params: appIdParams,
    body: S.object({ scopes: scopeList }),
    response: S.doc({ type: "object", properties: { _id: { type: "string" }, appId: { type: "string" }, appName: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, externalUserRef: { type: "string", nullable: true } } }),
    handler: ({ ctx, params, body }) => grantApp(ctx, params.appId, body),
});

defineRoute({
    method: "get", path: "/me/app-grants", tag: "App consent", auth: "firstParty",
    summary: "Apps I have authorised",
    response: S.doc({ type: "array", items: { type: "object", properties: { _id: { type: "string" }, appId: { type: "string" }, appName: { type: "string" }, scopes: { type: "array", items: { type: "string" } } } } }),
    handler: ({ ctx }) => listMyGrants(ctx),
});

defineRoute({
    method: "delete", path: "/me/app-grants/:grantId", tag: "App consent", auth: "firstParty", errors: [404],
    summary: "Withdraw an app's access (its tokens for me stop working immediately)",
    params: S.object({ grantId: S.objectId() }), response: S.doc({ type: "object", properties: { revoked: { type: "boolean" } } }),
    handler: ({ ctx, params }) => revokeMyGrant(ctx, params.grantId),
});

// ------------------------------------------------------------------ consent requests

const consentParams = S.object({ requestId: S.string({ min: 20, max: 40, pattern: /^[A-Za-z0-9_-]+$/ }) });
const decisionDoc = S.doc({ type: "object", properties: { redirectUrl: { type: "string", description: "Send the browser here (the app's registered callback, with state)" }, scopes: { type: "array", items: { type: "string" } } } });

defineRoute({
    method: "post", path: "/consent-requests", tag: "App consent", auth: "appCredential",
    summary: "App server: start a consent flow for one of its users (returns the SpreeWe URL to send them to)",
    description: "redirectUri must exactly match a registered callback URL. state is echoed back on the redirect (check it on your side against CSRF). externalUserRef is bound to the user who approves. Expires after 10 minutes; usable once.",
    body: S.object({
        redirectUri: S.string({ min: 8, max: 300 }),
        scopes: S.array(S.enum(ALL_SCOPES), { max: ALL_SCOPES.length }),
        state: S.string({ min: 8, max: 200, pattern: /^[!-~]+$/ }),
        externalUserRef: S.string({ optional: true, min: 1, max: 200, pattern: /^[\w.:@|-]+$/ }),
    }),
    response: S.doc({ type: "object", properties: { requestId: { type: "string" }, consentUrl: { type: "string" }, expiresAt: { type: "string" } } }),
    handler: ({ appAuth, body }) => createConsentRequest(appAuth!, body),
});

defineRoute({
    method: "get", path: "/consent-requests/:requestId", tag: "App consent", auth: "firstParty", errors: [404],
    summary: "Signed-in user: what an app is asking for (app, owner, each scope, context)",
    params: consentParams,
    response: S.doc({ type: "object", properties: { requestId: { type: "string" }, app: { type: "object" }, scopes: { type: "array", items: { type: "object", properties: { scope: { type: "string" }, description: { type: "string" }, sensitive: { type: "boolean" } } } }, redirectHost: { type: "string" }, contextMatches: { type: "boolean" }, existingScopes: { type: "array", items: { type: "string" } } } }),
    handler: ({ ctx, params }) => viewConsentRequest(ctx, params.requestId),
});

defineRoute({
    method: "post", path: "/consent-requests/:requestId/approve", tag: "App consent", auth: "firstParty", sensitive: true, errors: [404, 409],
    summary: "Signed-in user approves selected scopes (a subset of the request), in the app's context",
    params: consentParams, body: S.object({ scopes: scopeList }), response: decisionDoc,
    handler: ({ ctx, params, body }) => decideConsentRequest(ctx, params.requestId, { approve: true, scopes: body.scopes }),
});

defineRoute({
    method: "post", path: "/consent-requests/:requestId/deny", tag: "App consent", auth: "firstParty", sensitive: true, errors: [404],
    summary: "Signed-in user denies the request", params: consentParams, response: decisionDoc,
    handler: ({ ctx, params }) => decideConsentRequest(ctx, params.requestId, { approve: false }),
});

// ------------------------------------------------------------------ token exchange (app servers)

defineRoute({
    method: "post", path: "/app-tokens", tag: "App tokens", auth: "appCredential", errors: [],
    summary: "Exchange the app's server credential for a short-lived user token (server-to-server only)",
    description: "Only for users who authorised the app (grant). Scopes must be within the grant and the app; the tenant is the app's binding. Never call this from a browser or mobile app.",
    body: S.object({
        userId: S.objectId({ optional: true }),
        externalUserRef: S.string({ optional: true, min: 1, max: 200 }),
        scopes: S.array(S.enum(ALL_SCOPES), { optional: true, max: ALL_SCOPES.length }),
        ttlSeconds: S.int({ optional: true, min: 60, max: 3600 }),
    }),
    response: S.doc({ type: "object", properties: { accessToken: { type: "string" }, tokenType: { type: "string", enum: ["Bearer"] }, expiresIn: { type: "integer" }, expiresAt: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, tokenId: { type: "string" }, tenantId: { type: "string", nullable: true } } }),
    handler: ({ appAuth, body }) => issueToken(appAuth!, body),
});

defineRoute({
    method: "post", path: "/app-tokens/revoke", tag: "App tokens", auth: "appCredential",
    summary: "Revoke one of this app's user tokens (e.g. on sign-out)",
    body: S.object({ token: S.string({ min: 20, max: 4096, trim: false }) }),
    response: S.doc({ type: "object", properties: { revoked: { type: "boolean" } } }),
    handler: ({ appAuth, body }) => revokeToken(appAuth!, body.token),
});

// ------------------------------------------------------------------ platform admin

defineRoute({
    method: "get", path: "/admin/apps", tag: "Platform admin", auth: "firstParty", errors: [404],
    summary: "All apps' metadata (platform admins only; no tenant content)",
    response: S.doc({ type: "array", items: appDoc.openapi() }),
    handler: ({ ctx }) => adminListApps(ctx),
});
