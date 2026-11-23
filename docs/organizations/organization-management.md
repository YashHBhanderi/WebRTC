# Organization management

SpreeWe organizations work like Microsoft Teams workspaces. People create, join, configure and leave them **inside SpreeWe** (Angular frontend and Express backend). Nobody needs the Clerk Dashboard.

Clerk remains the identity and session provider. SpreeWe is the authority for membership and roles.

Related:
- [membership-and-permissions.md](membership-and-permissions.md)
- [invitations-and-join-requests.md](invitations-and-join-requests.md)
- [teams-and-channels.md](teams-and-channels.md)
- [clerk-integration.md](clerk-integration.md)
- [organization-api.md](organization-api.md)

## Contexts

| Context | How it is selected | What you see |
|---|---|---|
| **Personal (global)** | No active organization in the Clerk session | Personal chats, calls and meetings; the global directory (people who allow it) |
| **Organization (workspace)** | The Clerk session's active organization, **and** an active SpreeWe membership | That organization's teams, channels, chats, meetings and directory |
| **External** | A conversation with `scope: "external"` owned by one organization | Only that conversation; external people are labelled *External* and see nothing else of the organization |

Data never moves between contexts automatically. Creating or joining an organization does **not** move personal conversations into it.

The backend enforces contexts as before: a fail-closed tenant plugin on every tenant-scoped model ([../security/fail-closed-tenant-context.md](../security/fail-closed-tenant-context.md)).

This phase adds one plugin kind: `tenant`, for records that exist only inside an organization (teams and team memberships):
- Created in a user context: `tenantId` is stamped from the verified context. Upserts stamp it in `$setOnInsert`.
- Created by the system: `tenantId` must be supplied explicitly.
- Outside a workspace: queries match nothing, and writes are refused.

## Two kinds of organization

| `Tenant.managedBy` | Created by | Membership authority | Role source |
|---|---|---|---|
| `"spreewe"` | SpreeWe's create wizard / API (this phase) | `TenantMembership` in MongoDB | The database |
| `"clerk"` (default; legacy) | Clerk (Dashboard, or Clerk invitations in earlier phases) | Clerk | The session token's `org_role`, as before |

Existing tenants are **not** converted: they keep working exactly as before.

Organization management, teams and channels exist only for SpreeWe-managed organizations. On a legacy workspace these endpoints return 404 with: *"This workspace's members are managed in Clerk, so organization settings, teams and channels aren't available for it"*.

## Organization lifecycle

### Create
UI: `/organizations/new` is a three-step wizard:
1. **Details:** name, URL name (slug, suggested from the name) and description.
2. **Access:** Private, Discoverable with approval, or Discoverable and open; external chat on or off.
3. **Review**, then create.

API: `POST /v1/organizations`. It runs in this order, and each step undoes the earlier ones if it fails:

1. **Validate.**
   - Name: 2–80 characters.
   - Slug: `^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$`, unique among SpreeWe-managed organizations (unique partial index).
   - Unknown fields are refused (400).
2. **Rate limits:**
   - at most `ORG_CREATE_PER_DAY` (default 5) organizations created per user per 24 hours (429);
   - at most `ORG_OWNED_MAX` (default 20) organizations owned per user (409);
   - the route is also `sensitive`, so it gets the stricter per-IP limiter (`RATE_LIMIT_SENSITIVE_MAX`, default 60/min).
3. **Clerk organization** (Backend API, server-side):
   - `createdBy` = the creator, so Clerk adds them as `org:admin` and their session can select the organization;
   - `maxAllowedMemberships` = `CLERK_ORG_MAX_MEMBERSHIPS` (default 0 = unlimited, subject to the Clerk plan).
4. **Tenant** (`managedBy: "spreewe"`, `createdBy`, settings, policies).
5. **Owner membership** (`role: "owner"`, `source: "creator"`).
6. If step 4 or 5 fails, the Tenant is deleted and the Clerk organization is deleted. A duplicate slug in a race returns 409, and the loser's Clerk organization is deleted.
7. The frontend reloads the Clerk user, selects the new organization (`setActive`) and does a full page load into `/organization`. A full load means no state from the previous context survives, and the socket reconnects with the new organization's token.

**Logo:** the `Tenant.avatar` field exists, but there is **no upload or update path** for it yet. The wizard does not ask for a logo; see Limitations.

### Settings
UI: `/organization/settings`. Tabs appear according to the permissions the **server** reports in `GET /v1/workspace/organization` (`permissions`), but every action is checked again by the server.

| Tab | Who | What |
|---|---|---|
| General | everyone (read); owners/admins (edit) | Name, URL name, description |
| Members & roles | members (read); owners/admins (manage) | Roles, remove |
| Invitations | anyone with `members:invite` | Invite by email, copy link (shown once), resend, revoke |
| Join requests | owners/admins | Approve or reject |
| Privacy & discovery | owners/admins | Discoverable, join policy, allowed email domains, member invitations, member-created teams, guest access, join code |
| External access | owners/admins | External chat, calls and files; members may start external chats (existing `PATCH /v1/workspace/policies`) |
| Ownership | owners | Transfer ownership; delete the organization |
| Audit log | owners/admins | `org_audit_events` |

Settings (`Tenant.settings`; defaults in `DEFAULT_TENANT_SETTINGS`):

| Setting | Default | Meaning |
|---|---|---|
| `discoverable` | `false` | Listed in `GET /v1/organizations/discover` |
| `joinPolicy` | `invite` | `invite` · `request` (ask, admins approve) · `open` (join directly). Forced back to `invite` whenever `discoverable` is false |
| `allowedEmailDomains` | `[]` (any) | At most 20. Checked against **verified** Clerk emails when inviting, accepting, joining and requesting |
| `membersCanInvite` | `false` | Members may invite other members |
| `membersCanCreateTeams` | `true` | Members may create teams |
| `guestAccess` | `false` | Guest invitations and the guest role are allowed |
| `joinCodeEnabled` | `false` | A join code / link is active (only its hash is stored) |

### Leave, transfer, delete
- **Leave:** `POST /v1/workspace/leave`. The last owner must transfer ownership first (409).
- **Transfer:** owner only. The target becomes owner and the previous owner becomes admin. The target must be an active, non-guest member.
- **Delete:** owner only; the exact organization name must be typed as confirmation.
  - The tenant becomes `status: "deleted"` and every member loses access at once: caches are cleared and sockets disconnected.
  - Data is kept; nothing is purged.
  - The Clerk organization is then deleted. If that fails, the failure is audited as `clerk.sync_failed`; access is already gone.

## Workspace switcher
The switcher (`pages/shell/workspace-switcher.component.ts`) is always visible. It offers:
- Personal and each organization;
- Organization home and settings (when one is active);
- Create organization and Join organization.

Switching to an organization does a full page load into `/organization`; switching to Personal goes to `/chat`.

**Fallback on refusal.** Clerk may restore an organization as active that SpreeWe refuses: membership removed, organization deleted, or a Clerk-only membership. In that case `AuthService.ensureAppUser` clears the active organization, retries in the personal context, and the shell shows: *"You no longer have access to that organization, so you're in your personal workspace."* Before this fix, such users were signed out and could not sign in at all (see the implementation report).

## UI routes

| Route | Page |
|---|---|
| `/organizations/new` | Create wizard |
| `/organizations/join` | Invitations for me · join code · search discoverable organizations · my requests |
| `/organizations/invitation?token=…` | Invitation preview and accept (token removed from the address bar immediately) |
| `/organization` | Organization home: teams with their channels, people, create team |
| `/organization/settings?tab=…` | Management |
| `/teams/:teamId` | Team: channels, members, roles |

A **Teams** item appears in the main navigation when an organization is active.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CLERK_SECRET_KEY` | — | Clerk Backend API (server only; never sent to Angular) |
| `CLERK_ORG_MAX_MEMBERSHIPS` | `0` (unlimited) | `maxAllowedMemberships` for organizations SpreeWe creates. The Clerk instance default is 5, which would silently cap organizations |
| `ORG_CREATE_PER_DAY` | `5` | Organizations a user may create per 24 h |
| `ORG_OWNED_MAX` | `20` | Organizations a user may own |
| `APP_PUBLIC_URL` | — | Base of invitation and join links. **Must be set** in each environment, or links are relative |
| `MEMBERSHIP_CHECK_CACHE_MS` | `15000` (max 60000) | How long a membership/role lookup is cached per instance. Removal and role changes clear the cache on the instance that made them; other instances may lag by up to this value |
| `RATE_LIMIT_SENSITIVE_MAX`, `RATE_LIMIT_WINDOW_MS` | `60`, `60000` | Stricter limiter on `sensitive` routes |

## Limitations
- **No email provider.** Invitation links are shown once to the inviter, who shares them. Invitees also see pending invitations in-app after signing in with the invited, verified address. A provider plugs in through `setInvitationSender` ([invitations-and-join-requests.md](invitations-and-join-requests.md)).
- **No organization logo upload** (field reserved).
- **Shared channels can be created through the API only.** A UI picker for people outside the organization would let members enumerate accounts; it needs a design decision (for example, invite-by-email into a shared channel).
- **Legacy Clerk-managed workspaces** have no teams, channels or SpreeWe management. Converting one needs a deliberate migration; none is provided, by design.
- **Role and removal propagation across instances** is bounded by `MEMBERSHIP_CHECK_CACHE_MS`. Sockets on the instance that made the change are disconnected immediately.
