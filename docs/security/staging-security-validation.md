# Staging security validation (Phase 5B)

Date: 2026-10-22. Environment: see [../testing/staging-integration-test-report.md](../testing/staging-integration-test-report.md#environment).

**Status legend**

| Status | Meaning |
|---|---|
| **Staging** | Verified against a real staging service (real Clerk test instance, real S3 bucket, real mediasoup, FFmpeg or whisper.cpp) |
| **Mock** | Verified only by automated tests with mocks or in-memory services |
| **Not tested** | No evidence |
| **FAILED** | Failed; awaiting remediation |

## Blockers (production must not launch until resolved)

| # | Severity | Finding | Evidence | Fix | Owner |
|---|---|---|---|---|---|
| B1 | **Critical** | **The S3 bucket is publicly readable.** The bucket policy allows `s3:GetObject` to `*` on `<bucket>/*`, and all four Public Access Block settings are off. Every chat attachment and recording can be downloaded without a signature. Recording keys (`recordings/<conversationId>/<recordingId>.mp4`) are built from MongoDB ObjectIds, which are partly predictable, so recordings are guessable as well as leakable. | **FAILED (staging).** An unsigned GET of a private attachment returned 200. An unsigned HEAD of a real recording returned 200. `GetBucketPolicyStatus` reports `IsPublic=true`. | Replace the public statement with avatar folders only:<br>`arn:aws:s3:::<bucket>/*/users/*/avatar/*`<br>`arn:aws:s3:::<bucket>/*/groups/*/avatar/*`<br>Then turn on `BlockPublicAcls` and `IgnorePublicAcls`. Check every bucket the app uses, production included. Once the policy is fixed, rotate exposure by treating previously shared links as leaked. | DevOps / cloud owner |
| B2 | High (multi-instance only) | **Real-time events do not cross backend instances.** No shared Socket.IO adapter exists, so messages, call rings and presence emitted on instance A never reach sockets on instance B. Messages are still stored. | **FAILED (staging, 2 instances).** | Single instance only until a shared adapter is added. A MongoDB-backed adapter avoids new infrastructure; Redis is an alternative. See [../operations/multi-instance-readiness.md](../operations/multi-instance-readiness.md). | Backend lead |
| B3 | High (operations) | **Server clocks must be NTP-synchronised.** This host's clock is 10 s behind and syncs from a local domain controller. With the correct production skew (5 s), every Clerk token is refused as "issued in the future". | Staging: `session-token-iat-in-the-future`. | Sync production hosts to a reliable NTP source, and monitor drift. | DevOps |

## Fixed in this phase (code + regression tests)

| Finding | Fix | Verification |
|---|---|---|
| **3-minute JWT clock skew applied whenever a `pk_test_` key is used, even with `NODE_ENV=production`.** Expired tokens were accepted for up to 3 extra minutes, and the sign-out window grew from about 60 s to about 4 min. | The development skew applies only outside production. `check:config` fails production configurations that set more than 30 s. | **Staging:** a 30 s token was refused 70 s later. Unit test `security-config.test.ts`. |
| **Logging relied on pattern redaction.** Raw error objects (Mongoose and MongoDB, which carry document values such as message text and emails; HTTP and AWS errors, which carry headers and request config) were passed to `console` at 57 call sites. | `safeError()` serialises errors by type at the source: values are never kept, only paths, codes and kinds. `logEvent()` writes structured lines through an explicit field allowlist. All 57 call sites now use `safeError`. The pattern filter stays as a backstop, extended to cookies, Basic auth and secret-named keys. | Mock: `p5b-logging.test.ts` (18 tests) covers bearer tokens, Basic auth, cookies, emails, query strings, message bodies, signed URLs, webhook and developer secrets, and exception objects. One test documents what the backstop cannot catch (free text). |
| **Production startup accepted unsafe configuration:** reused secrets, a missing or non-https `APP_PUBLIC_URL`, missing Clerk keys, plain-http CORS origins. | `productionConfigProblems()` refuses all of these at startup. New read-only `npm run check:config` reports by variable name only. | Mock: `security-config.test.ts`. Run against the real `.env` with production rules: correctly refuses (5 problems). |
| **Legacy file serving followed symlinks.** | `lstat` check: a symlink placed in `LEGACY_UPLOADS_DIR` is not served. `legacyDirProblems()` validates the directory without listing, reading, moving or deleting files. | Mock: test confirms no `readdir` call. |
| **Startup wrote S3 lifecycle configuration unconditionally.** | Opt-out `S3_MANAGE_LIFECYCLE=false` (default unchanged), for staging or for lifecycle rules managed as infrastructure code. | Staging ran with it set; no bucket configuration was changed. |

## Validation results by area

| Area | Result | Status |
|---|---|---|
| Clerk sign-in, real session tokens | Valid tokens are accepted. Missing, tampered (`sub` changed), forged-signature, `alg=none` and expired tokens are refused. | Staging |
| Clerk authorized parties (`azp`) | A token minted for an origin not on the list is refused (`token-invalid-authorized-parties`). | Staging |
| Sign-out | After the Clerk session is revoked, no new tokens can be minted. An already-issued token stays valid until expiry (about 60 s, networkless verification; documented). | Staging |
| Pending sessions (`choose-organization`) | Refused by Express (401). Fixed at the configuration level ("Membership optional"). | Staging |
| Tenant isolation | A global user, another tenant's owner, a guest and a same-tenant non-participant all get 404 on a private OrgA conversation. It is excluded from the global user's lists. | Staging |
| Workspace switching | The token's org claim follows the switcher. The OrgA conversation is refused while in OrgB or in the personal context. | Staging (browser) |
| Roles | A member cannot change workspace policies (403). | Staging |
| External conversations | The guest can read only from their personal context. The host admin can read inside OrgA. Other tenants, unrelated global users and the guest (for other OrgA chats) get 404. | Staging |
| Socket.IO | A real token authenticates. A forged token is refused. A cross-tenant `sendMessage` is not stored. | Staging |
| Membership revocation (with webhook) | The pre-removal token is refused (403) and the live socket is disconnected 29 ms after delivery on the same instance, 746 ms on another instance. | Staging (Clerk removal is real; the webhook was delivered by the harness with valid Svix signing — Clerk cannot reach localhost) |
| Membership revocation (without webhook) | A pre-removal token keeps working until expiry. Revocation depends on webhook delivery. | Staging (documented gap) |
| Membership cache across instances | Another instance accepted a pre-removal token immediately after the webhook was processed elsewhere. Documented window: `MEMBERSHIP_CHECK_CACHE_MS` (default 15 s). Recommend `0` in production. | FAILED vs the strict expectation; matches the documented design |
| Re-add inference | A token whose `iat` is later than the tombstone's `removedAt` reactivates membership. Correct only while both timestamps come from Clerk's clock. A harness timestamp from the skewed host reproduced a false reactivation. | Staging (design risk; documented) |
| Clerk webhook endpoint | Wrong signature 400; stale timestamp refused; replayed `svix-id` idempotent. | Staging |
| Consent | Unregistered and path-manipulated callbacks 400. No credential 401. Reuse 404. Forged id 404. Expired 404. 8 concurrent approvals → 1 success. Linking someone else's external ref 409. Concurrent approvals across 2 instances → 1 success. | Staging |
| Developer tokens | Granted scope works. Ungranted scope 403. Cannot mint wider than the grant. Refused on first-party routes. Revoking the grant kills the live token. | Staging |
| Credential rotation race | 6 concurrent rotations across 2 instances → 1 success. | Staging |
| S3 signed URLs | Exact download works. Tampered signature, extended expiry, repurposing for another object and an expired URL are all refused by S3. | Staging |
| S3 uploads | Cross-tenant upload 404. `text/html` and executables 415. A member cannot attach another user's upload. | Staging |
| S3 privacy | Objects are publicly readable. | **FAILED (B1)** |
| Legacy files | Valid link works (as an attachment). Unsigned, tampered, extended, expired, cross-file, traversal and missing are all 404. | Staging (synthetic file) |
| Recording access | Other tenant, global user and a participant in another workspace get 404 (v1 and legacy routes). | Staging |
| Webhook SSRF (configuration-time, real network stack) | 22 destination forms refused: loopback, `[::1]`, the backend itself, the MongoDB port, metadata incl. v6-mapped, 10/8, the LAN, CGNAT, decimal/hex/octal/short IPs, 0.0.0.0, NAT64, 6to4, userinfo, odd port, file, gopher, `.internal`. Production http refused. Out-of-scope event refused. | Staging |
| Webhook delivery, DNS rebinding at connect time, redirects, retries, signatures at receiver | Covered by `webhooks.test.ts` with an injected resolver and local receivers. | **Mock** — no approved external test destination |
| Rate limits | Enforced per instance (429 at request 61 of 60). The effective limit is the limit × the number of instances. | Staging |

## Remaining risks (accepted for now, documented)

- Sign-out and membership removal take effect for HTTP only after token expiry if the Clerk webhook is not delivered. Clerk webhook delivery to a real staging URL is **not tested**.
- Log redaction of free text is impossible by pattern. The source-level controls must be kept up when new log lines are added.
- Re-add inference from token timing (above).
- Partial recordings on a crash leave unencrypted media in `RECORDING_TMP_DIR` indefinitely (see the integration report).
