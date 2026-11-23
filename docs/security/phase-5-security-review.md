# Phase 5 security review (P0 audit before Phase 4C / 5A)

Method:
1. Read the enforcement point in code for each of the 12 mandatory areas.
2. Write an attack test where the area was not already covered.
3. Fix confirmed issues.
4. Disable each fix (mutation check) and confirm a test fails.

"Fixed" below means fixed in code and locally tested. Nothing here has been verified against production services.

## Confirmed vulnerabilities (fixed)

| # | Severity | Finding | Fix | Regression test |
|---|---|---|---|---|
| F2 | **High** | **Account-link injection.** In 4B, the user's own client sent `externalUserRef` when granting an app. A user could set someone else's external id, so the app's server would then mint tokens for the attacker's SpreeWe account while acting for the victim (or the reverse). | `externalUserRef` is now set only in a consent request created by the app's server with its credential. The user approves on a SpreeWe page. The redirect URI must exactly match a registered callback. The request is single use (atomic claim), expires after 10 minutes, and is bound to the user's context. `POST /v1/apps/:id/grants` no longer accepts `externalUserRef`. See [../integrations/user-consent.md](../integrations/user-consent.md). | `p5-security.test.ts` (F2 group) |
| F1 | Medium | **Sensitive data in logs.** Error paths logged query strings (tokens), Mongo duplicate-key values (emails), validation messages echoing input, and message bodies. | `installSafeConsole()` runs at startup and redacts Bearer tokens, JWTs, `sws_`/`whsec_`/`swh_` secrets, query strings, dup-key values, quoted values and emails, then truncates to 2,000 characters. `sendError` logs the path only. This is defence in depth: code should still avoid logging sensitive data. | `p5-security.test.ts` (F1) |
| F3 | Medium | **Credential rotation race.** Concurrent rotations of the same credential could each create a new live secret. | Atomic claim of the old credential (`findOneAndUpdate` on `status:"active"`) before creating the new one. Losers get 404. | `p5-security.test.ts` (F3) |
| F4 | Medium (operational) | **CORS blocked developer browser apps**, which pushes operators toward `CORS_ORIGIN=*`. | App-registered origins are allowed **only** on `/v1` and Socket.IO, never with credentials. The list is cached for 60 s and cleared on app change. First-party origins are unchanged. | `p5-security.test.ts` (F4) |
| F5 | Medium | **Unbounded resources**: apps per owner, credentials per app, webhook endpoints per app. | Caps: 25 apps, 5 active credentials, 5 endpoints. Webhooks also have queue and in-flight caps. | `p5-security.test.ts` (F5) |

Also added: workspace owners and admins can suspend or reactivate apps bound to their workspace and withdraw all members' grants. This gives a tenant a kill switch without platform staff.

## The 12 mandatory checks

| Area | Result |
|---|---|
| Tenant isolation | No new issue. Webhook fan-out applies the same `visibleIn` rule plus grant-tenant and membership checks. Covered by tests. |
| Fail-closed context | No new issue. New services run queries inside `runAsSystem` with a reason; webhook publishing never runs in a request's context. |
| External conversations | No new issue. Webhooks: global apps receive external-chat events only for the guest. UI: chat list shows an **External** badge (`scope === 'external'`). |
| Legacy files | No change; not moved or deleted. |
| Developer tokens | F2 and F3 fixed. `lastUsedAt` is now tracked on grants. |
| Developer sockets | No new issue; app-origin CORS is now explicit (F4). |
| Clerk webhooks | No new issue found (Svix verification, idempotent event log from 4A). |
| CSRF / CORS | No cookies are used for auth (Bearer tokens), and CORS never sends credentials, so classic CSRF does not apply. F4 is fixed. High-impact developer actions require typing the app name (`confirm`). |
| Input validation | All new routes use the registry validator. Webhook URLs are SSRF-validated, and events are limited to the app's scopes. |
| Resource exhaustion | F5 is fixed. Webhook limits: 64 KB payload, 10,000 pending per app, 5 in flight per app, 4 KB response read, 10 s timeout. |
| Secrets and logging | F1 is fixed. Webhook secrets are AES-256-GCM encrypted; `WEBHOOK_SECRET_KEY` is required in production. |
| Race conditions | F3 is fixed. Consent decisions and webhook-secret rotation use compare-and-set. Deliveries are unique per (endpoint, event) and use lease claims. |

## Remaining risks (not fixed)

- **Rate limits are per instance** (in-memory) except the daily message quota. Multiple instances multiply the per-minute limits. Making them global would need shared state; no demonstrated need yet.
- **The log redaction is pattern-based.** It cannot catch every sensitive value, such as free-text content that matches none of the patterns.
- **The webhook worker has no network-level egress filter.** Application-level SSRF controls exist; an infrastructure egress policy is recommended (owner: DevOps).
- **The Clerk organization APIs used by the frontend** (`getOrganizationMemberships`, `setActive`, `mountOrganizationProfile`) are unverified against the live Clerk instance.
- **Consent screen UX** (phishing resistance, how clearly the app name and host are shown) has not been reviewed by a designer or with users.
