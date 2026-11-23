# Phase 2 & 3 report — tenant foundations and isolation

Scope: `webrtc-BE` only. No deployment, no production data touched, no Clerk configuration changed.

## Files

New:

- `src/tenancy/context.ts` — request context + AsyncLocalStorage (`runWithContext`, `runAsSystem`)
- `src/tenancy/scope.ts` — scope filters, Mongoose plugin, conversation-scope cache, `visibleIn`
- `src/tenancy/tenant.service.ts` — context resolution from Clerk claims, roles/permissions, policies, inclusion rule, external conversations, directory
- `src/models/tenantModel.ts`, `src/models/tenantMembershipModel.ts`
- `src/routes/tenant.routes.ts` — `/tenant/*`, `/directory`
- `src/config/security.ts` — rate limits, trust proxy, body limits, CORS validation
- `src/realtime/rate-limit.ts` — per-socket token bucket
- `test/**` (5 suites, 34 tests), `vitest.config.ts`

Changed:

- Models: `conversationModel`, `callModel`, `meetingModel`, `recordingModel`, `notificationModel`, `savedMessageModel` (scope plugin); `userModel` (`globalDiscoverable`)
- Auth / transport: `middleware/authMiddleware.ts`, `realtime/index.ts`, `realtime/io.ts`, `utils/multer.ts`, `types/customRequest.ts`, `app.ts`, `server.ts`, `utils/logger.ts`
- Services / controllers: `conversationService`, `group.service`, `meeting.service`, `message.service`, `notification.service`, `presence.service`, `search.service`, `identity.service`, `userServices`, `userController`, `upload.controller`, `call.gateway`, `message.gateway`
- `migrations/index.ts`, `package.json` (scripts `test`, `typecheck`), `tsconfig.json` (`include: ["src"]`)

Dependencies: production `helmet@8.1.0`, `express-rate-limit@7.5.1`; development `vitest@3.2.4`, `mongodb-memory-server@10.1.4`, `supertest@7.1.4`, `@types/supertest@6.0.3`, `socket.io-client@4.8.1`.

## Schema changes

| Collection | Added |
| --- | --- |
| `tenants` (new) | `clerkOrgId` (unique), `name`, `slug`, `status`, `policies` |
| `tenantmemberships` (new) | `tenantId`, `userId` (unique pair), `role`, `status`, `lastSeenAt` |
| `conversations` | `tenantId`, `scope`, `externalParticipants`; indexes `{tenantId}`, `{tenantId, members, isGroup}` |
| `calls`, `meetings`, `recordings`, `notifications`, `saved_messages` | `tenantId`, `scope`; index `{tenantId}` |
| `users` | `globalDiscoverable` (default true) |

## Migrations

`2026-10-20-tenancy-foundation`: indexes only, no data rewritten. **Executed only in the in-memory test database.** Not run on any real environment. Rollback: see `docs/migrations/tenant-migration.md`.

## Security issues fixed

See the table in `docs/security/tenant-isolation.md`. The most important: the global user directory leak (including emails via `GET /web/users` and `GET /web/user/:id`), broadcasts of profile changes and new accounts to every socket, missing security headers and rate limits, CORS open by default, and 1000 MB JSON / 100 MB socket message limits.

Two items from the Phase 1 audit were wrong and are corrected here:

- TURN with short-lived credentials already existed.
- `reactToMessage` already checks membership. A suspected IDOR in `addReaction` is not reachable.

## Verification

- Tests: **34 passed, 0 failed, 0 skipped** (`npm test`).
- Type-check: exit 0. Build: exit 0 (built to a temp folder).
- Mutation check: disabling the data-layer filter fails 9 isolation tests; disabling the socket delivery filter fails the switching test. Both reverted.
- Unverified: real Clerk tokens, S3 file paths, recording pipeline, load/concurrency, multi-instance, frontend.

## Remaining risks

Listed in `docs/security/tenant-isolation.md`: ALS fail-open on lost context, stale membership projection until webhook sync, derived external records visible from any of the participant's contexts, messages not stamped, presence shared across contexts, public legacy `/uploads`, per-process rate limits, no second-person security review.

Frontend impact: the conversation info panel's fallback line showed `peer.email` and will be blank for people outside your conversations. Workspace switching UI does not exist yet, so all current users keep working in the global context.

## Manual Clerk configuration still required

1. **Confirm Organizations is available on your Clerk plan** (membership limits, roles). Not verified here: no access to your Clerk dashboard or pricing.
2. Enable Organizations; decide who can create organizations.
3. Optional: create a custom role `org:owner`. Without it, owners are `org:admin`.
4. Ensure session tokens carry the active organization (default for Clerk v2 session tokens). The backend reads `o.id` / `o.rol` (v2) or `org_id` / `org_role` (v1).
5. Phase 4: a Clerk webhook (`organizationMembership.deleted` / `updated`) to keep `tenantmemberships` current.

Environment variables (new, all optional except `CORS_ORIGINS` in production): `CORS_ORIGINS`, `TRUST_PROXY`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`, `RATE_LIMIT_SENSITIVE_MAX`, `JSON_BODY_LIMIT`, `SOCKET_MAX_BUFFER_BYTES`, `SOCKET_RATE_PER_SEC`, `SOCKET_RATE_BURST`, `PLATFORM_ADMIN_CLERK_IDS`.

**Deployment warning:** production will refuse to start if `CORS_ORIGINS` is missing. Set it before deploying.

## Recommendation for Phase 4

In this order:

1. Clerk webhook sync for memberships and organizations, with signature verification. Closes the projection-staleness gap.
2. A request marker that fails closed when a user request runs without a context. Removes the ALS fail-open class of bugs.
3. Versioned REST under `/v1` with OpenAPI generated from route schemas, using a consistent error envelope (`errorCodeFor` already exists).
4. Developer applications: server-side secret, short-lived scoped user tokens (app + user + tenant + scopes), revocation.
5. Webhooks with signed payloads and delivery logs.
6. Redis only when a second instance is needed, for the Socket.IO adapter, rate limits and presence.

Before Phase 4, a backend developer should do a second-person review of `src/tenancy/*` and the emit changes in `src/realtime/io.ts`.
