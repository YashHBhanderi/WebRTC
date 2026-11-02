# Clerk integration for SpreeWe-managed organizations

Clerk provides identity, sessions, and the session's *active organization*. SpreeWe decides who belongs to an organization and with which role.

Every Clerk call is server-to-server through the Clerk Backend API (`@clerk/express` `clerkClient`) with `CLERK_SECRET_KEY`. The secret key never reaches Angular; the frontend only uses the publishable key and the Clerk JS SDK, to select the active organization.

Code: `webrtc-BE/src/organizations/clerk-sync.ts`.

## Why both sides are needed
A user's session token carries the active organization (`org_id`) only if Clerk knows the user belongs to it. So SpreeWe mirrors two things into Clerk: **the organization** and **its members**.

Access needs both of the following, so neither side alone grants it:
- **Clerk:** the session token names the organization;
- **SpreeWe:** an active `TenantMembership`, the authority.

| State | Result |
|---|---|
| Active in SpreeWe, member in Clerk | Access, with the SpreeWe role |
| Active in SpreeWe, missing in Clerk | No access: the session can't select the organization. Retrying the SpreeWe operation repairs it |
| Removed or missing in SpreeWe, member in Clerk (Dashboard edit, half-finished sync) | **No access** (403). Verified on staging: the switcher falls back to Personal |
| Organization deleted in SpreeWe | No access for anyone, whatever Clerk says |

A local MongoDB organization never becomes a Clerk organization by itself, and vice versa. Each SpreeWe-managed Tenant is linked to the Clerk organization SpreeWe created (`Tenant.clerkOrgId`).

## Operations and their ordering
All Clerk helpers are idempotent: "already a member" becomes a role update, and "not found" on delete counts as done. A failed workflow can therefore be retried, and compensations are safe. Failures are raised as `ClerkSyncError(operation, code)`; logs contain only the code, never tokens or personal data.

| SpreeWe workflow | Order | On failure |
|---|---|---|
| Create organization | Clerk `createOrganization` (`createdBy` = creator, `maxAllowedMemberships`), then Tenant, then owner membership | Tenant deleted, Clerk organization deleted; nothing remains |
| Accept invitation / approve request / join | Claim the invitation or request, then Clerk `createOrganizationMembership`, then local membership | Clerk failure: nothing granted, claim undone (503). Local failure: Clerk membership removed again |
| Change role | Local compare-and-set, then Clerk role update (mirror) | Local role stands (it is the authority); `clerk.sync_failed` audited |
| Remove / leave | Local tombstone (access ends), team and channel cleanup, socket disconnect, then Clerk `deleteOrganizationMembership` | Access already gone; `clerk.sync_failed` audited for retry |
| Transfer ownership | Local roles, then Clerk roles | Clerk errors ignored (both stay `org:admin` in Clerk) |
| Delete organization | Tenant `deleted` (access ends), caches cleared, sockets disconnected, then Clerk `deleteOrganization` | `clerk.sync_failed` audited |

**There is no automatic retry job yet.** `clerk.sync_failed` entries appear in the organization's audit log; nothing re-runs them. A stale Clerk membership grants nothing, but it stays in Clerk, shows the organization in Clerk's own organization list for that user, and may count towards Clerk plan limits until removed. Repeating the SpreeWe action, or an operator calling the Clerk API, clears it. A periodic reconciliation job is recommended before production.

**Rule:** every ordering fails towards *no access*. A partial failure can leave a stale Clerk membership, which grants nothing. It can never leave a SpreeWe membership that Clerk-side state would need to authorize.

**Role mapping:** owner and admin → `org:admin`; member and guest → `org:member`. The mapping is informational: SpreeWe never reads Clerk roles for SpreeWe-managed organizations.

**Membership limit:** Clerk organizations default to 5 members on this instance. SpreeWe creates organizations with `maxAllowedMemberships` = `CLERK_ORG_MAX_MEMBERSHIPS` (default 0 = unlimited; the Clerk plan may still cap it). Verified on staging (`max 0`).

## Verified emails
Invitation acceptance compares the invitation address with the caller's **verified** email addresses, read live from Clerk (`users.getUser`). Domain allow-lists use the same source. Unverified addresses never count.

## Webhooks
`webrtc-BE/src/integrations/clerk-webhooks.ts`:
- For SpreeWe-managed organizations, organization and membership events are acknowledged and **skipped** (`skipped:managed-in-spreewe`), so Clerk can't add members or change roles.
- The one exception is `organizationMembership.deleted`, which may only **remove** local access. That keeps "removed in Clerk" fail-safe.
- Legacy organizations are processed as before.

## Frontend
- `ClerkService.activateNewOrganization(clerkOrgId)` reloads the Clerk user, so it sees the new membership, then calls `setActive({ organization })`. The app then does a full page load.
- When the backend refuses the active organization at sign-in, `AuthService.ensureAppUser` calls `setActive({ organization: null })`, retries once in the personal context, and the shell shows a notice. A user removed from an organization is therefore never locked out of SpreeWe.

## Clerk configuration this relies on
These are already set on the approved **staging** instance; production must match:
- **Organizations enabled**, membership **optional**: users can be in the personal context.
- `force_organization_selection` **off**: a removed member must be able to land in Personal.
- The secret key is present only in the backend environment.
- `CLERK_AUTHORIZED_PARTIES` lists the frontend origin(s).

Nothing in this phase changed Clerk instance settings. The staging settings were made by the owner in the Dashboard during Phase 5B.

## Staging verification
Against the approved staging Clerk instance, not production:
- Organization creation through the SpreeWe UI created a real Clerk organization, linked to the Tenant, with the creator as `org:admin` and `max_allowed_memberships: 0`.
- Invitation acceptance, request approval and removal added and removed real Clerk memberships.
- A Clerk-only membership (added directly through the Clerk API as `org:admin`) granted nothing, and sign-in fell back to Personal.
- Concurrent owner demotion kept an owner; Clerk roles were mirrored back.

Results: [../implementation/organization-management-report.md](../implementation/organization-management-report.md).

Real Clerk organization creation has **not** been tested against a production instance, and must not be assumed to behave identically under a different plan or configuration.
