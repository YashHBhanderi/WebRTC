# Workspace and organization UI improvements, and live synchronization

Date: 2026-10-27.

**Status:** implemented with automated tests. Nothing is deployed or committed. No production settings, Clerk settings or data were changed. Browser verification on staging was **not** done in this round; see [What was not verified](#what-was-not-verified).

Related: [organization-management-report.md](organization-management-report.md) · [../organizations/organization-api.md](../organizations/organization-api.md) · [../organizations/membership-and-permissions.md](../organizations/membership-and-permissions.md)

## 1. Problems and their causes

Every cause below was confirmed by reading the code. Where it was also proven by a test that fails on the old code, that is stated.

| Problem | Root cause | Files |
|---|---|---|
| **The active Teams icon drew a wrong glyph** | The rail adds `ti-fill` to the active icon. `styles.scss` switched **every** `ti-fill` icon to the `tabler-icons-filled` font, but remapped codepoints only for a whitelist. Tabler 3.49 has no filled `users-group` glyph, so the outline codepoint U+FA21 was looked up in the filled font. It has no glyph there, and U+FA21 is a CJK compatibility ideograph, so the browser drew a character from a system font. `users` and `building` have the same gap. Proven: the new spec fails with the old rule. | `styles.scss`, `shell.component.html` |
| **Organization changes needed a reload** | (1) The server emitted nothing for most of the 28 audited mutations. The events that did exist went only to the person concerned, and only to their newest tab. (2) The Angular app subscribed to **none** of the organization, team or channel events. (3) Every organization page loaded once in `ngOnInit`. (4) The workspace switcher read Clerk's membership list once. | backend `organization.service.ts`, `team.service.ts`, `realtime/io.ts`; frontend organization pages and switcher |
| HTTP caching? **Not a cause.** | The service worker caches app files only (no `dataGroups`), and API responses aren't cached. A plain reload already returned fresh data. The service worker does keep serving the old app *code* after a deploy until it updates; that is unchanged (see limitations). | `ngsw-config.json`, `app.module.ts` |
| **The switcher was stale and partly wrong** | It listed Clerk memberships: at most 10 (Clerk's default page size), Clerk's names (SpreeWe renames never reach Clerk), and Clerk's roles (owner shown as admin). | `workspace-switcher.component.ts`, `clerk.service.ts` |
| **The Clerk organization screen on `/workspace`** | It mounted Clerk's `OrganizationProfile` inside a narrow card for **every** workspace. For SpreeWe-managed organizations this was a second, conflicting membership UI: Clerk-side invitations and role changes grant nothing in SpreeWe. Its intrinsic width caused the cramped, overlapping layout. | `workspace-admin-page.component.ts`, `clerk.service.ts` |
| **A removed member's tab went silent** | The server disconnected their socket and then sent `org:removed`, which was lost. The client never reconnects after a server-initiated disconnect and had no handler for it. | `organization.service.ts`, `socket.service.ts` |
| **A refused workspace survived a reload** | The fallback to Personal ran only on a fresh sign-in, not with a cached app user. Leave and Delete reloaded without clearing Clerk's active organization. | `auth.service.ts`, `organization-settings.component.ts` |
| **A refused switch left the tab half-switched** | Clerk was set to Personal while the page and socket stayed in the old workspace. The server's reason was never shown, because the error interceptor rethrows strings. | `workspace-switcher.component.ts` |
| **Security, high: channel rooms weren't cleaned up** | People removed from a team or private channel, including external participants of shared channels, stayed in its Socket.IO room and kept receiving its messages until they reconnected. Proven: the new test fails without the eviction. | `team.service.ts` |
| **Security, medium: live sockets kept their old role** | A role change (for example, member to guest) never reached a live socket; its context was fixed at the handshake. | `organization.service.ts`, `realtime/index.ts` |
| **Clerk webhooks overwrote names** | `organization.created/updated` overwrote the name and slug of SpreeWe-managed organizations with Clerk's values. | `integrations/clerk-webhooks.ts` |
| Cross-tab | Nothing reacted when the active organization changed outside this tab. Reading the clerk-js 6.39 bundle (not observed in a browser) suggests each tab keeps its own active organization, and focusing a tab re-asserts it on the shared session. | `clerk.service.ts` |

## 2. What changed

### Teams icon (stylesheet only; the template is unchanged)
- `styles.scss`: one map of icons that have a filled glyph. Each entry sets the filled font **and** its codepoint together, so `ti-fill` on any other icon keeps the correct outline glyph. Outline fallbacks get a slight `-webkit-text-stroke`, so an active Teams icon carries the same visual weight as the filled ones.
- `shell.component.scss`: rail tiles are now 40×30 with a rounded tinted background when active (`--app-rail-active-bg`) and a faint one on hover (`--app-rail-hover-bg`). This applies in the expanded and collapsed rail and on the phone tab bar. Count badges keep their position on the icon.

### Server events (backend)
- **`realtime/io.ts`:**
  - `emitToWorkspace(tenantId, event, payload, { userIds?, roles? })` reaches **every** SpreeWe socket (all tabs) in that workspace that matches the audience. It never reaches other contexts or developer-app sockets, and costs one cluster message per event.
  - `notifyUserEverywhere` sends notices about the user's own membership to all of their sockets, in any context.
  - `leaveRooms` and `closeRooms` evict sockets from rooms cluster-wide.
- **`realtime/workspace-sync.ts`:** `syncMembership`, `syncTenant` and `syncConversationScope`. After a change they drop the cached membership, tenant and scope on **every** instance (before, only locally), and update the role on live sockets in place, or disconnect them when access ends.
- **`organizations/events.ts`:** the event catalogue and audiences, in one place.
- **Services:** `organization.service.ts` and `team.service.ts` emit after every database write. Removal now notifies **before** disconnecting. Team and channel removals evict room membership. `workspace-policies.ts` adds events to policy changes (both API surfaces).
- **Clerk:** `clerk-webhooks.ts` skips name and slug for SpreeWe-managed organizations. `clerk-sync.ts` marks the Clerk organizations SpreeWe creates (`publicMetadata.managedBy = "spreewe"`), so a webhook arriving early is recognised too.

**Events** (payloads are IDs only, plus names only for people who are members of the thing named):

| Event | Audience | Trigger |
|---|---|---|
| `org:updated` | everyone in the organization | profile, settings, policies, join code |
| `org:members-changed` | non-guest members | join, accept, approve, remove, leave, role change, transfer |
| `org:role-changed` | the member (their tabs in the organization) | role change, transfer |
| `org:invitations-changed` | people who may invite | invite, resend, revoke, accept |
| `org:join-request-created` / `org:join-requests-changed` | owners and admins | request created / cancelled or decided |
| `org:joined`, `org:removed`, `org:deleted`, `org:invitation`, `org:invitation-revoked`, `org:join-request` | the person concerned, on all their tabs | own membership changes |
| `team:changed` (`created`/`updated`/`archived`) | team viewers (public: non-guest members; private: owners and admins), plus team members; former viewers too when visibility changes | team create, update, archive |
| `team:members-changed`, `team:channels-changed` | team viewers | team membership or roles; standard or shared channel added or removed |
| `team:joined`, `team:removed` | the member | team membership |
| `channel:created`, `channel:joined`, `channel:members-changed`, `channel:removed` | channel members (or the removed person) | channel changes |
| `conversation:removed` | removed external participants | shared channel left or deleted |

### Live updates (frontend)
- **`WorkspaceSyncService`** (`core/services/workspace-sync.service.ts`):
  - It subscribes once for the app's lifetime, so components add no listeners of their own.
  - It maps events to *topics*: `org`, `members`, `invitations`, `requests`, `teams`, `team:<id>`, `teamMembers:<id>`, `channels:<id>`, `mine`, `myInvitations`, `myRequests`.
  - It ignores a workspace event that names a different organization from the one the tab shows (a second check behind the server's scoping).
  - After a socket reconnect it refreshes every view (`*`), to cover events that may have been missed.
  - On `org:removed` or `org:deleted` for the shown workspace, it switches to Personal and does a full reload with a notice.
  - When the server drops the socket, it re-checks `/v1/workspace`: a refusal means leaving; otherwise it reconnects with no reload.
- **`ViewRefresher`:**
  - **Coalescing.** A burst of signals results in one request.
  - **Own changes.** A view's own change and the server's echo of it result in one request, after the mutation, so nothing is fetched twice.
  - **Failed changes.** A failed change still reloads the real state, so no stale rows are left behind.
  - **Replace, never append.** Lists are always replaced from the server, so nothing is duplicated.
- **Pages:**
  - Live: organization settings, organization home, team page, join page and switcher. All tear down their subscriptions on destroy.
  - Forms being edited aren't overwritten by live updates.
  - The team page follows route parameters (moving between two teams used to keep the first one's data).

### Workspace switching and isolation
- **Switching stays a full page load.** This was required unless a soft switch could be proven to reset every stateful service: socket, conversations, notifications, calls, caches. It can't be proven safe cheaply.
- **Loading and failure handling.** The switcher shows "Switching…". On refusal it restores the **previous** workspace and shows the server's reason.
- **Workspace guard** (`ClerkService.getToken`):
  - The tab pins the workspace it shows.
  - A token whose organization claim differs is never used. The auth interceptor aborts the request (`WorkspaceChangedError`) without sending it, and the error interceptor does **not** treat that as an expired session (before this change, the 401 path would have signed the user out of Clerk).
  - The tab then reloads into the session's current workspace with a notice.
- **Cross-tab:** SpreeWe's own switches are announced through `localStorage` (`spreewe.workspace`), and other SpreeWe tabs follow with a notice.
- **Refused-workspace check:** done once per app load, even with a cached user. Leave and Delete clear Clerk's active organization first.
- **`RAW_ERRORS` request flag:** lets callers see the HTTP status (a refusal vs. offline); the interceptor otherwise rethrows strings.

### Organization UI
- **`org-ui.scss`:** one shared layout vocabulary built only from SpreeWe's tokens (light and dark): page frame, header with organization avatar, settings section nav, panels, forms, toolbar and search, role chips, stacking tables, banners, empty and loading states.
- **Organization settings:**
  - header with the organization avatar, name, your role and the member count;
  - a section sidebar that turns into a horizontally scrolling tab strip under 900 px;
  - content capped at 760 px;
  - **Members:** search and a role filter, role chips, "(you)" on your own row, and a remove button only where the server would allow it;
  - invitation status shows "expired" based on the expiry date;
  - confirmations use the shared, focus-managed dialog (`AlertService.confirm`), replacing `window.confirm`;
  - tables become stacked cards under 640 px.
- **Organization home and team page:** the same header, panels, empty states with next actions, and loading and error states.
- **Workspace switcher:** an avatar per workspace, real role labels, "managed in Clerk" for legacy workspaces, and inline loading and error states.
- **`/workspace`:**
  - **SpreeWe-managed organization:** Clerk's `OrganizationProfile` is gone. The page links to the native settings (Members & roles, Invitations, External access) and keeps *Workspace apps*.
  - **Clerk-managed (legacy) workspace:** the Clerk screen stays, because Clerk is the authority there. It fills the page width and uses SpreeWe's colours (appearance variables).

## 3. Authorization considerations
- Events are invalidation signals. Data is always refetched through the REST API, which applies the caller's permissions, so a signal that reaches someone it shouldn't reveals only an ID.
- Audiences come from the database or from the socket's verified context. Roles on live sockets are refreshed on every change, so role-based audiences stay correct after a demotion.
- Removal: notice, then disconnect on every instance, plus cache invalidation everywhere. Team and channel removal: room eviction everywhere.
- The client never uses a token for a workspace other than the one it shows, and never trusts an event naming another organization.

## 4. Tests run (actual results)

| Suite | Result |
|---|---|
| Backend `tsc --noEmit` | pass |
| Backend Vitest, full | **224 / 224** passed |
| Backend new tests (`organizations-realtime.test.ts`, 5 added) | pass: all tabs in the org get member, role and profile signals, and a socket in another org gets none; a demotion applies to the live socket; a removed team member leaves the channel room; a removed member is told on the org tab and the personal tab |
| Mutation check | with room eviction disabled, the room test **fails** |
| Frontend `ngc` (strict templates) | pass |
| Frontend Karma, full | **77 / 77** passed |
| New specs | `rail-icons.spec.ts` (3: fails with the old rule); `workspace-sync.service.spec.ts` (event mapping, other-org events ignored, leaving on removal, server-disconnect re-check, reconnect refresh, cross-tab follow, token guard, **no sign-out on mismatch**, `ViewRefresher` coalescing, failure reload and teardown); `organizations.spec.ts` (live member list, one refetch for a mutation plus its echo, failed change, leave, live team page, archived team); `workspace-switcher.component.spec.ts` (SpreeWe list, live update, refused switch restores, accepted switch) |
| Production build | pass. `org-ui.scss` exceeds the 2 kB component-style **warning** budget, like 25 existing stylesheets |

**Flaky test:** `test/examples.test.ts` (developer examples end to end) failed once in a full backend run, waiting for an event, then passed alone twice and in the next full run. It doesn't touch the changed code paths. It's intermittent, not fixed.

## What was not verified
- **No browser or visual run on staging this time.** The staging harness (scripts and test-user credentials) lived in the session scratchpad and was deleted. Rebuilding it means resetting the staging Clerk test users' passwords, which needs your approval. Not checked in a real browser:
  - layout at desktop, tablet and phone widths in light and dark;
  - the Clerk screen's appearance on a legacy workspace;
  - real Clerk cross-tab behaviour;
  - the full two-user live flow.
- **Multi-instance delivery** of the new cluster messages (`workspace`, `membership`, `tenant`) is covered by code reading only. The tests run a single instance without the MongoDB adapter.

## Known limitations
- **Stale Clerk-only memberships in the switcher.** A Clerk-only membership of a *SpreeWe-managed* organization (left behind by a failed Clerk sync) still appears in the switcher's "managed in Clerk" group, because the client can't tell those apart from legacy workspaces. Choosing it is refused by the server, and the tab stays where it was.
- **Service worker updates.** In production builds the service worker keeps serving the old app code after a deploy until it updates; there is no update prompt yet.
- **Invitation expiry has no event.** Lists show "expired" from the date, and the server marks invitations expired on the next listing.
- **Not redesigned:** the create wizard, the invitation page, and the join page layout (the join page did get live sync).
- **Chat performance:** every channel message makes each member's open chat page re-fetch four lists. This is a performance issue found by the frontend reader and was not addressed.
- **Calls:** removal does not end an active channel call (needs a two-user call test).
- **Analysis coverage:** two of the six analysis readers (nav icons, test infrastructure) failed on a session limit. I covered both areas by hand; their independent review is missing.
