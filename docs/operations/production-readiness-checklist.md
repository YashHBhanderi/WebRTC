# Production readiness checklist

Status as of 2026-10-26 (Phase 5C). **Not production-ready.** Unchecked items block launch unless marked *recommended*.

## Blockers

- [x] ~~S3 bucket private (B1)~~: **contained 2026-10-26** on the only bucket (owner-approved policy change, verified with anonymous requests). See [../security/s3-public-access-remediation.md](../security/s3-public-access-remediation.md).
- [ ] **S3 incident follow-up** (owner):
  - decide on notification for the 37 exposed objects (10 recordings, 27 attachments);
  - enable server access logging or CloudTrail S3 data events;
  - for the production bucket, a separate public avatar bucket (or CDN), with all four Public Access Block settings on for private data.

  `npm run check:s3` must PASS.
- [ ] **Multi-instance.** Socket.IO events now cross instances (`SOCKET_ADAPTER=mongo`, verified with 2 real instances on staging). **Calls between users on different instances still have no media**: per-call routing to the instance hosting the mediasoup router is required, otherwise run **one** instance. `/health/ready` returns 503 when instances run without the adapter. Owner: backend lead and DevOps.
- [ ] **NTP-synchronised hosts.** This host and its domain controller (`dcserver.sit.local`) are about 16 s slow. `npm run check:clock` must PASS on every production host; the runtime monitor logs errors and reports in `/health/ready`. Owner: domain or infrastructure administrator, then DevOps.
- [ ] **Clerk production instance:**
  - Organizations enabled with **membership optional**;
  - webhook endpoint configured (`organizationMembership.*`, `organization.*`, `user.*`), with its signing secret in `CLERK_WEBHOOK_SIGNING_SECRET`;
  - **real Clerk webhook delivery verified** (not yet: needs an approved public staging URL).

  Owner: platform admin.
- [ ] `npm run check:config` with `NODE_ENV=production` reports **no FAIL** (today's development `.env` fails 5 checks).
- [ ] Real outbound webhook delivery against an owner-controlled receiver: signatures, retries, dead letter, recovery, DNS-rebinding domain; plus an infrastructure egress filter. **Not tested: no approved receiver yet.** Owner: backend and DevOps.
- [ ] TURN server configured and a real relay call verified behind a restrictive NAT. **Not tested: no TURN server.** Owner: DevOps.
- [ ] Graceful shutdown during active calls and recordings verified on a **Linux** host (Windows cannot deliver SIGTERM; unit-tested only). Owner: QA and DevOps.
- [x] ~~Recording temp-dir cleanup / interrupted recordings~~: crash-safe capture, host-scoped recovery and temp cleanup; verified with a real staging crash (audio and video recovered). See [recording-recovery.md](recording-recovery.md).

## Configuration (production)

| Variable | Requirement | Enforced |
|---|---|---|
| `CORS_ORIGINS` | https origins only; no `*` | Startup |
| `PLATFORM_TOKEN_SECRET`, `LEGACY_FILES_SECRET`, `WEBHOOK_SECRET_KEY` | 32+ characters, all different, identical on every instance | Startup |
| `APP_PUBLIC_URL` | https URL of the web app | Startup |
| `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET` | Set (live keys) | Startup (`check:config` warns on test keys) |
| `CLERK_AUTHORIZED_PARTIES` | Exact frontend origins | Warning |
| `CLERK_CLOCK_SKEW_MS` | Unset (5 s) or ≤ 30 s; **never raised to hide clock drift** | `check:config` |
| `SOCKET_ADAPTER` | `mongo` on every instance when more than one; `MONGO_URI` must be a replica set | Startup (invalid values and non-replica sets refused); readiness 503 on mismatch |
| `MEMBERSHIP_CHECK_CACHE_MS` | `0` with several instances | — |
| `LEGACY_UPLOADS_DIR` | Real absolute directory, readable | `check:config` |
| `S3_BUCKET`, `AWS_*` | Set; bucket passes `check:s3` | `check:config`, `check:s3` |
| `RECORDING_TMP_DIR`, `RECORDING_MIN_FREE_MB` (2048), `RECORDING_TMP_RETENTION_HOURS` (24) | Local disk with headroom for live recordings | Runtime |
| `WHISPER_MODEL`, `WHISPER_THREADS`, `TRANSCRIPTION_TIMEOUT_FACTOR` (12) | Choose from the benchmark (results doc); don't let transcription threads starve mediasoup | — |

## Quality gates (current state)

- [x] Backend tests: **179/179** (20 files); type-check and build pass.
- [x] Frontend: **36/36** Karma specs, 0 skipped; type-check and build pass (bundle budget warning).
- [x] OpenAPI: Spectral `spectral:oas`, 0 findings.
- [x] Staging (real Clerk, S3, mediasoup, FFmpeg, 2 instances): see [../testing/phase-5c-test-results.md](../testing/phase-5c-test-results.md). All checks run in this phase pass.
- [x] Browser walkthrough: developer dashboard, consent, connected apps, workspace admin, group calls, screen share.
- [x] Clerk invitations: create, revoke, accept (real). The invitee declining is not covered.
- [x] Incoming call recovery after reconnect (server `call:pending-rings` + client reconciliation).
- [ ] Logout, expired-session UX, keyboard accessibility, responsive layout: browser checks. *Recommended.*
- [ ] Transcription capacity decision (see benchmark): only `small` is faster than real time on 4 cores; its accuracy on real audio is unproven.
- [ ] Independent security review.
