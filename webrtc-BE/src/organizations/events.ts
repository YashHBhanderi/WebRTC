import { emitToWorkspace, notifyUserEverywhere, WorkspaceAudience } from "../realtime/io";

/**
 * Real-time signals for organization, team and channel views (see docs/organizations/organization-api.md).
 *
 * They are invalidation signals, not data: payloads carry ids (plus names only to people who are
 * members of the thing named), and clients refetch through the REST endpoints, which apply the
 * caller's permissions. Audiences are the people allowed to see the changed view:
 *   - workspace events go only to sockets whose verified workspace is that organization;
 *   - notices about the recipient's own membership go to all of their SpreeWe sockets in any context.
 * Emitted after the database write; a failure to emit never fails the operation.
 */
export const ADMIN_ROLES = ["owner", "admin"];
export const NON_GUEST_ROLES = ["owner", "admin", "member"];

const id = (v: unknown) => String(v);

function safely(fn: () => void): void {
    try {
        fn();
    } catch (error) {
        // No socket server (tools, some tests): the REST state is already correct
        void error;
    }
}

/** People who can see a team: public → every non-guest member; private → organization owners/admins. Plus its members. */
export function teamViewers(visibility: "public" | "private" | Array<"public" | "private">, memberIds: unknown[]): WorkspaceAudience {
    const anyPublic = (Array.isArray(visibility) ? visibility : [visibility]).includes("public");
    return { roles: anyPublic ? NON_GUEST_ROLES : ADMIN_ROLES, userIds: memberIds.map(id) };
}

export const orgEvents = {
    /** Profile, settings, policies or join code changed: everyone in the workspace refetches the overview. */
    updated: (tenantId: unknown) => safely(() => emitToWorkspace(id(tenantId), "org:updated", { organizationId: id(tenantId) })),
    /** Someone joined, left, was removed or changed role: people who can read the member list refetch it. */
    membersChanged: (tenantId: unknown) =>
        safely(() => emitToWorkspace(id(tenantId), "org:members-changed", { organizationId: id(tenantId) }, { roles: NON_GUEST_ROLES })),
    /** Invitation list changed: people who may invite (owners/admins, members when allowed). */
    invitationsChanged: (tenantId: unknown, membersCanInvite: boolean) =>
        safely(() => emitToWorkspace(id(tenantId), "org:invitations-changed", { organizationId: id(tenantId) }, { roles: membersCanInvite ? NON_GUEST_ROLES : ADMIN_ROLES })),
    joinRequestCreated: (tenantId: unknown, requestId: unknown) =>
        safely(() => emitToWorkspace(id(tenantId), "org:join-request-created", { organizationId: id(tenantId), requestId: id(requestId) }, { roles: ADMIN_ROLES })),
    /** Join request cancelled or decided: owners/admins refetch the pending list. */
    joinRequestsChanged: (tenantId: unknown) =>
        safely(() => emitToWorkspace(id(tenantId), "org:join-requests-changed", { organizationId: id(tenantId) }, { roles: ADMIN_ROLES })),
    /** The member's own role changed (their sockets in the organization). */
    roleChanged: (tenantId: unknown, userId: unknown, role: string) =>
        safely(() => emitToWorkspace(id(tenantId), "org:role-changed", { organizationId: id(tenantId), role }, { userIds: [id(userId)] })),

    // ---- notices about the recipient's own membership (any context)
    joined: (userId: unknown, org: { organizationId: unknown; clerkOrgId: string; name: string; role: string }) =>
        safely(() => notifyUserEverywhere(userId, "org:joined", { organizationId: id(org.organizationId), clerkOrgId: org.clerkOrgId, name: org.name, role: org.role })),
    removed: (userId: unknown, tenantId: unknown, reason: "removed" | "left") =>
        safely(() => notifyUserEverywhere(userId, "org:removed", { organizationId: id(tenantId), reason })),
    deleted: (userIds: unknown[], tenantId: unknown) =>
        safely(() => [...new Set(userIds.map(id))].forEach((u) => notifyUserEverywhere(u, "org:deleted", { organizationId: id(tenantId) }))),
    invited: (userId: unknown, tenantId: unknown, invitationId: unknown, name: string) =>
        safely(() => notifyUserEverywhere(userId, "org:invitation", { organizationId: id(tenantId), invitationId: id(invitationId), name })),
    invitationRevoked: (userId: unknown, tenantId: unknown, invitationId: unknown) =>
        safely(() => notifyUserEverywhere(userId, "org:invitation-revoked", { organizationId: id(tenantId), invitationId: id(invitationId) })),
    joinRequestDecided: (userId: unknown, tenantId: unknown, name: string, status: string) =>
        safely(() => notifyUserEverywhere(userId, "org:join-request", { organizationId: id(tenantId), name, status })),
};

export const teamEvents = {
    /** created | updated | archived: viewers refetch their team list (and the team page). */
    changed: (tenantId: unknown, teamId: unknown, change: "created" | "updated" | "archived", viewers: WorkspaceAudience) =>
        safely(() => emitToWorkspace(id(tenantId), "team:changed", { teamId: id(teamId), change }, viewers)),
    /** Team membership or team roles changed: viewers refetch members (and counts). */
    membersChanged: (tenantId: unknown, teamId: unknown, viewers: WorkspaceAudience) =>
        safely(() => emitToWorkspace(id(tenantId), "team:members-changed", { teamId: id(teamId) }, viewers)),
    /** A standard or shared channel was added or removed: viewers refetch the channel list. */
    channelsChanged: (tenantId: unknown, teamId: unknown, viewers: WorkspaceAudience) =>
        safely(() => emitToWorkspace(id(tenantId), "team:channels-changed", { teamId: id(teamId) }, viewers)),
    joined: (tenantId: unknown, userIds: unknown[], team: { teamId: unknown; name: string }) =>
        safely(() => emitToWorkspace(id(tenantId), "team:joined", { teamId: id(team.teamId), name: team.name }, { userIds })),
    removed: (tenantId: unknown, userId: unknown, teamId: unknown) =>
        safely(() => emitToWorkspace(id(tenantId), "team:removed", { teamId: id(teamId) }, { userIds: [id(userId)] })),
};

export const channelEvents = {
    created: (tenantId: unknown, memberIds: unknown[], c: { teamId: unknown; channelId: unknown; name: string }) =>
        safely(() => emitToWorkspace(id(tenantId), "channel:created", { teamId: id(c.teamId), channelId: id(c.channelId), name: c.name }, { userIds: memberIds })),
    joined: (tenantId: unknown, userIds: unknown[], c: { teamId: unknown; channelId: unknown }) =>
        safely(() => emitToWorkspace(id(tenantId), "channel:joined", { teamId: id(c.teamId), channelId: id(c.channelId) }, { userIds })),
    membersChanged: (tenantId: unknown, memberIds: unknown[], c: { teamId: unknown; channelId: unknown }) =>
        safely(() => emitToWorkspace(id(tenantId), "channel:members-changed", { teamId: id(c.teamId), channelId: id(c.channelId) }, { userIds: memberIds })),
    /** Removed from the channel, or the channel was deleted: organization members in the workspace. */
    removed: (tenantId: unknown, userIds: unknown[], c: { teamId: unknown; channelId: unknown }) =>
        safely(() => emitToWorkspace(id(tenantId), "channel:removed", { teamId: id(c.teamId), channelId: id(c.channelId) }, { userIds })),
    /** External participants see a shared channel as a conversation in their own context: tell them it's gone. */
    externalRemoved: (userIds: unknown[], conversationId: unknown) =>
        safely(() => [...new Set(userIds.map(id))].forEach((u) => notifyUserEverywhere(u, "conversation:removed", { conversationId: id(conversationId) }))),
};
