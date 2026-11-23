# Contact discovery, external communication and organization navigation

Date: 2026-10-28.

**Status:** implemented with automated tests. Nothing is deployed or committed, and no production configuration or data was touched. Browser checks on staging were not run (see [Not verified](#not-verified)).

## 1. What was wrong (confirmed in code)

| Area | Finding |
|---|---|
| **Personal directory** | `GET /web/users/except-current` (chat Contacts, calls, global search, meeting editor), `GET /web/users`, `/v1/directory` and people search all returned **every user who hadn't opted out of discovery** (`globalDiscoverable`): a public directory. Every new account was also broadcast live to everyone online in the personal context (`user:created`). |
| **Starting chats** | `POST /conversations {receiverId}` opened a chat with **any user ID** in the personal context, with no blocking or privacy check. |
| **Public profiles** | In the personal context, `GET /web/user/:id` and presence were visible for any discoverable account by ID. |
| **External chats** | Already policy-checked and correctly scoped (`createExternalConversation`), but they took a user ID, so finding the person depended on the directory. |
| **Invitations** | Already **domain-independent** unless an organization sets `allowedEmailDomains`. All failures returned one generic message, so the invitee couldn't tell expired, revoked, used or wrong-account apart. |
| **Duplicate navigation** | The account menu had **Workspace** (`/workspace`). The workspace popup had *Organization home*, *Organization settings*, *Create* and *Join*. Organization home had *Invite*, a settings icon and *Manage members*. Settings had separate *Invitations*, *Join requests*, *Ownership* and *Audit* tabs. |

## 2. Contact discovery

### Personal context
- **No directory.** The people list, people search, profiles and presence cover only people I **already share a conversation with**. The `user:created` broadcast is removed.
- **Finding someone new** is by **exact email** only, in **New chat** (chat sidebar icon, menu item, or the empty-state button) or by typing an email into the global search ("Find name@…").
- **Lookup** is `POST /v1/contacts/lookup {email}`; the email goes in a POST body, never in a URL or access log. The server:
  - normalizes the address (trim, lowercase) and validates it;
  - rate-limits **per user**: `CONTACT_LOOKUP_PER_10MIN`, default 30 per 10 minutes, **per instance**; the route is also `sensitive` (per-IP limit);
  - returns only `{_id, username, avatar}`, **never an email**, and the existing direct conversation if there is one.
- **One neutral answer.** Unregistered, blocked either way, opted out (`globalDiscoverable: false`), deleted, banned and your own address all receive the **same** response: `{found: false, message: "No eligible account found for this email."}`.
- **Starting a chat** is `POST /v1/contacts/start {email}`. The server **re-runs** the eligibility check and opens or reuses the one direct conversation. The client never supplies the recipient's ID.
- **`POST /conversations {receiverId}`** (the existing path) now refuses a *new* chat with:
  - a blocked pair (403);
  - in the personal context, someone who opted out, or a deleted or banned account (404).

  Existing chats stay reachable, for example to unblock someone.

### Organization context
- **Members:** `scope: "member"` (default) finds **active members of the verified active organization** by exact email. Guests only reach people they already share a conversation with. Members of other organizations get the neutral answer. Username search inside the organization works as before (`/search`, `/v1/directory`).
- **External people:** `scope: "external"`. The server checks:
  - the caller is a member of the active organization;
  - the organization's `allowExternalChat` policy, plus `membersCanStartExternal` for non-admins, else **403**: *"This organization's policy does not permit starting external conversations."*;
  - the recipient is eligible (same rules as personal) and not blocked.

  The conversation is created by the existing `createExternalConversation`: `scope: "external"`, `tenantId` of the organization, `externalParticipants: [them]`.
- **No duplicates:** an external search that matches a *member* returns them as an internal contact.
- **External badge:** shown in the conversation list (existing), the **conversation header** (new), and the New chat result card.
- **Isolation (unchanged):** an external participant sees only that conversation. They have no access to the organization, its member list, teams, channels or directory (tested).

The organization a lookup runs in is always the **verified session context**. No organization or recipient ID is accepted from the client.

## 3. Invitations across email domains
- Any address can be invited (gmail.com to Acme, or a member of one organization to another), unless the organization **restricts domains** with `allowedEmailDomains`. That policy still applies and is never overridden by an invitation.
- **Acceptance** requires one of the caller's **verified** Clerk emails to equal the invited address, plus a **single-use atomic claim**, the expiry check, and the invitation's role only (extra fields are rejected). After acceptance, membership is created in Clerk and MongoDB with compensation, and the new organization appears live in the switcher and on **Account & organizations**.
- **Clear states:**

  | Case | Response |
  |---|---|
  | Invalid or unknown link | 404 *"This invitation link isn't valid…"* (generic) |
  | Another account | 403 *"This invitation was sent to a different email address. Sign in with the invited address (verified)…"* (the address is **never** named) |
  | Already used, including losing a concurrent accept | 410 |
  | Revoked | 410 |
  | Expired | 410 |

  The precise reasons are given **only** to the addressee.

## 4. Navigation: one destination per function

| Function | Canonical route | Entry points |
|---|---|---|
| **Account & organizations**: account, my organizations (switch, open), create, join, invitations for me, my join requests | `/account` (new) | account menu (replaces **Workspace**); workspace popup "Account & organizations" |
| Organization home (overview, teams, people) | `/organization` | **Teams** in the rail; "Home" on Account & organizations |
| Organization settings | `/organization/settings` | "Settings" on the organization home and on Account & organizations |
| Members and roles, **Invite**, invitations, join requests | `/organization/settings?tab=members` (`&invite=1` focuses the invite form) | `/organization/members` and `/organization/invitations` **redirect** here; "Invite" on the home goes here |
| Team pages | `/teams/:teamId` | home, and the settings **Teams & channels** section |
| Workspace switching | top-bar switcher (kept), plus "Switch" on Account & organizations | both use one function, `pages/shell/workspace-switch.ts` |

- **Settings sections:** General (includes *Leave*), Members & roles (members, invite, invitations, join requests), Teams & channels, External communication, Privacy & discovery, Administration (ownership, deletion, audit). Old `?tab=invitations|requests|ownership|audit` links still open the section that now holds them.
- **Removed duplicates:**
  - account menu **Workspace**;
  - popup *Organization home*, *Organization settings*, *Create organization* and *Join organization* (now on Account & organizations);
  - home *Manage members*;
  - the unlabeled settings icon (now a "Settings" button);
  - separate Invitations, Join requests, Ownership and Audit tabs.
- **`/workspace` still exists** for Clerk-managed (legacy) workspaces and developer **Workspace apps**, and is linked from Account & organizations for a legacy active workspace.
- **Route shape: a deliberate choice.** The proposed `/organizations/:organizationId/...` routes were **not** adopted. Management always applies to the **verified active organization**, so an organization ID in the URL would add a second, client-chosen source of "which organization", which the security rules forbid trusting. Switching is the one way to change it.

## 5. Tests executed (actual results)

| Suite | Result |
|---|---|
| Backend `tsc --noEmit` | pass |
| Backend Vitest, full | **232 / 232** passed |
| … new `test/contacts.test.ts` (8) | personal email lookup (case-insensitive, minimal fields, no email echoed, reuse of one chat); identical answer for unregistered, blocked-either-way, opted-out and own address; API can't bypass (`/v1/contacts/start`, `/conversations`); validation and **per-user rate limit**; personal list, search and profile limited to existing contacts; members found only in the active organization; external refused when policy is off and for plain members, allowed when on, member-via-external de-duplicated, conversation scope `external` with the right participants, outsider has no organization access; gmail.com joins Acme, a member of one organization joins another, domain restriction still enforced; invitation role can't be escalated, single use |
| … updated tests | invitation states (403 wrong account, 410 used, revoked, expired); personal profiles not public (`tenant-isolation.test.ts`) |
| OpenAPI | regenerated; Spectral `spectral:oas`: 0 findings |
| Frontend `ngc` | pass |
| Frontend Karma, full | **85 / 85** passed |
| … new `contact-and-navigation.spec.ts` (8) | New chat: invalid email (no request), found and start (navigates by ID), neutral not-found, external scope and badge, policy refusal, rate-limit message. Account & organizations: lists and marks the active organization, links to canonical home and settings, switch uses the safe reload. Router: `/account`, member and invitation redirects to the one settings page |
| Production build | pass (existing style-budget warnings only) |

## Not verified
- **No browser run on staging.** The staging harness was lost with the earlier scratchpad, and rebuilding it means resetting staging Clerk test-user passwords, which needs approval. Layout at desktop, tablet and phone widths, and the end-to-end flows in a real browser, are untested.
- **The lookup rate limit is per instance** (in memory). With several instances the effective limit multiplies; the per-IP `sensitive` limiter also applies.

## Known limitations
- **Inherent to email search:** anyone who knows an address can learn that *an eligible account* exists for it (that's the feature). Rate limits and the uniform answer limit bulk enumeration, and opting out (`globalDiscoverable: false`) hides the account from lookups entirely.
- **Narrower pickers:** in the personal context, group, call and meeting pickers now show only existing contacts; a new person is reached through New chat first.
- **No invitations to unregistered addresses** for personal chats (no supported invitation feature exists); the lookup says no eligible account was found.
- **Not redesigned:** the create wizard, join page and invitation page keep their current layout.
