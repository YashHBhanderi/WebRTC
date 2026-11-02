import crypto from "crypto";
import mongoose from "mongoose";
import User from "../models/userModel";
import { AppIdentity, RequestContext, runAsSystem } from "../tenancy/context";
import { assertActiveTenantMember } from "../tenancy/tenant.service";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";
import {
    AppAuditEvent, AppCredential, AppEnvironment, AppGrant, AppUsage, ConsentRequest, DeveloperApp, IAppCredential, IDeveloperApp, RevokedToken,
} from "./models";
import { ALL_SCOPES, APP_SCOPES, UNAVAILABLE_SCOPES, isScope } from "./scopes";
import { forgetAppOrigins } from "./origins";
import { AppTokenClaims, AppTokenError, defaultTtlSeconds, maxTtlSeconds, signAppToken, verifyAppTokenSignature } from "./tokens";

/**
 * Developer platform rules (see docs/security/developer-platform-security.md).
 *
 * Management: only the owner, acting in the app's own context (its tenant as owner/admin, or the
 * global context for global apps), or a platform admin (status changes / metadata only).
 * Identity: tokens are only issued for users who granted the app themselves (AppGrant), with
 * scopes ⊆ grant ∩ app, bound to the app's tenant (or global). Developers cannot pick users,
 * tenants or scopes beyond that.
 */
const oid = (id: string | mongoose.Types.ObjectId) => new mongoose.Types.ObjectId(String(id));
const sys = <T>(fn: () => T, reason: string) => runAsSystem(fn, reason);

export const QUOTA_BOUNDS = {
    rateLimitPerMinute: { min: 1, max: 6000, development: 120 },
    maxConnections: { min: 1, max: 10_000, development: 20 },
    messagesPerDay: { min: 0, max: 1_000_000, development: 2000 },
} as const;

const RECENT_AUTH_MINUTES = 10;
/** Resource caps (abuse / exhaustion) */
export const LIMITS = { appsPerOwner: 25, activeCredentialsPerApp: 5 } as const;

function rotationGraceSeconds(): number {
    const n = Number(process.env.APP_CREDENTIAL_ROTATION_GRACE_SECONDS);
    return Number.isFinite(n) && process.env.APP_CREDENTIAL_ROTATION_GRACE_SECONDS !== undefined ? Math.min(86_400, Math.max(0, Math.floor(n))) : 3600;
}

const day = (d = new Date()) => d.toISOString().slice(0, 10);

// ------------------------------------------------------------------ audit / usage

async function audit(appId: unknown, ctx: RequestContext | null, actorKind: "owner" | "platform-admin" | "user" | "app", action: string, details: Record<string, unknown> = {}) {
    await sys(() => AppAuditEvent.create({ appId: oid(String(appId)), actorUserId: ctx ? oid(ctx.userId) : null, actorKind, action, details, at: new Date() }), "app-audit");
}

/** Usage counters live in MongoDB (shared by all instances); best effort, never blocks a request. */
export function recordUsage(appId: string, field: "apiRequests" | "tokensIssued" | "socketConnections" | "apiErrors", n = 1): void {
    void sys(() => AppUsage.updateOne({ appId: oid(appId), day: day() }, { $inc: { [field]: n } }, { upsert: true }), "app-usage")
        .catch(() => undefined);
}

/**
 * Daily message quota, enforced atomically in MongoDB (so it holds across instances):
 *   1. make sure today's counter document exists (idempotent upsert, no condition);
 *   2. increment it ONLY while below the quota (single conditional update, no upsert).
 * Step 2 is atomic per document, so concurrent sends can never exceed the quota. (The unique
 * {appId, day} index keeps step 1 from creating duplicates; see migration 2026-10-23.)
 */
export async function consumeMessageQuota(app: AppIdentity): Promise<boolean> {
    const key = { appId: oid(app.appId), day: day() };
    try {
        await sys(() => AppUsage.updateOne(key, { $setOnInsert: { messagesSent: 0 } }, { upsert: true }), "app-quota");
    } catch (error: any) {
        if (error?.code !== 11000) throw error; // created concurrently: fine
    }
    const res = await sys(() => AppUsage.updateOne({ ...key, messagesSent: { $lt: app.quotas.messagesPerDay } }, { $inc: { messagesSent: 1 } }), "app-quota");
    return res.modifiedCount === 1;
}

// ------------------------------------------------------------------ validation helpers

function origin(value: unknown, env: AppEnvironment, kind: "origin" | "callback"): string {
    if (typeof value !== "string" || value.length > 300) throw new AppError(`Invalid ${kind}`);
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new AppError(`Invalid ${kind}: ${value.slice(0, 80)}`);
    }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(env === "development" && local && url.protocol === "http:")) {
        throw new AppError(`${kind === "origin" ? "Origins" : "Callback URLs"} must use https (http://localhost only for development apps)`);
    }
    if (url.username || url.password || url.hash) throw new AppError(`Invalid ${kind}`);
    if (kind === "origin") {
        if (url.pathname !== "/" || url.search) throw new AppError("An origin has no path or query");
        return url.origin;
    }
    return url.toString();
}

function scopesFrom(value: unknown, allowed: readonly string[] = ALL_SCOPES): string[] {
    if (!Array.isArray(value)) throw new AppError("scopes must be an array");
    const out = [...new Set(value)];
    for (const s of out) {
        if (!isScope(s)) throw new AppError(`Unknown scope: ${String(s).slice(0, 40)}`);
        if (!allowed.includes(s)) throw new ForbiddenError(`Scope not allowed: ${s}`);
    }
    return out as string[];
}

/** Refuses scopes that grant nothing yet, except ones already present (kept for continuity) */
function availableScopes(scopes: string[], already: readonly string[] = []): string[] {
    const blocked = scopes.filter((s) => UNAVAILABLE_SCOPES.has(s) && !already.includes(s));
    if (blocked.length) throw new AppError(`Not available yet: ${blocked.join(", ")}`);
    return scopes;
}

function quotasFrom(input: Record<string, unknown> | undefined, env: AppEnvironment, current?: IDeveloperApp["quotas"]) {
    const q = { ...(current || { rateLimitPerMinute: 60, maxConnections: 20, messagesPerDay: 1000 }) };
    for (const [k, v] of Object.entries(input || {})) {
        const bound = (QUOTA_BOUNDS as any)[k];
        if (!bound) throw new AppError(`Unknown quota: ${k.slice(0, 40)}`);
        const max = env === "development" ? bound.development : bound.max;
        if (!Number.isInteger(v) || (v as number) < bound.min || (v as number) > max) throw new AppError(`${k} must be an integer between ${bound.min} and ${max}`);
        (q as any)[k] = v;
    }
    return q;
}

export function requireConfirmation(app: IDeveloperApp, ctx: RequestContext, confirm: unknown): void {
    if (confirm !== app.name) {
        throw new AppError("Confirm this action by sending the app's exact name as `confirm`");
    }
    // Clerk sessions carry fva (minutes since first-factor verification); require a recent sign-in
    if (typeof ctx.authAgeMinutes === "number" && ctx.authAgeMinutes > RECENT_AUTH_MINUTES) {
        throw new ForbiddenError(`Please sign in again (within ${RECENT_AUTH_MINUTES} minutes) to do this`);
    }
}

/** Optional website: empty, or an absolute http(s) URL without credentials */
function websiteUrlFrom(value: unknown): string {
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return "";
    let url: URL;
    try { url = new URL(raw); } catch { throw new AppError("websiteUrl must be an absolute http(s) URL"); }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) throw new AppError("websiteUrl must be an absolute http(s) URL");
    return url.toString();
}

function publicApp(app: IDeveloperApp) {
    return {
        _id: String(app._id), name: app.name, description: app.description || "", websiteUrl: app.websiteUrl || "",
        environment: app.environment, status: app.status,
        tenantId: app.tenantId ? String(app.tenantId) : null, scopes: app.scopes, allowedOrigins: app.allowedOrigins,
        callbackUrls: app.callbackUrls, quotas: app.quotas, createdAt: app.createdAt, updatedAt: app.updatedAt,
    };
}

function publicCredential(c: IAppCredential) {
    return {
        _id: String(c._id), keyId: c.keyId, hint: c.hint, status: c.status, graceUntil: c.graceUntil,
        expiresAt: c.expiresAt, lastUsedAt: c.lastUsedAt, createdAt: c.createdAt,
    };
}

function firstParty(ctx: RequestContext): void {
    if (ctx.app) throw new ForbiddenError("This operation needs a signed-in SpreeWe session");
}

// ------------------------------------------------------------------ app management

/** Owner in the app's own context, or (when allowed) a platform admin. Otherwise "not found". */
export async function managedApp(ctx: RequestContext, appId: string, opts: { platformAdmin?: boolean; tenantAdmin?: boolean } = {}) {
    firstParty(ctx);
    if (!mongoose.isValidObjectId(appId)) throw new NotFoundError("App not found");
    const app = await sys(() => DeveloperApp.findById(appId).lean<IDeveloperApp>(), "app-lookup");
    if (!app) throw new NotFoundError("App not found");
    if (opts.platformAdmin && ctx.isPlatformAdmin) return { app, actor: "platform-admin" as const };
    // Workspace owners / admins can suspend or reactivate apps bound to their workspace
    if (opts.tenantAdmin && app.tenantId && String(app.tenantId) === ctx.tenantId && (ctx.role === "owner" || ctx.role === "admin")) {
        return { app, actor: "owner" as const };
    }
    const sameContext = (app.tenantId ? String(app.tenantId) : null) === ctx.tenantId;
    const owner = String(app.ownerUserId) === ctx.userId;
    const tenantRoleOk = !app.tenantId || ctx.role === "owner" || ctx.role === "admin";
    if (!owner || !sameContext || !tenantRoleOk) throw new NotFoundError("App not found");
    return { app, actor: "owner" as const };
}

export async function createApp(ctx: RequestContext, input: any) {
    firstParty(ctx);
    const environment: AppEnvironment = input.environment;
    if (input.tenantBound) {
        if (!ctx.tenantId || (ctx.role !== "owner" && ctx.role !== "admin")) {
            throw new ForbiddenError("Workspace apps can only be created by workspace owners or admins, inside the workspace");
        }
    } else if (ctx.tenantId) {
        throw new AppError("Create global apps from your personal (global) context, or set tenantBound for this workspace");
    }
    const owned = await sys(() => DeveloperApp.countDocuments({ ownerUserId: oid(ctx.userId), status: { $ne: "revoked" } }), "app-create");
    if (owned >= LIMITS.appsPerOwner) throw new AppError(`You can have at most ${LIMITS.appsPerOwner} apps`, 409);
    const app = await sys(() => DeveloperApp.create({
        name: input.name,
        description: typeof input.description === "string" ? input.description.trim() : "",
        websiteUrl: websiteUrlFrom(input.websiteUrl),
        ownerUserId: oid(ctx.userId),
        tenantId: input.tenantBound ? oid(ctx.tenantId!) : null,
        environment,
        status: "active",
        scopes: availableScopes(scopesFrom(input.scopes ?? [])),
        allowedOrigins: (input.allowedOrigins ?? []).map((o: unknown) => origin(o, environment, "origin")),
        callbackUrls: (input.callbackUrls ?? []).map((o: unknown) => origin(o, environment, "callback")),
        quotas: quotasFrom(input.quotas, environment),
    }), "app-create");
    forgetAppOrigins();
    await audit(app._id, ctx, "owner", "app.created", { environment, tenantBound: !!input.tenantBound, scopes: app.scopes });
    return publicApp(app.toObject());
}

export async function listMyApps(ctx: RequestContext) {
    firstParty(ctx);
    const apps = await sys(() => DeveloperApp.find({ ownerUserId: oid(ctx.userId), tenantId: ctx.tenantId ? oid(ctx.tenantId) : null }).sort({ createdAt: -1 }).limit(100).lean<IDeveloperApp[]>(), "app-list");
    return apps.map(publicApp);
}

export async function getApp(ctx: RequestContext, appId: string) {
    const { app } = await managedApp(ctx, appId, { platformAdmin: true });
    return publicApp(app);
}

export async function updateApp(ctx: RequestContext, appId: string, patch: any) {
    const { app } = await managedApp(ctx, appId);
    if (app.status === "revoked") throw new AppError("A revoked app can't be changed", 409);
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.description !== undefined) set.description = String(patch.description).trim();
    if (patch.websiteUrl !== undefined) set.websiteUrl = websiteUrlFrom(patch.websiteUrl);
    // Unavailable scopes can't be newly added (ones an app already had are kept, still granting nothing)
    if (patch.scopes !== undefined) set.scopes = availableScopes(scopesFrom(patch.scopes), app.scopes);
    if (patch.allowedOrigins !== undefined) set.allowedOrigins = patch.allowedOrigins.map((o: unknown) => origin(o, app.environment, "origin"));
    if (patch.callbackUrls !== undefined) set.callbackUrls = patch.callbackUrls.map((o: unknown) => origin(o, app.environment, "callback"));
    if (patch.quotas !== undefined) set.quotas = quotasFrom(patch.quotas, app.environment, app.quotas);
    const updated = await sys(() => DeveloperApp.findByIdAndUpdate(app._id, { $set: set }, { new: true }).lean<IDeveloperApp>(), "app-update");
    forgetAppOrigins();
    await audit(app._id, ctx, "owner", "app.updated", { fields: Object.keys(set), scopes: set.scopes });
    return publicApp(updated!);
}

export async function setAppStatus(ctx: RequestContext, appId: string, action: "suspend" | "reactivate" | "revoke", confirm?: unknown) {
    const { app, actor } = await managedApp(ctx, appId, { platformAdmin: action !== "revoke", tenantAdmin: action !== "revoke" });
    if (app.status === "revoked") throw new AppError("This app is revoked", 409);
    const update: Record<string, unknown> = {};
    if (action === "revoke") {
        requireConfirmation(app, ctx, confirm);
        update.$set = { status: "revoked" };
        update.$inc = { tokenVersion: 1 };
    } else {
        update.$set = { status: action === "suspend" ? "suspended" : "active" };
    }
    const updated = await sys(() => DeveloperApp.findByIdAndUpdate(app._id, update, { new: true }).lean<IDeveloperApp>(), "app-status");
    forgetAppOrigins();
    await audit(app._id, ctx, actor, `app.${action === "suspend" ? "suspended" : action === "reactivate" ? "reactivated" : "revoked"}`);
    return publicApp(updated!);
}

export async function revokeAllTokens(ctx: RequestContext, appId: string, confirm: unknown) {
    const { app } = await managedApp(ctx, appId);
    requireConfirmation(app, ctx, confirm);
    await sys(() => DeveloperApp.updateOne({ _id: app._id }, { $inc: { tokenVersion: 1 } }), "app-tokens");
    await audit(app._id, ctx, "owner", "tokens.revoked_all");
    return { revoked: true };
}

export async function appUsage(ctx: RequestContext, appId: string, days: number) {
    const { app } = await managedApp(ctx, appId, { platformAdmin: true });
    const since = day(new Date(Date.now() - (days - 1) * 86_400_000));
    const rows = await sys(() => AppUsage.find({ appId: app._id, day: { $gte: since } }).sort({ day: 1 }).lean(), "app-usage");
    return rows.map((r) => ({ day: r.day, apiRequests: r.apiRequests, apiErrors: r.apiErrors || 0, tokensIssued: r.tokensIssued, messagesSent: r.messagesSent, socketConnections: r.socketConnections }));
}

export async function appAudit(ctx: RequestContext, appId: string) {
    const { app } = await managedApp(ctx, appId, { platformAdmin: true });
    const rows = await sys(() => AppAuditEvent.find({ appId: app._id }).sort({ at: -1 }).limit(200).lean(), "app-audit");
    return rows.map((r) => ({ action: r.action, actorKind: r.actorKind, actorUserId: r.actorUserId ? String(r.actorUserId) : null, details: r.details, at: r.at }));
}

/** Platform admin: metadata of every app (no tenant content). */
export async function adminListApps(ctx: RequestContext) {
    firstParty(ctx);
    if (!ctx.isPlatformAdmin) throw new NotFoundError("Not found");
    const apps = await sys(() => DeveloperApp.find({}).sort({ createdAt: -1 }).limit(500).lean<IDeveloperApp[]>(), "app-admin-list");
    return apps.map((a) => ({ ...publicApp(a), ownerUserId: String(a.ownerUserId) }));
}

// ------------------------------------------------------------------ credentials

const SECRET_PREFIX = "sws_";

function newCredentialMaterial(env: AppEnvironment) {
    const keyId = `swk_${env === "production" ? "live" : "test"}_${crypto.randomBytes(12).toString("base64url")}`;
    const secret = `${SECRET_PREFIX}${crypto.randomBytes(32).toString("base64url")}`;
    return { keyId, secret, secretHash: hashSecret(secret), hint: secret.slice(-4) };
}

/** 256-bit random secrets: a fast hash is sufficient (no guessable inputs); optional server pepper. */
function hashSecret(secret: string): string {
    const pepper = process.env.APP_CREDENTIAL_PEPPER || "";
    return crypto.createHash("sha256").update(pepper).update(secret).digest("base64url");
}

export async function createCredential(ctx: RequestContext, appId: string, input: { expiresInDays?: number; confirm?: unknown }) {
    const { app } = await managedApp(ctx, appId);
    if (app.status !== "active") throw new AppError("Only active apps can get new credentials", 409);
    requireConfirmation(app, ctx, input.confirm);
    const active = await sys(() => AppCredential.countDocuments({ appId: app._id, status: "active" }), "app-credential");
    if (active >= LIMITS.activeCredentialsPerApp) throw new AppError(`At most ${LIMITS.activeCredentialsPerApp} active credentials per app; revoke one first`, 409);
    const material = newCredentialMaterial(app.environment);
    const days = input.expiresInDays ?? 180;
    const credential = await sys(() => AppCredential.create({
        appId: app._id, keyId: material.keyId, secretHash: material.secretHash, hint: material.hint,
        status: "active", expiresAt: new Date(Date.now() + days * 86_400_000), createdBy: oid(ctx.userId),
    }), "app-credential");
    await audit(app._id, ctx, "owner", "credential.created", { keyId: material.keyId, expiresInDays: days });
    // The secret is returned exactly once and never stored or logged
    return { credential: publicCredential(credential.toObject()), secret: material.secret };
}

export async function listCredentials(ctx: RequestContext, appId: string) {
    const { app } = await managedApp(ctx, appId);
    const rows = await sys(() => AppCredential.find({ appId: app._id }).sort({ createdAt: -1 }).limit(100).lean<IAppCredential[]>(), "app-credential");
    return rows.map(publicCredential);
}

export async function rotateCredential(ctx: RequestContext, appId: string, credentialId: string, input: { expiresInDays?: number; confirm?: unknown }) {
    const { app } = await managedApp(ctx, appId);
    requireConfirmation(app, ctx, input.confirm);
    if (!mongoose.isValidObjectId(credentialId)) throw new NotFoundError("Credential not found");
    const grace = rotationGraceSeconds();
    // Claim the old credential atomically first: of two concurrent rotations only one wins
    const old = await sys(() => AppCredential.findOneAndUpdate(
        { _id: oid(credentialId), appId: app._id, status: "active" },
        grace > 0 ? { $set: { status: "rotated", graceUntil: new Date(Date.now() + grace * 1000) } } : { $set: { status: "revoked", graceUntil: null } },
        { new: false },
    ).lean<IAppCredential>(), "app-credential");
    if (!old) throw new NotFoundError("Credential not found");
    const material = newCredentialMaterial(app.environment);
    const days = input.expiresInDays ?? 180;
    const credential = await sys(() => AppCredential.create({
        appId: app._id, keyId: material.keyId, secretHash: material.secretHash, hint: material.hint,
        status: "active", expiresAt: new Date(Date.now() + days * 86_400_000), createdBy: oid(ctx.userId),
    }), "app-credential");
    await audit(app._id, ctx, "owner", "credential.rotated", { from: old.keyId, to: material.keyId, graceSeconds: grace });
    return { credential: publicCredential(credential.toObject()), secret: material.secret, previous: { keyId: old.keyId, validUntil: grace > 0 ? new Date(Date.now() + grace * 1000) : null } };
}

export async function revokeCredential(ctx: RequestContext, appId: string, credentialId: string, confirm: unknown) {
    const { app } = await managedApp(ctx, appId);
    requireConfirmation(app, ctx, confirm);
    if (!mongoose.isValidObjectId(credentialId)) throw new NotFoundError("Credential not found");
    const res = await sys(() => AppCredential.updateOne({ _id: oid(credentialId), appId: app._id, status: { $ne: "revoked" } }, { $set: { status: "revoked", graceUntil: null } }), "app-credential");
    if (!res.matchedCount) throw new NotFoundError("Credential not found");
    await audit(app._id, ctx, "owner", "credential.revoked", { credentialId });
    return { revoked: true };
}

/**
 * Server-to-server authentication: `Authorization: Basic base64(keyId:secret)`.
 * Every failure is the same 401 (no hint whether the key exists).
 */
export async function authenticateCredential(header: string | undefined) {
    const fail = () => new AppError("Invalid app credentials", 401);
    const match = /^Basic ([A-Za-z0-9+/=]{10,600})$/.exec(header || "");
    if (!match) throw fail();
    const decoded = Buffer.from(match[1], "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 1) throw fail();
    const keyId = decoded.slice(0, sep);
    const secret = decoded.slice(sep + 1);
    if (!/^swk_(live|test)_[A-Za-z0-9_-]{8,40}$/.test(keyId) || !secret.startsWith(SECRET_PREFIX) || secret.length > 200) throw fail();
    const credential = await sys(() => AppCredential.findOne({ keyId }).lean<IAppCredential>(), "app-auth");
    const expected = Buffer.from(credential?.secretHash || hashSecret("x".repeat(48)));
    const given = Buffer.from(hashSecret(secret));
    const matches = expected.length === given.length && crypto.timingSafeEqual(expected, given);
    if (!credential || !matches) throw fail();
    const now = Date.now();
    const usable = credential.status === "active" || (credential.status === "rotated" && !!credential.graceUntil && credential.graceUntil.getTime() > now);
    if (!usable || (credential.expiresAt && credential.expiresAt.getTime() <= now)) throw fail();
    const app = await sys(() => DeveloperApp.findById(credential.appId).lean<IDeveloperApp>(), "app-auth");
    if (!app || app.status !== "active") throw new ForbiddenError("This app is not active");
    void sys(() => AppCredential.updateOne({ _id: credential._id }, { $set: { lastUsedAt: new Date() } }), "app-auth").catch(() => undefined);
    return { app, credential };
}

// ------------------------------------------------------------------ user grants (consent)

/** The signed-in user authorises an app for themselves, in the app's own context. */
export async function grantApp(ctx: RequestContext, appId: string, input: { scopes: unknown }) {
    firstParty(ctx);
    if (!mongoose.isValidObjectId(appId)) throw new NotFoundError("App not found");
    const app = await sys(() => DeveloperApp.findById(appId).lean<IDeveloperApp>(), "app-grant");
    if (!app || app.status !== "active") throw new NotFoundError("App not found");
    const appTenant = app.tenantId ? String(app.tenantId) : null;
    if (appTenant !== ctx.tenantId) {
        // Workspace apps: only members, from inside that workspace. Global apps: from the global context.
        throw new NotFoundError("App not found");
    }
    const scopes = scopesFrom(input.scopes, app.scopes);
    if (!scopes.length) throw new AppError("Choose at least one permission");
    if (app.tenantId) await assertActiveTenantMember(String(app.tenantId), ctx.userId);
    // An externalUserRef is never set here: only an app-initiated consent request can bind one
    const grant = await sys(() => AppGrant.findOneAndUpdate(
        { appId: app._id, userId: oid(ctx.userId) },
        { $set: { scopes, status: "active", tenantId: app.tenantId }, $inc: { version: 1 } },
        { upsert: true, new: true },
    ).lean(), "app-grant");
    await audit(app._id, ctx, "user", "grant.updated", { scopes });
    return { _id: String(grant!._id), appId: String(app._id), appName: app.name, scopes: grant!.scopes, externalUserRef: grant!.externalUserRef, status: grant!.status };
}

// ------------------------------------------------------------------ consent requests (app-initiated)

const CONSENT_TTL_MS = 10 * 60_000;
/** Highlighted on the consent screen: content access, people data, or administrative power */
const SENSITIVE_SCOPES = new Set([
    "messages:read", "messages:write", "messages:edit", "messages:delete", "e2ee:device", "recordings:read", "recordings:write",
    "directory:read", "files:read", "search:read", "groups:manage", "conversations:delete", "calls:manage", "organizations:manage",
]);

/** Scope catalogue for developers: description, whether consent highlights it, whether it grants anything today */
export function scopeCatalog() {
    return (Object.entries(APP_SCOPES) as [string, string][]).map(([scope, description]) => ({
        scope, description, sensitive: SENSITIVE_SCOPES.has(scope), available: !UNAVAILABLE_SCOPES.has(scope),
    }));
}

/** App server: start a consent flow for one of its users. Returns the URL to send the user to. */
export async function createConsentRequest(auth: { app: IDeveloperApp }, input: { redirectUri: string; scopes: string[]; state: string; externalUserRef?: string }) {
    const { app } = auth;
    // Exact match against registered callback URLs (no prefix / wildcard matching)
    let normalized: string;
    try {
        normalized = new URL(input.redirectUri).toString();
    } catch {
        throw new AppError("redirectUri is not a valid URL");
    }
    if (!app.callbackUrls.includes(normalized)) throw new AppError("redirectUri must exactly match one of the app's callback URLs");
    const scopes = scopesFrom(input.scopes, app.scopes);
    if (!scopes.length) throw new AppError("Request at least one scope");
    const id = crypto.randomBytes(18).toString("base64url");
    await sys(() => ConsentRequest.create({
        _id: id, appId: app._id, scopes, externalUserRef: input.externalUserRef ?? null, redirectUri: normalized, state: input.state,
        status: "pending", expiresAt: new Date(Date.now() + CONSENT_TTL_MS),
    }), "consent-request");
    const base = (process.env.APP_PUBLIC_URL || "").replace(/\/+$/, "");
    return { requestId: id, consentUrl: `${base}/consent?request=${id}`, expiresAt: new Date(Date.now() + CONSENT_TTL_MS).toISOString() };
}

async function pendingRequest(requestId: string) {
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(requestId)) throw new NotFoundError("This consent request is invalid or has expired");
    const req = await sys(() => ConsentRequest.findOne({ _id: requestId, status: "pending", expiresAt: { $gt: new Date() } }).lean(), "consent-request");
    if (!req) throw new NotFoundError("This consent request is invalid or has expired");
    const app = await sys(() => DeveloperApp.findById(req.appId).lean<IDeveloperApp>(), "consent-request");
    if (!app || app.status !== "active") throw new NotFoundError("This consent request is invalid or has expired");
    return { req, app };
}

/** The signed-in user views a consent request (what the app asks for, in which context). */
export async function viewConsentRequest(ctx: RequestContext, requestId: string) {
    firstParty(ctx);
    const { req, app } = await pendingRequest(requestId);
    const owner = await User.findById(app.ownerUserId).select("username").lean();
    const existing = await sys(() => AppGrant.findOne({ appId: app._id, userId: oid(ctx.userId), status: "active" }).select("scopes").lean(), "consent-request");
    const appTenant = app.tenantId ? String(app.tenantId) : null;
    return {
        requestId: req._id,
        app: { _id: String(app._id), name: app.name, description: app.description || "", websiteUrl: app.websiteUrl || "", environment: app.environment, ownerName: owner?.username || "", tenantBound: !!appTenant, tenantId: appTenant },
        // Shown individually; nothing is pre-selected
        scopes: req.scopes.map((s) => ({ scope: s, description: (APP_SCOPES as Record<string, string>)[s], sensitive: SENSITIVE_SCOPES.has(s), available: !UNAVAILABLE_SCOPES.has(s) })),
        redirectHost: new URL(req.redirectUri).host,
        expiresAt: req.expiresAt,
        // The decision must be made in the app's own context (its workspace, or personal for global apps)
        contextMatches: appTenant === ctx.tenantId,
        existingScopes: existing?.scopes || [],
    };
}

/** Approve (subset of scopes) or deny. One-time and atomic. Returns where to send the browser. */
export async function decideConsentRequest(ctx: RequestContext, requestId: string, decision: { approve: boolean; scopes?: string[] }) {
    firstParty(ctx);
    const { req, app } = await pendingRequest(requestId);
    const appTenant = app.tenantId ? String(app.tenantId) : null;
    if (decision.approve) {
        if (appTenant !== ctx.tenantId) throw new ForbiddenError(appTenant ? "Switch to the app's workspace to approve it" : "Switch to your personal context to approve this app");
        const chosen = scopesFrom(decision.scopes ?? [], req.scopes);
        if (!chosen.length) throw new AppError("Choose at least one permission, or deny");
        if (appTenant) await assertActiveTenantMember(appTenant, ctx.userId);
        const claimed = await sys(() => ConsentRequest.findOneAndUpdate(
            { _id: req._id, status: "pending", expiresAt: { $gt: new Date() } },
            { $set: { status: "approved", decidedBy: oid(ctx.userId), decidedAt: new Date() } },
        ), "consent-request");
        if (!claimed) throw new NotFoundError("This consent request is invalid or has expired");
        try {
            const grant = await sys(() => AppGrant.findOneAndUpdate(
                { appId: app._id, userId: oid(ctx.userId) },
                { $set: { scopes: chosen, status: "active", tenantId: app.tenantId, ...(req.externalUserRef ? { externalUserRef: req.externalUserRef } : {}) }, $inc: { version: 1 } },
                { upsert: true, new: true },
            ).lean(), "consent-request");
            await audit(app._id, ctx, "user", "grant.updated", { scopes: chosen, via: "consent-request" });
            const url = new URL(req.redirectUri);
            url.searchParams.set("state", req.state);
            url.searchParams.set("result", "approved");
            url.searchParams.set("grant", String(grant!._id));
            return { redirectUrl: url.toString(), scopes: chosen };
        } catch (error: any) {
            if (error?.code === 11000) throw new AppError("This account link is already used by another SpreeWe account", 409);
            throw error;
        }
    }
    const claimed = await sys(() => ConsentRequest.findOneAndUpdate(
        { _id: req._id, status: "pending" },
        { $set: { status: "denied", decidedBy: oid(ctx.userId), decidedAt: new Date() } },
    ), "consent-request");
    if (!claimed) throw new NotFoundError("This consent request is invalid or has expired");
    const url = new URL(req.redirectUri);
    url.searchParams.set("state", req.state);
    url.searchParams.set("error", "access_denied");
    return { redirectUrl: url.toString(), scopes: [] };
}

export async function listMyGrants(ctx: RequestContext) {
    firstParty(ctx);
    const grants = await sys(() => AppGrant.find({ userId: oid(ctx.userId), status: "active" }).lean(), "app-grant");
    const apps = await sys(() => DeveloperApp.find({ _id: { $in: grants.map((g) => g.appId) } }).select("name environment tenantId status").lean(), "app-grant");
    const byId = new Map(apps.map((a) => [String(a._id), a]));
    return grants.map((g) => ({ _id: String(g._id), appId: String(g.appId), appName: byId.get(String(g.appId))?.name || "", environment: byId.get(String(g.appId))?.environment || "", scopes: g.scopes, tenantId: g.tenantId ? String(g.tenantId) : null, lastUsedAt: g.lastUsedAt || null, grantedAt: g.updatedAt }));
}

export async function revokeMyGrant(ctx: RequestContext, grantId: string) {
    firstParty(ctx);
    if (!mongoose.isValidObjectId(grantId)) throw new NotFoundError("Grant not found");
    const grant = await sys(() => AppGrant.findOneAndUpdate({ _id: oid(grantId), userId: oid(ctx.userId), status: "active" }, { $set: { status: "revoked" }, $inc: { version: 1 } }, { new: true }).lean(), "app-grant");
    if (!grant) throw new NotFoundError("Grant not found");
    await audit(grant.appId, ctx, "user", "grant.revoked");
    return { revoked: true };
}

// ------------------------------------------------------------------ token exchange + verification

/**
 * The developer's backend (app credential) asks for a token for ONE user who granted the app.
 * It identifies the user by SpreeWe user id or by the externalUserRef the user consented with.
 */
export async function issueToken(auth: { app: IDeveloperApp; credential: IAppCredential }, input: { userId?: string; externalUserRef?: string; scopes?: string[]; ttlSeconds?: number }) {
    const { app } = auth;
    if (!!input.userId === !!input.externalUserRef) throw new AppError("Send exactly one of userId or externalUserRef");
    const filter: Record<string, unknown> = { appId: app._id, status: "active" };
    if (input.userId) filter.userId = oid(input.userId);
    else filter.externalUserRef = input.externalUserRef;
    const grant = await sys(() => AppGrant.findOne(filter).lean(), "app-token");
    // Same answer whether the user doesn't exist or hasn't granted the app: no user enumeration
    if (!grant) throw new ForbiddenError("This user has not authorised the app");
    const allowed = grant.scopes.filter((s) => app.scopes.includes(s));
    const requested = input.scopes ?? allowed;
    const extra = requested.filter((s) => !allowed.includes(s));
    if (extra.length) throw new ForbiddenError(`Scopes not granted: ${extra.join(", ")}`);
    if (!requested.length) throw new ForbiddenError("No scopes to grant");
    const user = await User.findById(grant.userId).select("clerkDeletedAt clerkBanned").lean();
    if (!user || user.clerkDeletedAt || user.clerkBanned) throw new ForbiddenError("This user has not authorised the app");
    const tid = app.tenantId ? String(app.tenantId) : null;
    if ((grant.tenantId ? String(grant.tenantId) : null) !== tid) throw new ForbiddenError("This user has not authorised the app");
    if (tid) await assertActiveTenantMember(tid, String(grant.userId));
    const ttl = input.ttlSeconds ?? defaultTtlSeconds();
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > maxTtlSeconds()) throw new AppError(`ttlSeconds must be between 60 and ${maxTtlSeconds()}`);
    const { token, claims } = signAppToken({
        sub: String(grant.userId), app: String(app._id), env: app.environment, tid, scp: requested, tv: app.tokenVersion, gid: String(grant._id), gv: grant.version,
    }, ttl);
    recordUsage(String(app._id), "tokensIssued");
    void sys(() => AppGrant.updateOne({ _id: grant._id }, { $set: { lastUsedAt: new Date() } }), "app-token").catch(() => undefined);
    return { accessToken: token, tokenType: "Bearer", expiresIn: claims.exp - claims.iat, expiresAt: new Date(claims.exp * 1000).toISOString(), scopes: requested, tokenId: claims.jti, tenantId: tid };
}

/** The app revokes one of its own tokens (e.g. on user logout). */
export async function revokeToken(auth: { app: IDeveloperApp }, token: string) {
    let claims: AppTokenClaims;
    try {
        claims = verifyAppTokenSignature(token);
    } catch (error) {
        if (error instanceof AppTokenError && error.reason === "expired") return { revoked: true };
        throw new AppError("Invalid token");
    }
    if (claims.app !== String(auth.app._id)) throw new AppError("Invalid token");
    await sys(() => RevokedToken.updateOne({ _id: claims.jti }, { $setOnInsert: { appId: auth.app._id, expiresAt: new Date(claims.exp * 1000) } }, { upsert: true }), "app-token-revoke");
    return { revoked: true };
}

/**
 * Full validation of a user token (signature, then live state): app active + same environment +
 * same token version, grant active + same version, not individually revoked, user not deleted /
 * banned, tenant binding (active member of an active tenant), browser origin allowed.
 * Effective scopes = token ∩ grant ∩ app, re-evaluated on every request.
 */
export async function verifyUserToken(token: string, opts: { origin?: string | null } = {}): Promise<RequestContext> {
    const claims = verifyAppTokenSignature(token);
    const [app, grant, revoked] = await sys(() => Promise.all([
        mongoose.isValidObjectId(claims.app) ? DeveloperApp.findById(claims.app).lean<IDeveloperApp>() : null,
        mongoose.isValidObjectId(claims.gid) ? AppGrant.findById(claims.gid).lean() : null,
        RevokedToken.exists({ _id: claims.jti }),
    ]), "app-token-verify");
    if (!app || app.status !== "active") throw new AppTokenError(app ? `app-${app.status}` : "app");
    if (app.environment !== claims.env || app.tokenVersion !== claims.tv) throw new AppTokenError("app-version");
    if (revoked) throw new AppTokenError("revoked");
    if (!grant || grant.status !== "active" || grant.version !== claims.gv || String(grant.userId) !== claims.sub || String(grant.appId) !== claims.app) {
        throw new AppTokenError("grant");
    }
    const appTenant = app.tenantId ? String(app.tenantId) : null;
    if (claims.tid !== appTenant) throw new AppTokenError("tenant");
    if (opts.origin && !app.allowedOrigins.includes(opts.origin)) throw new AppTokenError("origin");
    const user = await User.findById(claims.sub).select("clerkDeletedAt clerkBanned").lean();
    if (!user || user.clerkDeletedAt || user.clerkBanned) throw new AppTokenError("user");
    if (appTenant) {
        try {
            await assertActiveTenantMember(appTenant, claims.sub);
        } catch {
            throw new AppTokenError("membership");
        }
    }
    const scopes = claims.scp.filter((s) => grant.scopes.includes(s) && app.scopes.includes(s));
    return {
        kind: "user",
        userId: claims.sub,
        tenantId: appTenant,
        clerkOrgId: null,
        // Least privilege: app tokens never carry workspace admin rights
        role: appTenant ? "member" : null,
        isPlatformAdmin: false,
        app: { appId: claims.app, environment: claims.env, scopes, jti: claims.jti, quotas: app.quotas },
    };
}
