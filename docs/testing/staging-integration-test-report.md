# Staging integration test report (Phase 5B)

Date: 2026-10-22. All data synthetic. Nothing was deployed; no production data or credentials were used.

## Environment

| Component | Configuration |
|---|---|
| Backend | 2 instances via ts-node (transpile-only) on one Windows 10 workstation: ports 8100 and 8101, mediasoup on 40100 and 40200. `NODE_ENV=development`, `CLERK_CLOCK_SKEW_MS=15000` (host clock −10 s), `SOCKET_REVALIDATE_MS=5000`. Secrets generated per run (never printed). |
| Frontend | `ng serve --ssl false` on `http://127.0.0.1:4300`, proxied to 8100. Browsers treat loopback as a secure context, so camera and mic still work. |
| Database | Local MongoDB, separate database `spreewe_phase5b` (the developer database was not touched). |
| Clerk | Approved **test** instance (development type). Organizations enabled with the owner's approval; "Membership optional" set by the owner. 6 synthetic users (`phase5b-*+clerk_test@example.com`); orgs `phase5b-OrgA` (admin owner, member, multi) and `phase5b-OrgB` (outsider owner, multi). |
| S3 | Approved test bucket, keys only under `phase5b-staging/`, deleted afterwards (0 remaining). `S3_MANAGE_LIFECYCLE=false`. |
| Media | Chromium 130 (Playwright 1.48.2) with fake camera and mic. FFmpeg (WinGet). whisper.cpp with `ggml-large-v3`, 2 threads. No STUN or TURN configured. |
| Harness | Scripts in the session scratchpad (not committed). They log claim summaries only, never tokens; the Playwright error output is redacted. |

## Required staging configuration

| Setting | Value / note |
|---|---|
| Clerk → Organizations | Enabled. Membership options: **Membership optional** (personal accounts allowed). With "required" selection, every session is `pending` and the API refuses it. |
| Clerk → authorized parties | `CLERK_AUTHORIZED_PARTIES` must list the exact frontend origin. |
| Clerk → webhooks | Endpoint `/api/webhooks/clerk` with `organizationMembership.*`, `organization.*` and `user.*` events. Its signing secret goes in `CLERK_WEBHOOK_SIGNING_SECRET`. **Not configured in staging** (it needs a public URL). |
| Host clock | NTP-synchronised. |

## Results summary

123 staging checks passed, 5 failed (B1 ×3, cross-instance real time, membership-cache window). Details: [../security/staging-security-validation.md](../security/staging-security-validation.md).

| Integration | Status | Notes |
|---|---|---|
| Clerk sign-in (API and browser form, incl. the new-device email code) | **Staging** | 9 + 26 checks. |
| Clerk organizations: selection, switching, roles, multi-org user | **Staging** | Via the real switcher UI. |
| Clerk membership removal | **Staging** (removal) + harness-delivered webhook | Real Clerk webhook delivery **not tested**. |
| Clerk invitations: acceptance and rejection | **Not tested** | Needs mailbox or ticket UI flows; next phase. |
| Consent and developer tokens | **Staging** | 16 checks, plus 2 cross-instance race checks. |
| S3 uploads and signed URLs | **Staging** | 18 passed, 2 FAILED (public bucket). |
| Legacy files | **Staging** | Synthetic file, staging directory. `LEGACY_UPLOADS_DIR` production validation: `check:config` (read-only). |
| Outbound webhooks: SSRF at configuration time | **Staging** | 24 checks. |
| Outbound webhooks: real delivery, retries, timeouts, rebinding, receiver verification, never blocking chat | **Mock** | No approved destination or rebinding domain. |
| WebRTC direct video call (mediasoup) | **Staging** | Both sides render live video (3/3 elements). |
| Group calls, screen share, reconnect after network loss | **Not tested** | |
| TURN behind restrictive NAT | **Not tested** | No TURN server configured. |
| Recording: start, REC indicator, stop, FFmpeg finalise, metadata, authorised access | **Staging** | `completed`, 19 s, 281 KB, tenant set; cross-tenant 404. |
| Recording interrupted by crash | **Staging** | See below. |
| Transcription | **Staging** (engine) | Exact transcript of a synthetic spoken sentence. The in-call path was not triggered because the fake mic produces no speech. |
| Graceful shutdown during an active recording | **Not tested** | Only a hard kill was tested. |
| Multi-instance | **Staging** (2 instances) | See [../operations/multi-instance-readiness.md](../operations/multi-instance-readiness.md). |
| Load | **Staging** (sample) | See below. |

## Notable observations

**Interrupted recordings (hard kill after about 12 s of recording)**
- Audio track files were **0 bytes**: FFmpeg's buffer was lost.
- Video `.mkv` files were 256 KB and not finalised. `ffmpeg -c copy` recovered **5.2 s of about 12 s**.
- Track paths are persisted only when recording stops, so the DB cannot locate partial files after a crash.
- On restart the recording is marked `failed` ("interrupted by a server restart"), as designed.
- **All partial files stay in `RECORDING_TMP_DIR` with no cleanup.** That is a disk leak and leaves private media on disk.
- Data recovery today: manual, video only, partial.

**Transcription performance.** whisper.cpp `large-v3` with 2 threads took **140 s for about 8 s of speech**, roughly 17× slower than real time. A one-hour meeting would take on the order of hours.

**Incoming call lost during socket reconnect.** `SocketService.connectWithToken()` always disconnects before connecting, and runs more than once at startup. A ring emitted in that gap is lost: the server keeps one primary socket per user and does not re-send pending rings on reconnect. Reproduced on staging. This is a reliability defect, not a security one.

**Load sample** (single instance, same host as the load generator, ts-node; not a capacity figure). Preset thresholds: p99 < 500 ms and no 5xx.

| Scenario | Throughput | p50 | p99 | Result |
|---|---|---|---|---|
| `GET /v1/me`, 10 connections, 15 s | 409 req/s | 22 ms | 39 ms | Pass (0 errors) |
| `GET /v1/me`, 50 connections, 15 s | 531 req/s | 92 ms | 135 ms | Pass (0 errors) |

With the default limits, about 99% of requests from one IP received 429 (600 per minute per IP).

## Reproducing

1. Start a backend with a staging env file. Required overrides: `PORT`, `MONGO_URI` (staging DB), `STORAGE_KEY_PREFIX`, `S3_MANAGE_LIFECYCLE=false`, the three secrets, `CLERK_WEBHOOK_SIGNING_SECRET`, `CLERK_AUTHORIZED_PARTIES`, `CORS_ORIGINS` and `APP_PUBLIC_URL` for the frontend origin, and a free `MEDIASOUP_RTC_PORT`.
2. Start the frontend: `BACKEND_URL=http://127.0.0.1:8100 npx ng serve --port 4300 --ssl false --proxy-config proxy.conf.js`. The harness reroutes the hard-coded `apiUrl` to the staging backend.
3. Create synthetic users and orgs with the Clerk Backend API (test key only). Sign in through the real form; `+clerk_test` addresses accept code `424242`.
4. Run the scenario scripts: auth, authz, revocation, consent, s3, ssrf, call, multi, load. The harness lives in the session scratchpad. Committing it as `webrtc-BE/staging-tests/` is a recommended next step.
