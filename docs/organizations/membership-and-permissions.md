# Membership and permissions

Authorization for SpreeWe-managed organizations happens in the backend, from the **database**. The client never supplies a role, and it cannot pick an organization ID to gain access.

The UI hides controls according to the permissions the server reports, but that is presentation only. Every endpoint checks again.

Source of truth:
- `webrtc-BE/src/organizations/permissions.ts` (`orgCan`, `invitableRoles`, `mayChangeRole`, `mayRemove`);
- `webrtc-BE/src/organizations/team.service.ts` (team rules);
- `webrtc-BE/src/tenancy/tenant.service.ts` (`can`, the directory rules, guest contacts).

## How a request gets its organization and role
1. Clerk verifies the session token. Its `org_id` claim names the organization the user selected in Clerk.
2. `resolveContext` loads the Tenant for that Clerk organization.
   - **SpreeWe-managed:** access requires an **active `TenantMembership`**, otherwise 403. The role is the membership's `role`; the token's `org_role` is ignored.
   - **Legacy (Clerk-managed):** unchanged from earlier phases (role from the token).
3. Organization routes then call `activeOrg(ctx, action)`. It loads the Tenant, requires `status: "active"`, and applies `orgCan`.

Consequences:
- Being a member **only in Clerk** (added in the Clerk Dashboard, or a half-finished sync) grants nothing. Verified on staging (scenario 15).
- **Removing the local membership** ends access at once; the Clerk side is cleaned up afterwards.
- Clerk webhooks cannot add members to SpreeWe-managed organizations. They return `skipped:managed-in-spreewe`, except `organizationMembership.deleted`, which may only remove access.

## Organization roles

| Role | Meaning |
|---|---|
| `owner` | Full control, including deletion and ownership transfer. At least one is always required |
| `admin` | Manages settings, members and guests, invitations, join requests and the audit log. Can't touch owners or create admins |
| `member` | Uses the organization; invites and creates teams when the settings allow |
| `guest` | Limited participant: only teams they are added to; no directory; no external chats. Only when `guestAccess` is on |

Mapping to Clerk roles (mirror only; never read back for authorization): owner and admin → `org:admin`; member and guest → `org:member`.

## Permission matrix (organization)

| Action (`OrgAction`) | owner | admin | member | guest |
|---|:-:|:-:|:-:|:-:|
| `org:read`: overview, own role, leave | ✓ | ✓ | ✓ | ✓ |
| `members:read`, `directory:read` | ✓ | ✓ | ✓ | ✗ |
| `org:update`: name, slug, description, settings, policies | ✓ | ✓ | ✗ | ✗ |
| `org:audit` | ✓ | ✓ | ✗ | ✗ |
| `requests:decide` | ✓ | ✓ | ✗ | ✗ |
| `joincode:manage` | ✓ | ✓ | ✗ | ✗ |
| `members:remove` | ✓ (anyone except self) | ✓ (members and guests only) | ✗ | ✗ |
| `members:role` | ✓ (any change except own) | ✓ (member ↔ guest only) | ✗ | ✗ |
| `members:invite` | ✓ | ✓ | if `membersCanInvite` | ✗ |
| `teams:create` | ✓ | ✓ | if `membersCanCreateTeams` | ✗ |
| `org:delete`, transfer ownership | ✓ | ✗ | ✗ | ✗ |
| Start an external chat | ✓ if `allowExternalChat` | ✓ if `allowExternalChat` | if `allowExternalChat` **and** `membersCanStartExternal` | ✗ |

Roles each inviter may grant (`invitableRoles`):
- owner → admin, member, plus guest when `guestAccess` is on;
- admin → member, plus guest when `guestAccess` is on;
- member → member, only when `membersCanInvite` is on;
- guest → nothing.

**Owner** is never granted by invitation; it is only reached by role change or transfer.

## Invariants
- **No self-escalation.** Nobody changes their own role (`mayChangeRole(..., self = true)` is always false). Ownership moves only by explicit transfer.
- **Admins can't escalate.** An admin can't grant admin or owner, and can't change, demote or remove an owner or another admin.
- **The last owner is protected.** The last owner can't be demoted, removed, or leave (409).
  - This also holds under concurrency. Two owners demoting, removing or leaving at the same moment used to be able to leave an organization with **no owner**: each request counted two owners before writing.
  - Every owner demotion now goes through `demoteOwner`: a compare-and-set write, a re-count, and an undo plus 409 if the organization would have no owner. In a simultaneous mutual demotion, both requests are refused (409, 409) and both stay owners; each person can retry.
  - Tested in `test/organizations.test.ts` and on staging against real Clerk.
- **Role changes are compare-and-set** on the role that was read, so a concurrent change produces 409 *"The member changed meanwhile"* instead of a lost update.
- **Platform administrators get nothing inside an organization.** `PLATFORM_ADMIN_CLERK_IDS` grants no membership, no content access and no management; they are treated like any other non-member. Tested.

## Guests
Guests are participants, not members of the directory:
- **People.** They can see, find (directory and search), view profiles, see presence of, and include only people they already **share a conversation with** in that organization: their teams' channels, and chats they were added to. Everyone else returns "not found", or 403 when they try to include them (`guestContacts`, `isGuest` in `tenant.service.ts`; also applied in `search.service.ts` and `presence.service.ts`).
- **Member lists.** `GET /v1/workspace/members` and `GET /v1/workspace/organization/members` return 403.
- **Teams.** They see only teams they were added to. They can't join public teams themselves, can't create teams or channels, and can't be made owner.
- **External chats.** They can't start them.

Before this phase's final fix, the older directory, search and profile code treated a guest like a member: a guest could list everyone. That is now covered by `test/teams-channels.test.ts`, "guests …".

## Team roles

| Action | Team owner | Team manager | Team member | Org owner/admin (not on the team) |
|---|:-:|:-:|:-:|:-:|
| See a public team | ✓ | ✓ | ✓ | ✓ |
| See a private team | ✓ | ✓ | ✓ | ✓ |
| Rename, change visibility or settings, archive | ✓ | ✗ | ✗ | ✓ |
| Add members | ✓ | ✓ | if `membersCanAddMembers` (as member only) | ✓ |
| Add owners or managers, change team roles | ✓ (not own role) | ✗ | ✗ | ✓ |
| Remove members | ✓ | ✓ (not owners) | self only | ✓ |
| Create standard or private channels | ✓ | ✓ | if `membersCanCreateChannels` | ✓ |
| Create shared channels¹ | ✓ | ✓ | ✗ | ✓ |

Any organization member except guests may join a **public** team themselves (`POST /v1/teams/:teamId/join`). Private teams are joined only by being added.

¹ Shared channels also need the organization's `allowExternalChat` policy. The creator must be an organization owner or admin, or `membersCanStartExternal` must be on.

Team rules:
- A team always keeps at least one owner. The same concurrency-safe demotion is used (`demoteTeamOwner`).
- **Adding people never changes the role of someone already on the team.** Previously a manager could "add" an existing owner as member and silently demote them; that is fixed and tested.
- A private team doesn't appear for people outside it; it returns 404 rather than 403, so its existence isn't confirmed.

## Channel access
Channels are conversations, so the conversation's `members` list is exactly who may read it. Messages, files, calls, search and sockets all use the existing conversation checks.
- **Standard:** every team member (kept in sync as the team changes).
- **Private:** an explicit subset of team members. **Not even organization owners or admins can open, list or join a private channel they are not in.**
- **Shared:** team members plus approved external people. See [teams-and-channels.md](teams-and-channels.md).

Removing someone from the organization also removes them from every team and every team channel in it.

## Caching
`MEMBERSHIP_CHECK_CACHE_MS` (default 15 s, max 60 s) caches membership and role lookups per instance. The instance that removes a member or changes a role clears its own cache and disconnects that user's sockets for the organization; other instances converge within the TTL. Set it to `0` where immediate cross-instance revocation matters more than lookup cost.

## Tests
- `test/organizations.test.ts`: creation, invitations, the authorization matrix, escalation, last owner (including races), legacy workspaces, platform administrators, joining, removal, Clerk failures.
- `test/teams-channels.test.ts`: teams, team roles, guests, private and shared channels, switching, removal.
- `test/organizations-realtime.test.ts`: authorized real-time events.
- `test/tenant-owned-scope.test.ts`: the `tenant` plugin kind.
- Frontend: `pages/organizations/organizations.spec.ts`; `core/services/auth.service.spec.ts` (refusal fallback).
