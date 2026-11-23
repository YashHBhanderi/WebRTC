import mongoose from "mongoose";
import User from "../models/userModel";
import Tenant from "../models/tenantModel";
import TenantMembership from "../models/tenantMembershipModel";
import { RequestContext, runAsSystem } from "../tenancy/context";
import { forgetMembership } from "../tenancy/tenant.service";
import { validateUsername } from "../services/userServices";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";
import { revokeAppDevices } from "../e2ee/e2ee.service";
import { recordUsage } from "./app.service";
import { AppAuditEvent, AppGrant, IDeveloperApp } from "./models";

/**
 * Users of a developer application ("app-managed users").
 *
 * An application with its own tenant registers its users here, server-to-server, with its app
 * credential. Each user:
 *   - is a separate SpreeWe user record whose home tenant is the application's tenant (User.tenantId),
 *     identified by the application's own id for that person (externalUserId, unique per tenant);
 *   - is an active member of that tenant and of no other, so directories, conversations, groups,
 *     meetings and calls only ever involve users of the same application;
 *   - has no SpreeWe sign-in: the application authenticates the person and asks for short-lived
 *     tokens (POST /v1/app-tokens with externalUserRef = externalUserId).
 * The same person in two applications is two unrelated users.
 *
 * The tenant is always the calling credential's own (never a request parameter), and every query
 * below is filtered by it.
 */
const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id));
const sys = <T>(fn: () => T, reason = "app-users") => runAsSystem(fn, reason);

/** Registered (active + deactivated) users per application */
export const APP_USER_LIMITS = { development: 1000, production: 100_000 } as const;

const EXTERNAL_ID = /^[\w.:@|-]{1,200}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Who is managing the app's users: the app's server (credential), or the app's owner in the
 * Developer Portal (`owner` = their verified session, after the ownership check in managedApp).
 * Either way the tenant is the app's own.
 */
export interface AppAuth { app: IDeveloperApp; owner?: RequestContext }

export interface AppUserInput {
    externalUserId?: string;
    name?: string;
    email?: string | null;
    avatarUrl?: string | null;
}

/** The app's own tenant, or a clear refusal for apps that have none (workspace / legacy global apps). */
function tenantOf(app: IDeveloperApp): mongoose.Types.ObjectId {
    if (!app.dedicatedTenant || !app.tenantId) {
        throw new ForbiddenError("This app has no tenant of its own, so it can't register users. Create a new app to get a dedicated tenant.");
    }
    return oid(app.tenantId);
}

/** Clear answer (instead of a misleading conflict) when the code is deployed before its migration */
export function migrationPending(): AppError {
    console.error("[app-tenants] migration 2026-11-16-app-tenants has not been applied to this database (run `npm run migrate`)");
    return new AppError("Application tenants are not available yet on this server. Please try again later.", 503);
}

function externalId(value: unknown): string {
    if (typeof value !== "string" || !EXTERNAL_ID.test(value)) {
        throw new AppError("externalUserId must be 1-200 characters: letters, digits and . _ : @ | -");
    }
    return value;
}

function emailFrom(value: unknown): string | undefined {
    if (value === null || value === undefined || value === "") return undefined;
    const email = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!email || email.length > 254 || !EMAIL.test(email)) throw new AppError("email is not a valid address");
    return email;
}

/** Profile pictures are links the application hosts: https only (http://localhost for development apps). */
function avatarFrom(value: unknown, app: IDeveloperApp): string {
    if (value === null || value === undefined || value === "") return "";
    if (typeof value !== "string" || value.length > 500) throw new AppError("avatarUrl is not a valid URL");
    let url: URL;
    try { url = new URL(value); } catch { throw new AppError("avatarUrl is not a valid URL"); }
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.username || url.password || (url.protocol !== "https:" && !(app.environment === "development" && local && url.protocol === "http:"))) {
        throw new AppError("avatarUrl must be an https URL");
    }
    return url.toString();
}

function publicAppUser(u: any) {
    return {
        _id: String(u._id),
        externalUserId: u.externalUserId,
        name: u.username,
        email: u.contactEmail || null,
        avatarUrl: u.avatar || "",
        status: u.deactivatedAt ? "deactivated" as const : "active" as const,
        tenantId: String(u.tenantId),
        createdAt: u.createdAt ?? (u._id?.getTimestamp ? u._id.getTimestamp() : null),
        deactivatedAt: u.deactivatedAt || null,
    };
}

async function audit(auth: AppAuth, action: string, details: Record<string, unknown>) {
    await sys(() => AppAuditEvent.create({
        appId: auth.app._id, actorUserId: auth.owner ? oid(auth.owner.userId) : null, actorKind: auth.owner ? "owner" : "app", action, details, at: new Date(),
    }), "app-audit").catch(() => undefined);
}

/** Membership + managed grant: what makes the user reachable in the tenant and lets the app get tokens. */
async function activate(app: IDeveloperApp, tenantId: mongoose.Types.ObjectId, userId: mongoose.Types.ObjectId, externalUserId: string) {
    await sys(() => TenantMembership.updateOne(
        { tenantId, userId },
        { $set: { status: "active", role: "member", source: "app", removedAt: null, lastSeenAt: new Date() }, $setOnInsert: { joinedAt: new Date() } },
        { upsert: true },
    ));
    await sys(() => AppGrant.updateOne(
        { appId: app._id, userId },
        { $set: { status: "active", managed: true, tenantId, externalUserRef: externalUserId, scopes: [] }, $inc: { version: 1 } },
        { upsert: true },
    ));
    forgetMembership(String(tenantId), String(userId));
}

async function find(app: IDeveloperApp, externalUserId: string) {
    const tenantId = tenantOf(app);
    const user = await sys(() => User.findOne({ tenantId, appId: app._id, externalUserId: externalId(externalUserId) }).lean());
    if (!user) throw new NotFoundError("User not found");
    return { user, tenantId };
}

/**
 * Register a user in the application's tenant. Registering an externalUserId again is refused (409);
 * a deactivated user is brought back with PATCH { active: true }.
 */
export async function registerAppUser(auth: AppAuth, input: AppUserInput) {
    const { app } = auth;
    if (app.status !== "active") throw new ForbiddenError("This app is not active");
    const tenantId = tenantOf(app);
    const externalUserId = externalId(input.externalUserId);
    const name = validateUsername(input.name);
    const contactEmail = emailFrom(input.email);
    const avatar = avatarFrom(input.avatarUrl, app);

    const tenant = await sys(() => Tenant.findOne({ _id: tenantId, kind: "app", appId: app._id }).select("status").lean());
    if (!tenant || tenant.status !== "active") throw new ForbiddenError("This app's workspace is not available");
    const limit = APP_USER_LIMITS[app.environment];
    if ((await sys(() => User.countDocuments({ tenantId, appId: app._id }))) >= limit) {
        throw new AppError(`This app has reached its limit of ${limit} registered users`, 409);
    }
    let user;
    try {
        user = await sys(() => User.create({
            username: name, tenantId, appId: app._id, externalUserId, contactEmail, avatar,
            // Not a SpreeWe account: never in the global directory, no sign-in
            globalDiscoverable: false, isVerified: true,
        }));
    } catch (error: any) {
        if (error?.code === 11000) {
            // Any other unique index here means the old all-document index on users.email is still in
            // place: migration 2026-11-16-app-tenants has not run on this database yet
            if (!("externalUserId" in (error.keyPattern || { externalUserId: 1 }))) throw migrationPending();
            throw new AppError("A user with this externalUserId is already registered", 409);
        }
        if (error?.name === "ValidationError") throw new AppError("The user could not be registered: check name and email");
        throw error;
    }
    await activate(app, tenantId, user._id as unknown as mongoose.Types.ObjectId, externalUserId);
    recordUsage(String(app._id), "usersRegistered");
    await audit(auth, "user.registered", { userId: String(user._id), externalUserId });
    return publicAppUser(user.toObject({ transform: false }));
}

export async function getAppUser({ app }: AppAuth, externalUserId: string) {
    return publicAppUser((await find(app, externalUserId)).user);
}

export async function listAppUsers({ app }: AppAuth, query: { limit: number; cursor?: string; status?: "active" | "deactivated" }) {
    const tenantId = tenantOf(app);
    const filter: Record<string, unknown> = { tenantId, appId: app._id };
    if (query.status) filter.deactivatedAt = query.status === "active" ? null : { $ne: null };
    if (query.cursor) filter._id = { $gt: oid(query.cursor) };
    const rows = await sys(() => User.find(filter).sort({ _id: 1 }).limit(query.limit + 1).lean());
    const page = rows.slice(0, query.limit);
    return { items: page.map(publicAppUser), nextCursor: rows.length > query.limit ? String(page[page.length - 1]._id) : null };
}

export async function updateAppUser(auth: AppAuth, externalUserId: string, patch: { name?: string; email?: string | null; avatarUrl?: string | null; active?: boolean }) {
    const { app } = auth;
    const { user, tenantId } = await find(app, externalUserId);
    const set: Record<string, unknown> = {};
    const unset: Record<string, unknown> = {};
    if (patch.name !== undefined) set.username = validateUsername(patch.name);
    if (patch.email !== undefined) {
        const email = emailFrom(patch.email);
        if (email) set.contactEmail = email; else unset.contactEmail = 1;
    }
    if (patch.avatarUrl !== undefined) set.avatar = avatarFrom(patch.avatarUrl, app);
    if (patch.active === false && !user.deactivatedAt) {
        await deactivate(auth, tenantId, user);
    } else if (patch.active === true && user.deactivatedAt) {
        set.deactivatedAt = null;
    }
    if (Object.keys(set).length || Object.keys(unset).length) {
        await sys(() => User.updateOne({ _id: user._id, tenantId, appId: app._id }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }));
    }
    if (patch.active === true && user.deactivatedAt) {
        await activate(app, tenantId, user._id as unknown as mongoose.Types.ObjectId, user.externalUserId!);
        await audit(auth, "user.reactivated", { userId: String(user._id), externalUserId: user.externalUserId });
    }
    return publicAppUser((await find(app, externalUserId)).user);
}

/**
 * Deactivate: the user can no longer get or use tokens (grant revoked, membership removed: both are
 * checked on every request), leaves the directory, and the app's encryption devices for them are
 * revoked. The record and their past messages are kept; conversations still show their name.
 */
async function deactivate(auth: AppAuth, tenantId: mongoose.Types.ObjectId, user: { _id: unknown; externalUserId?: string | null }) {
    const { app } = auth;
    const userId = oid(user._id);
    await sys(() => AppGrant.updateOne({ appId: app._id, userId }, { $set: { status: "revoked" }, $inc: { version: 1 } }));
    await sys(() => TenantMembership.updateOne({ tenantId, userId }, { $set: { status: "removed", removedAt: new Date() } }));
    await sys(() => User.updateOne({ _id: userId, tenantId, appId: app._id }, { $set: { deactivatedAt: new Date(), isOnline: false } }));
    forgetMembership(String(tenantId), String(userId));
    await revokeAppDevices(String(app._id), String(userId)).catch(() => undefined);
    await audit(auth, "user.deactivated", { userId: String(userId), externalUserId: user.externalUserId });
}

export async function deactivateAppUser(auth: AppAuth, externalUserId: string) {
    const { user, tenantId } = await find(auth.app, externalUserId);
    if (!user.deactivatedAt) await deactivate(auth, tenantId, user);
    return { deactivated: true };
}
