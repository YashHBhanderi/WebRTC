# Production audit — master TODO

Read-only security, scalability, and production-readiness review of MeetChat (`webrtc-BE` + `webrtc-FE`). Do not implement until an item is explicitly chosen.

Legend: **P0** before public production · **P1** before significant growth · **P2** important · **P3** long-term.

---

## SECURITY

- [ ] **SEC-001** · P0 · CRITICAL · `webrtc-BE/src/app.ts`
  - Change: Cap `express.json` / `urlencoded` from `1000mb` to 1–5 MB.
  - Reason: One request can pin Node heap (memory DoS).
  - Dependencies: Align nginx `client_max_body_size`.

- [ ] **SEC-002** · P0 · HIGH · `webrtc-BE/src/app.ts`, `server.ts`
  - Change: Add Helmet (or equivalent headers) and per-route / per-IP / per-user rate limits.
  - Reason: No app-layer abuse protection (upload, search, meeting codes, floods).
  - Dependencies: WAF / reverse proxy limits.

- [ ] **SEC-015** · P0 · LOW · `webrtc-BE/src/config/auth.ts`, `server.ts`
  - Change: Fail closed in production if `CORS_ORIGINS` or `CLERK_AUTHORIZED_PARTIES` is unset.
  - Reason: Token/origin binding is currently warn-only.
  - Dependencies: Ops env config.

- [ ] **SEC-010** · P2 · MEDIUM · `webrtc-BE/src/app.ts`
  - Change: Remove unauthenticated `express.static("/uploads")` in production.
  - Reason: Legacy files are served without membership checks.
  - Dependencies: Migrate leftover local files to S3.

---

## AUTHENTICATION

- [ ] **SEC-018** · P3 · LOW · `webrtc-FE/src/app/core/services/auth.service.ts`
  - Change: Store only the minimum profile fields in `localStorage` (or memory).
  - Reason: XSS can read email / user JSON (Clerk session token is already in memory).
  - Dependencies: CSP.

- [ ] **—** · P2 · — · Clerk dashboard / org settings
  - Change: Enforce MFA for the organization.
  - Reason: Account takeover of privileged users.
  - Dependencies: Clerk plan.

---

## AUTHORIZATION

- [ ] **SEC-003** · P0 · HIGH · `webrtc-BE/src/services/userServices.ts`, `controllers/userController.ts`
  - Change: Return a public profile projection; paginate; stop `User.find()` of the whole directory (`/web/users`, `/web/users/except-current`, `/web/user/:userId`).
  - Reason: Any signed-in user can harvest emails and `clerkId` (BOLA).
  - Dependencies: Frontend directory consumers.

- [ ] **SEC-004** · P0 · HIGH · `webrtc-BE/src/realtime/gateways/call.gateway.ts`, `services/meeting-controls.service.ts` (`mayProduce`)
  - Change: Require `isActiveParticipant` (joined) on `screen:join` / `start` / `stop` / `getState`; do not allow produce when `load()` fails or the call is not a group.
  - Reason: Knowing a `callId` is enough to join the Socket.IO room and grab the share lock.
  - Dependencies: None.

- [ ] **SEC-011** · P2 · MEDIUM · `webrtc-BE/src/services/conversationService.ts`
  - Change: Reject `POST /conversations` if the pair is blocked either way; validate `receiverId`.
  - Reason: REST bypasses block checks that sockets/uploads already apply.
  - Dependencies: `block.service.ts`.

- [ ] **SEC-013** · P1 · MEDIUM · `webrtc-BE/src/realtime/group.events.ts`, `services/call.service.ts`
  - Change: When a member is removed from a group, remove them from active `Call.participants` and drop media.
  - Reason: Ex-members can still pass `isActiveParticipant` if they have the `callId`.
  - Dependencies: Call leave / mediasoup `leaveCall`.

- [ ] **SEC-016** · P2 · LOW · `webrtc-BE/src/services/conversationService.ts`
  - Change: Drop `email` from `publicUsers` aggregation projections.
  - Reason: Group/1:1 APIs expose every member’s email.
  - Dependencies: Frontend if it displays email from those payloads.

- [ ] **SEC-017** · P2 · LOW · `webrtc-BE/src/services/recording.service.ts`
  - Change: Restrict transcript retry to host/moderator; cap attempts.
  - Reason: Any conversation member can burn CPU / ASR quota.
  - Dependencies: None.

---

## API

- [ ] **SEC-014** · P1 · MEDIUM · `webrtc-BE/src/services/meeting.service.ts`, meeting code routes
  - Change: Rate-limit `GET/POST /meetings/code/:code`; require password or invite for open join; consider longer codes.
  - Reason: Authenticated guessing of unpassworded meeting links.
  - Dependencies: Redis (or in-memory limiter for single node).

- [ ] **SEC-021** · P1 · MEDIUM · `webrtc-BE/src/services/message.service.ts`
  - Change: Cursor pagination; drop `safeLimit` of 2000 and large `skip()`.
  - Reason: Heavy populate + presign per page; skip tax grows with history.
  - Dependencies: Frontend message loader.

- [ ] **—** · P1 · — · `webrtc-BE/src/services/search.service.ts`
  - Change: Tighter limits and timeouts on message/user search.
  - Reason: Regex / `$or` over membership is expensive at scale.
  - Dependencies: Username / text indexes.

---

## WEBSOCKET

- [ ] **SEC-006** · P1 · HIGH · `webrtc-BE/src/realtime/io.ts`
  - Change: Socket.IO Redis adapter (or equivalent pub/sub).
  - Reason: `emitToUser` is a process-local `Map`; a second instance drops DMs and call invites.
  - Dependencies: Redis. **P0 if more than one Node process is already running.**

- [ ] **SEC-008** · P1 · HIGH · `webrtc-BE/src/realtime/gateways/presence.gateway.ts`
  - Change: `userId → Set<socketId>` instead of one socket per user.
  - Reason: Second tab/device overwrites `userSockets` and steals delivery.
  - Dependencies: Frontend multi-tab behavior.

- [ ] **SEC-012** · P1 · MEDIUM · `webrtc-BE/src/realtime/io.ts`
  - Change: Shrink `maxHttpBufferSize` from 100 MB to match text/metadata (files already go through HTTP upload).
  - Reason: Huge socket payloads are an easy DoS.
  - Dependencies: Confirm no socket file upload path.

- [ ] **—** · P1 · — · `webrtc-BE/src/realtime/gateways/*`
  - Change: Per-event rate limits (especially `sendMessage`, typing, transports, connects).
  - Reason: Only call reactions are throttled today.
  - Dependencies: Redis for multi-instance; in-memory OK on one box.

---

## CHAT

- [ ] **—** · P2 · — · Receipts / `message.service` / `receipts.service.ts`
  - Change: Avoid per-message write storms for delivered/seen on large groups.
  - Reason: Write amplification as membership grows.
  - Dependencies: Product rules for read receipts.

- [ ] **—** · P3 · — · Frontend message rendering
  - Change: Unfurl / phishing warnings for links (not XSS; social).
  - Reason: User-generated URLs in chat.
  - Dependencies: Product copy.

---

## WEBRTC

- [ ] **SEC-004** · P0 · HIGH · (see Authorization)
  - Same membership checks on screen-share signaling.

- [ ] **—** · P2 · — · `webrtc-BE/src/utils/network.ts`
  - Change: Shorten TURN credential TTL (default 86400 s is long).
  - Reason: Stolen relay credentials last a day.
  - Dependencies: coturn `TURN_SECRET`.

---

## MEDIASOUP

- [ ] **SEC-005** · P0 · HIGH · `webrtc-BE/src/realtime/gateways/media.gateway.ts`
  - Change: Refuse `createSendTransport` / `createRecvTransport` until `mediasoup:joinCall`.
  - Reason: ICE/DTLS allocations before call authorization.
  - Dependencies: Frontend connect order.

- [ ] **SEC-007** · P1 · HIGH · `webrtc-BE/src/services/mediasoup.service.ts`
  - Change: Multiple workers; do not `process.exit(1)` on worker death; consider a dedicated media process.
  - Reason: One worker/router; SFU crash takes REST and sockets with it.
  - Dependencies: Ops / process model.

- [ ] **—** · P1 · — · `mediasoup.service.ts` / `network.ts`
  - Change: Cap producers, consumers, and outgoing bitrate (incoming cap exists; outgoing default is 0).
  - Reason: Unbounded media resources per peer.
  - Dependencies: Config / FE simulcast.

---

## DATABASE

- [ ] **SEC-023** · P1 · LOW · `webrtc-BE/src/models/userModel.ts`
  - Change: Index `{ username: 1 }` for user search.
  - Reason: `User.find({ username: regex })` has no supporting index.
  - Dependencies: None.

- [ ] **—** · P1 · — · messages collection
  - Change: Atlas Search or text index for message search (regex `$or` today).
  - Reason: Unindexed content search will not scale.
  - Dependencies: Atlas or equivalent.

- [ ] **—** · P2 · — · messages / files
  - Change: Retention or archive policy.
  - Reason: Unbounded message and attachment growth.
  - Dependencies: Product.

---

## REDIS / CACHE

- [ ] **SEC-006** · P1 · HIGH · Socket.IO Redis adapter (see WebSocket).

- [ ] **—** · P1 · — · Redis
  - Change: Use for rate limits, presence, lobby / screen-share locks, identity cache.
  - Reason: Those stores are process-local Maps today.
  - Do not: store message bodies or media in Redis.
  - Dependencies: Redis deployment.

---

## FILE / S3

- [ ] **—** · P2 · — · `webrtc-BE/src/config/storage.ts` / IAM
  - Change: EC2 instance profile instead of long-lived access keys in `.env`.
  - Reason: Key leak = bucket access.
  - Dependencies: IAM role.

- [ ] **—** · P1 · — · S3 bucket policy
  - Change: Confirm public `GetObject` is prefix-only (`…/avatar/*`), chat and recordings private.
  - Reason: Accidental public bucket would expose all objects.
  - Dependencies: AWS.

- [ ] **—** · P2 · — · Upload pipeline
  - Change: Malware scan for allowed ZIP/Office types if those stay enabled.
  - Reason: Magic-byte allow-list is not a virus scanner.
  - Dependencies: Worker / AV service.

---

## FRONTEND

- [ ] **SEC-019** · P3 · LOW · `webrtc-FE/src/app/pages/chat/chat.component.ts`
  - Change: Allowlist hostnames before `bypassSecurityTrustResourceUrl` for PDF preview.
  - Reason: Safe today if URLs are always server presigns; dangerous if API ever returns attacker URLs.
  - Dependencies: S3 / CloudFront hosts.

- [ ] **SEC-020** · P3 · LOW · `webrtc-FE/src/app/_shared/dialog/info-dialog`
  - Change: Do not bind unsanitized `[innerHTML]`, or keep the dialog unused.
  - Reason: Latent XSS if anything starts passing user HTML into `DialogService.info()`.
  - Dependencies: Confirm unused.

- [ ] **—** · P2 · — · `index.html` / nginx
  - Change: CSP that allows Clerk, S3/CloudFront, Socket.IO, and WebRTC (`media-src`, `connect-src`; camera/mic/display-capture).
  - Reason: No CSP in the app today.
  - Dependencies: Clerk origins, media URLs.

---

## INFRASTRUCTURE

- [ ] **—** · P0 · — · Reverse proxy (not in repo)
  - Change: TLS 1.2+, HTTP→HTTPS, security headers, WebSocket `/socket.io`, `client_max_body_size` ~100m.
  - Reason: No nginx/Docker/IaC in this repository.
  - Dependencies: Ops.

- [ ] **—** · P0 · — · AWS security groups
  - Change: Do not expose MongoDB (27017) or Redis; only 443, mediasoup `rtcPort` UDP/TCP, TURN as needed. App currently listens `0.0.0.0`.
  - Reason: Network exposure is deploy-time, not encoded in source.
  - Dependencies: AWS.

- [ ] **—** · P1 · — · Deploy
  - Change: Repeatable image (Docker or AMI) and documented env vars (no committed secrets).
  - Reason: `.env` is gitignored; there is no `.env.example`.
  - Dependencies: Ops.

---

## PERFORMANCE

- [ ] **SEC-021** · P1 · MEDIUM · Message history pagination (see API).

- [ ] **SEC-003** · P0 · HIGH · Stop unbounded `User.find` (see Authorization).

---

## SCALING

- [ ] **SEC-006 / SEC-007 / SEC-008** · P1 · HIGH
  - Change: Split API fleet from media fleet; Redis adapter; multi-socket presence; N mediasoup workers with room affinity.
  - Reason: Current architecture is one process. Two instances break chat and calls.
  - Dependencies: Redis, SFU nodes, load balancer / sticky or room-aware routing.

---

## MONITORING

- [ ] **—** · P1 · — · Metrics
  - Change: Track WebSocket count, mediasoup worker died, 5xx, disk, CPU, UDP/FFmpeg recording slots.
  - Reason: No Prometheus/CloudWatch/Sentry in the repo.
  - Dependencies: CloudWatch or Prometheus.

- [ ] **—** · P2 · — · Error tracking
  - Change: Sentry (or equivalent) on FE and BE.
  - Reason: Failures are console/file logs only.
  - Dependencies: DSN / secrets manager.

---

## BACKUP / RECOVERY

- [ ] **—** · P0 · — · Data
  - Change: MongoDB snapshots + S3 versioning (especially recordings).
  - Reason: No backup automation in the repository.
  - Dependencies: AWS Backup / Atlas snapshots.

- [ ] **—** · P1 · — · DR
  - Change: Document RPO/RTO and run a restore drill.
  - Reason: Worker death currently exits the whole Node process; restore path is undefined.
  - Dependencies: Ops runbook.
