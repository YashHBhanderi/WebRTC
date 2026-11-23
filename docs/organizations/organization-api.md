# Organization, team and channel API (`/v1`)

The machine-readable contract is `docs/api/openapi.yaml`, generated from the route definitions (`npm run openapi` in `webrtc-BE`) and linted with Spectral (`spectral:oas`, 0 findings). This page is the overview. Envelope, errors and pagination are as in [../api/v1.md](../api/v1.md):
- success: `{ "data": … }`;
- paginated: `{ "data": [ … ], "page": { "nextCursor": … } }`;
- errors: `{ "error": { "code", "message" } }`.

All routes below are **first-party only** (signed-in users of SpreeWe's own apps). Developer-platform app tokens are refused. Request bodies are validated strictly: unknown fields are refused with 400. `POST` success returns 201.

**Context:**
- *any* = works in the personal or an organization context.
- *workspace* = needs an active organization in the Clerk session, an active SpreeWe membership, and a SpreeWe-managed organization. Legacy workspaces get 404 with a clear message.

The organization is **always** the one in the verified session context. Endpoints that take an `:organizationId` (join, request) only *ask to enter*; they never act inside an organization the caller doesn't belong to.

## Organizations (any context)

| Method | Path | Body / query | Notes |
|---|---|---|---|
| POST | `/v1/organizations` | `name`, `slug`, `description?`, `discoverable?`, `joinPolicy?`, `allowExternalChat?` | Creates; caller becomes owner. 409 slug taken or owner limit; 429 daily limit. Returns `organizationId`, `clerkOrgId`, `name`, `slug` |
| GET | `/v1/organizations/mine` | — | For the switcher: role, `managedBy`, `active` |
| GET | `/v1/organizations/discover` | `q?`, `limit?` (≤50) | Discoverable organizations only, with `myStatus` |
| POST | `/v1/organizations/:organizationId/join` | `code?` | Open join, or with a join code. Generic 404 when not allowed |
| POST | `/v1/organizations/:organizationId/join-requests` | `message?` | Request-policy organizations only. 409 duplicate or already a member |
| GET | `/v1/me/join-requests` | — | My requests |
| POST | `/v1/me/join-requests/:requestId/cancel` | — | My pending request |
| GET | `/v1/me/organization-invitations` | — | Pending invitations to my verified emails |
| POST | `/v1/organization-invitations/preview` | `token` or `invitationId` | Generic 404 if invalid, expired, revoked, used, or for another account |
| POST | `/v1/organization-invitations/accept` | `token` or `invitationId` | Single use. 503 if Clerk failed (invitation remains usable) |

## Active organization (workspace context)

| Method | Path | Permission | Body / query |
|---|---|---|---|
| GET | `/v1/workspace/organization` | any member | Returns `role`, `permissions`, `invitableRoles`, `policies`; `settings` only for owners/admins |
| PATCH | `/v1/workspace/organization` | `org:update` | `name?`, `slug?`, `description?`, `settings?` (`discoverable`, `joinPolicy`, `allowedEmailDomains` ≤20, `membersCanInvite`, `membersCanCreateTeams`, `guestAccess`) |
| PATCH | `/v1/workspace/policies` | owner/admin | External chat, calls and files; `membersCanStartExternal` (existing endpoint) |
| POST | `/v1/workspace/organization/delete` | owner | `confirm` = exact organization name |
| POST | `/v1/workspace/organization/transfer` | owner | `userId` (active, non-guest member) |
| POST | `/v1/workspace/leave` | any member | 409 for the last owner |
| GET | `/v1/workspace/organization/members` | not guests | `limit?`, `cursor?`, `includeRemoved?` (owners/admins) |
| PATCH | `/v1/workspace/organization/members/:userId` | `members:role` | `role`. 403 self or escalation; 409 last owner, or changed concurrently |
| POST | `/v1/workspace/organization/members/:userId/remove` | `members:remove` | 409 last owner |
| POST | `/v1/workspace/invitations` | `members:invite` | `emails` (1–50), `role`, `expiresInDays?` (1–30). Per-address results; links returned once |
| GET | `/v1/workspace/invitations` | `members:invite` | `status?`, `limit?`, `cursor?`. Never returns tokens |
| POST | `/v1/workspace/invitations/:invitationId/resend` | `members:invite` | New token and link (old link stops working) |
| POST | `/v1/workspace/invitations/:invitationId/revoke` | `members:invite` | — |
| GET | `/v1/workspace/join-requests` | `requests:decide` | `status?` |
| POST | `/v1/workspace/join-requests/:requestId/approve` | `requests:decide` | — |
| POST | `/v1/workspace/join-requests/:requestId/reject` | `requests:decide` | — |
| POST | `/v1/workspace/join-code` | `joincode:manage` | `enable`. Code and link returned once |
| GET | `/v1/workspace/audit` | `org:audit` | `limit?`, `cursor?` |
| GET | `/v1/workspace/members` | not guests | Existing workspace member list (now refuses guests) |

## Teams and channels (workspace context)

| Method | Path | Who | Body |
|---|---|---|---|
| GET | `/v1/teams` | members: public and own teams; owners/admins: all; guests: own | — |
| POST | `/v1/teams` | `teams:create` | `name`, `description?`, `visibility?` |
| GET | `/v1/teams/:teamId` | anyone who can see it | — (`myRole`, `canManage`) |
| PATCH | `/v1/teams/:teamId` | team owner, org owner/admin | `name?`, `description?`, `visibility?`, `settings?` |
| POST | `/v1/teams/:teamId/archive` | team owner, org owner/admin | — |
| POST | `/v1/teams/:teamId/join` | non-guest members, public teams | — |
| GET | `/v1/teams/:teamId/members` | anyone who can see it | — |
| POST | `/v1/teams/:teamId/members` | team owner/manager (members if allowed) | `userIds` (1–200), `role?`. Existing members are skipped; `added` counts new ones |
| PATCH | `/v1/teams/:teamId/members/:userId` | team owner, org owner/admin | `role` (`owner` \| `manager` \| `member`) |
| POST | `/v1/teams/:teamId/members/:userId/remove` | self, team owner/manager | 409 last team owner |
| GET | `/v1/teams/:teamId/channels` | team members (private channels: their members only) | — |
| POST | `/v1/teams/:teamId/channels` | see [teams-and-channels.md](teams-and-channels.md) | `name`, `type`, `description?`, `memberIds?`, `externalUserIds?` (shared) |
| POST | `/v1/teams/:teamId/channels/:channelId/members` | channel or team owners/managers | `userIds` (team members) |
| POST | `/v1/teams/:teamId/channels/:channelId/members/:userId/remove` | self, channel or team owners/managers | — |
| POST | `/v1/teams/:teamId/channels/:channelId/delete` | channel or team owners/managers | — (General can't be deleted) |

Channel messages, files and calls use the existing conversation endpoints with the channel's ID (`/v1/conversations/{id}/messages` and so on).

## Status codes used
- **400:** validation, or a business rule (for example "Everyone added must be a member of this organization").
- **401:** not signed in.
- **403:** signed in but not allowed. This includes a session naming an organization the caller isn't an active SpreeWe member of.
- **404:** not found **or not visible**. Used deliberately for private teams and channels, invitations and joins, so existence isn't revealed.
- **409:** conflict: slug taken, already a member, duplicate request, last owner, concurrent change.
- **429:** rate limited (`sensitive` routes per IP; organization creation per user per day).
- **503:** Clerk unavailable during a join or accept; nothing was granted and the request can be retried.

## Real-time events (Socket.IO)

> **Updated 2026-10-27:** the full, current event catalogue is in [../implementation/workspace-organization-ui-improvements.md](../implementation/workspace-organization-ui-improvements.md#server-events-backend). It adds organization, invitation, join-request, team and channel signals for everyone allowed to see the change. Notices about the user's own membership now reach all of their tabs, and `org:removed` is sent before the disconnect. The table below is the original subset.
Every event is emitted by the server after an authorized change. Clients cannot emit them. Tenant-scoped events reach only the recipient's sockets **in that organization**; user-scoped events reach the user's primary socket in any context.

| Event | Scope | Recipient | Payload |
|---|---|---|---|
| `org:joined` | user | The new member | `organizationId`, `clerkOrgId`, `name`, `role` |
| `org:removed` | user | The removed or departing member (their sockets in the organization are also disconnected) | `organizationId`, `reason` (`removed` \| `left`) |
| `org:role-changed` | tenant | The member | `organizationId`, `role` |
| `org:invitation` | user | An existing account matching an invited email | `organizationId`, `name` (no token) |
| `org:join-request-created` | tenant | Owners and admins | `organizationId`, `requestId` |
| `org:join-request` | user | The requester | `organizationId`, `name`, `status` |
| `team:joined`, `team:removed`, `channel:created`, `channel:joined` | tenant | See [teams-and-channels.md](teams-and-channels.md) | — |

Tests: `test/organizations-realtime.test.ts` covers:
- `org:invitation` (invitee only);
- `org:join-request-created` (admins' sockets in that organization only; not their personal socket, not members);
- `team:joined`, `channel:created` and `org:role-changed` (only the person concerned, on their socket in the organization);
- removal (the workspace socket is disconnected and reconnecting is refused).

`org:joined`, `org:join-request`, `team:removed` and `channel:joined` use the same emit helpers but have no event-specific test.
