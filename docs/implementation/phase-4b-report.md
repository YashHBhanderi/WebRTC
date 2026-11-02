# Phase 4B report: developer platform, scoped tokens, remaining isolation risks

Scope: `webrtc-BE`, plus `docs/`. No deployment, no real database touched, no Clerk configuration changed, nothing committed, no files deleted. **Not production-ready:** real-service and deployment checks have not been performed (see "Remaining real-service tests").

## Priority 0: known risks

| Risk | Finding | Fix | Tests |
| --- | --- | --- | --- |
| **A. Public `/uploads`** | `express.static` served 117 legacy files (87 jpg, 19 png, 4 pdf, 4 mp4, 3 jfif) to anyone, including private attachments. Nothing writes there any more; old messages may still link to them | Public route removed. Files are served only with an HMAC-signed, expiring link for that exact name (`LEGACY_FILES_SECRET`, default TTL 900 s). Links are minted only when a message referencing the file is returned to an authorized reader. Non-media files are forced to download, with `nosniff`. Nothing deleted | Anonymous, unsigned, forged, expired, cross-file and traversal requests all 404; member gets a working link; outsiders, other tenants and wrong contexts get none |
| **B. External conversations** | Records of external chats (messages, calls, notifications…) were visible from any context, filtered only by user. Guests saw external chats inside their own organization's workspaces | Host members: host workspace only. Guests: personal context only. Records carry `guestUserIds`. The consistency checker covers guest lists, and migration `2026-10-22` backfills them | REST, search, notifications, call history and socket delivery; see `docs/security/external-conversation-isolation.md` |
| **C. Shared presence** | Presence went to every co-member in any context | Delivered per socket, only if the viewer's current context shares a visible conversation with the person or lists them in its directory | Global socket gets no presence for a workspace-only contact; workspace socket does |
| **D. Multi-instance revocation** | 15 s per-instance cache; webhook disconnects only on the receiving instance | `MEMBERSHIP_CHECK_CACHE_MS` (0 = read MongoDB on every request: immediate on all instances). A per-instance revalidation sweep (`SOCKET_REVALIDATE_MS`, default 30 s) disconnects live sockets whose membership or tenant (or app token) is no longer valid. **No Redis.** With the default cache, cross-instance revocation of new requests can lag up to 15 s, and live sockets up to the sweep interval | Removal written "by another instance" → sweep disconnects; cache 0 → immediate 403 |

Two further bugs were found and fixed:
- **Validator defaults (Phase 4A bug):** optional fields with defaults were ignored when absent, so `limit` was undefined on list endpoints. Regression test added.
- **First-time member cache (pre-existing):** `resolveContext` cached "no membership" for a first-time member for 15 s.

## Developer platform design

### Models

All are platform-level, in `src/developer/models.ts`, and are authorized explicitly in the service, not by tenant scope.

| Model | Purpose |
| --- | --- |
| `developer_apps` | Owner, optional tenant binding, environment, status, maximum scopes, origins, callbacks, quotas, `tokenVersion` |
| `app_credentials` | Public key id, SHA-256 secret hash, hint, status (active/rotated/revoked), `graceUntil`, `expiresAt` |
| `app_grants` | User consent: app, user, tenant, scopes, `externalUserRef`, status, version |
| `revoked_app_tokens` | `jti` denylist with a TTL at token expiry |
| `app_usage` | Per app per UTC day: API requests, tokens issued, messages sent, socket connections |
| `app_audit_events` | Sensitive management actions; no secrets |

### Lifecycle

- **Credential:** created (shown once) → active → rotated (valid until grace end) or revoked; expires after 1–365 days.
- **Token:** issued (10 min default, 15 max) → checked on every request against signature and live state → ends by expiry, `jti` revocation, grant version bump, app token version bump, suspension, or membership loss.

### Authorization rules

- **Management:** owner in the app's own context. Workspace apps also require the owner/admin role. Platform admins get metadata and suspend/reactivate only. Everyone else gets 404.
- **Identity:** tokens only for users who granted the app themselves. Scopes ⊆ grant ∩ app. Tenant = the app's binding; never from a request.
- **API:** every `/v1` route declares an auth mode. App tokens are accepted only where a route names a scope. First-party-only routes (workspace administration, policies, external-chat creation, app management, consent) refuse them; legacy routes refuse them (401).
- **CSRF:** cookie-only `/v1` writes are refused.
- **High-impact actions:** confirmation by app name, plus a recent sign-in when Clerk `fva` is present.

Full details: `docs/security/developer-platform-security.md`.

### Management API (`/v1`)

| Area | Endpoints |
| --- | --- |
| Apps | `POST /apps`, `GET /apps`, `GET /apps/{id}`, `PATCH /apps/{id}`, `POST /apps/{id}/suspend`, `/reactivate`, `/revoke`, `/tokens/revoke-all`, `GET /apps/{id}/usage`, `/audit` |
| Credentials | `GET`/`POST /apps/{id}/credentials`, `.../{credentialId}/rotate`, `.../revoke` |
| Consent | `POST /apps/{id}/grants`, `GET /me/app-grants`, `DELETE /me/app-grants/{grantId}` |
| Token exchange | `POST /app-tokens`, `POST /app-tokens/revoke` |
| Platform admin | `GET /admin/apps` |

**Webhook configuration for apps: not implemented** (outbound webhooks are a later phase).

## Files

New:
- `src/developer/{models,scopes,tokens,app.service}.ts`
- `src/api/v1/developer.routes.ts`
- `src/services/legacy-files.service.ts`
- `src/realtime/revalidate.ts`
- `test/{p0-isolation,developer-platform,examples}.test.ts`
- `docs/integrations/examples/backend/{spreewe-server-client,server}.ts`, `docs/integrations/examples/frontend/spreewe-browser-client.ts`
- `docs/security/developer-platform-security.md`, `docs/security/external-conversation-isolation.md`
- `docs/integrations/developer-app-registration.md`, `docs/integrations/scoped-user-tokens.md`
- this report

Changed:
- `src/api/v1/{registry,routes,schema,openapi}.ts`
- `src/tenancy/{context,scope,tenant.service,consistency}.ts`
- `src/realtime/{index,io,rate-limit}.ts`
- `src/services/{presence,notification,file}.service.ts`
- `src/middleware/authMiddleware.ts`
- `src/config/security.ts`
- `src/migrations/index.ts`
- `src/app.ts`, `src/server.ts`
- `test/{helpers,api-v1.test,security-config.test}.ts`, `test/setup/env.ts`
- `docs/api/openapi.yaml` (regenerated)

No new dependencies.

**Migrations added** (run only in the in-memory test database; not run anywhere real):
- `2026-10-22-external-guest-lists`: guest-list backfill and scope repair.
- `2026-10-23-developer-platform`: indexes; the unique ones carry correctness.

## Verification

| Check | Result |
| --- | --- |
| Tests (`npm test`) | **95 passed, 0 failed, 0 skipped** (12 files; 63 before this phase, 32 new) |
| Type-check | exit 0 |
| Build (to a temp folder) | exit 0 |
| Examples | Type-checked under `strict`. The server client and browser client run end to end against the in-process server (`examples.test.ts`). `server.ts` is type-checked only |
| OpenAPI | Regenerated from the registry; the sync test passes; parsed back with `js-yaml` and deep-equal to the generated object; 30 operations over 27 paths, **0 without a security requirement**; three schemes (`clerkSession`, `appUserToken`, `appCredential`) |
| Negative checks | 11 protections disabled one at a time, **all detected**, all files restored byte-identical |
| Static checks | No raw-driver or `$lookup` bypasses (existing static test); no leftover mutation markers |

The 11 protections checked: unsigned legacy files; guests in any context; external records globally visible; presence to all contacts; scope check; scope elevation at exchange; workspace-app membership; suspended apps; rotated credentials never expiring; app sockets receiving all events; per-socket instead of per-user budget.

**Flake found and fixed:** a quota test assumed asynchronous checks run in send order. The test was fixed, and the quota logic was hardened so it no longer depends on a unique index existing. A concurrency test (10 parallel sends against a quota of 3 → exactly 3) was added.

## Remaining real-service tests (not executed)

- **Clerk:** real sessions, and whether your Clerk configuration emits `fva` (without it, re-auth falls back to confirmation only); real webhook delivery; organization switching.
- **S3:** presigned URLs for message files and recordings in external and cross-tenant scenarios.
- **FFmpeg / recordings / transcription** under fail-closed rules.
- **A real mediasoup worker:** media is not offered to apps, but first-party calls still need real verification.
- **Load:** many app sockets, quota contention.
- **Multiple instances:** per-instance rate limits and connection caps, revalidation-sweep timing, legacy-file signing with a shared secret.
- **Production secrets management** and secret rotation runbooks.
- **Frontend:** consent screen, workspace switcher (Phase 6).

## Environment variables

**Required in production** (the server refuses to start without them):

| Variable | Notes |
| --- | --- |
| `PLATFORM_TOKEN_SECRET` | 32+ characters, same on every instance |
| `LEGACY_FILES_SECRET` | 32+ characters, same on every instance |
| `CORS_ORIGINS` | From Phase 2–3 |

**Optional:**

| Variable | Default |
| --- | --- |
| `LEGACY_UPLOADS_DIR` | `src/uploads` |
| `LEGACY_FILE_URL_TTL_SECONDS` | 900 |
| `MEMBERSHIP_CHECK_CACHE_MS` | 15000 |
| `SOCKET_REVALIDATE_MS` | 30000 |
| `APP_TOKEN_DEFAULT_TTL_SECONDS` | 600 |
| `APP_TOKEN_MAX_TTL_SECONDS` | 900 |
| `APP_CREDENTIAL_ROTATION_GRACE_SECONDS` | 3600 |
| `APP_CREDENTIAL_PEPPER` | (none) |
| `APP_CREDENTIAL_RATE_PER_MIN` | 120 |

**Operational note:** in production the legacy files live outside `dist/`. Set `LEGACY_UPLOADS_DIR` to wherever they are actually kept, or legacy links will 404. That may already be the case today.

## Manual configuration

**Clerk** (unchanged from 4A):
1. Confirm Organizations is on your plan.
2. Set up webhooks and `CLERK_WEBHOOK_SIGNING_SECRET`.
3. Check whether session tokens include `fva`; it is used for re-authentication.

**Deployment** (to be decided by your platform team):
- Store and rotate `PLATFORM_TOKEN_SECRET`. Rotating it invalidates all app tokens (acceptable at ≤15 min lifetimes).
- Decide on `MEMBERSHIP_CHECK_CACHE_MS=0` if you run several instances and need immediate revocation.

## Recommended next phase

1. **Staging verification with real services:** Clerk sessions, `fva` and webhooks; S3; FFmpeg; mediasoup. Run all four new migrations on a copy of production data and check their ledger output.
2. **A second-person security review** of `src/developer/*`, `src/api/v1/registry.ts`, `src/realtime/index.ts` (app sockets) and `src/services/legacy-files.service.ts`.
3. **Phase 6 frontend:** consent screen (`POST /v1/apps/{id}/grants`), app management UI, workspace switcher.
4. **Outbound webhooks for apps,** signed with delivery logs, once the review is done.
5. **Redis-backed rate limits, connection caps and revocation broadcast,** only when a multi-instance deployment is scheduled.
