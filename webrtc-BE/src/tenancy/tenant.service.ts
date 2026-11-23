import mongoose from "mongoose";
import Tenant, { DEFAULT_TENANT_POLICIES, ITenant, ITenantPolicies } from "../models/tenantModel";
import TenantMembership from "../models/tenantMembershipModel";
import User from "../models/userModel";
import Conversation from "../models/conversationModel";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";
import { escapeRegExp, requireObjectId } from "../utils/validation";
import { RequestContext, TenantRole, runAsSystem, runWithContext } from "./context";
import { ScopeInfo, conversationScope, rememberConversationScope } from "./scope";
import { anyOutsideRealm, assertSameRealm, realmUserFilter } from "./realm";

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** Organization claims of a verified Clerk session (HTTP getAuth or socket token payload). */
export interface OrgClaims {
    orgId?: string | null;
    orgRole?: string | null;
    orgSlug?: string | null;
}

/** Org claims from a verified session-token payload: v2 tokens use `o`, v1 tokens `org_*`. */
export function orgClaimsFromPayload(payload: Record<string, any>): OrgClaims {
    if (payload?.v === 2 || payload?.o) {
        const o = payload?.o;
        return { orgId: o?.id || null, orgRole: o?.rol ? `org:${o.rol}` : null, orgSlug: o?.slg || null };
    }
    return { orgId: payload?.org_id || null, orgRole: payload?.org_role || null, orgSlug: payload?.org_slug || null };
}

/** Clerk role → our role. "org:owner" is a custom role you can create in Clerk; admin/member are built in. */
export function mapRole(orgRole: string | null | undefined): TenantRole {
    switch (orgRole) {
        case "org:owner": return "owner";
        case "org:admin": return "admin";
        default: return "member";
    }
}

const platformAdmins = () => new Set((process.env.PLATFORM_ADMIN_CLERK_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));

// ------------------------------------------------------------------ context resolution

type CachedTenant = { id: string; status: string; policies: ITenantPolicies; managedBy: "spreewe" | "clerk"; kind: "organization" | "app" };
const tenantByOrg = new Map<string, { tenant: CachedTenant; at: number }>();
const TENANT_TTL_MS = 30_000;
const projectionSeen = new Map<string, number>();
const PROJECTION_TTL_MS = 5 * 60_000;

async function tenantForOrg(clerkOrgId: string, slug: string | null): Promise<CachedTenant> {
    const hit = tenantByOrg.get(clerkOrgId);
    if (hit && Date.now() - hit.at < TENANT_TTL_MS) {
        return hit.tenant;
    }
    // First sight of an organization creates its tenant with the secure default policies
    const doc = await runAsSystem(() => Tenant.findOneAndUpdate(
        { clerkOrgId },
        { $setOnInsert: { clerkOrgId, name: slug || "", slug: slug || "", status: "active", policies: { ...DEFAULT_TENANT_POLICIES } } },
        { upsert: true, new: true },
    ).lean());
    const tenant: CachedTenant = { id: String(doc!._id), status: doc!.status, policies: { ...DEFAULT_TENANT_POLICIES, ...(doc!.policies || {}) }, managedBy: doc!.managedBy === "spreewe" ? "spreewe" : "clerk", kind: doc!.kind === "app" ? "app" : "organization" };
    tenantByOrg.set(clerkOrgId, { tenant, at: Date.now() });
    return tenant;
}

/** Drop cached tenant data (after a policy / status change). */
export function forgetTenant(tenantId: string): void {
    for (const [orgId, entry] of tenantByOrg) {
        if (entry.tenant.id === tenantId) {
            tenantByOrg.delete(orgId);
        }
    }
}

/**
 * Trusted context for an authenticated user. The organization comes only from the verified
 * session (Clerk's active organization), never from request parameters.
 *
 * Revocation: a membership removed in Clerk (webhook tombstone) or a deleted / suspended tenant
 * refuses the workspace immediately, even for session tokens Clerk would still accept until they
 * expire. `issuedAt` (token iat, seconds) tells a stale token apart from a re-added member's new one.
 */
export async function resolveContext(localUserId: string, clerkUserId: string, claims: OrgClaims, issuedAt?: number | null): Promise<RequestContext> {
    const isPlatformAdmin = platformAdmins().has(clerkUserId);
    if (!claims.orgId) {
        return { kind: "user", userId: String(localUserId), tenantId: null, clerkOrgId: null, role: null, isPlatformAdmin };
    }
    if (!/^org_[A-Za-z0-9]+$/.test(claims.orgId)) {
        throw new AppError("Invalid organization in session", 401);
    }
    const tenant = await tenantForOrg(claims.orgId, claims.orgSlug || null);
    // An application's dedicated tenant is reachable only with that application's user tokens
    if (tenant.kind === "app") {
        throw new ForbiddenError("This workspace is not available");
    }
    if (tenant.status !== "active") {
        throw new ForbiddenError(tenant.status === "deleted" ? "This workspace no longer exists" : "This workspace is suspended");
    }
    const userId = String(localUserId);
    const state = await membershipState(tenant.id, userId);
    if (tenant.managedBy === "spreewe") {
        // Organization managed in SpreeWe: membership and role are SpreeWe's. Clerk's claim alone (e.g.
        // someone added in the Clerk dashboard, or a half-finished sync) never grants access.
        if (!state || state.status !== "active") {
            throw new ForbiddenError("You are not a member of this organization");
        }
        return { kind: "user", userId, tenantId: tenant.id, clerkOrgId: claims.orgId, role: state.role as TenantRole, isPlatformAdmin };
    }
    if (state?.status === "removed") {
        const removedAt = state.removedAt ? state.removedAt.getTime() : Number.POSITIVE_INFINITY;
        const tokenAt = typeof issuedAt === "number" && Number.isFinite(issuedAt) ? issuedAt * 1000 : null;
        if (tokenAt === null || tokenAt <= removedAt) {
            throw new ForbiddenError("You are no longer a member of this workspace");
        }
        // Token issued after the removal: Clerk re-added them
        await runAsSystem(() => TenantMembership.updateOne(
            { tenantId: oid(tenant.id), userId: oid(userId), status: "removed" },
            { $set: { status: "active", removedAt: null } },
        ), "membership-reactivate");
        forgetMembership(tenant.id, userId);
    }
    const role = mapRole(claims.orgRole);
    await recordMembership(tenant.id, userId, role);
    // The check above may have cached "no membership yet" for a first-time member; it's active now
    membershipCache.set(`${tenant.id}:${userId}`, { value: { status: "active", removedAt: null }, at: Date.now() });
    return { kind: "user", userId, tenantId: tenant.id, clerkOrgId: claims.orgId, role, isPlatformAdmin };
}

// Short cache of the membership tombstone check (one indexed read per user per workspace per TTL).
// Webhook handling invalidates it in this process; other instances catch up within the TTL.

/**
 * MEMBERSHIP_CHECK_CACHE_MS (0–60000, default 15000). The tombstone lives in MongoDB (shared by all
 * instances); this cache is per process. 0 = read MongoDB on every request (immediate revocation
 * on every instance, one indexed read per request).
 */
function membershipTtlMs(): number {
    const n = Number(process.env.MEMBERSHIP_CHECK_CACHE_MS);
    return Number.isFinite(n) && process.env.MEMBERSHIP_CHECK_CACHE_MS !== undefined && process.env.MEMBERSHIP_CHECK_CACHE_MS !== "" ? Math.min(60_000, Math.max(0, n)) : 15_000;
}
const membershipCache = new Map<string, { value: { status: string; removedAt: Date | null; role?: string } | null; at: number }>();

async function membershipState(tenantId: string, userId: string) {
    const key = `${tenantId}:${userId}`;
    const hit = membershipCache.get(key);
    if (hit && Date.now() - hit.at < membershipTtlMs()) {
        return hit.value;
    }
    const row = await runAsSystem(() => TenantMembership.findOne({ tenantId: oid(tenantId), userId: oid(userId) }).select("status removedAt role").lean(), "membership-check");
    const value = row ? { status: row.status, removedAt: row.removedAt || null, role: row.role } : null;
    membershipCache.set(key, { value, at: Date.now() });
    return value;
}

/**
 * For developer-app tokens: the user must be an ACTIVE member of the token's tenant now, and the
 * tenant must be active. (A token never creates or revives a membership.)
 */
export async function assertActiveTenantMember(tenantId: string, userId: string): Promise<void> {
    const tenant = await runAsSystem(() => Tenant.findById(tenantId).select("status").lean(), "app-token-tenant");
    if (!tenant || tenant.status !== "active") {
        throw new ForbiddenError("This workspace is not available");
    }
    const state = await membershipState(tenantId, userId);
    if (!state || state.status !== "active") {
        throw new ForbiddenError("You are no longer a member of this workspace");
    }
}

export function forgetMembership(tenantId: string, userId?: string): void {
    for (const key of [...membershipCache.keys(), ...projectionSeen.keys()]) {
        if (key.startsWith(`${tenantId}:${userId ?? ""}`)) {
            membershipCache.delete(key);
            projectionSeen.delete(key);
        }
    }
}

/** Keep the local membership projection current (throttled; role changes write immediately). */
async function recordMembership(tenantId: string, userId: string, role: TenantRole): Promise<void> {
    const key = `${tenantId}:${userId}:${role}`;
    if (Date.now() - (projectionSeen.get(key) || 0) < PROJECTION_TTL_MS) {
        return;
    }
    // Never resurrects a removed membership (that only happens above, for a newer token)
    try {
        await runAsSystem(() => TenantMembership.updateOne(
            { tenantId: oid(tenantId), userId: oid(userId), status: { $ne: "removed" } },
            { $set: { role, lastSeenAt: new Date() }, $setOnInsert: { status: "active" } },
            { upsert: true },
        ), "membership-projection");
    } catch (error: any) {
        // Upsert raced with a removal tombstone (unique key): the tombstone wins
        if (error?.code !== 11000) throw error;
    }
    projectionSeen.set(key, Date.now());
}

/** Test helper: reset in-memory caches. */
export function resetTenantCaches(): void {
    tenantByOrg.clear();
    projectionSeen.clear();
    membershipCache.clear();
}

// ------------------------------------------------------------------ permissions

export type Permission =
    | "tenant:read"
    | "tenant:policies:update"
    | "tenant:members:read"
    | "external:start";

/**
 * Role → permission matrix for the ACTIVE workspace. Platform admins get nothing extra inside a
 * tenant's data (no implicit cross-tenant access); platform operations are separate.
 */
export function can(ctx: RequestContext, permission: Permission, policies?: ITenantPolicies): boolean {
    if (!ctx.tenantId || !ctx.role) {
        return false;
    }
    const admin = ctx.role === "owner" || ctx.role === "admin";
    switch (permission) {
        case "tenant:read":
            return true;
        case "tenant:members:read":
            return ctx.role !== "guest";
        case "tenant:policies:update":
            return admin;
        case "external:start":
            return ctx.role !== "guest" && !!policies?.allowExternalChat && (admin || !!policies.membersCanStartExternal);
        default:
            return false;
    }
}

export function requireTenant(ctx: RequestContext): string {
    if (!ctx.tenantId) {
        throw new AppError("Switch to a workspace first", 400);
    }
    return ctx.tenantId;
}

export async function policiesOf(tenantId: string): Promise<ITenantPolicies> {
    const doc = await runAsSystem(() => Tenant.findById(tenantId).select("policies").lean());
    return { ...DEFAULT_TENANT_POLICIES, ...(doc?.policies || {}) };
}

// ------------------------------------------------------------------ membership rules

export const isGuest = (ctx: RequestContext | null | undefined): boolean => !!ctx?.tenantId && ctx.role === "guest";

/**
 * Guests don't get an organization's directory: the people they can find, see or add are only the
 * ones they already share a conversation with there (their teams' channels, chats they were added to).
 */
export async function guestContacts(ctx: RequestContext): Promise<mongoose.Types.ObjectId[]> {
    const rows = await runWithContext(ctx, () => Conversation.find({ members: oid(ctx.userId) }).select("members").limit(2000).lean());
    const ids = new Set(rows.flatMap((c: any) => (c.members || []).map(String)));
    ids.delete(String(ctx.userId));
    return [...ids].map(oid);
}

/**
 * In a workspace, conversations / groups / meetings may only include members of that workspace.
 * Outsiders need an explicit external conversation (createExternalConversation).
 * In the global context any SpreeWe account may be included, as before.
 * In every context: never a user of another realm (another application's users, or SpreeWe accounts
 * from inside an application tenant).
 */
export async function assertCanInclude(ctx: RequestContext | undefined, userIds: string[]): Promise<void> {
    if (ctx) {
        await assertSameRealm(ctx, userIds.filter((id) => String(id) !== ctx.userId));
    }
    if (!ctx?.tenantId) {
        return;
    }
    const others = [...new Set(userIds.map(String))].filter((id) => id !== ctx.userId);
    if (!others.length) {
        return;
    }
    const count = await runAsSystem(() => TenantMembership.countDocuments({
        tenantId: oid(ctx.tenantId!),
        userId: { $in: others.map(oid) },
        status: "active",
    }));
    if (count !== others.length) {
        throw new ForbiddenError("Only members of this workspace can be added here");
    }
    if (isGuest(ctx)) {
        const contacts = new Set((await guestContacts(ctx)).map(String));
        if (others.some((id) => !contacts.has(id))) {
            throw new ForbiddenError("Guests can only include people they already share a conversation with");
        }
    }
}

/**
 * Policy gate for things that cross the workspace boundary. Internal and global conversations are
 * not affected; external ones need the tenant's matching policy switched on.
 */
export async function assertExternalAllowed(conversationId: unknown, action: "chat" | "call" | "file"): Promise<void> {
    const info = await conversationScope(conversationId);
    if (!info || info.scope !== "external" || !info.tenantId) {
        return;
    }
    const policies = await policiesOf(info.tenantId);
    const allowed = action === "chat" ? policies.allowExternalChat
        : action === "call" ? policies.allowExternalChat && policies.allowExternalCalls
        : policies.allowExternalChat && policies.allowExternalFiles;
    if (!allowed) {
        throw new ForbiddenError(action === "chat"
            ? "External chat is turned off for this workspace"
            : action === "call" ? "Calls with external people are turned off for this workspace"
            : "File sharing with external people is turned off for this workspace");
    }
}

// ------------------------------------------------------------------ external conversations

/**
 * A 1:1 conversation between a workspace member and an outside person, owned by the workspace.
 * Requires the workspace policy and the caller's permission; the guest sees only this conversation.
 */
export async function createExternalConversation(ctx: RequestContext, guestUserId: unknown) {
    const tenantId = requireTenant(ctx);
    const policies = await policiesOf(tenantId);
    if (!can(ctx, "external:start", policies)) {
        throw new ForbiddenError(policies.allowExternalChat
            ? "Only workspace admins can start external conversations"
            : "External chat is turned off for this workspace");
    }
    const guestId = requireObjectId(guestUserId, "userId");
    if (guestId === ctx.userId) {
        throw new AppError("You can't start an external chat with yourself");
    }
    // Application tenants are closed workspaces: no external conversations in or out of them
    if (ctx.realm) {
        throw new ForbiddenError("External chat is turned off for this workspace");
    }
    const guest = await runAsSystem(() => User.findOne({ _id: oid(guestId), ...realmUserFilter(ctx) }).select("_id").lean());
    if (!guest) {
        throw new NotFoundError("User not found");
    }
    const isMember = await runAsSystem(() => TenantMembership.exists({ tenantId: oid(tenantId), userId: oid(guestId), status: "active" }));
    if (isMember) {
        throw new AppError("This person is a member of the workspace; start a normal chat instead");
    }
    const existing = await runAsSystem(() => Conversation.findOne({
        tenantId: oid(tenantId),
        scope: "external",
        isGroup: false,
        members: { $all: [oid(ctx.userId), oid(guestId)] },
    }));
    if (existing) {
        return existing;
    }
    const conversation = new Conversation({
        members: [ctx.userId, guestId],
        isGroup: false,
        tenantId: oid(tenantId),
        scope: "external",
        externalParticipants: [oid(guestId)],
    });
    // Scope set explicitly above; save as system so the context stamp does not override it
    await runAsSystem(() => conversation.save());
    const info: ScopeInfo = { tenantId, scope: "external", externalParticipants: [guestId] };
    rememberConversationScope(String(conversation._id), info);
    return conversation;
}

// ------------------------------------------------------------------ tenant admin + directory

export async function tenantSummary(ctx: RequestContext) {
    const tenantId = requireTenant(ctx);
    const tenant = await runAsSystem(() => Tenant.findById(tenantId).lean<ITenant>());
    if (!tenant) {
        throw new NotFoundError("Workspace not found");
    }
    return {
        _id: String(tenant._id),
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        role: ctx.role,
        policies: { ...DEFAULT_TENANT_POLICIES, ...(tenant.policies || {}) },
        permissions: {
            updatePolicies: can(ctx, "tenant:policies:update"),
            startExternal: can(ctx, "external:start", { ...DEFAULT_TENANT_POLICIES, ...(tenant.policies || {}) }),
        },
    };
}

const POLICY_KEYS: (keyof ITenantPolicies)[] = ["allowExternalChat", "allowExternalCalls", "allowExternalFiles", "membersCanStartExternal"];

export async function updatePolicies(ctx: RequestContext, input: unknown) {
    const tenantId = requireTenant(ctx);
    if (!can(ctx, "tenant:policies:update")) {
        throw new ForbiddenError("Only workspace owners and admins can change policies");
    }
    if (!input || typeof input !== "object") {
        throw new AppError("Policies are required");
    }
    const set: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
        if (!POLICY_KEYS.includes(key as keyof ITenantPolicies)) {
            throw new AppError(`Unknown policy: ${key.slice(0, 40)}`);
        }
        if (typeof value !== "boolean") {
            throw new AppError(`${key} must be true or false`);
        }
        set[`policies.${key}`] = value;
    }
    if (!Object.keys(set).length) {
        throw new AppError("Nothing to update");
    }
    await runAsSystem(() => Tenant.updateOne({ _id: oid(tenantId) }, { $set: set }));
    forgetTenant(tenantId);
    return tenantSummary(ctx);
}

/** Fields shown to people who don't share a conversation with the user (no email). */
export const DIRECTORY_FIELDS = "username avatar isOnline lastSeen bio status statusMessage autoAway";

/**
 * People I may start a conversation with in the active context:
 *   workspace → active members of that workspace
 *   global    → users who are listed in the global directory
 */
export async function directory(ctx: RequestContext, opts: { q?: unknown; limit?: number } = {}) {
    const limit = Math.min(Math.max(opts.limit || 500, 1), 1000);
    const filter = await directoryFilter(ctx, opts.q);
    return runAsSystem(() => User.find(filter).select(DIRECTORY_FIELDS).sort({ username: 1 }).limit(limit).lean());
}

/** Audience of the directory in this context, as a User filter (shared by legacy and /v1). */
export async function directoryFilter(ctx: RequestContext, q?: unknown): Promise<Record<string, unknown>> {
    const text = typeof q === "string" ? q.trim().slice(0, 100) : "";
    const filter: Record<string, unknown> = { _id: { $ne: oid(ctx.userId) } };
    if (text) {
        filter.username = { $regex: escapeRegExp(text), $options: "i" };
    }
    if (isGuest(ctx)) {
        filter._id = { $in: await guestContacts(ctx) };
    } else if (ctx.tenantId) {
        const rows = await runAsSystem(() => TenantMembership.find({ tenantId: oid(ctx.tenantId!), status: "active" }).select("userId").lean());
        filter._id = { $in: rows.map((r) => r.userId).filter((id) => String(id) !== ctx.userId) };
    } else {
        // Personal context: no public directory. People I already talk to; others are found by exact
        // email (contacts/contact.service.ts)
        filter._id = { $in: await guestContacts(ctx) };
    }
    // Only people of the acting user's realm (never another application's users), and not deactivated
    Object.assign(filter, realmUserFilter(ctx));
    filter.deactivatedAt = null;
    // Accounts deleted or banned in Clerk are never listed
    filter.clerkDeletedAt = null;
    filter.clerkBanned = { $ne: true };
    return filter;
}

/** Can the acting user see this person's profile (directory member, or shares a conversation)? */
export async function canSeeUser(ctx: RequestContext, targetId: string): Promise<boolean> {
    if (targetId === ctx.userId) {
        return true;
    }
    if (await anyOutsideRealm(ctx, [targetId])) {
        return false;
    }
    // Shares a conversation visible in this context (tenant-scoped query)
    if (await Conversation.exists({ members: { $all: [oid(ctx.userId), oid(targetId)] } })) {
        return true;
    }
    if (isGuest(ctx)) {
        return false; // guests: shared conversations only (above)
    }
    if (ctx.tenantId) {
        return !!(await runAsSystem(() => TenantMembership.exists({ tenantId: oid(ctx.tenantId!), userId: oid(targetId), status: "active" })));
    }
    // Personal context: shared conversations only (no profile lookups of arbitrary accounts by id)
    return false;
}

/** Workspaces this user has been seen in (for a future workspace switcher). */
export async function myWorkspaces(ctx: RequestContext) {
    const rows = await runAsSystem(() => TenantMembership.find({ userId: oid(ctx.userId), status: "active" }).select("tenantId role").lean());
    const tenants = await runAsSystem(() => Tenant.find({ _id: { $in: rows.map((r) => r.tenantId) } }).select("clerkOrgId name slug status").lean());
    const byId = new Map(tenants.map((t) => [String(t._id), t]));
    return rows.map((r) => {
        const t = byId.get(String(r.tenantId));
        return t ? { tenantId: String(t._id), clerkOrgId: t.clerkOrgId, name: t.name, slug: t.slug, status: t.status, role: r.role, active: String(t._id) === ctx.tenantId } : null;
    }).filter(Boolean);
}
