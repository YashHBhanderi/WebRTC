import mongoose from "mongoose";
import chatState from "../services/chat-state.service";
import Conversation, { IConversation } from "../models/conversationModel";
import TenantMembership, { MembershipRole } from "../models/tenantMembershipModel";
import User from "../models/userModel";
import { DEFAULT_TENANT_POLICIES } from "../models/tenantModel";
import { RequestContext, runAsSystem } from "../tenancy/context";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";
import { closeRooms, leaveRooms } from "../realtime/io";
import { syncConversationScope } from "../realtime/workspace-sync";
import { ITeam, ITeamMembership, Team, TeamMembership, TeamRole, OrgAuditEvent } from "./models";
import { activeOrg } from "./organization.service";
import { channelEvents, teamEvents, teamViewers } from "./events";

/**
 * Teams and channels inside the ACTIVE organization (Microsoft Teams-style).
 *
 * Teams / team memberships are tenant-scoped (fail-closed plugin): queries here run in the caller's
 * verified workspace context, so another organization's teams are invisible by construction.
 * Channels are conversations (teamId + channelType): `members` is exactly who may read a channel, so
 * every existing message / file / call / search / socket check applies unchanged.
 *   standard  all team members (kept in sync when the team changes)
 *   private   an explicit subset of team members
 *   shared    an external conversation: team members + approved people outside the organization
 *             (needs the organization's external-chat policy; labelled External everywhere)
 */
const oid = (id: unknown) => new mongoose.Types.ObjectId(String(id));
const sys = <T>(fn: () => Promise<T>, reason: string) => runAsSystem(fn, reason);
const ORG_ADMIN: MembershipRole[] = ["owner", "admin"];

type TeamAccess = { team: ITeam; myTeamRole: TeamRole | null; orgRole: MembershipRole; orgAdmin: boolean };

async function audit(ctx: RequestContext, action: string, target: Record<string, unknown>) {
    await sys(() => OrgAuditEvent.create({ tenantId: oid(ctx.tenantId), actorId: oid(ctx.userId), action, target, at: new Date() }), "team-audit").catch(() => undefined);
}

/** Everyone who can see the team now (and with `alsoVisibility`, also under that visibility). */
async function viewers(team: Pick<ITeam, "_id" | "visibility">, alsoVisibility?: "public" | "private") {
    return teamViewers(alsoVisibility ? [team.visibility, alsoVisibility] : team.visibility, await activeTeamMemberIds(team._id));
}

/**
 * People leave a channel: out of its Socket.IO room on every instance (room broadcasts don't consult
 * the member list), told where they can see it, and external participants' cached scope refreshed.
 */
function channelGone(ctx: RequestContext, channel: { _id: unknown; teamId?: unknown }, internalIds: unknown[], externalIds: unknown[]) {
    leaveRooms([...internalIds, ...externalIds], [channel._id]);
    if (externalIds.length) {
        syncConversationScope(channel._id);
        channelEvents.externalRemoved(externalIds, channel._id);
    }
    if (internalIds.length) channelEvents.removed(ctx.tenantId, internalIds, { teamId: channel.teamId, channelId: channel._id });
}

/** Load a team the caller may SEE: public teams for non-guest members, otherwise only teams they belong to. */
async function teamFor(ctx: RequestContext, teamId: string): Promise<TeamAccess> {
    const { role: orgRole } = await activeOrg(ctx, "org:read");
    if (!mongoose.isValidObjectId(teamId)) throw new NotFoundError("Team not found");
    const team = await Team.findOne({ _id: oid(teamId), status: "active" }).lean<ITeam>();
    if (!team) throw new NotFoundError("Team not found");
    const mine = await TeamMembership.findOne({ teamId: team._id, userId: oid(ctx.userId), status: "active" }).lean<ITeamMembership>();
    const orgAdmin = ORG_ADMIN.includes(orgRole);
    const visible = !!mine || orgAdmin || (team.visibility === "public" && orgRole !== "guest");
    if (!visible) throw new NotFoundError("Team not found"); // never confirms a private team exists
    return { team, myTeamRole: mine?.role || null, orgRole, orgAdmin };
}

const canManage = (a: TeamAccess) => a.orgAdmin || a.myTeamRole === "owner" || a.myTeamRole === "manager";

async function activeTeamMemberIds(teamId: unknown): Promise<string[]> {
    return (await TeamMembership.find({ teamId: oid(teamId), status: "active" }).select("userId").lean()).map((m) => String(m.userId));
}

const teamOwnerCount = (teamId: unknown) => TeamMembership.countDocuments({ teamId: oid(teamId), status: "active", role: "owner" });

/** Demote a team owner while keeping at least one (re-counted after the write, as for organization owners). */
async function demoteTeamOwner(teamId: unknown, membershipId: unknown, to: TeamRole, lastOwnerMessage: string): Promise<void> {
    if ((await teamOwnerCount(teamId)) <= 1) throw new AppError(lastOwnerMessage, 409);
    const res = await TeamMembership.updateOne({ _id: membershipId, role: "owner", status: "active" }, { $set: { role: to } });
    if (!res.modifiedCount) throw new AppError("The member changed meanwhile. Try again.", 409);
    if ((await teamOwnerCount(teamId)) === 0) {
        await TeamMembership.updateOne({ _id: membershipId }, { $set: { role: "owner" } });
        throw new AppError(lastOwnerMessage, 409);
    }
}

/** Users must be active organization members (guests only where allowed). */
async function assertOrgMembers(ctx: RequestContext, userIds: string[], allowGuests: boolean): Promise<void> {
    const rows = await sys(() => TenantMembership.find({ tenantId: oid(ctx.tenantId), userId: { $in: userIds.map(oid) }, status: "active" }).select("userId role").lean(), "team-members");
    const ok = new Set(rows.filter((r) => allowGuests || r.role !== "guest").map((r) => String(r.userId)));
    if (userIds.some((id) => !ok.has(id))) throw new AppError("Everyone added must be a member of this organization" + (allowGuests ? "" : " (guests can't be added here)"));
}

// ------------------------------------------------------------------ teams

export async function listTeams(ctx: RequestContext) {
    const { role } = await activeOrg(ctx, "org:read");
    const mine = await TeamMembership.find({ userId: oid(ctx.userId), status: "active" }).select("teamId role").lean();
    const myRole = new Map(mine.map((m) => [String(m.teamId), m.role]));
    const filter = role === "guest" ? { _id: { $in: mine.map((m) => m.teamId) }, status: "active" } : { status: "active", $or: [{ visibility: "public" }, { _id: { $in: mine.map((m) => m.teamId) } }, ...(ORG_ADMIN.includes(role) ? [{}] : [])] };
    const teams = await Team.find(filter).sort({ name: 1 }).limit(500).lean<ITeam[]>();
    const counts = await TeamMembership.aggregate([{ $match: { teamId: { $in: teams.map((t) => t._id) }, status: "active" } }, { $group: { _id: "$teamId", n: { $sum: 1 } } }]);
    const count = new Map(counts.map((c: any) => [String(c._id), c.n]));
    return teams.map((t) => ({ teamId: String(t._id), name: t.name, description: t.description, avatar: t.avatar, visibility: t.visibility, memberCount: count.get(String(t._id)) || 0, myRole: myRole.get(String(t._id)) || null }));
}

export async function createTeam(ctx: RequestContext, input: { name: string; description?: string; visibility?: "public" | "private" }) {
    const { settings } = await activeOrg(ctx, "teams:create");
    void settings;
    const name = String(input.name || "").trim();
    if (name.length < 2 || name.length > 80) throw new AppError("Team name must be 2–80 characters");
    let team: ITeam;
    try {
        team = (await Team.create({ name, description: String(input.description || "").slice(0, 500), visibility: input.visibility === "private" ? "private" : "public", createdBy: oid(ctx.userId) })).toObject() as ITeam;
    } catch (error) {
        if ((error as any)?.code === 11000) throw new AppError("A team with this name already exists", 409);
        throw error;
    }
    await TeamMembership.create({ teamId: team._id, userId: oid(ctx.userId), role: "owner" });
    // Every team starts with its General channel (standard)
    await createChannelDoc(ctx, team, { name: "General", type: "standard", memberIds: [String(ctx.userId)] });
    await audit(ctx, "team.created", { teamId: String(team._id) });
    teamEvents.changed(ctx.tenantId, team._id, "created", teamViewers(team.visibility, [ctx.userId]));
    return { teamId: String(team._id), name: team.name, visibility: team.visibility };
}

export async function getTeam(ctx: RequestContext, teamId: string) {
    const a = await teamFor(ctx, teamId);
    return { teamId: String(a.team._id), name: a.team.name, description: a.team.description, avatar: a.team.avatar, visibility: a.team.visibility, settings: a.team.settings, myRole: a.myTeamRole, canManage: canManage(a) };
}

export async function updateTeam(ctx: RequestContext, teamId: string, input: { name?: string; description?: string; visibility?: "public" | "private"; settings?: Partial<ITeam["settings"]> }) {
    const a = await teamFor(ctx, teamId);
    if (!(a.orgAdmin || a.myTeamRole === "owner")) throw new ForbiddenError("Only team owners can change the team");
    const set: Record<string, unknown> = {};
    if (input.name !== undefined) {
        const name = String(input.name).trim();
        if (name.length < 2 || name.length > 80) throw new AppError("Team name must be 2–80 characters");
        set.name = name;
    }
    if (input.description !== undefined) set.description = String(input.description).slice(0, 500);
    if (input.visibility) set.visibility = input.visibility;
    if (input.settings) set.settings = { ...a.team.settings, ...input.settings };
    try {
        await Team.updateOne({ _id: a.team._id }, { $set: set });
    } catch (error) {
        if ((error as any)?.code === 11000) throw new AppError("A team with this name already exists", 409);
        throw error;
    }
    await audit(ctx, "team.updated", { teamId, fields: Object.keys(set) });
    // Former viewers too, when the visibility changed (public → private: they drop the team)
    teamEvents.changed(ctx.tenantId, a.team._id, "updated", await viewers(a.team, set.visibility as "public" | "private" | undefined));
    return getTeam(ctx, teamId);
}

export async function archiveTeam(ctx: RequestContext, teamId: string) {
    const a = await teamFor(ctx, teamId);
    if (!(a.orgAdmin || a.myTeamRole === "owner")) throw new ForbiddenError("Only team owners can delete the team");
    const audience = await viewers(a.team);
    const channels = await Conversation.find({ teamId: a.team._id, channelArchivedAt: null }).select("members externalParticipants teamId").lean<(IConversation & { _id: mongoose.Types.ObjectId })[]>();
    await Team.updateOne({ _id: a.team._id }, { $set: { status: "archived" } });
    // Its channels are archived too: history kept, nobody can read them any more
    await Conversation.updateMany({ teamId: a.team._id, channelArchivedAt: null }, { $set: { channelArchivedAt: new Date(), members: [], groupAdmins: [] } });
    closeRooms(channels.map((c) => c._id));
    for (const c of channels) {
        const externals = (c.externalParticipants || []).map(String);
        if (externals.length) channelGone(ctx, c, [], externals);
    }
    await audit(ctx, "team.archived", { teamId });
    teamEvents.changed(ctx.tenantId, a.team._id, "archived", audience);
    return { archived: true };
}

// ------------------------------------------------------------------ team membership

export async function teamMembers(ctx: RequestContext, teamId: string) {
    const a = await teamFor(ctx, teamId);
    const rows = await TeamMembership.find({ teamId: a.team._id, status: "active" }).lean();
    const users = await sys(() => User.find({ _id: { $in: rows.map((r) => r.userId) } }).select("username avatar").lean(), "team-members");
    const byId = new Map(users.map((u: any) => [String(u._id), u]));
    return rows.map((r) => ({ userId: String(r.userId), username: (byId.get(String(r.userId)) as any)?.username || "", avatar: (byId.get(String(r.userId)) as any)?.avatar || "", role: r.role }));
}

/** Add people who aren't on the team yet; current members keep their role (roles change only via setTeamRole). */
async function addToTeam(ctx: RequestContext, team: ITeam, userIds: string[], role: TeamRole): Promise<string[]> {
    const current = new Set(await activeTeamMemberIds(team._id));
    const fresh = userIds.filter((id) => !current.has(id));
    for (const userId of fresh) {
        await TeamMembership.updateOne({ teamId: team._id, userId: oid(userId), status: { $ne: "active" } }, { $set: { status: "active", role } }, { upsert: true }).catch((error) => {
            if (error?.code !== 11000) throw error; // added concurrently: already a member, role untouched
        });
    }
    // Standard channels follow the team
    await Conversation.updateMany({ teamId: team._id, channelType: "standard", channelArchivedAt: null }, { $addToSet: { members: { $each: userIds.map(oid) } } });
    if (fresh.length) {
        teamEvents.joined(ctx.tenantId, fresh, { teamId: team._id, name: team.name });
        teamEvents.membersChanged(ctx.tenantId, team._id, await viewers(team));
    }
    return fresh;
}

export async function joinTeam(ctx: RequestContext, teamId: string) {
    const a = await teamFor(ctx, teamId);
    if (a.myTeamRole) return { joined: false, already: true };
    if (a.team.visibility !== "public" || a.orgRole === "guest") throw new ForbiddenError("Ask a team owner to add you");
    await addToTeam(ctx, a.team, [String(ctx.userId)], "member");
    await audit(ctx, "team.member_joined", { teamId });
    return { joined: true };
}

export async function addTeamMembers(ctx: RequestContext, teamId: string, userIds: string[], role: TeamRole = "member") {
    const a = await teamFor(ctx, teamId);
    const may = canManage(a) || (a.myTeamRole === "member" && a.team.settings?.membersCanAddMembers && role === "member");
    if (!may) throw new ForbiddenError("You can't add members to this team");
    if (role !== "member" && !(a.orgAdmin || a.myTeamRole === "owner")) throw new ForbiddenError("Only team owners can add owners or managers");
    const ids = [...new Set(userIds.map(String))];
    if (!ids.length || ids.length > 200) throw new AppError("Add 1–200 people at a time");
    await assertOrgMembers(ctx, ids, true);
    const added = await addToTeam(ctx, a.team, ids, role);
    await audit(ctx, "team.members_added", { teamId, count: added.length, role });
    return { added: added.length };
}

export async function setTeamRole(ctx: RequestContext, teamId: string, userId: string, role: TeamRole) {
    const a = await teamFor(ctx, teamId);
    if (!(a.orgAdmin || a.myTeamRole === "owner")) throw new ForbiddenError("Only team owners can change team roles");
    if (userId === ctx.userId && !a.orgAdmin) throw new ForbiddenError("You can't change your own team role");
    const target = await TeamMembership.findOne({ teamId: a.team._id, userId: oid(userId), status: "active" }).lean();
    if (!target) throw new NotFoundError("Not a member of this team");
    if (target.role === "owner" && role !== "owner") await demoteTeamOwner(a.team._id, target._id, role, "A team needs at least one owner");
    else await TeamMembership.updateOne({ _id: target._id }, { $set: { role } });
    await audit(ctx, "team.role_changed", { teamId, userId, role });
    teamEvents.membersChanged(ctx.tenantId, a.team._id, await viewers(a.team));
    return { userId, role };
}

async function dropFromTeam(ctx: RequestContext, team: ITeam, userId: string) {
    const rooms = (await Conversation.find({ teamId: team._id, members: oid(userId) }).select("_id").lean()).map((c) => c._id);
    await TeamMembership.updateOne({ teamId: team._id, userId: oid(userId) }, { $set: { status: "removed" } });
    await Conversation.updateMany({ teamId: team._id, members: oid(userId) }, { $pull: { members: oid(userId), groupAdmins: oid(userId) } });
    // Out of every channel room of the team, so channel traffic stops now (not at their next reconnect)
    leaveRooms([userId], rooms);
}

export async function removeTeamMember(ctx: RequestContext, teamId: string, userId: string) {
    const a = await teamFor(ctx, teamId);
    const self = userId === ctx.userId;
    if (!self && !canManage(a)) throw new ForbiddenError("You can't remove members from this team");
    const target = await TeamMembership.findOne({ teamId: a.team._id, userId: oid(userId), status: "active" }).lean();
    if (!target) throw new NotFoundError("Not a member of this team");
    if (target.role === "owner" && !self && !(a.orgAdmin || a.myTeamRole === "owner")) throw new ForbiddenError("Managers can't remove owners");
    if (target.role === "owner") await demoteTeamOwner(a.team._id, target._id, "member", "The last team owner can't leave or be removed. Make someone else an owner first.");
    await dropFromTeam(ctx, a.team, userId);
    await audit(ctx, self ? "team.member_left" : "team.member_removed", { teamId, userId });
    teamEvents.removed(ctx.tenantId, userId, a.team._id);
    teamEvents.membersChanged(ctx.tenantId, a.team._id, await viewers(a.team));
    return { removed: true };
}

// ------------------------------------------------------------------ channels

function channelView(c: IConversation & { _id: unknown }, me: string, favorites?: Set<string>) {
    return {
        channelId: String(c._id), name: c.groupName || "", description: c.groupDescription || "", type: c.channelType,
        external: c.scope === "external", memberCount: (c.members || []).length,
        isMember: (c.members || []).some((m) => String(m) === me),
        isFavorite: !!favorites?.has(String(c._id)),
    };
}

export async function listChannels(ctx: RequestContext, teamId: string) {
    const a = await teamFor(ctx, teamId);
    const me = String(ctx.userId);
    // Standard / shared channels are listed to team members; private ones only to their members
    const filter: Record<string, unknown> = { teamId: a.team._id, channelArchivedAt: null };
    if (!a.myTeamRole) filter.channelType = "standard"; // non-members browsing a public team see its standard channels only
    const rows = await Conversation.find(filter).select("groupName groupDescription channelType scope members").lean<(IConversation & { _id: unknown })[]>();
    const visible = rows.filter((c) => c.channelType !== "private" || (c.members || []).some((m) => String(m) === me));
    const favorites = await chatState.favoriteIds(me, visible.map((c) => String(c._id)));
    return visible.map((c) => channelView(c, me, favorites));
}

async function createChannelDoc(ctx: RequestContext, team: ITeam, input: { name: string; description?: string; type: "standard" | "private" | "shared"; memberIds: string[]; externalUserIds?: string[] }) {
    const external = input.externalUserIds || [];
    const doc = new Conversation({
        members: [...new Set([...input.memberIds, ...external])].map(oid),
        isGroup: true,
        groupName: input.name,
        groupDescription: input.description || "",
        groupAdmin: oid(ctx.userId),
        groupAdmins: [oid(ctx.userId)],
        teamId: team._id,
        channelType: input.type,
    });
    if (input.type === "shared") {
        // External conversation owned by this organization (scope set explicitly, never from input)
        (doc as any).tenantId = oid(ctx.tenantId);
        (doc as any).scope = "external";
        (doc as any).externalParticipants = external.map(oid);
    }
    return doc.save();
}

export async function createChannel(ctx: RequestContext, teamId: string, input: { name: string; description?: string; type: "standard" | "private" | "shared"; memberIds?: string[]; externalUserIds?: string[] }) {
    const a = await teamFor(ctx, teamId);
    if (!a.myTeamRole && !a.orgAdmin) throw new ForbiddenError("Join the team first");
    const may = canManage(a) || (a.myTeamRole === "member" && a.team.settings?.membersCanCreateChannels !== false && input.type !== "shared");
    if (!may || a.orgRole === "guest") throw new ForbiddenError("You can't create channels in this team");
    const name = String(input.name || "").trim();
    if (name.length < 1 || name.length > 60) throw new AppError("Channel name must be 1–60 characters");
    const teamMembers = await activeTeamMemberIds(a.team._id);
    let memberIds: string[];
    let externalUserIds: string[] = [];
    if (input.type === "standard") {
        memberIds = teamMembers;
    } else {
        const asked = [...new Set([String(ctx.userId), ...(input.memberIds || []).map(String)])];
        if (asked.some((id) => !teamMembers.includes(id) && id !== String(ctx.userId))) throw new AppError("Private and shared channel members must belong to the team");
        memberIds = asked;
    }
    if (input.type === "shared") {
        const { tenant, role } = await activeOrg(ctx, "org:read");
        const policies = { ...DEFAULT_TENANT_POLICIES, ...(tenant.policies || {}) };
        if (!policies.allowExternalChat || !(ORG_ADMIN.includes(role) || policies.membersCanStartExternal)) throw new ForbiddenError("This organization doesn't allow shared channels with external people");
        externalUserIds = [...new Set((input.externalUserIds || []).map(String))];
        if (!externalUserIds.length || externalUserIds.length > 50) throw new AppError("Add 1–50 external people");
        // External = NOT members of this organization (members are added as normal channel members)
        const insiders = await sys(() => TenantMembership.find({ tenantId: oid(ctx.tenantId), userId: { $in: externalUserIds.map(oid) }, status: "active" }).select("userId").lean(), "channel-shared");
        if (insiders.length) throw new AppError("Organization members can't be added as external participants");
        const exist = await sys(() => User.countDocuments({ _id: { $in: externalUserIds.map(oid) } }), "channel-shared");
        if (exist !== externalUserIds.length) throw new AppError("Some people could not be found");
    }
    const channel = await createChannelDoc(ctx, a.team, { name, description: input.description, type: input.type, memberIds, externalUserIds });
    await audit(ctx, "channel.created", { teamId, channelId: String(channel._id), type: input.type });
    channelEvents.created(ctx.tenantId, memberIds, { teamId: a.team._id, channelId: channel._id, name });
    // Standard and shared channels are listed to the whole team; a private one only to its members (above)
    if (input.type !== "private") teamEvents.channelsChanged(ctx.tenantId, a.team._id, await viewers(a.team));
    return channelView(channel.toObject() as any, String(ctx.userId));
}

async function channelFor(ctx: RequestContext, teamId: string, channelId: string) {
    const a = await teamFor(ctx, teamId);
    if (!mongoose.isValidObjectId(channelId)) throw new NotFoundError("Channel not found");
    const channel = await Conversation.findOne({ _id: oid(channelId), teamId: a.team._id, channelArchivedAt: null }).lean<IConversation & { _id: mongoose.Types.ObjectId }>();
    const me = String(ctx.userId);
    // Private channels exist only for their members — not even organization admins can open or join them
    if (!channel || (channel.channelType === "private" && !(channel.members || []).some((m) => String(m) === me))) throw new NotFoundError("Channel not found");
    const channelOwner = (channel.groupAdmins || []).some((x) => String(x) === me);
    return { a, channel, mayManage: canManage(a) || channelOwner };
}

export async function addChannelMembers(ctx: RequestContext, teamId: string, channelId: string, userIds: string[]) {
    const { a, channel, mayManage } = await channelFor(ctx, teamId, channelId);
    if (channel.channelType === "standard") throw new AppError("Standard channels include the whole team: add people to the team instead");
    if (!mayManage) throw new ForbiddenError("Only channel or team owners can add members");
    const teamMembers = await activeTeamMemberIds(a.team._id);
    const ids = [...new Set(userIds.map(String))];
    if (!ids.length || ids.some((id) => !teamMembers.includes(id))) throw new AppError("Only team members can be added to this channel");
    await Conversation.updateOne({ _id: channel._id }, { $addToSet: { members: { $each: ids.map(oid) } } });
    await audit(ctx, "channel.members_added", { teamId, channelId, count: ids.length });
    channelEvents.joined(ctx.tenantId, ids, { teamId: a.team._id, channelId: channel._id });
    channelEvents.membersChanged(ctx.tenantId, [...(channel.members || []).map(String), ...ids], { teamId: a.team._id, channelId: channel._id });
    return { added: ids.length };
}

export async function removeChannelMember(ctx: RequestContext, teamId: string, channelId: string, userId: string) {
    const { a, channel, mayManage } = await channelFor(ctx, teamId, channelId);
    if (channel.channelType === "standard") throw new AppError("Standard channels include the whole team: remove the person from the team instead");
    if (userId !== ctx.userId && !mayManage) throw new ForbiddenError("Only channel or team owners can remove members");
    const external = (channel.externalParticipants || []).some((x) => String(x) === userId);
    await Conversation.updateOne({ _id: channel._id }, { $pull: { members: oid(userId), groupAdmins: oid(userId), externalParticipants: oid(userId) } });
    await audit(ctx, "channel.member_removed", { teamId, channelId, userId });
    channelGone(ctx, channel, external ? [] : [userId], external ? [userId] : []);
    const remaining = (channel.members || []).map(String).filter((m) => m !== userId);
    channelEvents.membersChanged(ctx.tenantId, remaining, { teamId: a.team._id, channelId: channel._id });
    return { removed: true };
}

export async function deleteChannel(ctx: RequestContext, teamId: string, channelId: string) {
    const { a, channel, mayManage } = await channelFor(ctx, teamId, channelId);
    if (!mayManage) throw new ForbiddenError("Only channel or team owners can delete channels");
    if (channel.channelType === "standard" && channel.groupName === "General") throw new AppError("The General channel can't be deleted");
    await Conversation.updateOne({ _id: channel._id }, { $set: { channelArchivedAt: new Date(), members: [], groupAdmins: [] } });
    await audit(ctx, "channel.deleted", { teamId, channelId });
    const externals = (channel.externalParticipants || []).map(String);
    const internal = (channel.members || []).map(String).filter((m) => !externals.includes(m));
    closeRooms([channel._id]);
    channelGone(ctx, channel, internal, externals);
    if (channel.channelType !== "private") teamEvents.channelsChanged(ctx.tenantId, a.team._id, await viewers(a.team));
    return { deleted: true };
}

