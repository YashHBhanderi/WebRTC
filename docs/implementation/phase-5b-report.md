# Phase 5B report: staging validation, security remediation, production readiness

Date: 2026-10-22. **Not production-ready** (3 blockers). Nothing deployed or committed. No production data, credentials or Clerk production configuration were used.

## 1. Clerk settings incident and fix

- **Cause:** enabling Organizations on the test instance (approved) also turned on `force_organization_selection` by default. Every new session became `pending` (`tasks: [choose-organization]`, token claim `sts: pending`), and `@clerk/express` treats pending sessions as signed out, so the API returned 401.
- **My attempt to revert:** turning the setting back off through the API was blocked by the tool's permission policy.
- **Fix:** the owner set **Organizations → Membership options → Membership optional**.
- **Verified after the fix:**

| Check | Result |
|---|---|
| Fresh session status | `active`, no tasks, `sts: active` |
| Fresh personal-user token at Express | Accepted (`/v1/me` 200, no tenant) |
| Personal-user sign-in through the real Angular form | Works |
| Org member, and the multi-org user switching OrgB → OrgA → Personal | Work. The token's org claim follows; the backend resolves the matching tenant. |
| Global user without an org | Resolves to global (no tenant access) |
| Expired, forged, tampered and `alg=none` tokens | Refused |
| Membership removal | Enforced. See §3. |

## 2. Code changes in this phase

| Area | Change | Files |
|---|---|---|
| Logging (primary controls) | `safeError()` type-aware error serialisation; `logEvent()` structured allowlist logging; 57 raw-error call sites converted; backstop rules for cookies, Basic auth and secret-named keys | `src/utils/safe-log.ts`, 21 call-site files, `test/p5b-logging.test.ts` |
| JWT clock skew | 3-minute dev skew never applies in production | `src/config/auth.ts` |
| Startup fail-closed | Refuses reused secrets, missing or non-https `APP_PUBLIC_URL`, missing Clerk keys, http CORS origins in production | `src/config/security.ts` |
| Config doctor | `npm run check:config`: read-only, names only | `src/config/check.ts`, `package.json` |
| Legacy files | Symlinks refused; safe `LEGACY_UPLOADS_DIR` validation | `src/services/legacy-files.service.ts` |
| S3 lifecycle | `S3_MANAGE_LIFECYCLE=false` opt-out (default unchanged) | `src/services/recording.service.ts` |
| Migration logs | Signed URL query strings stripped at the source | `src/migrations/legacy-media.ts` |
| OpenAPI | Every operation gets a description of its access rules; contact info | `src/api/v1/openapi.ts`, `docs/api/openapi.yaml` |
| Frontend tests | Consent and switcher specs; 2 stale scaffolds made compilable (skipped) | `consent-page.component.spec.ts`, `workspace-switcher.component.spec.ts`, `auth.guard.spec.ts`, `chat.component.spec.ts` |
| Tests | Production config, clock skew, `LEGACY_UPLOADS_DIR`, `check:config`; webhook index race | `test/security-config.test.ts`, `test/webhooks.test.ts` |

**Schemas and migrations:** none changed.

**Diff review** (this phase's files):
- No authorization was weakened.
- Defaults are either unchanged (`S3_MANAGE_LIFECYCLE`) or stricter (clock skew, production config).
- One deployment-affecting change: **production now refuses http CORS origins and a non-https `APP_PUBLIC_URL`**. Any existing http-only deployment must move to https before upgrading.

## 3. Verification results

| Check | Result |
|---|---|
| Backend tests | **142/142** (15 files) |
| Backend `tsc --noEmit` and build | Pass |
| Frontend `ngc --noEmit` and `ng build` | Pass (existing budget warnings) |
| Frontend new UI specs | 7/7 (full Karma suite: 12 pre-existing scaffold failures, unchanged) |
| OpenAPI Spectral (`spectral:oas`) | 0 errors, 0 warnings (was 42 warnings) |
| Staging security and integration checks | **123 pass, 5 fail** |
| Mutation checks | Phase 5A set (14/14) was not re-run this phase. New UI guard mutant caught (after fixing a test that initially missed it). |

Full per-area results: [../security/staging-security-validation.md](../security/staging-security-validation.md) and [../testing/staging-integration-test-report.md](../testing/staging-integration-test-report.md).

**Real staging vs. mock vs. not tested**

| Status | Areas |
|---|---|
| **Staging** | Clerk auth, organizations and switching; membership removal (Clerk side); consent and developer tokens; S3 signed URLs and upload rules; legacy files; webhook SSRF refusal; mediasoup direct video call; FFmpeg recording and finalise; whisper.cpp transcription engine; crash recovery behaviour; two-instance behaviour; load sample |
| **Mock only** | Real outbound webhook delivery, retries, rebinding at connect time, receiver verification; Clerk webhook delivery by Clerk itself (signed locally); daily quota under concurrency; webhook worker concurrency |
| **Not tested** | Clerk invitations; TURN / restrictive NAT; group calls; screen share; reconnect after network loss; graceful shutdown under traffic or during recording; developer dashboard, workspace admin and connected apps in a browser; logout; accessibility |

## 4. Security issues and blockers

| # | Status | Issue |
|---|---|---|
| **B1** | Open — Critical | S3 bucket publicly readable (attachments and recordings; recordings guessable). Fix is in the bucket policy (DevOps). |
| **B2** | Open — High | No cross-instance real-time delivery; single instance only. |
| **B3** | Open — High (ops) | Hosts must be NTP-synced; this host is 10 s slow. |
| Fixed | — | Production clock-skew issue; source-level log safety; unsafe production configuration; legacy symlinks. |

Documented risks:
- revocation depends on Clerk webhook delivery;
- 15 s membership-cache window across instances;
- re-add inference from token timing;
- crash leaves partial recordings on disk, with no cleanup and only partial video recoverable;
- transcription about 17× slower than real time;
- incoming call lost during socket reconnect;
- 12 broken Karma scaffolds.

## 5. Staging state left behind

| Resource | State |
|---|---|
| Clerk test instance | Organizations enabled, membership optional. 6 synthetic `phase5b-*` users (passwords set; kept in the session scratchpad only). Orgs `phase5b-OrgA` and `phase5b-OrgB`. `member` was removed from OrgA by the last test. |
| S3 | `phase5b-staging/` is empty. |
| MongoDB | Database `spreewe_phase5b` (synthetic). Drop it when no longer needed. |
| Processes | Staging backends on 8100 and 8101 and the frontend on 4300 are still running (the developer servers on 8000 and 4200 were not touched). |

## 6. Actions required from the owner

1. **Fix the bucket policy (B1) now.** It affects the current dev/test bucket and likely others. Check the production bucket too.
2. Decide the topology: single instance for launch, or approve adding a Socket.IO adapter (MongoDB-based preferred, to avoid new infrastructure).
3. Approve a **webhook test destination** (a receiver you control, reachable over the internet) and a public staging URL for **Clerk webhooks**, so the two remaining real-delivery checks can run.
4. Provide a TURN server for staging.
5. Fix NTP on production hosts. Separately, the domain controller this workstation syncs from runs about 10 s slow.
6. Commission the independent security review.

## 7. Next phase

1. Recording tmp cleanup and partial-recovery job.
2. Re-send pending rings on reconnect, and remove the double connect.
3. Socket.IO adapter (if multi-instance is needed).
4. Remaining browser walkthroughs and Karma clean-up.
5. Transcription capacity: smaller model or queue limits.
6. Commit the staging harness as `webrtc-BE/staging-tests/`.
