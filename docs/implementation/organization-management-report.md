# Organization and workspace management: implementation report

Date: 2026-10-26.

**Status:** implemented and tested locally and on the approved **staging** Clerk instance.
- Not deployed and not committed.
- No production Clerk settings, credentials or data were touched.
- No Clerk instance settings were changed in this phase.

Design and reference documentation:
- [organization-management.md](../organizations/organization-management.md)
- [membership-and-permissions.md](../organizations/membership-and-permissions.md)
- [invitations-and-join-requests.md](../organizations/invitations-and-join-requests.md)
- [teams-and-channels.md](../organizations/teams-and-channels.md)
- [clerk-integration.md](../organizations/clerk-integration.md)
- [organization-api.md](../organizations/organization-api.md)

## Owner decisions this phase
- **Invitation delivery:** a secure link plus a pluggable email sender. No provider is configured, so links are shown once to the inviter and invitations are also shown in-app to the verified address.
- **Role authority:** the SpreeWe database (`TenantMembership`), not Clerk roles.

## What was built

| Area | Delivered |
|---|---|
| Contexts | Personal, organization and external, unchanged in isolation. New SpreeWe-managed organizations (`managedBy: "spreewe"`) coexist with legacy Clerk-managed ones, which are untouched. Personal conversations are never moved |
| Creation | Three-step wizard (details, access, review). Clerk organization created server-side, then Tenant, then owner membership, with full rollback. Slug uniqueness also holds under races. Per-user daily and ownership limits plus per-IP limit. The user is switched into the new organization |
| Clerk | Server-side Backend API only; idempotent sync; failures always end in *no access*. `maxAllowedMemberships` 0 (unlimited) instead of the instance default of 5. Clerk webhooks can't grant membership for managed organizations |
| Invitations | 256-bit tokens, SHA-256 at rest, 1–30 day expiry, single use (atomic claim), verified-email match, generic errors (no enumeration). Resend rotates the token; revoke; status tracking; in-app list. Works for existing and new accounts |
| Joining | Invitation; approved request; join code or link (hashed, constant-time compare); open join for discoverable organizations. Private organizations refuse everything else with the same generic 404 |
| Policies | Discoverable, join policy, allowed email domains, members can invite, members can create teams, guest access, join code. Existing external policies: chat, calls, files, members can start external chats |
| Roles | Owner, admin, member, guest; team owner, manager, member. No self-escalation; admins can't escalate; last owner protected (also under concurrency); platform administrators get nothing. Guests have no directory |
| Teams and channels | Public and private teams, General channel, standard, private and shared channels as conversations, archive. Private channels are hidden even from organization admins. Removal cascades to every team and channel |
| UI (Angular) | Workspace switcher (create, join, home, settings; fallback notice); organization home; settings tabs (general, members and roles, invitations, join requests, privacy and discovery, external access, ownership and deletion, audit); team page; join page; invitation page |
| API and data | 42 new `/v1` operations (27 organization, including join-request approve and reject; 15 team and channel), in the regenerated OpenAPI. Models `org_invitations`, `org_join_requests`, `org_audit_events`, `teams`, `team_memberships`; Tenant, TenantMembership and Conversation extended. Migration `2026-10-27-organizations` |
| Real-time | `org:joined`, `org:removed`, `org:role-changed`, `org:invitation`, `org:join-request-created`, `org:join-request`, `team:joined`, `team:removed`, `channel:created`, `channel:joined`. All emitted by the server after authorized changes; tenant-scoped where they concern an organization |

## Test results (final runs, 2026-10-26)

| Suite | Result |
|---|---|
| Backend type-check (`tsc --noEmit`) | Pass |
| Backend Vitest, full suite | **220 / 220 passed** (25 files) |
| … organization-specific | `organizations.test.ts` 23, `teams-channels.test.ts` 11, `organizations-realtime.test.ts` 4, `tenant-owned-scope.test.ts` 2, `organizations-migration.test.ts` 1 |
| Repeatability | Organization and team files run 4× consecutively; real-time file 3×: all passing |
| OpenAPI | Regenerated (`npm run openapi`); Spectral `spectral:oas`: 0 findings |
| Frontend `ngc` (strict template type-check) | Pass |
| Frontend Karma (ChromeHeadless) | **46 / 46 passed**, including 8 organization screens and 3 auth fallback tests |
| Frontend production build | Pass. 25 component-style budget warnings, all in pre-existing chat, call and shell styles; none in the organization pages |
| Mutation checks (organization guards removed one at a time) | 14 / 14 caught. Run **before** the final fixes below, and not re-run since |

### Browser end-to-end on staging (real Clerk staging instance, real Angular UI, two backend instances)

| Run | Result |
|---|---|
| Scenarios 1–14 (`org-e2e.js`): create in UI, real Clerk organization linked, invite and accept, replay refused, stolen link refused, roles, admin can't invite admins, in-app invitation, member gets 403 on every admin operation, discover, request and approve, private not joinable, teams, standard and private channels, channel deep link, switching between organizations and Personal, removal with immediate refusal and Clerk membership removed | **24 / 24 passed** |
| Scenario 15 (`org-e2e-15.js`): a membership added directly in Clerk (as `org:admin`) grants nothing; sign-in falls back to Personal | **4 / 4 passed** (after the lockout fix below; it failed before) |
| Owner race and team re-add re-check (`org-e2e-owner-race.js`), against the existing organization with no new Clerk organizations | **5 / 5 passed** (both concurrent demotions refused, 409/409; an owner remained; roles restored and mirrored in Clerk) |

Which code each run used:
- The 24-check run predates the fixes for the race, team re-add, guest directory and legacy message.
- The race re-check ran on code with the race and team fixes, before the guest-directory fix.
- The guest-directory fix is covered by automated tests only.

The harness is in the session scratchpad; it is not part of the repository.

### Clerk staging verification (verified, not assumed)
- Organizations created by SpreeWe exist in Clerk with `max_allowed_memberships: 0`, the creator as `org:admin`, and the linked `Tenant.clerkOrgId`.
- Accept, approve and remove changed real Clerk memberships.
- Clerk-only membership was refused by SpreeWe.

Organizations left on the **staging** Clerk instance by these runs:
- `phase5c Org mvpcq73h` (4 members);
- `phase5c Private` (1 member).

These are synthetic and can be deleted by the owner. `phase5b-OrgA` and `phase5b-OrgB` predate this phase.

**Not verified:** production Clerk, any other Clerk plan, and real email delivery (no provider).

## Migration status
- `2026-10-27-organizations` is index-only and idempotent (`createIndexes`). It creates:
  - the unique slug index for managed organizations;
  - one pending invitation per (organization, email);
  - one pending request per (organization, user);
  - unique active team names (case-insensitive), unique team membership;
  - lookup indexes, and the channel `teamId` index.
- It changes no data: existing tenants stay Clerk-managed and no conversations move.
- Applied on the local staging database; covered by `organizations-migration.test.ts` (runs twice, no changes).
- **Not run in production.** It must run before the feature is enabled: several correctness guarantees (slug uniqueness, duplicate requests, team names) rely on the unique indexes. Mongoose `autoIndex` builds them only asynchronously; the tests now build them explicitly for that reason.

## Security findings in this work (all fixed, each with a regression test)

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | High | **Sign-in lockout:** a user whose Clerk session restored an organization SpreeWe refuses (removed, deleted, Clerk-only) was signed out and could not use SpreeWe at all. Found by staging scenario 15 | `ensureAppUser` clears the active organization, retries in Personal, and shows a notice. Karma tests; staging re-run passed |
| 2 | High | **Zero owners by race:** two owners demoting, removing or leaving at the same time could leave an organization with no owner. Same for teams | Concurrency-safe demotion with re-count and undo (`demoteOwner`, `demoteTeamOwner`). Reproduced first (0 owners), then fixed; staging re-check passed |
| 3 | High | **Manager demotes owner:** adding people to a team rewrote the role of existing members, so a manager (or a member with `membersCanAddMembers`) could demote team owners, including the last one | Adding skips existing members; roles change only through the team-role endpoint |
| 4 | High | **Guest directory exposure:** the pre-existing directory, people search, profile, presence and member-list paths treated guests like members, so a guest could enumerate the whole organization | Guests reach only people they share a conversation with; member lists return 403; guests can't start external chats |
| 5 | High | **Private channels opened by organization admins** (found in review of this phase's own code) | Bypass removed; private channels are strictly members-only |
| 6 | Medium | **Team membership upsert stored no `tenantId`**, invisible to tenant-scoped queries (data integrity) | The `tenant` plugin kind stamps `tenantId` in `$setOnInsert` |
| 7 | Medium | **"Leave team" UI could remove another member** with the same role | Uses the caller's user ID |
| 8 | Low | Each "my invitations" call ran an unscoped `updateMany` across all organizations | Removed; the query already filters on expiry |

Design properties verified by tests:
- invitation and join refusals don't reveal existence or the invited address;
- tokens and codes are stored only as hashes and never logged or listed;
- partial Clerk failures never grant access;
- platform administrators get no access;
- legacy workspaces now get a clear refusal instead of a misleading "Organization not found".

## Known limitations and open risks
1. **No email provider.** Links must be shared by hand; the plug-in point exists. Owner decision needed: provider and sending domain.
2. **No automatic Clerk reconciliation.** `clerk.sync_failed` is audited only. Stale Clerk memberships grant nothing, but they persist in Clerk and may count towards plan limits. Recommend a periodic reconciliation job before production.
3. **Cross-instance revocation lag.** Bounded by `MEMBERSHIP_CHECK_CACHE_MS` (default 15 s). The presence-visibility cache (60 s) is keyed by organization, not role, so a member changed to guest may keep seeing presence for up to a minute.
4. **Rate limiting is per instance.** `express-rate-limit` uses its default in-memory store. With several instances, effective limits multiply. The per-user organization-creation limits are database-backed and global.
5. **Shared channels are API-only**, pending a product decision on adding outside people without account enumeration. The API accepts user IDs, and its "not found" error confirms whether an ID exists. That is limited to owners, admins and team managers, and the IDs are not guessable.
6. **No organization logo upload.** The field is reserved; the wizard doesn't offer it.
7. **Ownership transfer** promotes the target, then safely demotes the caller. It is not a single atomic operation: if the caller is demoted concurrently, the target is still promoted. No zero-owner state is possible.
8. **Deleted organizations keep their data.** No retention or purge policy is defined.
9. **Legacy Clerk-managed workspaces** have no teams, channels or SpreeWe management. No conversion path, by design.
10. **Test harness noise:** running a single filtered Vitest test can print `ECONNRESET` after the summary, from in-memory MongoDB teardown. Full runs are clean.

## Manual configuration required (no code change)

| Item | Owner role |
|---|---|
| Set `APP_PUBLIC_URL` per environment (invitation and join links) | DevOps |
| Set `CLERK_ORG_MAX_MEMBERSHIPS` deliberately, and confirm the Clerk **plan's** organization-membership limit | Product owner with the Clerk account admin |
| Production Clerk: Organizations enabled, membership optional, `force_organization_selection` off (as on staging) | Clerk account admin, with explicit production approval |
| Run migration `2026-10-27-organizations` before enabling the feature | DevOps, during the release window |
| Choose and configure an email provider; register it with `setInvitationSender` | Product owner (decision), then a backend developer |
| Choose `MEMBERSHIP_CHECK_CACHE_MS` (0 = immediate cross-instance revocation, at the cost of more lookups) | Tech lead |
| Delete the synthetic staging organizations if no longer needed | Staging owner |

## Main code locations
- **Backend:**
  - `src/organizations/` (models, permissions, organization and team services, Clerk sync, mailer);
  - `src/api/v1/organization.routes.ts`, `team.routes.ts`;
  - `src/tenancy/` (`tenant` scope kind, managed-tenant context resolution, guest rules);
  - `src/integrations/clerk-webhooks.ts`;
  - `src/migrations/index.ts`.
- **Frontend:**
  - `core/services/organization.service.ts`, `clerk.service.ts`, `auth.service.ts`;
  - `pages/organizations/*`;
  - `pages/shell/workspace-switcher.component.ts`, `shell.component.ts`;
  - `pages/chat/chat.component.ts` (channel deep link).
- **Tests:**
  - backend: `test/organizations*.test.ts`, `test/teams-channels.test.ts`, `test/tenant-owned-scope.test.ts`, `test/support/clerk-double.ts`;
  - frontend: `pages/organizations/organizations.spec.ts`, `core/services/auth.service.spec.ts`.
