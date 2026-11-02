# Phase 5C report: critical remediation, bug fixes, reliability

Date: 2026-10-26. **Not production-ready.** Nothing deployed or committed. The only infrastructure change is the owner-approved S3 bucket policy (exact operation approved, old policy saved).

Note: the development machine rebooted before this phase. All local services (including the developer servers on 8000 and 4200) were down, and the session scratchpad was cleared, so the staging harness was rebuilt. The local `MongoDB` Windows service was started again; it is a single-node replica set `rs0`.

## Outcome by category

| Category | Items |
|---|---|
| **Fixed and verified (real services)** | S3 public exposure contained (anonymous 403 for private data); cross-instance Socket.IO events (2 real instances, real Clerk); incoming-call recovery after reconnect (staging); crash-safe recording capture and recovery (real staging crash); group calls and screen share; Phase 5A UI walkthrough; Clerk invitation create, revoke and accept |
| **Fixed in code, automated tests only** | Host-scoped recording recovery (protects other instances' recordings); temp-file cleanup and disk guard; transcription timeout; clock diagnostics; frontend test baseline |
| **Still failing / open** | Cross-instance call **media** (per-instance mediasoup) |
| **Blocked by missing infrastructure** | Real outbound webhooks (no approved receiver); Clerk webhook delivery (no approved public URL); TURN (no server); graceful shutdown during calls (needs a Linux host) |
| **Requires manual DevOps / admin action** | Fix the domain time source (about 16 s slow); S3 access logging; production bucket design; Clerk production webhook; per-call routing or a single-instance launch |
| **Requires explicit production approval** | Any production bucket or policy change. The owner stated this test/dev bucket is the only bucket; none exists for production yet. |

Details: [../security/phase-5c-security-review.md](../security/phase-5c-security-review.md) · [../testing/phase-5c-test-results.md](../testing/phase-5c-test-results.md) · [../security/s3-public-access-remediation.md](../security/s3-public-access-remediation.md) · [../operations/socketio-multi-instance.md](../operations/socketio-multi-instance.md) · [../operations/time-synchronization.md](../operations/time-synchronization.md) · [../operations/recording-recovery.md](../operations/recording-recovery.md) · [../operations/production-readiness-checklist.md](../operations/production-readiness-checklist.md)

## Code changes

**Backend, new files**
- `src/realtime/cluster.ts`: adapter, cross-instance delivery, heartbeat, guard
- `src/health.ts`: `/health/live`, `/health/ready`
- `src/config/clock.ts`: `check:clock` and the monitor
- `src/config/check-s3.ts`: `check:s3`
- `src/recording/recovery.ts`

**Backend, changed files**
- `src/realtime/io.ts`: local delivery + publish; handlers
- `src/realtime/index.ts`: `user:<id>` room
- `src/services/presence.service.ts`: cluster-aware online state and fan-out
- `src/realtime/gateways/call.gateway.ts`: `call:pending-rings`
- `src/services/recording.service.ts`: host, persisted tracks, disk guard, recovery, cleanup
- `src/models/recordingModel.ts`: `recovering`, `host`, `liveTracks`, `recovery`
- `src/recording/track-capture.ts`: crash-safe muxing
- `src/recording/composer.ts`: export `probe`
- `src/recording/transcription.ts`: proportional timeout
- `src/server.ts`: wiring
- `package.json`:
  - `@socket.io/mongo-adapter` **0.4.0** (exact)
  - `check:clock` and `check:s3` scripts

**Backend tests**
- 5 new files
- test MongoDB is now an in-memory **replica set**
- Clerk test double extracted to `test/support/clerk-double.ts`, shared with the child test instance
- `fail-closed.test.ts`: `realtime/cluster.ts` added to reviewed raw-DB exceptions (infrastructure collections only)

**Frontend**
- `socket.service.ts`: no restart while connecting; `onPendingRings`
- `call-manager.service.ts`: pending-ring reconciliation
- 14 specs rewritten or added (none skipped)

**Schema:** recording documents gain optional fields and a new status value. No migration is needed: old documents without `host` keep the previous recovery behaviour.

**Diff review:**
- no authorization weakened;
- no secrets in logs;
- no unrelated changes;
- token tolerance unchanged (production 5 s); the staging-only 25 s skew lives in the scratch env file, not the code.

## Test results (actual)

- Backend 179/179; type-check and build pass.
- Frontend 36/36 (0 skipped); type-check and build pass.
- OpenAPI 0 findings.
- Staging: all checks run in this phase pass (S3 15, multi-instance 8, walkthrough 19, invitations 6, group and screen 8, crash recovery 8, clock monitor 2).

Commands to re-run: [../testing/phase-5c-test-results.md](../testing/phase-5c-test-results.md#how-to-re-run).

## Environment variables added

| Variable | Default | Purpose |
|---|---|---|
| `SOCKET_ADAPTER` | unset (single instance) | `mongo` = share Socket.IO events between instances (replica set required) |
| `CLOCK_REFERENCE_URL` | `https://api.clerk.com/v1/jwks` | Clock check reference (https only) |
| `CLOCK_CHECK_INTERVAL_MS` | 900000 | Runtime clock check |
| `RECORDING_TMP_RETENTION_HOURS` | 24 | Temp folder retention for finished / failed recordings |
| `RECORDING_MIN_FREE_MB` | 2048 | Refuse / stop recordings on low disk |
| `TRANSCRIPTION_TIMEOUT_FACTOR` | 12 | whisper.cpp kill timeout = factor × audio length (≥ 30 min) |

## Staging state left behind

| Resource | State |
|---|---|
| Processes | Staging backends on 8100 and 8101 and the frontend on 4300 are running. |
| Clerk test instance | 6 synthetic `phase5b-*` users (passwords re-generated, kept only in the scratchpad), OrgA and OrgB, memberships restored. |
| Database | `spreewe_phase5b` |
| S3 | `phase5b-staging/` holds no current objects. Versioning keeps non-current versions, which are not publicly readable. |
| Downloads | Benchmark models in the scratchpad; your `WHISPER_MODEL_DIR` was not touched. |

## Next actions required from you

1. **S3 incident:** decide whether the 37 exposed objects contained real user data (notification), and have DevOps enable access logging. For production, approve the bucket design (a separate public avatar bucket is recommended).
2. **Time:** ask the domain administrator to fix the `sit.local` PDC time source. Production hosts need NTP and a passing `npm run check:clock`.
3. **Multi-instance:** choose between launching on **one instance**, or funding per-call routing for mediasoup media. Socket.IO events are ready for multiple instances.
4. **Provide for the remaining real-service tests:**
   - an owner-controlled public webhook receiver (and a DNS-rebinding test domain);
   - an approved public staging URL or tunnel for Clerk webhooks;
   - a TURN server;
   - a Linux staging host (graceful shutdown).
5. **Transcription:** decide the model using real, consented meeting audio (the benchmark options are in the results doc).
6. Commission the independent security review.
