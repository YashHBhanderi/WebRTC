import crypto from "crypto";
import mongoose from "mongoose";
import Tenant, { DEFAULT_TENANT_POLICIES, DEFAULT_TENANT_SETTINGS, ITenant, ITenantSettings, JoinPolicy } from "../models/tenantModel";
import TenantMembership, { ITenantMembership, MembershipRole } from "../models/tenantMembershipModel";
import User from "../models/userModel";
import Conversation from "../models/conversationModel";
import { RequestContext, runAsSystem } from "../tenancy/context";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";
import { escapeRegExp } from "../utils/validation";
import { disconnectWorkspaceSockets } from "../realtime/io";
import { syncMembership, syncTenant } from "../realtime/workspace-sync";
import { safeError } from "../utils/safe-log";
import { IOrgInvitation, JoinRequest, OrgAuditEvent, OrgInvitation, Team, TeamMembership } from "./models";
import { orgEvents, teamEvents, teamViewers } from "./events";
import { invitableRoles, mayChangeRole, mayRemove, OrgAction, orgCan } from "./permissions";
import { ClerkSyncError, createClerkOrganization, deleteClerkOrganization, ensureClerkMembership, removeClerkMembership, verifiedEmailsOf } from "./clerk-sync";
import { deliverInvitation } from "./mailer";

/**
 * Organizations managed in SpreeWe: creation, settings, invitations, joining, members and roles.
 *
 * Consistency with Clerk (no distributed transaction): every workflow is ordered so that a failure at
 * any step leaves the user WITHOUT access, and compensations undo the earlier steps. Access to a
 * SpreeWe-managed organization needs an active TenantMembership here AND the Clerk session claim, so
 * neither side alone can grant it. See docs/organizations/clerk-integration.md.
 */
const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id));
const sys = <T>(fn: () => Promise<T>, reason: string) => runAsSystem(fn, reason);
const sha256 = (v: string) => crypto.createHash("sha256").update(v).digest("hex");
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const DOMAIN = /^(?=.{3,190}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

export const ORG_LIMITS = {
    /** Organizations a user may create per 24 h / own in total */
    createdPerDay: Number(process.env.ORG_CREATE_PER_DAY) > 0 ? Number(process.env.ORG_CREATE_PER_DAY) : 5,
    ownedTotal: Number(process.env.ORG_OWNED_MAX) > 0 ? Number(process.env.ORG_OWNED_MAX) : 20,
    invitationsPerCall: 50,
    pendingInvitations: 500,
};

// ------------------------------------------------------------------ shared helpers

async function audit(tenantId: unknown, actorId: unknown, action: string, target: Record<string, unknown> = {}): Promise<void> {
    await sys(() => OrgAuditEvent.create({ tenantId: oid(tenantId), actorId: actorId ? oid(actorId) : null, action, target, at: new Date() }), "org-audit").catch((e) => console.error("[org] audit failed:", safeError(e)));
}

/** Tell the people who can see these teams that their membership changed (after someone left them). */
async function teamMembersChanged(tenantId: unknown, teamIds: unknown[]): Promise<void> {
    if (!teamIds.length) return;
    const [teams, members] = await Promise.all([
        sys(() => Team.find({ tenantId: oid(tenantId), _id: { $in: teamIds.map(oid) }, status: "active" }).select("visibility").lean(), "org-team-events"),
        sys(() => TeamMembership.find({ tenantId: oid(tenantId), teamId: { $in: teamIds.map(oid) }, status: "active" }).select("teamId userId").lean(), "org-team-events"),
    ]);
    for (const t of teams) {
        const memberIds = members.filter((m) => String(m.teamId) === String(t._id)).map((m) => m.userId);
        teamEvents.membersChanged(tenantId, t._id, teamViewers(t.visibility, memberIds));
    }
}

async function managedTenant(tenantId: unknown): Promise<ITenant> {
    const t = await sys(() => Tenant.findOne({ _id: oid(tenantId), managedBy: "spreewe" }).lean<ITenant>(), "org-load");
    if (!t || t.status === "deleted") throw new NotFoundError("Organization not found");
    return t;
}

export const settingsOf = (t: Pick<ITenant, "settings">): ITenantSettings => ({ ...DEFAULT_TENANT_SETTINGS, ...((t.settings as any)?.toObject?.() ?? t.settings ?? {}) });

/** The ACTIVE workspace as a SpreeWe-managed organization, with the caller's server-side role. */
export async function activeOrg(ctx: RequestContext, action?: OrgAction): Promise<{ tenant: ITenant; role: MembershipRole; settings: ITenantSettings }> {
    if (!ctx.tenantId || !ctx.role) throw new AppError("Switch to an organization first", 400);
    const tenant = await managedTenant(ctx.tenantId).catch(async (error) => {
        // A workspace that predates SpreeWe-managed organizations (members managed in Clerk) exists, so say so
        if (await sys(() => Tenant.exists({ _id: oid(ctx.tenantId), managedBy: { $ne: "spreewe" } }), "org-load")) {
            throw new NotFoundError("This workspace's members are managed in Clerk, so organization settings, teams and channels aren't available for it");
        }
        throw error;
    });
    if (tenant.status !== "active") throw new ForbiddenError("This organization is suspended");
    const settings = settingsOf(tenant);
    const role = ctx.role as MembershipRole;
    if (action && !orgCan(role, action, settings)) throw new ForbiddenError("You don't have permission to do this in this organization");
    return { tenant, role, settings };
}

async function clerkIdOf(userId: unknown): Promise<string> {
    const u = await sys(() => User.findById(oid(userId)).select("clerkId").lean(), "org-user");
    if (!u?.clerkId) throw new AppError("This account is not linked to a sign-in", 409);
    return String(u.clerkId);
}

function domainAllowed(settings: ITenantSettings, email: string): boolean {
    if (!settings.allowedEmailDomains.length) return true;
    const domain = email.split("@").pop() || "";
    return settings.allowedEmailDomains.includes(domain);
}

const activeOwners = (tenantId: unknown) => sys(() => TenantMembership.countDocuments({ tenantId: oid(tenantId), status: "active", role: "owner" }), "org-owners");

/**
 * Demote an owner while keeping at least one. Callers' count-then-write checks can't stop two owners
 * demoting (or removing) each other at the same moment, so this re-counts after the write and undoes
 * it if the organization was left without an owner.
 */
async function demoteOwner(tenantId: unknown, membershipId: unknown, to: MembershipRole, lastOwnerMessage: string): Promise<void> {
    const res = await sys(() => TenantMembership.updateOne({ _id: membershipId, role: "owner", status: "active" }, { $set: { role: to } }), "org-owner");
    if (!res.modifiedCount) throw new AppError("The member changed meanwhile. Try again.", 409);
    if ((await activeOwners(tenantId)) === 0) {
        await sys(() => TenantMembership.updateOne({ _id: membershipId }, { $set: { role: "owner" } }), "org-owner");
        throw new AppError(lastOwnerMessage, 409);
    }
}

/**
 * Add (or re-activate) a member: Clerk first, then the local record that grants access. If the local
 * write fails the Clerk membership is removed again; if Clerk fails nothing was granted.
 */
async function addMember(tenant: ITenant, userId: string, role: MembershipRole, source: NonNullable<ITenantMembership["source"]>): Promise<"added" | "already"> {
    const existing = await sys(() => TenantMembership.findOne({ tenantId: tenant._id, userId: oid(userId) }).lean(), "org-member");
    if (existing?.status === "active") return "already";
    const clerkUserId = await clerkIdOf(userId);
    await ensureClerkMembership(tenant.clerkOrgId, clerkUserId, role);
    try {
        await sys(() => TenantMembership.updateOne(
            { tenantId: tenant._id, userId: oid(userId) },
            { $set: { status: "active", role, source, joinedAt: new Date(), removedAt: null, lastSeenAt: new Date() } },
            { upsert: true },
        ), "org-member");
    } catch (error) {
        await removeClerkMembership(tenant.clerkOrgId, clerkUserId).catch(() => undefined);
        throw error;
    }
    syncMembership(String(tenant._id), userId, role);
    orgEvents.joined(userId, { organizationId: tenant._id, clerkOrgId: tenant.clerkOrgId, name: tenant.name, role });
    orgEvents.membersChanged(tenant._id);
    return "added";
}

/**
 * Remove access: local tombstone first (access ends now), then tell the member on all their sockets
 * (before the disconnect, or the notice is lost), end their sockets in the organization on every
 * instance, update everyone who can see the member list or their teams, then Clerk (best effort).
 */
async function removeMember(tenant: ITenant, userId: string, actorId: string, reason: "removed" | "left"): Promise<void> {
    const teamIds = (await sys(() => TeamMembership.find({ tenantId: tenant._id, userId: oid(userId), status: "active" }).select("teamId").lean(), "org-member")).map((m) => m.teamId);
    await sys(() => TenantMembership.updateOne({ tenantId: tenant._id, userId: oid(userId) }, { $set: { status: "removed", removedAt: new Date() } }), "org-member");
    await sys(() => TeamMembership.updateMany({ tenantId: tenant._id, userId: oid(userId) }, { $set: { status: "removed" } }), "org-member");
    // …and out of every team channel of this organization (channels are conversations)
    await sys(() => Conversation.updateMany({ tenantId: tenant._id, teamId: { $ne: null }, members: oid(userId) }, { $pull: { members: oid(userId), groupAdmins: oid(userId) } }), "org-member");
    orgEvents.removed(userId, tenant._id, reason);
    syncMembership(String(tenant._id), userId, null);
    orgEvents.membersChanged(tenant._id);
    await teamMembersChanged(tenant._id, teamIds).catch((e) => console.error("[org] team events failed:", safeError(e)));
    try {
        await removeClerkMembership(tenant.clerkOrgId, await clerkIdOf(userId));
    } catch (error) {
        // Access is already gone (local record is the authority); recorded for a retry
        await audit(tenant._id, actorId, "clerk.sync_failed", { op: "removeMembership", userId, code: (error as ClerkSyncError).code || "error" });
    }
}

// ------------------------------------------------------------------ create / read / update / delete

export interface CreateOrganizationInput {
    name: string;
    slug: string;
    description?: string;
    discoverable?: boolean;
    joinPolicy?: JoinPolicy;
    allowExternalChat?: boolean;
}

export async function createOrganization(ctx: RequestContext, input: CreateOrganizationInput) {
    if (ctx.app) throw new ForbiddenError("Apps cannot create organizations");
    const name = String(input.name || "").trim();
    const slug = String(input.slug || "").trim().toLowerCase();
    if (name.length < 2 || name.length > 80) throw new AppError("Organization name must be 2–80 characters");
    if (!SLUG.test(slug)) throw new AppError("The URL name may use 3–40 lower-case letters, digits and hyphens");
    const since = new Date(Date.now() - 24 * 3600_000);
    const [recent, owned] = await Promise.all([
        sys(() => Tenant.countDocuments({ createdBy: oid(ctx.userId), managedBy: "spreewe", createdAt: { $gte: since } }), "org-create"),
        sys(() => TenantMembership.countDocuments({ userId: oid(ctx.userId), role: "owner", status: "active" }), "org-create"),
    ]);
    if (recent >= ORG_LIMITS.createdPerDay) throw new AppError("You've created too many organizations today. Try again tomorrow.", 429);
    if (owned >= ORG_LIMITS.ownedTotal) throw new AppError(`You can own at most ${ORG_LIMITS.ownedTotal} organizations`, 409);
    if (await sys(() => Tenant.exists({ slug, managedBy: "spreewe" }), "org-create")) throw new AppError("That URL name is taken", 409);

    const creatorClerkId = await clerkIdOf(ctx.userId);
    // 1. Clerk organization (creator becomes a Clerk member, so the session can select it)
    const clerkOrgId = await createClerkOrganization(name, creatorClerkId);
    let tenant: ITenant;
    try {
        // 2. Tenant + 3. owner membership (local authority)
        const settings: ITenantSettings = { ...DEFAULT_TENANT_SETTINGS, discoverable: !!input.discoverable, joinPolicy: input.joinPolicy || "invite" };
        tenant = (await sys(() => Tenant.create({
            clerkOrgId, name, slug, managedBy: "spreewe", status: "active", description: String(input.description || "").slice(0, 500),
            policies: { ...DEFAULT_TENANT_POLICIES, allowExternalChat: !!input.allowExternalChat }, settings, createdBy: oid(ctx.userId),
        }), "org-create")).toObject() as ITenant;
        await sys(() => TenantMembership.updateOne(
            { tenantId: tenant._id, userId: oid(ctx.userId) },
            { $set: { status: "active", role: "owner", source: "creator", joinedAt: new Date(), removedAt: null, lastSeenAt: new Date() } },
            { upsert: true },
        ), "org-create");
    } catch (error) {
        // Compensate: nothing must remain half-created
        await sys(() => Tenant.deleteOne({ clerkOrgId }), "org-create-rollback").catch(() => undefined);
        await deleteClerkOrganization(clerkOrgId).catch((e) => console.error("[org] rollback of Clerk organization failed:", safeError(e)));
        if ((error as any)?.code === 11000) throw new AppError("That URL name is taken", 409);
        throw error;
    }
    await audit(tenant._id, ctx.userId, "org.created", { slug });
    // The creator's other tabs refresh their workspace list
    orgEvents.joined(ctx.userId, { organizationId: tenant._id, clerkOrgId, name, role: "owner" });
    return { organizationId: String(tenant._id), clerkOrgId, name, slug };
}

function card(t: ITenant, extra: Record<string, unknown> = {}) {
    const s = settingsOf(t);
    return { organizationId: String(t._id), clerkOrgId: t.clerkOrgId, name: t.name, slug: t.slug, description: t.description || "", avatar: t.avatar || "", discoverable: s.discoverable, joinPolicy: s.joinPolicy, ...extra };
}

/** Organizations I belong to (any managed or legacy), for the switcher. */
export async function myOrganizations(ctx: RequestContext) {
    const rows = await sys(() => TenantMembership.find({ userId: oid(ctx.userId), status: "active" }).select("tenantId role").lean(), "org-mine");
    const tenants = await sys(() => Tenant.find({ _id: { $in: rows.map((r) => r.tenantId) }, status: { $ne: "deleted" } }).lean<ITenant[]>(), "org-mine");
    const roleOf = new Map(rows.map((r) => [String(r.tenantId), r.role]));
    return tenants.map((t) => card(t, { role: roleOf.get(String(t._id)), managedBy: t.managedBy || "clerk", status: t.status, active: String(t._id) === ctx.tenantId }));
}

/** Discovery: only organizations that opted in. Never lists private ones; never reveals members. */
export async function discover(ctx: RequestContext, q?: string, limit = 20) {
    const filter: Record<string, unknown> = { managedBy: "spreewe", status: "active", "settings.discoverable": true };
    const text = String(q || "").trim().slice(0, 80);
    if (text) filter.$or = [{ name: { $regex: escapeRegExp(text), $options: "i" } }, { slug: { $regex: escapeRegExp(text.toLowerCase()) } }];
    const tenants = await sys(() => Tenant.find(filter).sort({ name: 1 }).limit(Math.min(50, Math.max(1, limit))).lean<ITenant[]>(), "org-discover");
    const ids = tenants.map((t) => t._id);
    const [mine, pending] = await Promise.all([
        sys(() => TenantMembership.find({ userId: oid(ctx.userId), tenantId: { $in: ids }, status: "active" }).select("tenantId").lean(), "org-discover"),
        sys(() => JoinRequest.find({ userId: oid(ctx.userId), tenantId: { $in: ids }, status: "pending" }).select("tenantId").lean(), "org-discover"),
    ]);
    const member = new Set(mine.map((m) => String(m.tenantId)));
    const asked = new Set(pending.map((p) => String(p.tenantId)));
    return tenants.map((t) => card(t, { myStatus: member.has(String(t._id)) ? "member" : asked.has(String(t._id)) ? "requested" : "none" }));
}

/** Overview of the active organization (any member). */
export async function overview(ctx: RequestContext) {
    const { tenant, role, settings } = await activeOrg(ctx, "org:read");
    const memberCount = await sys(() => TenantMembership.countDocuments({ tenantId: tenant._id, status: "active" }), "org-overview");
    const admin = orgCan(role, "org:update", settings);
    return {
        ...card(tenant), role, memberCount, policies: { ...DEFAULT_TENANT_POLICIES, ...(tenant.policies || {}) },
        ...(admin ? { settings: { ...settings, joinCodeSet: !!tenant.joinCodeHash } } : {}),
        permissions: Object.fromEntries((["org:update", "org:delete", "org:audit", "members:invite", "members:remove", "members:role", "requests:decide", "joincode:manage", "teams:create"] as OrgAction[]).map((a) => [a, orgCan(role, a, settings)])),
        invitableRoles: invitableRoles(role, settings),
    };
}

export async function updateOrganization(ctx: RequestContext, input: { name?: string; description?: string; slug?: string; settings?: Partial<ITenantSettings> }) {
    const { tenant, settings } = await activeOrg(ctx, "org:update");
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) {
        const name = String(input.name).trim();
        if (name.length < 2 || name.length > 80) throw new AppError("Organization name must be 2–80 characters");
        set.name = name;
    }
    if (input.description !== undefined) set.description = String(input.description).slice(0, 500);
    if (input.slug !== undefined) {
        const slug = String(input.slug).trim().toLowerCase();
        if (!SLUG.test(slug)) throw new AppError("The URL name may use 3–40 lower-case letters, digits and hyphens");
        if (slug !== tenant.slug && (await sys(() => Tenant.exists({ slug, managedBy: "spreewe" }), "org-update"))) throw new AppError("That URL name is taken", 409);
        set.slug = slug;
    }
    if (input.settings) {
        const next = { ...settings, ...input.settings };
        if (!["invite", "request", "open"].includes(next.joinPolicy)) throw new AppError("Unknown join policy");
        next.allowedEmailDomains = [...new Set((next.allowedEmailDomains || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
        if (next.allowedEmailDomains.length > 20 || next.allowedEmailDomains.some((d) => !DOMAIN.test(d))) throw new AppError("Allowed email domains are invalid (at most 20)");
        // Joining without an invitation only makes sense for discoverable organizations
        if (!next.discoverable && next.joinPolicy !== "invite") next.joinPolicy = "invite";
        set.settings = next;
    }
    if (!Object.keys(set).length) return overview(ctx);
    try {
        await sys(() => Tenant.updateOne({ _id: tenant._id }, { $set: set }), "org-update");
    } catch (error) {
        if ((error as any)?.code === 11000) throw new AppError("That URL name is taken", 409);
        throw error;
    }
    syncTenant(String(tenant._id));
    await audit(tenant._id, ctx.userId, "org.updated", { fields: Object.keys(set) });
    orgEvents.updated(tenant._id);
    return overview(ctx);
}

export async function deleteOrganization(ctx: RequestContext, confirm: string) {
    const { tenant } = await activeOrg(ctx, "org:delete");
    if (confirm !== tenant.name) throw new AppError("Confirm with the organization's exact name");
    const memberIds = (await sys(() => TenantMembership.find({ tenantId: tenant._id, status: "active" }).select("userId").lean(), "org-delete")).map((m) => m.userId);
    // Access ends now (status), data is kept; Clerk organization removed afterwards
    await sys(() => Tenant.updateOne({ _id: tenant._id }, { $set: { status: "deleted", deletedAt: new Date() } }), "org-delete");
    syncTenant(String(tenant._id));
    // Members are told on all their tabs before their sockets in the organization are closed
    orgEvents.deleted(memberIds, tenant._id);
    disconnectWorkspaceSockets(String(tenant._id));
    await audit(tenant._id, ctx.userId, "org.deleted");
    try {
        await deleteClerkOrganization(tenant.clerkOrgId);
    } catch (error) {
        await audit(tenant._id, ctx.userId, "clerk.sync_failed", { op: "deleteOrganization", code: (error as ClerkSyncError).code || "error" });
    }
    return { deleted: true };
}

// ------------------------------------------------------------------ members

export async function members(ctx: RequestContext, opts: { limit: number; cursor?: string; q?: string; includeRemoved?: boolean }) {
    const { tenant, role, settings } = await activeOrg(ctx, "members:read");
    const filter: Record<string, unknown> = { tenantId: tenant._id, status: opts.includeRemoved && orgCan(role, "members:remove", settings) ? { $in: ["active", "removed"] } : "active" };
    if (opts.cursor) filter._id = { $gt: oid(opts.cursor) };
    const rows = await sys(() => TenantMembership.find(filter).sort({ _id: 1 }).limit(opts.limit + 1).lean(), "org-members");
    const page = rows.slice(0, opts.limit);
    const users = await sys(() => User.find({ _id: { $in: page.map((r) => r.userId) } }).select("username avatar").lean(), "org-members");
    const byId = new Map(users.map((u: any) => [String(u._id), u]));
    return {
        items: page.map((r) => ({ userId: String(r.userId), username: (byId.get(String(r.userId)) as any)?.username || "", avatar: (byId.get(String(r.userId)) as any)?.avatar || "", role: r.role, status: r.status, joinedAt: r.joinedAt || r.createdAt, source: r.source || null })),
        nextCursor: rows.length > opts.limit ? String(page[page.length - 1]._id) : null,
    };
}

export async function changeRole(ctx: RequestContext, userId: string, to: MembershipRole) {
    const { tenant, role, settings } = await activeOrg(ctx, "members:role");
    if (to === "guest" && !settings.guestAccess) throw new AppError("Guest access is turned off for this organization");
    const target = await sys(() => TenantMembership.findOne({ tenantId: tenant._id, userId: oid(userId), status: "active" }).lean(), "org-role");
    if (!target) throw new NotFoundError("Member not found");
    if (!mayChangeRole(role, target.role, to, userId === ctx.userId)) throw new ForbiddenError("You can't give this role");
    const lastOwner = "An organization needs at least one owner. Transfer ownership first.";
    if (target.role === "owner" && (await activeOwners(tenant._id)) <= 1) throw new AppError(lastOwner, 409);
    if (target.role === "owner") {
        await demoteOwner(tenant._id, target._id, to, lastOwner);
    } else {
        // Compare-and-set on the role read above
        const res = await sys(() => TenantMembership.updateOne({ _id: target._id, role: target.role, status: "active" }, { $set: { role: to } }), "org-role");
        if (!res.modifiedCount) throw new AppError("The member changed meanwhile. Try again.", 409);
    }
    // Live sockets of the member get the new role on every instance (a demotion applies at once)
    syncMembership(String(tenant._id), userId, to);
    await audit(tenant._id, ctx.userId, "member.role_changed", { userId, from: target.role, to });
    orgEvents.roleChanged(tenant._id, userId, to);
    orgEvents.membersChanged(tenant._id);
    // Clerk mirror (admin / member) — informational for SpreeWe-managed organizations
    try {
        await ensureClerkMembership(tenant.clerkOrgId, await clerkIdOf(userId), to);
    } catch (error) {
        await audit(tenant._id, ctx.userId, "clerk.sync_failed", { op: "updateMembership", userId, code: (error as ClerkSyncError).code || "error" });
    }
    void settings;
    return { userId, role: to };
}

export async function removeMemberFromOrg(ctx: RequestContext, userId: string) {
    const { tenant, role } = await activeOrg(ctx, "members:remove");
    const target = await sys(() => TenantMembership.findOne({ tenantId: tenant._id, userId: oid(userId), status: "active" }).lean(), "org-remove");
    if (!target) throw new NotFoundError("Member not found");
    if (!mayRemove(role, target.role, userId === ctx.userId)) throw new ForbiddenError("You can't remove this member");
    if (target.role === "owner") {
        if ((await activeOwners(tenant._id)) <= 1) throw new AppError("The last owner can't be removed", 409);
        await demoteOwner(tenant._id, target._id, "admin", "The last owner can't be removed");
    }
    await removeMember(tenant, userId, ctx.userId, "removed");
    await audit(tenant._id, ctx.userId, "member.removed", { userId, role: target.role });
    return { removed: true };
}

export async function leaveOrganization(ctx: RequestContext) {
    const { tenant, role } = await activeOrg(ctx, "org:read");
    const lastOwner = "You're the last owner. Transfer ownership before leaving.";
    if (role === "owner") {
        if ((await activeOwners(tenant._id)) <= 1) throw new AppError(lastOwner, 409);
        const mine = await sys(() => TenantMembership.findOne({ tenantId: tenant._id, userId: oid(ctx.userId), status: "active" }).select("_id").lean(), "org-leave");
        if (mine) await demoteOwner(tenant._id, mine._id, "admin", lastOwner);
    }
    await removeMember(tenant, ctx.userId, ctx.userId, "left");
    await audit(tenant._id, ctx.userId, "member.left");
    return { left: true };
}

export async function transferOwnership(ctx: RequestContext, userId: string) {
    const { tenant, role } = await activeOrg(ctx, "org:delete");
    if (role !== "owner" || userId === ctx.userId) throw new ForbiddenError("Only an owner can transfer ownership to someone else");
    const target = await sys(() => TenantMembership.findOne({ tenantId: tenant._id, userId: oid(userId), status: "active" }).lean(), "org-transfer");
    if (!target || target.role === "guest") throw new AppError("Ownership can only go to an active, non-guest member");
    await sys(() => TenantMembership.updateOne({ _id: target._id, status: "active" }, { $set: { role: "owner" } }), "org-transfer");
    const mine = await sys(() => TenantMembership.findOne({ tenantId: tenant._id, userId: oid(ctx.userId), status: "active", role: "owner" }).select("_id").lean(), "org-transfer");
    if (mine) await demoteOwner(tenant._id, mine._id, "admin", "An organization needs at least one owner.");
    syncMembership(String(tenant._id), userId, "owner");
    if (mine) syncMembership(String(tenant._id), ctx.userId, "admin");
    await audit(tenant._id, ctx.userId, "org.ownership_transferred", { to: userId });
    orgEvents.roleChanged(tenant._id, userId, "owner");
    if (mine) orgEvents.roleChanged(tenant._id, ctx.userId, "admin");
    orgEvents.membersChanged(tenant._id);
    for (const [u, r] of [[userId, "owner"], [ctx.userId, "admin"]] as const) {
        await ensureClerkMembership(tenant.clerkOrgId, await clerkIdOf(u), r).catch(() => undefined);
    }
    return { owner: userId };
}

// ------------------------------------------------------------------ invitations

const inviteLink = (token: string) => `${(process.env.APP_PUBLIC_URL || "").replace(/\/+$/, "")}/organizations/invitation?token=${token}`;
const newToken = () => `inv_${crypto.randomBytes(32).toString("base64url")}`;

export async function invite(ctx: RequestContext, input: { emails: string[]; role: MembershipRole; expiresInDays?: number }) {
    const { tenant, role, settings } = await activeOrg(ctx, "members:invite");
    if (!invitableRoles(role, settings).includes(input.role)) throw new ForbiddenError("You can't invite people with this role");
    const emails = [...new Set((input.emails || []).map((e) => String(e).trim().toLowerCase()))];
    if (!emails.length || emails.length > ORG_LIMITS.invitationsPerCall) throw new AppError(`Invite 1–${ORG_LIMITS.invitationsPerCall} addresses at a time`);
    const bad = emails.filter((e) => !EMAIL.test(e));
    if (bad.length) throw new AppError("Some email addresses are invalid");
    const pending = await sys(() => OrgInvitation.countDocuments({ tenantId: tenant._id, status: "pending" }), "org-invite");
    if (pending + emails.length > ORG_LIMITS.pendingInvitations) throw new AppError("Too many pending invitations; revoke some first", 409);
    const days = Math.min(30, Math.max(1, Math.floor(input.expiresInDays ?? 7)));
    const inviter = await sys(() => User.findById(oid(ctx.userId)).select("username").lean(), "org-invite");
    // Existing members by email (admins see their own members anyway; nothing is revealed about outsiders)
    const users = await sys(() => User.find({ email: { $in: emails } }).select("_id email").lean(), "org-invite");
    const memberIds = new Set((await sys(() => TenantMembership.find({ tenantId: tenant._id, status: "active", userId: { $in: users.map((u) => u._id) } }).select("userId").lean(), "org-invite")).map((m) => String(m.userId)));
    const memberEmails = new Set(users.filter((u) => memberIds.has(String(u._id))).map((u) => String(u.email)));
    const results: { email: string; status: "invited" | "already_member" | "domain_not_allowed"; invitationId?: string; link?: string; emailed?: boolean }[] = [];
    for (const email of emails) {
        if (memberEmails.has(email)) { results.push({ email, status: "already_member" }); continue; }
        if (!domainAllowed(settings, email)) { results.push({ email, status: "domain_not_allowed" }); continue; }
        const token = newToken();
        const expiresAt = new Date(Date.now() + days * 86_400_000);
        // One open invitation per address: re-inviting replaces the token (the old link stops working)
        const inv = await sys(() => OrgInvitation.findOneAndUpdate(
            { tenantId: tenant._id, email, status: "pending" },
            { $set: { tokenHash: sha256(token), role: input.role, expiresAt, invitedBy: oid(ctx.userId) }, $inc: { sentCount: 1 }, $setOnInsert: { status: "pending" } },
            { upsert: true, new: true },
        ), "org-invite");
        const emailed = await deliverInvitation({ to: email, organizationName: tenant.name, inviterName: inviter?.username || "", role: input.role, link: inviteLink(token), expiresAt });
        results.push({ email, status: "invited", invitationId: String(inv!._id), link: inviteLink(token), emailed });
        const existing = users.find((u) => String(u.email) === email);
        if (existing) orgEvents.invited(existing._id, tenant._id, inv!._id, tenant.name);
    }
    await audit(tenant._id, ctx.userId, "invitation.created", { count: results.filter((r) => r.status === "invited").length, role: input.role });
    orgEvents.invitationsChanged(tenant._id, settings.membersCanInvite);
    return { results };
}

export async function listInvitations(ctx: RequestContext, status: string | undefined, limit: number, cursor?: string) {
    const { tenant } = await activeOrg(ctx, "members:invite");
    await expireInvitations(tenant._id);
    const filter: Record<string, unknown> = { tenantId: tenant._id };
    if (status) filter.status = status;
    if (cursor) filter._id = { $lt: oid(cursor) };
    const rows = await sys(() => OrgInvitation.find(filter).sort({ _id: -1 }).limit(limit + 1).select("-tokenHash").lean(), "org-invitations");
    const page = rows.slice(0, limit);
    return {
        items: page.map((i) => ({ invitationId: String(i._id), email: i.email, role: i.role, status: i.status, expiresAt: i.expiresAt, createdAt: i.createdAt, sentCount: i.sentCount, invitedBy: String(i.invitedBy) })),
        nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null,
    };
}

async function expireInvitations(tenantId: unknown) {
    await sys(() => OrgInvitation.updateMany({ ...(tenantId ? { tenantId } : {}), status: "pending", expiresAt: { $lte: new Date() } }, { $set: { status: "expired", decidedAt: new Date() } }), "org-invitations");
}

export async function resendInvitation(ctx: RequestContext, invitationId: string) {
    const { tenant, settings } = await activeOrg(ctx, "members:invite");
    const token = newToken();
    const inv = await sys(() => OrgInvitation.findOneAndUpdate(
        { _id: oid(invitationId), tenantId: tenant._id, status: "pending" },
        { $set: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + 7 * 86_400_000) }, $inc: { sentCount: 1 } },
        { new: true },
    ), "org-invite");
    if (!inv) throw new NotFoundError("Invitation not found (or no longer pending)");
    const emailed = await deliverInvitation({ to: inv.email, organizationName: tenant.name, inviterName: "", role: inv.role, link: inviteLink(token), expiresAt: inv.expiresAt });
    await audit(tenant._id, ctx.userId, "invitation.resent", { invitationId });
    orgEvents.invitationsChanged(tenant._id, settings.membersCanInvite);
    return { invitationId, link: inviteLink(token), emailed, expiresAt: inv.expiresAt };
}

export async function revokeInvitation(ctx: RequestContext, invitationId: string) {
    const { tenant, settings } = await activeOrg(ctx, "members:invite");
    const inv = await sys(() => OrgInvitation.findOneAndUpdate(
        { _id: oid(invitationId), tenantId: tenant._id, status: "pending" },
        { $set: { status: "revoked", decidedAt: new Date() } },
        { new: true },
    ).select("email").lean(), "org-invite");
    if (!inv) throw new NotFoundError("Invitation not found (or no longer pending)");
    await audit(tenant._id, ctx.userId, "invitation.revoked", { invitationId });
    orgEvents.invitationsChanged(tenant._id, settings.membersCanInvite);
    // An invitee with an account drops it from "Invitations for you" (same address match as the invitation notice)
    const invitee = await sys(() => User.findOne({ email: inv.email }).select("_id").lean(), "org-invite");
    if (invitee) orgEvents.invitationRevoked(invitee._id, tenant._id, inv._id);
    return { revoked: true };
}

/**
 * Load a usable invitation for the CALLER. A link that matches nothing gets one generic answer. Once
 * the caller is shown to be the addressee (one of their VERIFIED emails is the invited address), they
 * get the precise reason (used, revoked, expired); someone else learns only that it isn't theirs.
 * The invited address's domain doesn't matter, unless the organization restricts domains.
 */
export const INVITATION_INVALID = "This invitation link isn't valid. Check the link or ask for a new invitation.";
async function invitationForCaller(ctx: RequestContext, by: { token?: string; invitationId?: string }): Promise<{ inv: IOrgInvitation; tenant: ITenant }> {
    const invalid = new NotFoundError(INVITATION_INVALID);
    let filter: Record<string, unknown>;
    if (by.token) {
        if (!/^inv_[A-Za-z0-9_-]{20,}$/.test(by.token)) throw invalid;
        filter = { tokenHash: sha256(by.token) };
    } else if (by.invitationId && mongoose.isValidObjectId(by.invitationId)) {
        filter = { _id: oid(by.invitationId) };
    } else throw invalid;
    const inv = await sys(() => OrgInvitation.findOne(filter).lean<IOrgInvitation>(), "org-accept");
    if (!inv) throw invalid;
    const emails = await verifiedEmailsOf(await clerkIdOf(ctx.userId));
    if (!emails.includes(inv.email)) {
        // Never says to whom it was sent
        throw new ForbiddenError("This invitation was sent to a different email address. Sign in with the invited address (verified) to accept it.");
    }
    if (inv.status === "accepted") throw new AppError("This invitation has already been used.", 410);
    if (inv.status === "revoked") throw new AppError("This invitation was revoked. Ask the organization for a new one.", 410);
    if (inv.status === "expired" || new Date(inv.expiresAt).getTime() <= Date.now()) throw new AppError("This invitation has expired. Ask the organization for a new one.", 410);
    const tenant = await managedTenant(inv.tenantId).catch(() => { throw invalid; });
    if (tenant.status !== "active") throw invalid;
    return { inv, tenant };
}

export async function previewInvitation(ctx: RequestContext, by: { token?: string; invitationId?: string }) {
    const { inv, tenant } = await invitationForCaller(ctx, by);
    return { ...card(tenant), invitationId: String(inv._id), role: inv.role, expiresAt: inv.expiresAt };
}

export async function acceptInvitation(ctx: RequestContext, by: { token?: string; invitationId?: string }) {
    if (ctx.app) throw new ForbiddenError("Apps cannot accept invitations");
    const { inv, tenant } = await invitationForCaller(ctx, by);
    const settings = settingsOf(tenant);
    if (!domainAllowed(settings, inv.email)) throw new ForbiddenError("This organization only accepts other email domains");
    if (inv.role === "guest" && !settings.guestAccess) throw new ForbiddenError("Guest access is turned off for this organization");
    // Single use: atomic claim (two concurrent accepts → one wins)
    const claimed = await sys(() => OrgInvitation.findOneAndUpdate(
        { _id: inv._id, status: "pending", expiresAt: { $gt: new Date() } },
        { $set: { status: "accepted", acceptedBy: oid(ctx.userId), decidedAt: new Date() } },
        { new: true },
    ), "org-accept");
    // Lost a race with another accept of the same invitation (single use)
    if (!claimed) throw new AppError("This invitation has already been used.", 410);
    try {
        const outcome = await addMember(tenant, ctx.userId, inv.role, "invitation");
        await audit(tenant._id, ctx.userId, "invitation.accepted", { invitationId: String(inv._id), role: inv.role, outcome });
        orgEvents.invitationsChanged(tenant._id, settings.membersCanInvite);
        return { ...card(tenant), role: inv.role, outcome };
    } catch (error) {
        // Nothing granted: give the invitation back so it can be used once the problem is fixed
        await sys(() => OrgInvitation.updateOne({ _id: inv._id, status: "accepted" }, { $set: { status: "pending", acceptedBy: null, decidedAt: null } }), "org-accept-rollback");
        throw error instanceof ClerkSyncError ? new AppError("We couldn't finish joining the organization. Please try again.", 503) : error;
    }
}

/** Pending invitations addressed to my verified emails (shown in-app; no token needed). */
export async function myInvitations(ctx: RequestContext) {
    const emails = await verifiedEmailsOf(await clerkIdOf(ctx.userId));
    const invs = await sys(() => OrgInvitation.find({ email: { $in: emails }, status: "pending", expiresAt: { $gt: new Date() } }).select("-tokenHash").lean(), "org-my-invitations");
    const tenants = await sys(() => Tenant.find({ _id: { $in: invs.map((i) => i.tenantId) }, status: "active", managedBy: "spreewe" }).lean<ITenant[]>(), "org-my-invitations");
    const byId = new Map(tenants.map((t) => [String(t._id), t]));
    return invs.filter((i) => byId.has(String(i.tenantId))).map((i) => ({ ...card(byId.get(String(i.tenantId))!), invitationId: String(i._id), role: i.role, expiresAt: i.expiresAt }));
}

// ------------------------------------------------------------------ joining

async function callerEmailAllowed(ctx: RequestContext, settings: ITenantSettings): Promise<boolean> {
    if (!settings.allowedEmailDomains.length) return true;
    const emails = await verifiedEmailsOf(await clerkIdOf(ctx.userId));
    return emails.some((e) => domainAllowed(settings, e));
}

/** Join directly: with a valid join code (any visibility), or an open + discoverable organization. */
export async function join(ctx: RequestContext, organizationId: string, code?: string) {
    if (ctx.app) throw new ForbiddenError("Apps cannot join organizations");
    const generic = new NotFoundError("Organization not found or not open for joining");
    if (!mongoose.isValidObjectId(organizationId)) throw generic;
    const tenant = await managedTenant(organizationId).catch(() => { throw generic; });
    if (tenant.status !== "active") throw generic;
    const settings = settingsOf(tenant);
    let source: "code" | "open";
    if (code !== undefined) {
        const ok = settings.joinCodeEnabled && !!tenant.joinCodeHash && crypto.timingSafeEqual(Buffer.from(sha256(String(code).trim().toUpperCase())), Buffer.from(tenant.joinCodeHash));
        if (!ok) throw generic;
        source = "code";
    } else {
        if (!settings.discoverable || settings.joinPolicy !== "open") throw generic;
        source = "open";
    }
    if (!(await callerEmailAllowed(ctx, settings))) throw new ForbiddenError("This organization only accepts other email domains");
    const outcome = await addMember(tenant, ctx.userId, "member", source);
    if (outcome === "added") await audit(tenant._id, ctx.userId, "member.joined", { source });
    return { ...card(tenant), role: "member", outcome };
}

export async function requestToJoin(ctx: RequestContext, organizationId: string, message?: string) {
    if (ctx.app) throw new ForbiddenError("Apps cannot join organizations");
    const generic = new NotFoundError("Organization not found or not accepting requests");
    if (!mongoose.isValidObjectId(organizationId)) throw generic;
    const tenant = await managedTenant(organizationId).catch(() => { throw generic; });
    const settings = settingsOf(tenant);
    if (tenant.status !== "active" || !settings.discoverable || settings.joinPolicy !== "request") throw generic;
    if (await sys(() => TenantMembership.exists({ tenantId: tenant._id, userId: oid(ctx.userId), status: "active" }), "org-request")) throw new AppError("You're already a member", 409);
    if (!(await callerEmailAllowed(ctx, settings))) throw new ForbiddenError("This organization only accepts other email domains");
    try {
        const r = await sys(() => JoinRequest.create({ tenantId: tenant._id, userId: oid(ctx.userId), message: String(message || "").slice(0, 500) }), "org-request");
        await audit(tenant._id, ctx.userId, "join_request.created", { requestId: String(r._id) });
        // Owners / admins see it live — only on their sockets in THIS organization
        orgEvents.joinRequestCreated(tenant._id, r._id);
        return { requestId: String(r._id), status: "pending" };
    } catch (error) {
        if ((error as any)?.code === 11000) throw new AppError("You already asked to join", 409);
        throw error;
    }
}

export async function myJoinRequests(ctx: RequestContext) {
    const rows = await sys(() => JoinRequest.find({ userId: oid(ctx.userId) }).sort({ _id: -1 }).limit(50).lean(), "org-my-requests");
    const tenants = await sys(() => Tenant.find({ _id: { $in: rows.map((r) => r.tenantId) } }).lean<ITenant[]>(), "org-my-requests");
    const byId = new Map(tenants.map((t) => [String(t._id), t]));
    return rows.filter((r) => byId.has(String(r.tenantId))).map((r) => ({ requestId: String(r._id), status: r.status, createdAt: r.createdAt, organization: card(byId.get(String(r.tenantId))!) }));
}

export async function cancelJoinRequest(ctx: RequestContext, requestId: string) {
    if (!mongoose.isValidObjectId(requestId)) throw new NotFoundError("Request not found");
    const cancelled = await sys(() => JoinRequest.findOneAndUpdate(
        { _id: oid(requestId), userId: oid(ctx.userId), status: "pending" },
        { $set: { status: "cancelled", decidedAt: new Date() } },
        { new: true },
    ).select("tenantId").lean(), "org-request");
    if (!cancelled) throw new NotFoundError("Request not found");
    orgEvents.joinRequestsChanged(cancelled.tenantId);
    return { cancelled: true };
}

export async function listJoinRequests(ctx: RequestContext, status = "pending") {
    const { tenant } = await activeOrg(ctx, "requests:decide");
    const rows = await sys(() => JoinRequest.find({ tenantId: tenant._id, status }).sort({ _id: 1 }).limit(200).lean(), "org-requests");
    const users = await sys(() => User.find({ _id: { $in: rows.map((r) => r.userId) } }).select("username avatar email").lean(), "org-requests");
    const byId = new Map(users.map((u: any) => [String(u._id), u]));
    return rows.map((r) => ({ requestId: String(r._id), userId: String(r.userId), username: (byId.get(String(r.userId)) as any)?.username || "", email: (byId.get(String(r.userId)) as any)?.email || "", message: r.message, status: r.status, createdAt: r.createdAt }));
}

export async function decideJoinRequest(ctx: RequestContext, requestId: string, approve: boolean) {
    const { tenant } = await activeOrg(ctx, "requests:decide");
    const claimed = await sys(() => JoinRequest.findOneAndUpdate(
        { _id: oid(requestId), tenantId: tenant._id, status: "pending" },
        { $set: { status: approve ? "approved" : "rejected", decidedBy: oid(ctx.userId), decidedAt: new Date() } },
        { new: true },
    ), "org-requests");
    if (!claimed) throw new NotFoundError("Request not found (or already decided)");
    if (approve) {
        try {
            await addMember(tenant, String(claimed.userId), "member", "request");
        } catch (error) {
            await sys(() => JoinRequest.updateOne({ _id: claimed._id }, { $set: { status: "pending", decidedBy: null, decidedAt: null } }), "org-requests-rollback");
            throw error instanceof ClerkSyncError ? new AppError("We couldn't add the member. Please try again.", 503) : error;
        }
    }
    orgEvents.joinRequestDecided(claimed.userId, tenant._id, tenant.name, claimed.status);
    orgEvents.joinRequestsChanged(tenant._id);
    await audit(tenant._id, ctx.userId, approve ? "join_request.approved" : "join_request.rejected", { requestId, userId: String(claimed.userId) });
    return { requestId, status: claimed.status };
}

/** New join code (shown once) or disable. Codes: 10 characters from an unambiguous alphabet (~50 bits). */
export async function setJoinCode(ctx: RequestContext, enable: boolean) {
    const { tenant, settings } = await activeOrg(ctx, "joincode:manage");
    if (!enable) {
        await sys(() => Tenant.updateOne({ _id: tenant._id }, { $set: { joinCodeHash: null, "settings.joinCodeEnabled": false } }), "org-joincode");
        await audit(tenant._id, ctx.userId, "joincode.disabled");
        syncTenant(String(tenant._id));
        orgEvents.updated(tenant._id);
        return { enabled: false };
    }
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const code = Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join("");
    await sys(() => Tenant.updateOne({ _id: tenant._id }, { $set: { joinCodeHash: sha256(code), "settings.joinCodeEnabled": true } }), "org-joincode");
    await audit(tenant._id, ctx.userId, "joincode.rotated");
    void settings;
    // Never the code itself: other admins only learn that the setting changed
    syncTenant(String(tenant._id));
    orgEvents.updated(tenant._id);
    return { enabled: true, code, link: `${(process.env.APP_PUBLIC_URL || "").replace(/\/+$/, "")}/organizations/join?org=${tenant._id}&code=${code}` };
}

export async function auditLog(ctx: RequestContext, limit: number, cursor?: string) {
    const { tenant } = await activeOrg(ctx, "org:audit");
    const filter: Record<string, unknown> = { tenantId: tenant._id };
    if (cursor) filter._id = { $lt: oid(cursor) };
    const rows = await sys(() => OrgAuditEvent.find(filter).sort({ _id: -1 }).limit(limit + 1).lean(), "org-audit");
    const page = rows.slice(0, limit);
    return { items: page.map((r: any) => ({ id: String(r._id), action: r.action, actorId: r.actorId ? String(r.actorId) : null, target: r.target || {}, at: r.at })), nextCursor: rows.length > limit ? String(page[page.length - 1]._id) : null };
}
