# Developer platform security

Code: `webrtc-BE/src/developer/*`, `src/api/v1/registry.ts`, `src/api/v1/developer.routes.ts`, `src/realtime/index.ts`. Tests: `test/developer-platform.test.ts`, `test/examples.test.ts`.

## Trust model

| Actor | Authenticates with | Can |
| --- | --- | --- |
| SpreeWe user (first party) | Clerk session | Everything they could before; manage the apps they own; grant or withdraw apps |
| App owner | Clerk session, in the app's own context | Configure their app, create/rotate/revoke credentials, see usage and audit |
| Platform admin (`PLATFORM_ADMIN_CLERK_IDS`) | Clerk session | List app metadata, suspend/reactivate apps. **No** access to credentials, grants or any tenant content |
| App backend | App credential (`Basic keyId:secret`) | Exchange for user tokens of users who granted the app; revoke its own tokens |
| App frontend (browser/mobile) | Short-lived user token | `/v1` routes covered by the token's scopes; a restricted Socket.IO connection |

**Developers cannot choose identities.**
- A token is issued only for a user who granted the app themselves, from their own signed-in SpreeWe session (`POST /v1/apps/{appId}/grants`).
- The app's server identifies that user by SpreeWe user id, or by the `externalUserRef` the user consented with.
- An unknown user and a user who never granted the app get the same `403`, so the endpoint can't be used to enumerate users.

## Application and tenant binding

| App type | Created by | Grant from | Token context | Reaches |
| --- | --- | --- | --- | --- |
| Global (`tenantId: null`) | Any user, from their personal (global) context | Personal context | Global | Global data visible to that user (incl. external chats they're a guest in) |
| Workspace-owned | Workspace owner/admin, from inside the workspace | Inside that workspace (members only) | That workspace only | That workspace's data visible to that user |

- No endpoint takes a tenant id. Unknown fields are rejected, and `tenantId` in a token request is a `400`.
- **Workspace-app tokens require the user to be an active member at every request.** Removal or a deleted/suspended tenant invalidates them (`assertActiveTenantMember`).
- App tokens carry role `member`, never workspace admin rights. Workspace administration, policies, external-chat creation and app management are first-party only.

## Credentials

| Property | Implementation |
| --- | --- |
| Generation | `crypto.randomBytes`: 96-bit public key id (`swk_test_…` / `swk_live_…`), 256-bit secret (`sws_…`) |
| Storage | SHA-256 hash only, optional server pepper `APP_CREDENTIAL_PEPPER`. A fast hash is enough for 256-bit random secrets |
| Disclosure | The secret is returned once, in the create/rotate response. Never listed, never logged, never in audit details |
| Comparison | Timing-safe. Every failure is the same `401` (no "key exists" oracle) |
| Expiry | `expiresInDays` (1–365, default 180) |
| Rotation | New secret immediately. The old one stays valid for `APP_CREDENTIAL_ROTATION_GRACE_SECONDS` (default 3600, max 86400, `0` = immediate), then it is refused |
| Revocation | Immediate |
| App suspended/revoked | All credentials refused (`403`) |

**High-impact actions** (create/rotate/revoke credential, revoke app, revoke all tokens) require:
- `confirm` = the app's exact name, and
- when the Clerk session carries `fva`, a first-factor verification within the last 10 minutes.

**CSRF:** `/v1` writes authenticated by cookie only (a `Cookie` header and no `Authorization` header) are refused. First-party clients send the bearer header.

## User tokens

- **Format:** HS256 JWS signed with `PLATFORM_TOKEN_SECRET`, which is server-only and shared by all instances. Header `{alg:"HS256", typ:"JWT", kid:"spreewe-app-v1"}`; any other header is rejected, including `alg:none`.
- **Claims:** `iss=spreewe`, `aud=spreewe:app:<appId>`, `sub` (SpreeWe user), `app`, `env`, `tid` (tenant or null), `scp`, `jti`, `iat`, `exp`, `tv` (app token version), `gid`/`gv` (grant id and version).
- **Lifetime:** default 600 s (`APP_TOKEN_DEFAULT_TTL_SECONDS`), at most 900 s (`APP_TOKEN_MAX_TTL_SECONDS`, cap 3600). Clock skew of 30 s is allowed on `iat` only.
- **Checked on every request:**
  1. signature, issuer, audience, lifetime;
  2. app active, same environment, same token version;
  3. grant active, same version, same user and app;
  4. `jti` not revoked;
  5. user not deleted or banned in Clerk;
  6. tenant binding equals the app's binding, and the user is an active member;
  7. browser `Origin` is in the app's `allowedOrigins`.
- **Effective scopes = token ∩ grant ∩ app**, re-evaluated each request. Removing a scope from the app or grant takes effect immediately; it never widens.

**Revocation strategy:**

| Scope | How |
| --- | --- |
| One token | App server: `POST /v1/app-tokens/revoke` (denylist entry until the token would expire) |
| One user's tokens for an app | User withdraws consent (grant version bump) |
| All of an app's tokens | Owner: `POST /v1/apps/{id}/tokens/revoke-all` (token version bump); also app revoke |
| Temporarily | Suspend the app |
| By membership | Workspace removal, organization deletion, Clerk user deletion or ban |

All of these are checked against MongoDB, so they apply on every instance at once. App sockets are re-checked by the revalidation sweep (`SOCKET_REVALIDATE_MS`), and app sockets are always closed when their token expires.

## Scopes (least privilege; nothing by default)

`profile:read`, `directory:read`, `conversations:read`, `messages:read`, `messages:write` (text only, Socket.IO), `calls:read`, `recordings:read`, `realtime:connect`.

**Not available to apps at all:**
- calls and media;
- group management;
- uploads and file sending;
- recording control and transcription jobs;
- workspace administration;
- app management.

## Socket.IO for apps

- **Handshake:** requires `realtime:connect` and passes the same token checks as REST, including origin.
- **Isolation:** app sockets never take over the user's own SpreeWe connection, never register presence or call handlers, and never join rooms (so room broadcasts can't reach them).
- **Inbound:** only `sendMessage`, with `messages:write`, text only, counted against the daily message quota. Everything else is refused.
- **Outbound:** only `receiveMessage`, `message:updated`, `message:deleted` (`messages:read`), `user:presence` and `rate-limited` (`realtime:connect`). Presence follows the visibility rules.
- **Expiry:** closed when the token expires; the client reconnects with a fresh token.

## Rate limits and quotas

| Limit | Key | Where enforced | Across instances? |
| --- | --- | --- | --- |
| HTTP per IP (`RATE_LIMIT_MAX`) | IP | in memory | **No**, per instance |
| HTTP per app (`quotas.rateLimitPerMinute`) | app | in memory | **No**, per instance (N instances allow up to N×) |
| Token exchange per credential (`APP_CREDENTIAL_RATE_PER_MIN`, default 120) | key id | in memory | **No** |
| Socket events per user / per app user | user, app+user | in memory, shared by all of that user's connections | **No** |
| App socket connections (`quotas.maxConnections`, 5 per app user) | app, app+user | in memory | **No** |
| Messages per day (`quotas.messagesPerDay`) | app + UTC day | **MongoDB, atomic conditional update** | **Yes** |
| Usage counters (requests, tokens, messages, connections) | app + day | MongoDB `$inc` (best effort, never blocks) | Yes (counts) |

Development apps have lower caps: 120 requests/min, 20 connections, 2000 messages/day.

Not exposed to apps, so there are no app quotas for: uploads and storage, call participants and media sessions, recording and transcription workloads.

## Audit

`app_audit_events` records actor, kind (owner, platform-admin, user), action and non-secret details for:
- `app.created`, `app.updated`, `app.suspended`, `app.reactivated`, `app.revoked`;
- `credential.created`, `credential.rotated`, `credential.revoked`;
- `tokens.revoked_all`;
- `grant.updated`, `grant.revoked`.

Owners and platform admins can read it at `GET /v1/apps/{id}/audit`.

## Verified (tests) / not verified

Verified in the test suite, with 11 negative checks each disabling one protection:
- secrets stored only as hashes and never listed;
- ownership 404s;
- confirmation, re-auth and CSRF guards;
- cross-app credential isolation;
- rotation grace and immediate revocation;
- suspension and revocation;
- platform-admin limits;
- grant-only issuance and no impersonation;
- tampered, `alg:none`, expired, revoked and wrong-scope tokens;
- scope shrink, revoke-all and consent withdrawal;
- origin allow-list;
- workspace-app isolation and membership revocation;
- app sockets: scopes, text only, quota, event filtering, connection cap, shared budget, suspension sweep;
- quota under concurrency;
- the published examples end to end.

**Not verified:** real Clerk sessions (the `fva` claim's presence and format in your Clerk configuration), multi-instance behaviour, load, and production secrets management.
