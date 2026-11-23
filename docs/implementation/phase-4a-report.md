# Phase 4A report — fail-closed context, Clerk sync, /v1 foundation

Scope: `webrtc-BE` only. No deployment, no real database touched, no Clerk configuration changed, nothing committed.

## 1. Fail-closed tenant context

- Scoped models (`Conversation`, `Message`, `calls`, `Meeting`, `Recording`, `Notification`, `SavedMessage`) now **throw** without a user context or an explicit `runAsSystem(fn, reason)`. Before, they ran unfiltered.
- System context is established explicitly for migrations, the legacy-media script, startup recovery, meeting reminders, the recording and transcription pipelines, and Clerk webhooks.
- Every Socket.IO listener, including `disconnect`, runs in the socket's context.
- **Bug found and fixed:** lazy Mongoose queries inside `runAsSystem`/`runWithContext` executed outside the context. They are now started inside it.
- A static test fails the build on raw driver access, `$lookup` into scoped collections, or `bulkWrite` on scoped models outside the reviewed files.
- Details: `docs/security/fail-closed-tenant-context.md`.

## 2. Clerk webhook sync

- `POST /webhooks/clerk`: Clerk `verifyWebhook` (Svix) over the raw body, a dedup ledger keyed on `svix-id`, ordering by event timestamp, and retry on failure. Webhooks never grant permissions.
- **Immediate revocation:** a removal tombstone is checked against the token's `iat` on every request and socket connection, and live sockets are disconnected. Organization deletion ends access for everyone and keeps the data.
- Details and dashboard setup: `docs/integrations/clerk-webhooks.md`.

## 3. Authorization and data integrity

- **New gap fixed:** `screen:join` let any socket join any call room by id (cross-workspace call broadcasts). `screen:getState` revealed a call's screen sharer. Both now require an active participant.
- **Messages now carry `tenantId`/`scope`.** Backfill migration `2026-10-21-message-scope`. `checkScopeConsistency()` detects mismatches and can repair them. A mismatch fails closed: the message is hidden, never leaked.
- **Reviewed and found guarded:**
  - group events (admin-checked services);
  - typing (verified room membership);
  - reactions, deletes and forwards (conversation-checked);
  - media transports and consume (joined peer, own-call producers only);
  - upload, recordings and transcripts (scoped conversation checks).
- **Not verified with real services:** S3 signed URLs, the recording/transcription pipeline, and a real mediasoup worker.

## 4. /v1 API foundation

- 10 endpoints under `/v1` (and `/api/v1`).
- Every route is authenticated by the router itself (no opt-out) and runs with the trusted workspace context. Validation rejects unknown fields and gives field-level details.
- Standard `{data, page}` / `{error}` envelope, cursor pagination, a stricter rate limit on sensitive routes, and 404 for resources not visible in your context.
- `docs/api/openapi.yaml` is generated from the same route definitions; a test enforces that it is in sync, and it round-trips through a YAML parser.
- Details: `docs/api/v1.md`.

## 5. Operational readiness

- **CORS:** production refuses to start without a valid `CORS_ORIGINS` (from Phase 2–3; still tested).
- **Graceful shutdown** (`src/shutdown.ts`) on SIGTERM/SIGINT, in this order: stop timers, close Socket.IO and HTTP, wait for disconnect handlers, close the mediasoup worker, disconnect MongoDB. It forces exit after `SHUTDOWN_TIMEOUT_MS` (default 15 s).
  - Live recordings are **not** finalised on shutdown; they are marked failed on the next start.
  - Found while testing: presence "offline" writes failed when the database closed too early. A settle delay was added.
- **Still single-process (no Redis, by design for now):**
  - rate-limit counters (HTTP and socket);
  - the revocation cache (other instances lag up to 15 s after a webhook);
  - `userSockets` / `socketContexts`, presence, and the mediasoup peer and room state;
  - call and recording live state.

  A second instance needs the Socket.IO Redis adapter, shared rate limiting, a shared presence and revocation signal, and sticky sessions or a signalling-to-media-node map.

## Files

New:
- `src/tenancy/consistency.ts`
- `src/integrations/clerk-webhooks.ts`
- `src/models/clerkWebhookEventModel.ts`
- `src/api/v1/{schema,registry,routes,openapi}.ts`
- `src/shutdown.ts`
- `test/{fail-closed,clerk-webhooks,api-v1,shutdown}.test.ts`
- `docs/security/fail-closed-tenant-context.md`, `docs/integrations/clerk-webhooks.md`, `docs/api/v1.md`, `docs/api/openapi.yaml`, this report

Changed in 4A:
- `src/tenancy/{context,scope,tenant.service}.ts`
- `src/models/{messageModel,tenantModel,tenantMembershipModel,userModel}.ts`
- `src/middleware/authMiddleware.ts` (`createVerifyToken` factory; legacy behaviour unchanged)
- `src/realtime/{index,io}.ts`
- `src/realtime/gateways/call.gateway.ts`
- `src/services/{message,meeting,recording,mediasoup}.service.ts`
- `src/migrations/{index,legacy-media}.ts`
- `src/app.ts`, `src/server.ts`
- `test/{helpers,global.test,socket-isolation.test}.ts`, `test/setup/env.ts`
- `package.json` (script `openapi`)
- Updated docs: `docs/security/tenant-isolation.md`, `docs/migrations/tenant-migration.md`, `docs/architecture/multi-tenancy.md`, `docs/testing/tenant-security-tests.md`

No new dependencies in 4A. The webhook verifier ships with `@clerk/express`.

## Verification

| Check | Result |
| --- | --- |
| Tests (`npm test`) | **63 passed, 0 failed, 0 skipped** (9 files; 34 from Phase 2–3, 29 new) |
| Type-check (`tsc --noEmit`) | exit 0 |
| Build (`tsc`, to a temp folder) | exit 0 |
| Negative checks | 5 protections disabled one at a time; all detected; all restored and verified byte-identical |

Requirement coverage (Phase 4A list): 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11 and 12 are covered by `fail-closed`, `tenant-isolation`, `socket-isolation`, `clerk-webhooks`, `api-v1`, `global` and `security-config`. Scenario 10 covers chat, meetings, calls and recording **metadata**; it does not cover media or recording processing.

## Unresolved risks

- **Untested against real services:**
  - Clerk token verification and real webhook delivery;
  - S3 upload and signed URLs;
  - the recording/transcription pipeline and FFmpeg;
  - a real mediasoup worker and its callbacks (which now fail closed if they touch scoped models without context);
  - load and concurrency at scale;
  - multiple instances;
  - the frontend.
- **Multi-instance gaps:** revocation is enforced per instance with a 15 s cache. Rate limits are per process.
- **Design limitations:**
  - derived records of external conversations are visible from any of the participant's contexts;
  - presence is shared across contexts;
  - legacy `/uploads` is public;
  - `runAsSystem` misuse is prevented only by review.
- No second-person security review yet.

## Manual Clerk setup required

1. Confirm Organizations is available on your plan (still unverified).
2. Enable Organizations.
3. Optionally create the custom role `org:owner`.
4. Create the webhook endpoint and subscribe to the events in `docs/integrations/clerk-webhooks.md`.
5. Set `CLERK_WEBHOOK_SIGNING_SECRET` on the server.

New environment variables:
- `CLERK_WEBHOOK_SIGNING_SECRET` (required for webhooks)
- `SHUTDOWN_TIMEOUT_MS` (optional)

## Recommended next phase (4B)

1. **Staging verification first:** run both migrations on a copy of production data, check the ledger counts, and exercise real Clerk sign-in, org switching and webhooks. Then a call with recording: S3 and FFmpeg under fail-closed rules.
2. A second-person security review of `src/tenancy/*`, `src/integrations/clerk-webhooks.ts` and `src/api/v1/registry.ts`.
3. Developer applications and short-lived scoped tokens on top of `/v1`, then signed outbound webhooks.
4. Phase 6 frontend: workspace switcher using Clerk's `setActive`, socket reconnect on switch, and clearing cached state.
5. Redis only when a second instance is scheduled: Socket.IO adapter, shared rate limits, and revocation broadcast.
