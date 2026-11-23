# Phase 4C + 5A report

Date: 2026-10-22. Status: implemented and locally verified. **Not deployed and not production-verified.** No production database, live Clerk configuration or production credentials were touched. No legacy files were moved or deleted.

## 1. Vulnerabilities fixed (P0 audit)

Details are in [../security/phase-5-security-review.md](../security/phase-5-security-review.md).

| # | Severity | Issue | Status |
|---|---|---|---|
| F2 | High | Account-link injection through user-supplied `externalUserRef` | Fixed: server-initiated, single-use consent requests |
| F1 | Medium | Tokens, emails, query strings and content in logs | Fixed: global redaction (defence in depth) |
| F3 | Medium | Concurrent credential rotation created two live secrets | Fixed: atomic claim |
| F4 | Medium | CORS pushed operators toward `*` | Fixed: app origins only on `/v1` and socket, never credentialed |
| F5 | Medium | Unbounded apps, credentials and endpoints | Fixed: caps of 25, 5 and 5 |

## 2. Phase 4C: outbound webhooks

See [../integrations/outbound-webhooks.md](../integrations/outbound-webhooks.md) and [../security/outbound-webhook-security.md](../security/outbound-webhook-security.md).

- **Events:** six types, each gated by the app's scopes and the user's grant.
- **Isolation:**
  - tenant, global and external audiences;
  - active-membership re-check;
  - minimal payload (text capped at 4,000 characters, no URLs).
- **Network safety:**
  - SSRF checks: IPv4 and IPv6, embedded IPv4, alternate forms, ports, internal names;
  - DNS pinning at connect time;
  - redirects refused;
  - 10 s timeout and 4 KB response read.
- **Delivery mechanics:**
  - HMAC-SHA256 signatures with a timestamp and delivery id;
  - multi-signature during secret rotation;
  - idempotent (endpoint, event) rows;
  - lease-based worker;
  - backoff with jitter;
  - dead letter after 8 attempts, with manual retry;
  - auto-disable after 15 consecutive failures, recovered by re-enable plus re-verify.
- **Limits:** 64 KB payload, 10,000 pending and 5 in flight per app.
- **Secrets:** encrypted at rest with `WEBHOOK_SECRET_KEY`.
- **Chat is never blocked:** publishing is deferred and swallows errors.
- **Infrastructure:** the queue is MongoDB-backed. No Redis or new infrastructure was added, because the existing MongoDB with leases covers it at current scale.

## 3. Phase 5A: Angular UI

New screens:

| Route | Component | Purpose |
|---|---|---|
| `/consent?request=` | `ConsentPageComponent` | App, owner, environment warning, return host, per-scope opt-in (nothing pre-ticked), sensitive flags, context check |
| `/settings/apps` | `ConnectedAppsPageComponent` | Grants with granted and last-used dates; revoke |
| `/developer` | `DeveloperAppsPageComponent` | Apps in the current context; register (environment, scopes, origins, callbacks) |
| `/developer/apps/:id` | `DeveloperAppDetailComponent` | Settings and quotas; credentials (secret shown once, rotate, revoke); webhooks (create, verify, enable/disable, rotate, delete, delivery log, retry); usage; audit; suspension notice. High-impact actions require typing the app name; the server also checks it. |
| `/workspace` | `WorkspaceAdminPageComponent` | Policies (admins only), members, Clerk `OrganizationProfile` for invites and roles, workspace apps (suspend, withdraw all grants) |
| top bar | `WorkspaceSwitcherComponent` | Switches the Clerk organization, confirms with `GET /v1/workspace`, then does a full reload (clears stale state and reconnects the socket). Falls back to personal on error. |
| chat list | badge | **External** label when `scope === 'external'` |

The account menu now links to Workspace, Connected apps and Developer.

## 4. Files and schemas

**Backend, new**
- `src/webhooks/{ssrf,crypto,models,events,sender,worker,service}.ts`
- `src/api/v1/webhook.routes.ts`, `src/api/v1/workspace.routes.ts`
- `src/developer/origins.ts`, `src/utils/safe-log.ts`
- `test/p5-security.test.ts`, `test/webhooks.test.ts`

**Backend, changed**
- `src/developer/{models,app.service}.ts`
- `src/api/v1/developer.routes.ts`
- `src/app.ts`, `src/realtime/io.ts`, `src/server.ts`
- `src/utils/errors.ts`, `src/config/security.ts`, `src/migrations/index.ts`
- Event hooks: `services/call-session.service.ts`, `realtime/gateways/call.gateway.ts`, `realtime/group.events.ts`, `services/recording.service.ts`
- `services/conversationService.ts` (exposes `scope` and `externalParticipants`)
- Tests: `developer-platform.test.ts`, `examples.test.ts`, `security-config.test.ts`, `env.ts`
- Docs and examples: `docs/integrations/examples/backend/spreewe-server-client.ts` (`startConsent`), `docs/api/openapi.yaml`

**Frontend, new**
- `core/services/developer.service.ts`
- `pages/shell/workspace-switcher.component.ts`
- `pages/developer/*` (5 components and `developer.scss`)

**Frontend, changed**
- `core/services/clerk.service.ts` (organization methods)
- `pages/pages.module.ts`, `pages/pages-routing.module.ts`
- `pages/shell/shell.component.html`
- `pages/chat/chat.component.{html,scss}`

**Schemas**

| Collection | Change | Indexes / TTL |
|---|---|---|
| `webhook_endpoints` | new | — |
| `webhook_deliveries` | new | unique (endpointId, eventId); 7-day TTL |
| `app_consent_requests` | new | TTL |
| `app_grants` | adds `lastUsedAt` | — |

- **Migration:** `2026-10-24-webhooks-and-consent` creates indexes only.
- **Rollback:** drop the three new collections. `lastUsedAt` is optional and harmless. No data transformation is involved.
- **Breaking change:** `POST /v1/apps/:id/grants` no longer accepts `externalUserRef`. Integrators must move to consent requests ([../integrations/user-consent.md](../integrations/user-consent.md)).

## 5. Test, build and validation results (local)

| Check | Result |
|---|---|
| Backend `vitest run` (mongodb-memory-server) | **119 / 119 passed**, 14 files. One earlier run failed 2 tests in `webhooks.test.ts`: a race between the duplicate-insert assertion and Mongoose's asynchronous index build. The test now creates the index explicitly, as the migration does. |
| Backend `tsc --noEmit` and `tsc` build (to scratch dir) | Passed |
| Frontend `ngc -p tsconfig.app.json --noEmit` | Passed |
| Frontend `ng build` | Succeeded. Warnings only: existing initial-bundle budget (1.18 MB vs 500 kB) and CommonJS warnings. |
| OpenAPI regenerated (`OPENAPI_WRITE=1`) and parsed with js-yaml | 3.0.3; 44 paths / 48 operations; all have responses; 0 dangling `$ref`. Not run through a full spec linter. |
| Mutation checks: each security control disabled in turn | **14 / 14 caught**: F1, F2 callback match, F2 single use, F3, F4, F5, SSRF IPv4, SSRF embedded IPv4, pinned lookup, redirects, audience visibility, audience membership, payload cap, auto-disable. The first run had 3 survivors (Bearer redaction, concurrent consent claim, content cap), meaning those controls were untested. Tests were added and all three are now caught. |

The frontend has no automated UI tests for the new screens, and they have not been exercised in a browser against a running backend.

## 6. Remaining risks

- Per-minute rate limits and connection limits are per instance.
- Log redaction is pattern-based.
- No infrastructure egress filter for the webhook worker. Recommended; owner: DevOps.
- Consent screen not UX-reviewed for phishing resistance.
- Frontend bundle is over budget (pre-existing).

## 7. Real-service checks outstanding (staging)

1. **Clerk organizations in the frontend:** `getOrganizationMemberships`, `setActive`, `mountOrganizationProfile`. Written against the Clerk JS API but not run against the live instance. Owner: frontend developer.
2. **Real webhook delivery** over the internet: TLS, real DNS (including multiple records), a rebinding test domain, a receiver verifying signatures. Owner: backend developer.
3. **Multiple API instances:** concurrent webhook workers, origin cache, rate limits. Owner: DevOps / backend.
4. **Load** on fan-out and the delivery queue.
5. **Manual browser walkthrough** of the consent, developer dashboard, workspace admin and switcher flows. Owner: QA.
6. Previously listed and still open: S3, FFmpeg, mediasoup in a deployed environment.

## 8. Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `WEBHOOK_SECRET_KEY` | **Yes in production** (startup fails without it) | development fallback only | 32+ characters; identical on all instances; changing it makes stored webhook secrets unreadable |
| `APP_PUBLIC_URL` | Yes for consent links | — | Base URL of the web app (`/consent` page) |
| `WEBHOOK_TIMEOUT_MS` | No | 10000 | |
| `WEBHOOK_WORKER_INTERVAL_MS` | No | 2000 | |
| `WEBHOOK_MAX_ATTEMPTS` | No | 8 | |
| `WEBHOOK_DISABLE_AFTER_FAILURES` | No | 15 | |

## 9. Suggested next phase

1. Run the staging verification in section 7. It is required before any production claim.
2. Infrastructure egress policy for the worker.
3. Frontend tests for the consent and developer screens.
4. Decide whether rate limits need to be global. This depends on the instance count; it would justify shared state only then.
5. Integrator migration notice for the `externalUserRef` breaking change.
