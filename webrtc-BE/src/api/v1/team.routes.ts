import { defineRoute } from "./registry";
import { S } from "./schema";
import * as teams from "../../organizations/team.service";

/**
 * Teams and channels of the ACTIVE organization (first-party sessions). Channel messages, files and
 * calls use the existing conversation endpoints and sockets with the channelId (a conversation id):
 * channel membership is that conversation's membership. See docs/organizations/teams-and-channels.md.
 */
const TEAM_ROLE = ["owner", "manager", "member"] as const;
const team = { teamId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, avatar: { type: "string" }, visibility: { type: "string", enum: ["public", "private"] } };
const channel = { channelId: { type: "string" }, name: { type: "string" }, description: { type: "string" }, type: { type: "string", enum: ["standard", "private", "shared"] }, external: { type: "boolean" }, memberCount: { type: "integer" }, isMember: { type: "boolean" }, isFavorite: { type: "boolean" } };
const teamParams = S.object({ teamId: S.objectId() });
const base = { tag: "Teams", auth: "firstParty" as const, workspace: true };

defineRoute({
    ...base, method: "get", path: "/teams", scope: "organizations:read",
    summary: "Teams I can see: public teams and teams I belong to (guests: only their teams)",
    response: S.doc({ type: "array", items: { type: "object", properties: { ...team, memberCount: { type: "integer" }, myRole: { type: "string", nullable: true } } } }),
    handler: ({ ctx }) => teams.listTeams(ctx),
});

defineRoute({
    ...base, method: "post", path: "/teams", scope: "organizations:write", sensitive: true, errors: [409],
    summary: "Create a team (owners / admins; members if the organization allows). You become its owner; it gets a General channel",
    body: S.object({ name: S.string({ min: 2, max: 80, trim: true }), description: S.string({ optional: true, max: 500 }), visibility: S.enum(["public", "private"] as const, { optional: true }) }),
    response: S.doc({ type: "object", properties: { teamId: { type: "string" }, name: { type: "string" }, visibility: { type: "string" } } }),
    handler: ({ ctx, body }) => teams.createTeam(ctx, body as any),
});

defineRoute({
    ...base, method: "get", path: "/teams/:teamId", scope: "organizations:read", errors: [404],
    summary: "A team (404 for private teams I'm not in)",
    params: teamParams,
    response: S.doc({ type: "object", properties: { ...team, myRole: { type: "string", nullable: true }, canManage: { type: "boolean" } } }),
    handler: ({ ctx, params }) => teams.getTeam(ctx, params.teamId),
});

defineRoute({
    ...base, method: "patch", path: "/teams/:teamId", scope: "organizations:manage", sensitive: true, errors: [404, 409],
    summary: "Update a team (team owners, organization owners / admins)",
    params: teamParams,
    body: S.object({
        name: S.string({ optional: true, min: 2, max: 80, trim: true }), description: S.string({ optional: true, max: 500 }),
        visibility: S.enum(["public", "private"] as const, { optional: true }),
        settings: S.object({ membersCanCreateChannels: S.bool({ optional: true }), membersCanAddMembers: S.bool({ optional: true }) }, { optional: true }),
    }, { minProperties: 1 }),
    response: S.doc({ type: "object" }),
    handler: ({ ctx, params, body }) => teams.updateTeam(ctx, params.teamId, body as any),
});

defineRoute({
    ...base, method: "post", path: "/teams/:teamId/archive", scope: "organizations:manage", sensitive: true, errors: [404],
    summary: "Delete (archive) a team and its channels; history is kept but nobody can read them",
    params: teamParams,
    response: S.doc({ type: "object", properties: { archived: { type: "boolean" } } }),
    handler: ({ ctx, params }) => teams.archiveTeam(ctx, params.teamId),
});

defineRoute({
    ...base, method: "post", path: "/teams/:teamId/join", scope: "organizations:write", errors: [404],
    summary: "Join a public team (organization members, not guests)",
    params: teamParams,
    response: S.doc({ type: "object", properties: { joined: { type: "boolean" } } }),
    handler: ({ ctx, params }) => teams.joinTeam(ctx, params.teamId),
});

defineRoute({
    ...base, method: "get", path: "/teams/:teamId/members", scope: "organizations:read", errors: [404],
    summary: "Members of a team",
    params: teamParams,
    response: S.doc({ type: "array", items: { type: "object", properties: { userId: { type: "string" }, username: { type: "string" }, avatar: { type: "string" }, role: { type: "string", enum: [...TEAM_ROLE] } } } }),
    handler: ({ ctx, params }) => teams.teamMembers(ctx, params.teamId),
});

defineRoute({
    ...base, method: "post", path: "/teams/:teamId/members", scope: "organizations:write", sensitive: true, errors: [404],
    summary: "Add organization members to a team (team owners / managers)",
    params: teamParams,
    body: S.object({ userIds: S.array(S.objectId(), { max: 200 }), role: S.enum(TEAM_ROLE, { optional: true }) }),
    response: S.doc({ type: "object", properties: { added: { type: "integer" } } }),
    handler: ({ ctx, params, body }) => teams.addTeamMembers(ctx, params.teamId, body.userIds as string[], (body.role as any) || "member"),
});

defineRoute({
    ...base, method: "patch", path: "/teams/:teamId/members/:userId", scope: "organizations:manage", sensitive: true, errors: [404, 409],
    summary: "Change a team role (team owners)",
    params: S.object({ teamId: S.objectId(), userId: S.objectId() }), body: S.object({ role: S.enum(TEAM_ROLE) }),
    response: S.doc({ type: "object", properties: { userId: { type: "string" }, role: { type: "string" } } }),
    handler: ({ ctx, params, body }) => teams.setTeamRole(ctx, params.teamId, params.userId, body.role as any),
});

defineRoute({
    ...base, method: "post", path: "/teams/:teamId/members/:userId/remove", scope: "organizations:manage", sensitive: true, errors: [404, 409],
    summary: "Remove someone from a team, or leave it (your own id). The last owner can't",
    params: S.object({ teamId: S.objectId(), userId: S.objectId() }),
    response: S.doc({ type: "object", properties: { removed: { type: "boolean" } } }),
    handler: ({ ctx, params }) => teams.removeTeamMember(ctx, params.teamId, params.userId),
});

defineRoute({
    ...base, method: "get", path: "/teams/:teamId/channels", scope: "organizations:read", errors: [404],
    summary: "Channels of a team (private channels only for their members)",
    params: teamParams,
    response: S.doc({ type: "array", items: { type: "object", properties: channel } }),
    handler: ({ ctx, params }) => teams.listChannels(ctx, params.teamId),
});

defineRoute({
    ...base, method: "post", path: "/teams/:teamId/channels", scope: "organizations:write", sensitive: true, errors: [404],
    summary: "Create a channel: standard (whole team), private (chosen team members) or shared (with approved external people; policy permitting)",
    params: teamParams,
    body: S.object({
        name: S.string({ min: 1, max: 60, trim: true }), description: S.string({ optional: true, max: 500 }),
        type: S.enum(["standard", "private", "shared"] as const),
        memberIds: S.array(S.objectId(), { optional: true, max: 200 }), externalUserIds: S.array(S.objectId(), { optional: true, max: 50 }),
    }),
    response: S.doc({ type: "object", properties: channel }),
    handler: ({ ctx, params, body }) => teams.createChannel(ctx, params.teamId, body as any),
});

const channelParams = S.object({ teamId: S.objectId(), channelId: S.objectId() });

defineRoute({
    ...base, method: "post", path: "/teams/:teamId/channels/:channelId/members", scope: "organizations:write", sensitive: true, errors: [404],
    summary: "Add team members to a private or shared channel (channel / team owners)",
    params: channelParams, body: S.object({ userIds: S.array(S.objectId(), { max: 200 }) }),
    response: S.doc({ type: "object", properties: { added: { type: "integer" } } }),
    handler: ({ ctx, params, body }) => teams.addChannelMembers(ctx, params.teamId, params.channelId, body.userIds as string[]),
});

defineRoute({
    ...base, method: "post", path: "/teams/:teamId/channels/:channelId/members/:userId/remove", scope: "organizations:manage", sensitive: true, errors: [404],
    summary: "Remove someone from a private or shared channel (or leave it)",
    params: S.object({ teamId: S.objectId(), channelId: S.objectId(), userId: S.objectId() }),
    response: S.doc({ type: "object", properties: { removed: { type: "boolean" } } }),
    handler: ({ ctx, params }) => teams.removeChannelMember(ctx, params.teamId, params.channelId, params.userId),
});

defineRoute({
    ...base, method: "post", path: "/teams/:teamId/channels/:channelId/delete", scope: "organizations:manage", sensitive: true, errors: [404],
    summary: "Delete (archive) a channel; history is kept but nobody can read it",
    params: channelParams,
    response: S.doc({ type: "object", properties: { deleted: { type: "boolean" } } }),
    handler: ({ ctx, params }) => teams.deleteChannel(ctx, params.teamId, params.channelId),
});
