# SpreeWe — Phase 0b Audit Report

- **Date:** 2026-11-02
- **Scope:** `webrtc-BE` (Express 4 / Socket.IO / mediasoup / MongoDB), `webrtc-FE` (Angular 16), `docs/`
- **Baseline:** the **uncommitted working tree** on `main` (HEAD `77a01bf`) — not HEAD itself. See §2.
- **Method:** code reading, the backend and frontend test suites, and the builds. Each finding is marked **Verified** (read in code or observed in a run) or **Inferred** (reasoned, not confirmed).

---

## 1. Decisions recorded

| # | Decision | Owner |
|---|---|---|
| D1 | Stay on Express 4. No NestJS migration without a specific technical limitation. | Product owner |
| D2 | Infrastructure (Terraform) stays outside this repository. Do not duplicate it here. | Product owner |
| D3 | Keep Matrix Olm/Megolm (`@matrix-org/matrix-sdk-crypto-wasm` 18.9.0). Do not replace or weaken it. API authorization and encryption-key authorization remain separate. | Product owner |
| D4 | No billing provider is selected yet. Design a provider-independent subscription and entitlement architecture first. | Product owner |
| D5 | Preserve the uncommitted working tree. Nothing is committed, reset or discarded without confirmation. | Product owner |

**Open:** Where the infrastructure repository lives. **No `.tf` files exist in this repository (Verified).** The repo URL, the owner, and how it maps to SpreeWe environments are still to be documented here.

---

## 2. Baseline

### 2.1 Build and test results (Verified, 2026-11-02, working tree)

| Check | Command | Result |
|---|---|---|
| Backend typecheck | `npx tsc --noEmit -p .` | Pass (exit 0) |
| Backend tests | `npx vitest run` | **30 files, 252 tests, all pass** (248 s) |
| Frontend build | `npx ng build` | Pass. **Warning:** the initial bundle is 1.21 MB against a 500 kB budget (734 kB over). |
| Frontend tests | `npx ng test --watch=false --browsers=ChromeHeadless` | **96 / 96 pass** |

Not run: end-to-end tests, cross-network call tests, load tests. None of these exist yet.

### 2.2 Working-tree risk (Verified)

- **95 tracked files are modified** (+7,592 / −1,442 lines). **169 files are untracked.**
- The untracked set contains most of the platform layer:
  - Backend: `api/v1`, `developer/`, `e2ee/`, `tenancy/`, `organizations/`, `webhooks/`, `contacts/`, `integrations/`
  - The entire backend `test/` folder
  - All of `docs/`
  - Frontend: `core/crypto/`, `pages/organizations/`, `pages/developer/`
- **None of this has git history.** A `git clean`, a disk failure or a lost laptop loses it permanently. This is the top operational risk today.

### 2.3 Inventory: sensitive, accidental and generated content (Verified)

| Item | Finding | Action |
|---|---|---|
| Secrets | A pattern scan (Clerk `sk_`, `whsec_`, AWS `AKIA`, private keys, Mongo URIs with credentials) of all untracked files found one hit: a **fake** fixture in `test/p5-security.test.ts:42` used to test redaction. | None. Safe to commit. |
| `webrtc-BE/src/uploads/` | Contains what appear to be real personal documents (salary slips, a PAN-style filename). **Gitignored, never tracked.** | Delete or move off developer machines (data owner). |
| `.env` | Gitignored. Not present in the change set. | None |
| `dist/`, `logs/`, `node_modules/` | Gitignored. Not in the change set. | None |
| `webrtc-BE/tsconfig.json` | 109/108 changed lines, but the only content change is adding `"include": ["src"]`. The rest is line-ending churn (`core.autocrlf=true`, no `.gitattributes`). | Commit the content change. Add a `.gitattributes` in a separate commit to stop the churn. |
| `package-lock.json` (BE +2,864 / −706, FE +710 / −33) | Generated. Matches the `package.json` dependency changes. | Commit with its manifest. |
| `docs/flutter/CLAUDE.md` | Implementation guide for a planned Flutter client. In scope for the product. | Commit with docs. |
| Unrelated modifications | None identified. Every change maps to a feature area below. | — |

### 2.4 Proposed commit breakdown

Proposed order for a recoverable baseline. **Not executed — awaiting confirmation.** Each commit should typecheck. The full suites will only pass once commits 1–7 are all in, because tests span features.

| # | Commit | Contents |
|---|---|---|
| 1 | `chore: line endings and tooling` | `.gitattributes` (new). `tsconfig.json`. `vitest.config.ts`. `package.json` scripts and dev dependencies, with the lockfile. |
| 2 | `feat(security): HTTP hardening, config checks, logging` | `app.ts`, `server.ts`, `config/{security,check,check-s3,clock,auth}.ts`, `health.ts`, `shutdown.ts`, `utils/{errors,logger,safe-log,multer,network}.ts`, `middleware/authMiddleware.ts`, `types/customRequest.ts`, runtime dependencies (helmet, express-rate-limit), with the lockfile. |
| 3 | `feat(tenancy): tenant model, scope plugin, fail-closed context` | `tenancy/`, `models/tenant*.ts`, `routes/tenant.routes.ts`, the tenant fields across `models/*.ts`, `migrations/*`. |
| 4 | `feat(orgs): organizations, teams, workspace policies, Clerk sync` | `organizations/`, `integrations/clerk-webhooks.ts`, `models/clerkWebhookEventModel.ts`, `contacts/`. |
| 5 | `feat(realtime): multi-instance adapter, socket rate limits, revalidation` | `realtime/*`, `@socket.io/mongo-adapter`, presence, chat-state, notification services. |
| 6 | `feat(e2ee): Olm/Megolm device and key relay` | `e2ee/`, the message gateway and services that enforce encrypted payloads, `message-actions.service.ts`. |
| 7 | `feat(platform): api/v1, developer apps, scopes, tokens, webhooks` | `api/`, `developer/`, `webhooks/`, recording, search and file service changes, `legacy-files.service.ts`. |
| 8 | `test(be): backend test suite` | `webrtc-BE/test/**`. |
| 9 | `feat(fe): crypto, organizations, developer console, workspace UI` | All `webrtc-FE` changes, `angular.json` (wasm asset), FE `package.json` and lockfile. |
| 10 | `docs: architecture, security, operations, audit` | `docs/**`, including this report. |

**Alternative (lower effort, still recoverable):** one WIP commit on a new branch `baseline/2026-11-02`, pushed, then split later. This secures the code today. Recommended if the original author can't be reached quickly to confirm the split.

**Needs a person:** the author of the working tree (git user `YashHBhanderi`, not the requester) should confirm attribution before anything is committed.

---

## 3. Current architecture (Verified)

```
Angular 16 SPA (Clerk JS, socket.io-client, mediasoup-client, matrix-sdk-crypto-wasm)
        │  REST (/web/*, /api/v1/*)        │  Socket.IO (events, signaling)
        ▼                                  ▼
Express 4 app ── auth (Clerk session | platform app token) ── tenancy context (fail-closed)
   ├─ controllers/ + services/   (chat, groups, calls, meetings, recording, search, files)
   ├─ api/v1 registry            (typed routes, OpenAPI generation, scope + auth kind per route)
   ├─ developer/                 (apps, scopes, tokens, origins, consent)
   ├─ webhooks/                  (signed outbound delivery, SSRF guard, worker)
   ├─ organizations/ tenancy/    (workspaces, memberships, policies, Clerk org sync)
   ├─ e2ee/                      (public-key and ciphertext relay only)
   └─ realtime/                  (gateways, per-user token bucket, Mongo adapter for multi-instance)
mediasoup SFU — in-process, ONE worker
MongoDB (Mongoose)   S3 (files, recordings)   Whisper (transcription, optional)
```

Key facts:

- **Framework:** Express 4. There is no NestJS anywhere.
- **Multi-instance:** supported through the Mongo Socket.IO adapter, but only when `SOCKET_ADAPTER=mongo` is set on a replica set. Readiness returns 503 otherwise (`realtime/cluster.ts:11-16`).
- **Media:** the SFU runs in the API process. If the single worker dies, the process exits (`mediasoup.service.ts:59-63`).

---

## 4. Capability inventory

| Area | Status | Notes |
|---|---|---|
| Personal 1:1 and group chat, replies, reactions, edits, receipts, typing, presence | Implemented, tested | Encryption is mandatory for text and media. |
| Search | Partial | Regex-based, no text index, no `maxTimeMS`. |
| Attachments | Implemented | AES-256-GCM on the client. Whether the server refuses unencrypted uploads is not verified. |
| Organizations, teams, policies, invitations, guests / external isolation | Implemented, tested | Tenant isolation tests exist. |
| 1:1 and group audio/video, lobby, screen share, reconnect | Implemented | Single worker. Calls are not tied to conversation membership (SEC-013). |
| Recording and transcription | Implemented | Recovery tests exist. |
| Developer apps, scopes, consent, scoped tokens, origins | Implemented, tested | `messages:write` grants nothing (§6). |
| Outbound webhooks | Implemented, tested | Signed, with SSRF protection. |
| `/api/v1` and OpenAPI | Implemented | 322 kB OpenAPI spec. |
| Developer console UI | Partial | `pages/developer/` exists. Completeness not audited. |
| E2EE key backup / recovery, cross-signing | **Missing** | — |
| TypeScript SDK package | **Missing** | Only example clients in `docs/integrations/examples/`. |
| Angular UI package | **Missing** | All UI is inside the app. |
| Subscriptions, entitlements, quotas, billing | **Missing** | No code at all. |
| Infrastructure as code | **Not in this repo** | — |
| End-to-end / load tests | **Missing** | — |

---

## 5. Security findings

`docs/production-audit-todo.md` checkboxes are **stale**. Several items are already fixed. Status below is against the working tree.

### 5.1 P0

| ID | Status | Evidence |
|---|---|---|
| SEC-001 body limits | Fixed | `app.ts:67-68`, `security-config.test.ts` (413) |
| SEC-002 Helmet / rate limits | Fixed | `app.ts:39,53-60`, `security-config.test.ts` |
| SEC-003 directory BOLA | Fixed. Dead code remains. | Controllers use `directory(ctx)`. `userServices.getAllUsersExceptCurrentUser` (`:93`) still does `User.find({_id:{$ne}})` and is unused. Delete it. |
| SEC-004 screen share without joining | Fixed | `call.gateway.ts:277` `isActiveParticipant` |
| **SEC-005** transports before join | **Open** | §7.1 |
| **SEC-015** fail-closed auth config | **Partial** | CORS half fixed. Clerk half open. §7.2 |

### 5.2 P1

| ID | Status | Evidence / gap |
|---|---|---|
| SEC-006 cross-instance delivery | Fixed (Mongo adapter, not Redis) | `cluster.ts`, `io.ts:153-157`, `multi-instance.test.ts`. Depends on ops setting `SOCKET_ADAPTER=mongo`. |
| **SEC-007** one worker, `process.exit` on worker death | **Open** | `mediasoup.service.ts:55,59-63` |
| **SEC-008** last socket wins | **Open (softened)** | `io.ts:19,160`. DMs and call invites go to one socket only. `notifyUserEverywhere` uses rooms. |
| SEC-012 socket buffer | Fixed | 5 MB default (`security.ts:34`). Consider lowering it for text events. |
| **SEC-013** removed group member keeps call access | **Open** | `group.events.ts:42-49` never touches `Call.participants`. `isActiveParticipant` checks only the Call. |
| SEC-014 meeting-code guessing | Partial | `GET /meetings/code/:code` is not on the sensitive limiter. Codes carry about 49.5 bits (Inferred: brute force impractical). |
| SEC-021 unbounded history | Partial | `/v1` uses cursors. The legacy `history()` still allows a limit of 2000 plus `skip`. |
| search.service | Partial | No `maxTimeMS`. Populates every member on each search. |
| Per-event socket limits | Partial | One shared bucket per user (30/s, burst 120), per process. No per-event budgets. No connect-rate limit. |
| **mediasoup caps** | **Open** | No producer/consumer count limits. `MEDIASOUP_MAX_OUTGOING_BITRATE` defaults to 0 (unlimited). |
| **SEC-023** username index | **Open** | `userModel.ts` indexes only `clerkId`. |
| Messages text index | Open | Regex search only. |
| Redis-backed shared state | Open (n/a as written) | Limiters, presence and locks are per process. |
| S3 bucket policy | Tooling fixed. **Live bucket not verified.** | `npm run check:s3` must be run against production (DevOps). |

### 5.3 Additional

- **Socket `azp` exemption:** the socket handshake skips the Clerk authorized-party check when the `Origin` header is absent (`realtime/index.ts:80`). This is intended for the native app, but any non-browser client gets the same exemption. **Decision needed:** accept and document, or bind native clients differently.
- **App origins widen socket CORS:** `io.ts:32-35` allows developer-registered origins in addition to `CORS_ORIGINS`. This is by design and should be documented.

---

## 6. E2EE review

The implementation uses Olm/Megolm through the Rust matrix-sdk-crypto (WASM) on the client. The server stores only public keys and opaque ciphertext. Plaintext sends are refused (`message.gateway.ts:126-133`, Verified).

### 6.1 Flows (Verified unless noted)

| Flow | Implementation | Gap |
|---|---|---|
| Device registration | First-party Clerk session only (`e2ee.routes.ts:11`). App tokens are refused twice (`registry.ts`, `e2ee.service.ts:43-46`). Keyed by `(session user, deviceId)`. Ed25519 key pinned per device. A revoked id can't be re-registered. | No step-up auth or approval from an existing device. No cap on devices per user. |
| One-time / fallback keys | Up to 100 keys per upload. Atomic claim. Claims limited to conversation peers (sensitive limiter). | No total cap per device. Upload is not on the sensitive limiter. A peer can drain one-time keys (first-message protection then falls back; Matrix accepts the same trade-off). |
| Olm sessions | Client-side through the SDK. The server relays only to peers, with an allow-listed event type, ≤64 KB per message, dedupe and TTL. | Fan-out up to 1000 users × all devices per call. No per-recipient queue cap. |
| Megolm sharing | Keys go to all non-revoked devices of server-listed members (`EncryptionSettings()` defaults). | **No trust gate.** Membership on the server is the authority (trust-on-first-use, TOFU). |
| Payload validation | Shape-only (`payload.ts`). | The server doesn't bind `device_id` / `sender_key` to the sender. The Angular client does (FE `e2ee.service.ts:293-297`). **Every SDK client must repeat this check.** |
| Membership change | The client invalidates the group session when the member set shrinks (`sharedWith`). | `sharedWith` lives in memory and is lost on reload. Whether matrix-sdk-crypto 18.9.0 `shareRoomKey` auto-rotates on recipient removal is **Inferred, not verified**. Must be confirmed with a test. |
| Revocation | Sets `revokedAt`, purges one-time keys and pending messages, notifies peers. | Keys the device already holds stay usable until the next rotation. **Revoke needs only a session**, so a stolen session can revoke the user's real devices and add its own. |
| Multi-device / backup | — | **No key backup.** A new device can't read history. Clearing browser storage loses all history. |
| Client key storage | IndexedDB store encrypted with a random passphrase, wrapped by a non-extractable WebCrypto key. | No user secret. Any script on the origin (XSS, a malicious extension) can use the keys. The CSP is the main defence. |
| Verification | Local fingerprint comparison only. | No cross-signing. Trust is not synced across devices or enforced. |

### 6.2 Third-party / SDK participation

- API scopes (app ∩ grant ∩ token) and key authorization (first-party session + device + membership) are **fully separate today**. This matches D3.
- `messages:write` is in the scope catalogue and offered on consent screens ("Send text messages over Socket.IO"). However, `realtime/index.ts:195-199` refuses **every** app `sendMessage`. **The scope grants nothing.**
  - `docs/integrations/examples/backend/server.ts:25` still requests it.
  - The browser example and `scoped-user-tokens.md` correctly say sending is unavailable.
- **Required design (Phase 4, not implemented):** an SDK running *on the end user's device* registers its own Olm device and runs the same machine on-device.
  - Needs a delegated device-registration grant, kept separate from API scopes (proposed: a distinct `e2ee:device` consent).
  - The device must be visibly labelled by app in the user's device list.
  - The user must be able to revoke it independently.
  - Server-held app credentials must **never** obtain a device. A server-side "send as user" stays impossible by design.
- **Prerequisites before third-party messaging:**
  1. Step-up or existing-device approval for new devices and for revocation.
  2. A trust policy for room-key sharing.
  3. A verified rotation-on-removal test.
  4. Fixing the stale `messages:write` consent text now.

### 6.3 E2EE severity ranking

1. **High:** a stolen session can register a device and silently receive future room keys (no device approval, no trust gate, no cross-signing).
2. **High:** a stolen session can revoke all of the user's devices.
3. **Medium:** rotation after member removal is not verified across reloads.
4. **Medium:** key and queue growth is unbounded (one-time keys, to-device fan-out).
5. **Medium:** no backup or recovery.
6. **Medium:** keys can be used by any script on the origin.
7. **Low–Medium:** sender binding is enforced on the client only.
8. **Low:** the `messages:write` scope is misleading.

---

## 7. Proposed fixes: SEC-005 and SEC-015 (not yet implemented)

### 7.1 SEC-005: mediasoup transports allocated before call authorization

**Root cause (Verified):**

- `presence.gateway.ts:28` creates a mediasoup peer for **every** connected socket.
- `media.gateway.ts:55-86` `createTransportHandler` then allocates a WebRtcTransport (ICE/DTLS ports on the single worker) without checking `peer.callId`, `isActiveParticipant` or the lobby.
- `connectTransport` (`:91`) and `restartIce` (`:115`) are not gated either.
- `produce` and `consume` are effectively gated through `peer.callId`.

Impact: any authenticated socket can allocate and churn media resources, and lobby-waiting attendees hold transports before admission.

**Client dependency (Verified):** the Angular client creates transports **before** joining.

- `group-call.component.ts:447` calls `mediasoupService.initialize()`, which creates both transports (`mediasoup.service.ts:151-152`). Only then does it call `joinCall`.
- `initialize()` has no other callers.

**Proposed change (minimal):**

1. **Backend, `media.gateway.ts`:** in `createTransportHandler`, `connectTransport` and `restartIce`, refuse unless `peer.callId` is set (it is set only by a successful, non-lobby `mediasoup:joinCall`). Return `{ error, code: "NOT_JOINED" }`.
2. **Frontend, `mediasoup.service.ts` and `group-call.component.ts`:** split `initialize()` into:
   - `loadDevice()`: router capabilities, before join.
   - `createTransports()`: called after a successful non-lobby `joinCall`.

   The existing lazy recv-transport re-creation (`:638`) runs after join, so it is unaffected.
3. **Release coupling:** the backend gate breaks older clients, so ship both changes in the same release. Alternatively, put the backend check behind a flag (`MEDIA_REQUIRE_JOIN`, default on) for one release so stale cached SPAs can still connect.
4. **Tests:**
   - Backend, `test/socket-isolation.test.ts`: `createSendTransport` before join is refused with `NOT_JOINED`; the same for `connectTransport`; a lobby-waiting user is refused. A positive test needs a mediasoup worker in tests, which still has to be checked.
   - Frontend, `mediasoup.service.spec.ts` / `group-call.component.spec.ts`: transports are created only after a successful join, and not while in the lobby.

### 7.2 SEC-015: fail closed when auth origin config is missing in production

**Root cause (Verified):**

- `CORS_ORIGINS` is already fail-closed (`config/security.ts:41-58`, thrown at startup from `server.ts:37`).
- `CLERK_AUTHORIZED_PARTIES` is only logged as a warning (`config/auth.ts:56-57`) and is absent from `productionConfigProblems` (`security.ts:70-83`).
- When it is unset, Clerk's `azp` check is skipped on REST (`app.ts:75`) and sockets (`realtime/index.ts:80`) (Inferred from the code).

**Proposed change (minimal):**

1. `config/security.ts`: add `CLERK_AUTHORIZED_PARTIES` to `productionConfigProblems`. In production it is required, `https` only, with no `*` and no paths. This reuses the existing origin validation used for `CORS_ORIGINS`.
2. `config/auth.ts`: remove the production warning branch. Do **not** throw at import time, because tests and `check.ts` import this module.
3. `config/check.ts`: the FAIL line comes automatically if the check runs through `productionConfigProblems`. Confirm this.
4. Tests in `test/security-config.test.ts`:
   - Add `CLERK_AUTHORIZED_PARTIES` to `PROD_OK`. The existing "no problems" assertions would otherwise fail.
   - Add cases for missing, `http://` and `*` values.
5. **Deployment impact:** production fails to start if the variable is unset. DevOps must confirm it is set in every production environment **before** deploying.

**Out of scope, decision needed:** the Origin-less socket exemption (§5.3).

---

## 8. Dependency map

```
Baseline commit (§2.4)
   └─► Phase 2 quick fixes (SEC-005, SEC-015, SEC-013, dead code, caps)
          ├─► Phase 1 domain model + authorization matrix (mostly documenting existing tenancy/org rules)
          │      ├─► Phase 3 messaging contract (versioned socket events)
          │      │      └─► Phase 4 E2EE hardening (device approval, trust policy, rotation test, backup)
          │      │             └─► Phase 5 developer platform (delegated device grant, fix messages:write)
          │      │                    └─► Phase 7 SDK ─► Phase 8 Angular UI package ─► Phase 11 console + docs
          │      └─► Phase 9 entitlements (provider-independent) ─► Phase 10 personal/business completion
          └─► Phase 6 media (worker pool, SEC-007/008, TURN, caps) — parallel track
Phase 12 production readiness — needs infra repo access (D2)
```

---

## 9. Recommended sequence and acceptance criteria

| Step | Work | Acceptance |
|---|---|---|
| 0 | Baseline commits (§2.4), `.gitattributes` | Working tree clean. Backend 252/252 and frontend 96/96 still pass on the new HEAD. |
| 1 | SEC-015 | New tests pass. Production refuses to start without the variable. |
| 2 | SEC-005 (backend + frontend) | Refusal tests pass. Manual group call with a lobby works in two browsers. |
| 3 | SEC-013, delete unused `getAllUsersExceptCurrentUser`, `GET /meetings/code` on the sensitive limiter, `maxTimeMS` on search, cap legacy history to the `/v1` limit | Each change has a regression test. |
| 4 | Remove `messages:write` from consent screens and examples until Phase 5 | Consent UI and examples no longer offer a scope that does nothing. |
| 5 | Phase 1 domain/authorization matrix document | Reviewed by the backend lead. |
| 6 | E2EE: rotation-on-removal test, device approval, revoke step-up, key and queue caps | Security review sign-off before any third-party messaging. |
| 7 | Media track: worker pool, no `process.exit`, per-peer caps, multi-socket delivery (SEC-007/008) | Worker-death test: API and sockets survive. |
| 8 | Entitlement design (D4) | Design reviewed. Enforced server-side, in one central place. |

---

## 10. Decisions required

| Decision | Owner |
|---|---|
| Confirm the commit split and authorship of the working tree | Working-tree author / tech lead |
| Infrastructure repository location and environment mapping | DevOps |
| Run `npm run check:s3` against the production bucket. Confirm `SOCKET_ADAPTER=mongo` and `CLERK_AUTHORIZED_PARTIES` are set in production. | DevOps |
| Origin-less socket exemption for native clients: accept or redesign | Security / backend lead |
| E2EE trust model: stay with server-membership TOFU, or require device verification for key sharing | Security lead / product owner |
| Key backup / recovery approach (needs a user secret or recovery key) | Product owner / security lead |
| Delegated device grant (`e2ee:device`) for SDK clients | Security lead / backend lead |
| Disposal of `webrtc-BE/src/uploads/` personal documents | Data owner |
