# Phase 5C test results

Date: 2026-10-26. Host: Windows 10, Core i5-6500 (4 logical cores), 16 GB RAM. All data synthetic.

## How to re-run

```bash
# Backend (in-memory MongoDB replica set; Clerk test double; real FFmpeg if installed)
cd webrtc-BE
npx tsc --noEmit -p .                      # type-check
npm run build                              # build
npx vitest run                             # 179 tests
npx vitest run test/multi-instance.test.ts # two real backend processes + MongoDB adapter

# Read-only operational checks (no secrets printed)
npm run check:config                       # NODE_ENV=production applies production rules
npm run check:clock                        # host clock vs the token issuer
npm run check:s3                           # bucket exposure

# Frontend
cd ../webrtc-FE
npx ngc -p tsconfig.app.json --noEmit
npx ng build
CHROME_BIN=<path to Chrome/Chromium> npx ng test --watch=false --browsers=ChromeHeadless

# OpenAPI
npx -y @stoplight/spectral-cli@6.11.1 lint docs/api/openapi.yaml --ruleset <spectral:oas ruleset>
```

The staging harness (real Clerk, S3, mediasoup) lives in the session scratchpad and is not committed. Committing it as `webrtc-BE/staging-tests/` is recommended.

## Automated results

| Suite | Result |
|---|---|
| Backend `vitest run` | **179 passed / 179** (20 files). A harmless `ECONNRESET` is printed after teardown (in-memory replica set shutdown); exit code 0. |
| Backend type-check, build | Pass |
| Frontend Karma | **36 passed / 36**, 0 skipped (was 12 failing + 2 skipped) |
| Frontend `ngc`, `ng build` | Pass (existing budget warnings; initial bundle 1.18 MB, unchanged) |
| OpenAPI Spectral `spectral:oas` | 0 findings |

New backend test files:
- `multi-instance.test.ts` (9)
- `call-reconnect.test.ts` (6)
- `recording-recovery.test.ts` (9, real FFmpeg)
- `token-validation.test.ts` (8, real `@clerk/backend`)
- `s3-policy-check.test.ts` (5)

New or rewritten frontend specs:
- consent, switcher
- call manager (pending rings), socket service (connect lifecycle)
- auth guard, error interceptor (no 5xx internals shown; 401 retry then sign-out)
- app component (sign-out teardown), dialogs, services, chat and group-call construction

### Mutation checks (each guard removed; the suite must fail)

| Guard | Caught |
|---|---|
| Cross-instance publish of user events | Yes (5 tests) |
| Per-socket visibility on the receiving instance | Yes (2 tests). The first version of the tests missed it; fixed. |
| Recording recovery: claim status condition | Yes. Initially missed (a second guard held); a test for re-claiming a completed recording was added. |
| Recording recovery: claim host condition | Yes (after adding the direct-claim test) |
| Pending rings: ring-timeout bound | Yes |
| Pending rings: participant still `ringing` | Yes |
| Pending rings: visibility filter | Not caught alone: the tenant scope plugin filters `Call` queries independently (defence in depth) |
| Client: no reconnect while connecting | Yes |
| Client: only drop rings older than the reconnect | Yes |
| Consent page: wrong-context Allow guard | Yes (Phase 5B) |

## Real-service results (staging)

| Area | Checks | Result | Real service |
|---|---|---|---|
| S3 containment: anonymous requests per category, before → after | 9 | attachments and recordings 200 → **403**; avatars 200 → 200 | AWS S3 (approved bucket) |
| S3 signed URLs after containment | 3 | 200 | AWS S3 |
| `check:s3` on the real bucket | 2 | PASS | AWS S3 |
| Recovered recording object, anonymous | 1 | 403 | AWS S3 |
| Two instances, real Clerk sessions: health, live message A→B, OrgA isolation, ring A→B, pending ring on reconnect, revocation via the cluster (44 ms), immediate 403 on B | 8 | 8 pass | Clerk + 2 backends + MongoDB replica set |
| Browser walkthrough: developer dashboard (register, secret shown once, never again), consent (nothing pre-selected, callback with state), connected apps (removal kills the token), workspace admin (admin vs member), no console errors | 19 | 19 pass | Clerk + backend + Angular |
| Clerk invitations: create, revoke, accept (frontend SDK), new member's workspace access, member cannot change policies, other user's invitation not visible | 6 | 6 pass | Clerk |
| Group meeting (3 people) and screen share | 8 | 8 pass (after a harness fix: the host had not clicked "Join now") | mediasoup, Chromium fake devices |
| Recording crash on staging: live tracks persisted → hard kill → audio files non-empty (≈56–58 KB) → restart → recovered audio and video (~15 s) → completed → participant 200, non-participant 404 | 8 | 8 pass | mediasoup, FFmpeg, S3 |
| Clock monitor on both instances | 2 | Correctly reports FAIL (−15.9 s / −16.6 s) | Clerk API time |

### Not tested in this phase

| Area | Reason |
|---|---|
| Real outbound webhook delivery, retries, DNS-rebinding domain | No owner-approved receiver or rebinding domain |
| Clerk's own webhook delivery | No approved public staging URL or tunnel |
| TURN relay, restrictive NAT | No TURN server |
| Graceful shutdown during calls / recordings | Windows host cannot deliver SIGTERM to another process (Linux host needed); unit-tested only |
| Invitee declining an invitation | Not covered |
| Cross-instance **media** | Known not to work (per-instance mediasoup); see socketio-multi-instance.md |

## Transcription benchmark

29.2 s of synthetic English speech (Windows speech synthesis, known script), 16 kHz mono, whisper.cpp `whisper-cli`, language `auto`. Peak memory sampled every 0.5 s.

| Model | Threads | Time | × real time | Peak memory | WER |
|---|---|---|---|---|---|
| large-v3 (installed default) | 4 | 105.3 s | 3.60 | 3,921 MB | 0% |
| large-v3-turbo-q5_0 | 2 | 159.7 s | 5.47 | 813 MB | 0% |
| large-v3-turbo-q5_0 | 4 | 87.0 s | 2.98 | 813 MB | 0% |
| small | 2 | 26.6 s | 0.91 | 770 MB | 0% |
| small | 4 | 19.6 s | 0.67 | 770 MB | 0% |

Findings:
- The Phase 5B "17× slower than real time" came from an 8 s clip on 2 threads, which is dominated by loading the 3 GB model. On 29 s, large-v3 runs at 3.6× with 4 threads.
- **Only `small` is faster than real time** on this CPU.
- The 0% WER says only that clean synthetic speech is easy. **Accuracy on real, noisy or multilingual meetings is unmeasured**, so the default model was not changed.
- The fixed 8 h kill timer would have stopped transcription of long meetings (a 4 h meeting needs about 12–16 h with large-v3). It is now proportional to the audio length (`TRANSCRIPTION_TIMEOUT_FACTOR`, default 12×, minimum 30 min).
- Transcription already runs one job at a time, at low CPU priority. `WHISPER_THREADS` defaults to half the cores, to protect live calls.
- Recommendation: decide with real (consented) audio. For CPU-only hosts, `large-v3-turbo-q5_0` is a candidate: 4.8× less memory than large-v3, somewhat faster, multilingual. `small` is a candidate if near-real-time matters more than accuracy.
