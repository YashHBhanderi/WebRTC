import { defineRoute } from "./registry";
import { S } from "./schema";
import * as orgs from "../../organizations/organization.service";

/**
 * Organization management (SpreeWe-managed organizations). First-party sessions only: developer-app
 * tokens can't administer organizations. Administrative routes act on the ACTIVE workspace (from the
 * verified session), never on an organization id taken from the request. Joining routes name the
 * organization, and are authorized by its policy (discoverable + open / request) or a join code.
 * See docs/organizations/organization-api.md.
 */
const ROLE = ["owner", "admin", "member", "guest"] as const;
const INVITE_ROLE = ["admin", "member", "guest"] as const;
const card = { organizationId: { type: "string" }, clerkOrgId: { type: "string" }, name: { type: "string" }, slug: { type: "string" }, description: { type: "string" }, avatar: { type: "string" }, discoverable: { type: "boolean" }, joinPolicy: { type: "string", enum: ["invite", "request", "open"] } };
const cardDoc = (extra: Record<string, unknown> = {}) => S.doc({ type: "object", properties: { ...card, ...extra } });
const page = (cursorKind: "objectId" = "objectId") => S.object({ limit: S.int({ optional: true, min: 1, max: 100, default: 50 }), cursor: cursorKind === "objectId" ? S.objectId({ optional: true }) : S.string({ optional: true }) });

// ---------------------------------------------------------------- any context

defineRoute({
    method: "post", path: "/organizations", tag: "Organizations", scope: "organizations:write", sensitive: true, errors: [409, 429],
    summary: "Create an organization; the caller becomes its owner (switch to it with the returned clerkOrgId)",
    body: S.object({
        name: S.string({ min: 2, max: 80, trim: true }),
        slug: S.string({ min: 3, max: 40, pattern: /^[a-z0-9-]+$/, description: "URL name: lower-case letters, digits, hyphens" }),
        description: S.string({ optional: true, max: 500 }),
        discoverable: S.bool({ optional: true }),
        joinPolicy: S.enum(["invite", "request", "open"] as const, { optional: true }),
        allowExternalChat: S.bool({ optional: true }),
    }),
    response: S.doc({ type: "object", properties: { organizationId: { type: "string" }, clerkOrgId: { type: "string" }, name: { type: "string" }, slug: { type: "string" } } }),
    handler: ({ ctx, body }) => orgs.createOrganization(ctx, body as any),
});

defineRoute({
    method: "get", path: "/organizations/mine", tag: "Organizations", scope: "organizations:read",
    summary: "Organizations I belong to (for the workspace switcher)",
    response: S.doc({ type: "array", items: { type: "object", properties: { ...card, role: { type: "string", enum: [...ROLE] }, managedBy: { type: "string" }, status: { type: "string" }, active: { type: "boolean" } } } }),
    handler: ({ ctx }) => orgs.myOrganizations(ctx),
});

defineRoute({
    method: "get", path: "/organizations/discover", tag: "Organizations", scope: "organizations:read", sensitive: true,
    summary: "Search organizations that chose to be discoverable (private organizations are never listed)",
    query: S.object({ q: S.string({ optional: true, max: 80 }), limit: S.int({ optional: true, min: 1, max: 50, default: 20 }) }),
    response: S.doc({ type: "array", items: { type: "object", properties: { ...card, myStatus: { type: "string", enum: ["member", "requested", "none"] } } } }),
    handler: ({ ctx, query }) => orgs.discover(ctx, query.q, query.limit),
});

defineRoute({
    method: "post", path: "/organizations/:organizationId/join", tag: "Organizations", scope: "organizations:write", sensitive: true, errors: [404],
    summary: "Join with a join code, or directly if the organization is discoverable and open",
    params: S.object({ organizationId: S.objectId() }),
    body: S.object({ code: S.string({ optional: true, min: 6, max: 20 }) }),
    response: cardDoc({ role: { type: "string" }, outcome: { type: "string", enum: ["added", "already"] } }),
    handler: ({ ctx, params, body }) => orgs.join(ctx, params.organizationId, body.code),
});

defineRoute({
    method: "post", path: "/organizations/:organizationId/join-requests", tag: "Organizations", scope: "organizations:write", sensitive: true, errors: [404, 409],
    summary: "Ask to join a discoverable organization whose policy is 'request'",
    params: S.object({ organizationId: S.objectId() }),
    body: S.object({ message: S.string({ optional: true, max: 500 }) }),
    response: S.doc({ type: "object", properties: { requestId: { type: "string" }, status: { type: "string" } } }),
    handler: ({ ctx, params, body }) => orgs.requestToJoin(ctx, params.organizationId, body.message),
});

defineRoute({
    method: "get", path: "/me/join-requests", tag: "Organizations", scope: "organizations:read",
    summary: "My requests to join organizations",
    response: S.doc({ type: "array", items: { type: "object", properties: { requestId: { type: "string" }, status: { type: "string" }, organization: { type: "object", properties: card } } } }),
    handler: ({ ctx }) => orgs.myJoinRequests(ctx),
});

defineRoute({
    method: "post", path: "/me/join-requests/:requestId/cancel", tag: "Organizations", scope: "organizations:write", errors: [404],
    summary: "Withdraw my pending join request",
    params: S.object({ requestId: S.objectId() }),
    response: S.doc({ type: "object", properties: { cancelled: { type: "boolean" } } }),
    handler: ({ ctx, params }) => orgs.cancelJoinRequest(ctx, params.requestId),
});

defineRoute({
    method: "get", path: "/me/organization-invitations", tag: "Organizations", scope: "organizations:read",
    summary: "Pending invitations addressed to my verified email addresses",
    response: S.doc({ type: "array", items: { type: "object", properties: { ...card, invitationId: { type: "string" }, role: { type: "string" }, expiresAt: { type: "string", format: "date-time" } } } }),
    handler: ({ ctx }) => orgs.myInvitations(ctx),
});

const invitationRef = S.object({ token: S.string({ optional: true, max: 200 }), invitationId: S.objectId({ optional: true }) }, { minProperties: 1 });

defineRoute({
    method: "post", path: "/organization-invitations/preview", tag: "Organizations", scope: "organizations:read", sensitive: true, errors: [404],
    summary: "What an invitation (link token or my invitation id) is for — only if it is addressed to one of my verified emails",
    body: invitationRef,
    response: cardDoc({ invitationId: { type: "string" }, role: { type: "string" }, expiresAt: { type: "string", format: "date-time" } }),
    handler: ({ ctx, body }) => orgs.previewInvitation(ctx, body as any),
});

defineRoute({
    method: "post", path: "/organization-invitations/accept", tag: "Organizations", scope: "organizations:write", sensitive: true, errors: [404, 503],
    summary: "Accept an invitation addressed to one of my verified emails (single use)",
    body: invitationRef,
    response: cardDoc({ role: { type: "string" }, outcome: { type: "string", enum: ["added", "already"] } }),
    handler: ({ ctx, body }) => orgs.acceptInvitation(ctx, body as any),
});

// ---------------------------------------------------------------- active organization

defineRoute({
    method: "get", path: "/workspace/organization", tag: "Organization admin", scope: "organizations:read", workspace: true, errors: [404],
    summary: "The active organization: details, my role and permissions (settings for owners / admins)",
    response: S.doc({ type: "object" }),
    handler: ({ ctx }) => orgs.overview(ctx),
});

defineRoute({
    method: "patch", path: "/workspace/organization", tag: "Organization admin", scope: "organizations:manage", workspace: true, sensitive: true, errors: [404, 409],
    summary: "Update details and membership / visibility settings (owners / admins)",
    body: S.object({
        name: S.string({ optional: true, min: 2, max: 80, trim: true }),
        description: S.string({ optional: true, max: 500 }),
        slug: S.string({ optional: true, min: 3, max: 40, pattern: /^[a-z0-9-]+$/ }),
        settings: S.object({
            discoverable: S.bool({ optional: true }),
            joinPolicy: S.enum(["invite", "request", "open"] as const, { optional: true }),
            allowedEmailDomains: S.array(S.string({ max: 190 }), { optional: true, max: 20 }),
            membersCanInvite: S.bool({ optional: true }),
            membersCanCreateTeams: S.bool({ optional: true }),
            guestAccess: S.bool({ optional: true }),
        }, { optional: true }),
    }, { minProperties: 1 }),
    response: S.doc({ type: "object" }),
    handler: ({ ctx, body }) => orgs.updateOrganization(ctx, body as any),
});

defineRoute({
    method: "post", path: "/workspace/organization/delete", tag: "Organization admin", auth: "firstParty", workspace: true, sensitive: true, errors: [404],
    summary: "Delete the organization (owners; confirm with its exact name). Access ends immediately; data is kept",
    body: S.object({ confirm: S.string({ max: 80 }) }),
    response: S.doc({ type: "object", properties: { deleted: { type: "boolean" } } }),
    handler: ({ ctx, body }) => orgs.deleteOrganization(ctx, body.confirm as string),
});

defineRoute({
    method: "post", path: "/workspace/organization/transfer", tag: "Organization admin", auth: "firstParty", workspace: true, sensitive: true,
    summary: "Make another member the owner; you become an admin (owners)",
    body: S.object({ userId: S.objectId() }),
    response: S.doc({ type: "object", properties: { owner: { type: "string" } } }),
    handler: ({ ctx, body }) => orgs.transferOwnership(ctx, body.userId as string),
});

defineRoute({
    method: "post", path: "/workspace/leave", tag: "Organization admin", scope: "organizations:write", workspace: true, errors: [409],
    summary: "Leave the active organization (the last owner must transfer ownership first)",
    response: S.doc({ type: "object", properties: { left: { type: "boolean" } } }),
    handler: ({ ctx }) => orgs.leaveOrganization(ctx),
});

defineRoute({
    method: "get", path: "/workspace/organization/members", tag: "Organization admin", scope: "organizations:read", workspace: true, paginated: true,
    summary: "Members of the active organization (removed members: owners / admins with includeRemoved)",
    query: S.object({ limit: S.int({ optional: true, min: 1, max: 100, default: 50 }), cursor: S.objectId({ optional: true }), includeRemoved: S.bool({ optional: true }) }),
    response: S.doc({ type: "object", properties: { userId: { type: "string" }, username: { type: "string" }, avatar: { type: "string" }, role: { type: "string", enum: [...ROLE] }, status: { type: "string" }, joinedAt: { type: "string", format: "date-time" }, source: { type: "string", nullable: true } } }),
    handler: ({ ctx, query }) => orgs.members(ctx, query),
});

defineRoute({
    method: "patch", path: "/workspace/organization/members/:userId", tag: "Organization admin", scope: "organizations:manage", workspace: true, sensitive: true, errors: [404, 409],
    summary: "Change a member's role (owners: any; admins: member ↔ guest). Never your own",
    params: S.object({ userId: S.objectId() }), body: S.object({ role: S.enum(ROLE) }),
    response: S.doc({ type: "object", properties: { userId: { type: "string" }, role: { type: "string" } } }),
    handler: ({ ctx, params, body }) => orgs.changeRole(ctx, params.userId, body.role as any),
});

defineRoute({
    method: "post", path: "/workspace/organization/members/:userId/remove", tag: "Organization admin", scope: "organizations:manage", workspace: true, sensitive: true, errors: [404, 409],
    summary: "Remove a member (access ends immediately, on every instance within MEMBERSHIP_CHECK_CACHE_MS)",
    params: S.object({ userId: S.objectId() }),
    response: S.doc({ type: "object", properties: { removed: { type: "boolean" } } }),
    handler: ({ ctx, params }) => orgs.removeMemberFromOrg(ctx, params.userId),
});

defineRoute({
    method: "post", path: "/workspace/invitations", tag: "Organization admin", scope: "organizations:manage", workspace: true, sensitive: true, errors: [409],
    summary: "Invite people by email; returns each single-use link once (no email provider is configured yet)",
    body: S.object({ emails: S.array(S.string({ max: 254 }), { max: 50 }), role: S.enum(INVITE_ROLE), expiresInDays: S.int({ optional: true, min: 1, max: 30 }) }),
    response: S.doc({ type: "object", properties: { results: { type: "array", items: { type: "object", properties: { email: { type: "string" }, status: { type: "string" }, invitationId: { type: "string" }, link: { type: "string" }, emailed: { type: "boolean" } } } } } }),
    handler: ({ ctx, body }) => orgs.invite(ctx, body as any),
});

defineRoute({
    method: "get", path: "/workspace/invitations", tag: "Organization admin", scope: "organizations:manage", workspace: true, paginated: true,
    summary: "Invitations of the active organization",
    query: S.object({ status: S.enum(["pending", "accepted", "revoked", "expired"] as const, { optional: true }), limit: S.int({ optional: true, min: 1, max: 100, default: 50 }), cursor: S.objectId({ optional: true }) }),
    response: S.doc({ type: "object", properties: { invitationId: { type: "string" }, email: { type: "string" }, role: { type: "string" }, status: { type: "string" }, expiresAt: { type: "string", format: "date-time" }, sentCount: { type: "integer" } } }),
    handler: ({ ctx, query }) => orgs.listInvitations(ctx, query.status, query.limit, query.cursor),
});

defineRoute({
    method: "post", path: "/workspace/invitations/:invitationId/resend", tag: "Organization admin", scope: "organizations:manage", workspace: true, sensitive: true, errors: [404],
    summary: "New link for a pending invitation (the previous link stops working)",
    params: S.object({ invitationId: S.objectId() }),
    response: S.doc({ type: "object", properties: { invitationId: { type: "string" }, link: { type: "string" }, emailed: { type: "boolean" }, expiresAt: { type: "string", format: "date-time" } } }),
    handler: ({ ctx, params }) => orgs.resendInvitation(ctx, params.invitationId),
});

defineRoute({
    method: "post", path: "/workspace/invitations/:invitationId/revoke", tag: "Organization admin", scope: "organizations:manage", workspace: true, errors: [404],
    summary: "Revoke a pending invitation",
    params: S.object({ invitationId: S.objectId() }),
    response: S.doc({ type: "object", properties: { revoked: { type: "boolean" } } }),
    handler: ({ ctx, params }) => orgs.revokeInvitation(ctx, params.invitationId),
});

defineRoute({
    method: "get", path: "/workspace/join-requests", tag: "Organization admin", scope: "organizations:manage", workspace: true,
    summary: "Join requests (owners / admins)",
    query: S.object({ status: S.enum(["pending", "approved", "rejected", "cancelled"] as const, { optional: true }) }),
    response: S.doc({ type: "array", items: { type: "object", properties: { requestId: { type: "string" }, userId: { type: "string" }, username: { type: "string" }, email: { type: "string" }, message: { type: "string" }, status: { type: "string" } } } }),
    handler: ({ ctx, query }) => orgs.listJoinRequests(ctx, query.status || "pending"),
});

for (const [verb, approve] of [["approve", true], ["reject", false]] as const) {
    defineRoute({
        method: "post", path: `/workspace/join-requests/:requestId/${verb}`, tag: "Organization admin", auth: "firstParty", workspace: true, sensitive: true, errors: [404, 503],
        summary: `${approve ? "Approve" : "Reject"} a join request (owners / admins)`,
        params: S.object({ requestId: S.objectId() }),
        response: S.doc({ type: "object", properties: { requestId: { type: "string" }, status: { type: "string" } } }),
        handler: ({ ctx, params }) => orgs.decideJoinRequest(ctx, params.requestId, approve),
    });
}

defineRoute({
    method: "post", path: "/workspace/join-code", tag: "Organization admin", scope: "organizations:manage", workspace: true, sensitive: true,
    summary: "Create a new join code (shown once; replaces the old one) or disable joining by code",
    body: S.object({ enable: S.bool() }),
    response: S.doc({ type: "object", properties: { enabled: { type: "boolean" }, code: { type: "string" }, link: { type: "string" } } }),
    handler: ({ ctx, body }) => orgs.setJoinCode(ctx, !!body.enable),
});

defineRoute({
    method: "get", path: "/workspace/audit", tag: "Organization admin", scope: "organizations:manage", workspace: true, paginated: true,
    summary: "Administrative audit log of the active organization (owners / admins)",
    query: page(),
    response: S.doc({ type: "object", properties: { id: { type: "string" }, action: { type: "string" }, actorId: { type: "string", nullable: true }, target: { type: "object" }, at: { type: "string", format: "date-time" } } }),
    handler: ({ ctx, query }) => orgs.auditLog(ctx, query.limit, query.cursor),
});
