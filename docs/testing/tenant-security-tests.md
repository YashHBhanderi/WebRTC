# Tenant security tests

## Harness

- **Vitest 3.2.4** + **mongodb-memory-server 10.1.4** (in-memory MongoDB, one database per test file) + **supertest** (real Express app) + **socket.io-client** (real Socket.IO server).
- Clerk is replaced at the module boundary (`test/setup/env.ts`): a session is JSON `{ sub, org?, role? }` sent as an HTTP header or socket handshake token, returned in the same shape as Clerk's v2 session claims. **Real Clerk token verification is not exercised by these tests.**
- No test touches a real database; `MONGO_URI` is blanked in the test environment.
- Run: `cd webrtc-BE && npm test` (first run downloads a MongoDB binary). Type-check: `npm run typecheck`.

## Coverage against the required scenarios

| # | Scenario | Tests | Status |
| --- | --- | --- | --- |
| 1 | Global-to-global communication | `global.test.ts` | Pass |
| 2 | Tenant A can't read / modify / delete / discover Tenant B | `tenant-isolation.test.ts` › Tenant B cannot… | Pass |
| 3 | Multi-tenant user can't cross-access when switching | › member of two workspaces… ; global chats not visible inside a workspace | Pass |
| 4 | Non-members can't access tenant conversations, meetings, recordings | › non-members cannot access workspace meetings and recordings | Pass (files covered indirectly — see gaps) |
| 5 | Unauthorized external guests | › workspace policies and external conversations (4 tests) | Pass |
| 6 | Forged tenant / conversation / socket / media ids | › conversation created in a workspace belongs to it; › forged ids; socket › joinCall forged id | Pass |
| 7 | Unauthorized socket events / WebRTC operations | `socket-isolation.test.ts` (wrong-context room join, send, call start, joinCall, consume) | Pass |
| 8 | Historical data accessible | `global.test.ts` › legacy conversations… | Pass |
| 9 | Switching doesn't leak stale data | socket › chat events reach a socket only in the owning context; directory per context | Pass (server side only; client cache clearing is Phase 6) |
| 10 | Rate limits, CORS, security config | `security-config.test.ts` (8 tests); socket flood test | Pass |
| – | Data-layer plugin unit tests | `scope-plugin.test.ts` (4 tests) | Pass |

## Results (2026-10-20, Windows, Node 24.18.0)

```
Test Files  5 passed (5)
     Tests  34 passed (34)
```

- `npm run typecheck` (`tsc --noEmit`): exit 0.
- `tsc` build (to a temp folder, `dist/` untouched): exit 0.
- Baseline before changes: `tsc --noEmit` exit 0; no tests existed.

### Mutation check (do the tests detect a missing protection?)

| Protection disabled | Tests that failed | Interpretation |
| --- | --- | --- |
| Data-layer scope filter | 9 of 22 isolation tests | The other 13 are protected by independent layers (membership, inclusion rule, policies, delivery filter, rate limiter) |
| Socket delivery filter | the "switching" test | Delivery filter is the only thing stopping cross-context pushes |

Both mutations were reverted; the final run above is on the unmodified code.

## Not covered / unverified

- Real Clerk token verification, org-switch behaviour of the Clerk SDK, and the `org:owner` custom role.
- File upload and signed-URL generation against S3 (storage not configured in tests). `/upload` uses the same scoped `getConversationForMember` plus the external-files policy.
- Recording processing, transcription and their notifications end to end.
- Concurrency and load ("concurrent workloads"): **no load tests yet**.
- Frontend behaviour (workspace switcher, cache clearing) — Phase 6.
- Multi-instance deployment.

## Phase 4A results (2026-10-20)

New suites:
- `fail-closed.test.ts` (8 tests)
- `clerk-webhooks.test.ts` (10 tests, real Svix signature verification with a test-only secret)
- `api-v1.test.ts` (9 tests)
- `shutdown.test.ts` (1 test)
- `socket-isolation.test.ts` +1 (`screen:join`)

The final full run is recorded in `docs/implementation/phase-4a-report.md`.

Negative checks (each protection disabled, then restored; every one was detected):

| Disabled | Failing tests |
| --- | --- |
| Fail-closed throw | fail-closed refusal test |
| Revocation tombstone check | webhook revocation test; `/v1` revoked-membership test |
| Webhook signature verification | signature rejection test |
| `/v1` router authentication | 8 of 9 `/v1` tests |
| `screen:join` participant check | `screen:join` isolation test |

Environment note: one run failed to start the in-memory MongoDB (mongod internal `fassert`); an immediate re-run passed. This is unrelated to the code under test.

## Phase 4B results (2026-10-21)

New suites:
- `p0-isolation.test.ts` (9 tests)
- `developer-platform.test.ts` (21 tests)
- `examples.test.ts` (1 test, runs the published examples)
- `security-config.test.ts` +1 (production secrets)

Full run: **95 passed, 0 failed, 0 skipped**. 11 negative checks, all detected. Details in `docs/implementation/phase-4b-report.md`.
