# Phase 5C security review

Date: 2026-10-26.

Status key: **Fixed + verified** (real service) · **Fixed (automated tests only)** · **Open** · **Blocked (infrastructure)** · **Operator action**.

| # | Severity | Component | Root cause | Fix | Regression test | Verification evidence | Limitations | Status |
|---|---|---|---|---|---|---|---|---|
| S1 | Critical | S3 bucket `webrtc-test-dev-…` (the only bucket) | Policy granted anonymous `GetObject` on `<bucket>/*`; Public Access Block off | Avatar-only public policy; `BlockPublicAcls` + `IgnorePublicAcls` (owner-approved exact change); new `check:s3` | `s3-policy-check.test.ts` (incident policy FAILS, remediated PASSES) | Anonymous HEAD per category: 200 → 403 for attachments and recordings; avatars 200; signed URLs 200; `check:s3` PASS on the real bucket | Past access cannot be ruled out (no access logs, no CloudTrail permission) | Fixed + verified · **Operator action** (incident decision, logging, production bucket design) |
| S2 | High | Socket.IO, multiple instances | Per-user delivery used process-local socket maps | MongoDB adapter as transport; per-user events re-published and filtered by the **receiving** instance with the same checks; cluster-wide presence; cross-instance revocation; readiness guard | `multi-instance.test.ts` (9, two processes) + mutants | Staging, 2 instances, real Clerk: 8/8 (message, isolation, ring, pending ring, revocation 44 ms, immediate 403) | **Media** across instances not supported (per-instance mediasoup) | Fixed + verified for events · **Open** for cross-instance calls |
| S3 | High (availability of auth) | Host time | Domain time source about 16 s slow | No change to validation. `check:clock`, runtime monitor, readiness report, documented correction | `token-validation.test.ts` (real `@clerk/backend`: future, expired, nbf, forged, tampered, none, HS256 confusion) | Monitor reports FAIL (−15.9 / −16.6 s) on staging | Staging uses `CLERK_CLOCK_SKEW_MS=25000` only to tolerate this host; production stays 5 s | **Operator action** (fix the domain time source) |
| S4 | High (data integrity, multi-instance) | Recording startup recovery | `recoverOnStartup` failed **every** live and processing recording, including other instances' | Host-scoped recovery with an atomic claim | `recording-recovery.test.ts` (other host untouched; exactly once) + mutants | Unit and real-FFmpeg tests | — | Fixed (automated tests) |
| S5 | Medium | Recording capture | Matroska buffering: a crash lost all audio | `-flush_packets 1 -cluster_time_limit 1000`; persisted track metadata; recovery through the normal pipeline | Real-FFmpeg crash tests | Staging crash: audio 56–58 KB on disk, recovered audio and video, completed, access 200 / 404; S3 object anonymous 403 | About 1 s per track lost; alignment ±1 s | Fixed + verified |
| S6 | Medium | Temp media on disk | Partial recordings (private media) never removed | Retention-based cleanup that never touches active recordings; disk-space guard | Cleanup and disk tests | Unit | Disk-full stop not exercised on a real full disk | Fixed (automated tests) |
| S7 | Medium (availability) | Incoming calls | Ring lost during the client's startup double connect; no re-delivery | Server `call:pending-rings` (scoped, visibility-checked, unexpired, still ringing); client: no restart while connecting, reconciliation | `call-reconnect.test.ts` (6) + Karma specs + mutants | Staging: callee reconnecting to instance B received the pending ring | — | Fixed + verified |
| S8 | Low | Transcription | Fixed 8 h kill timer cut off long meetings | Timeout proportional to audio length | Unit | Benchmark data | Model choice is an operator decision | Fixed (automated tests) |
| S9 | Low | Frontend error display | — (review) | 5xx bodies never shown (generic message); 4xx only server-written user messages | `error.interceptor.spec.ts` | Karma | — | Verified (tests) |

## Reviewed, no change needed

- Authorization on the new paths:
  - pending rings run in the socket's verified context, plus the tenant plugin and an explicit visibility check;
  - recovered recordings use the existing recording access checks (staging 200 / 404);
  - `/health/*` exposes only status, short reason codes and the clock offset level.
- Cluster messages are produced only by server code (`io.serverSideEmit`); clients cannot publish them. The adapter's `socket_io_events` collection holds event payloads for up to 1 h (TTL). It contains the same data clients receive, so access to the database must stay restricted as before.

## Remaining (not fixed in this phase)

| Item | Why | Owner |
|---|---|---|
| Cross-instance call media | Needs per-call routing or mediasoup piping | Backend lead and DevOps |
| Real outbound webhook delivery and rebinding | No approved receiver | Owner to provide |
| Clerk webhook delivery | No approved public staging URL | Owner to provide |
| TURN | No server | DevOps |
| Graceful shutdown during calls | Needs a Linux host | QA and DevOps |
| Independent security review | Required before launch | Owner to commission |
