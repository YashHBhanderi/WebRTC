# Invitations and joining

There are five ways into a SpreeWe-managed organization. Each one is checked by the server against the organization's current settings.

| Way in | Needs | Works for private organizations? |
|---|---|---|
| Invitation link or in-app invitation | A pending, unexpired invitation addressed to one of the caller's **verified** emails | Yes |
| Approved join request | `discoverable` **and** `joinPolicy: "request"` | No |
| Join code / link | `joinCodeEnabled` and the correct code | Yes (that is its purpose) |
| Open join | `discoverable` **and** `joinPolicy: "open"` | No |
| Being made owner/admin/member by role change | Already a member | — |

Any other attempt is refused with the same generic 404, for example a join or request by organization ID against a private organization: *"Organization not found or not open for joining"* or *"…not accepting requests"*. The response does not reveal whether the organization exists.

`allowedEmailDomains`, when set, applies to every way in: invitations are refused per address (`domain_not_allowed`), and accepting, joining and requesting check the caller's verified emails.

## Invitations

### Creating
`POST /v1/workspace/invitations` with `{ emails: [...], role, expiresInDays? }`. It requires `members:invite`, and the role must be one the inviter may grant ([membership-and-permissions.md](membership-and-permissions.md)).
- 1–50 addresses per call; at most 500 pending invitations per organization.
- `expiresInDays`: 1–30, default 7.
- Each address gets a per-address result:
  - `invited`, with `link` and `emailed`;
  - `already_member`;
  - `domain_not_allowed`.
- **One pending invitation per (organization, email)** (unique partial index). Re-inviting the same address replaces the token, so the old link stops working, and increments `sentCount`.
- If the address belongs to an existing SpreeWe account, that user receives a real-time `org:invitation` event (no token in it).

### Token security
- Token: `inv_` followed by 32 random bytes in base64url (256 bits). **Only its SHA-256 is stored** (`tokenHash`, unique index), so a database read doesn't yield usable links.
- The link `APP_PUBLIC_URL/organizations/invitation?token=…` is returned **once**, to the inviter. It is not retrievable later; listing invitations never returns tokens or hashes.
- The invitation page removes the token from the address bar (`replaceUrl`) before calling the API, so it doesn't remain in history.

### Previewing and accepting
`POST /v1/organization-invitations/preview` and `POST /v1/organization-invitations/accept`, with `{ token }` or `{ invitationId }`. The `invitationId` form is used by the in-app list, which needs no token because the address match is the proof.

Checks, in order. Any failure returns the **same** 404, *"This invitation is invalid, expired or not for this account"*, so the response reveals neither whom an invitation is for nor whether it exists:
1. The token format, then a lookup by hash (or by ID): status `pending`, `expiresAt` in the future.
2. **Verified-email match.** The invitation's email must be one of the caller's **verified** email addresses in Clerk (`clerkClient.users.getUser`). An unverified address does not count. A stolen link used from a different account fails.
3. The organization is SpreeWe-managed and active.
4. On accept:
   - the domain allow-list and `guestAccess` (for guest invitations) are checked again;
   - an **atomic claim** sets `pending` → `accepted`, so two concurrent accepts produce exactly one membership (tested);
   - then a Clerk membership is added, then the local membership.
   - If Clerk or the local write fails, nothing is granted and the invitation is put back to `pending`, so it can be used once the problem is fixed (503 *"We couldn't finish joining…"*).

**New users:** someone without an account signs up through Clerk with the invited address, verifies it, then opens the link or finds the invitation under **Join organization → Invitations for you**. No pre-created account is needed, and none is created on their behalf.

**Replay:** once accepted, the same link returns the generic 404 (tested; also verified on staging).

### Managing
- **List:** `GET /v1/workspace/invitations?status=` (pending, accepted, revoked, expired). Expired pending invitations are marked `expired` when an admin lists them.
- **Resend:** `POST …/:invitationId/resend` issues a **new token**, so the old link stops working, and a new 7-day expiry. The new link is returned once.
- **Revoke:** `POST …/:invitationId/revoke`. Pending only; afterwards the link returns the generic 404.
- **Mine:** `GET /v1/me/organization-invitations` lists pending invitations addressed to my verified emails.

### Email delivery
No email provider is configured (owner decision for this phase). `webrtc-BE/src/organizations/mailer.ts` defines the plug-in point:

```ts
setInvitationSender({ name: "provider", async send({ to, organizationName, inviterName, role, link, expiresAt }) { /* … */ } });
```

`deliverInvitation` returns `emailed: true` only when a sender accepted the email. A delivery failure never fails the invitation: the inviter still gets the link.

The sender receives the plaintext link. A provider integration must not log it.

## Join requests
- **Ask:** `POST /v1/organizations/:organizationId/join-requests` with `{ message? }`.
  - Allowed only for discoverable organizations with `joinPolicy: "request"`; otherwise the generic 404.
  - Already a member → 409; one pending request per person per organization (unique partial index) → 409.
  - Domain allow-list enforced.
  - Owners and admins receive `org:join-request-created`, **only on their sockets in that organization**.
- **Decide:** `GET /v1/workspace/join-requests`, `POST …/:requestId/approve` or `…/reject`. Requires `requests:decide`.
  - An atomic claim on `pending` means two admins can't both decide.
  - Approval adds the Clerk membership, then the local one. On failure the request goes back to `pending` (503).
  - The requester receives `org:join-request` with the decision.
- **Mine:** `GET /v1/me/join-requests`; cancel with `POST /v1/me/join-requests/:requestId/cancel` (own pending requests only).

## Join codes
- `POST /v1/workspace/join-code` with `{ enable: true }` generates a new code; `{ enable: false }` disables it. Requires `joincode:manage`.
- The code is 10 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I), about 50 bits. Only its SHA-256 is stored.
- The response returns the code and a link (`/organizations/join?org=<id>&code=<code>`) **once**. Generating a new code invalidates the old one.
- Joining (`POST /v1/organizations/:organizationId/join` with `{ code }`) compares hashes in constant time. A wrong code returns the same generic 404 as any refused join.
- The route is `sensitive`, so it is rate limited per IP.

Codes are a **shareable secret**: anyone holding a valid code can join as a member. Rotate the code when it leaks.

## Open join
`POST /v1/organizations/:organizationId/join` with no code, for discoverable organizations with `joinPolicy: "open"`. The caller becomes a member; the domain allow-list is enforced.

## Discovery
`GET /v1/organizations/discover?q=` lists only organizations with `settings.discoverable: true` and `status: "active"`, with the caller's status for each (`member`, `requested`, `none`). It never returns private organizations, member lists or member counts.

## Audit
Every step writes `org_audit_events`:
- `invitation.created`, `invitation.resent`, `invitation.revoked`, `invitation.accepted`;
- `join_request.created`, `join_request.approved`, `join_request.rejected`;
- `member.joined`, `joincode.rotated`, `joincode.disabled`.

Audit entries never contain tokens or codes.
