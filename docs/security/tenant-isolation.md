# Tenant isolation — security notes

Automated tests passing does **not** prove isolation. This document lists what is enforced, where, and what is known to be weak, so a reviewer can check it.

## Enforcement layers

1. **Trusted context** — workspace = active organization in the *verified* Clerk session (`resolveContext`). No endpoint or socket event accepts a tenant id. Malformed org ids → 401. Suspended tenant → 403.
2. **Data-layer scope filter** — Mongoose plugin on `Conversation` (strict: own workspace, or external conversations the user is a guest of) and on `Call`, `Meeting`, `Recording`, `Notification`, `SavedMessage` (own workspace, or `external`; these queries are already per-user).
3. **Existing membership checks** — unchanged and still required (`authorization.service.ts`, gateway checks, `isActiveParticipant`, `findProducerInCall`).
4. **Inclusion rule** — in a workspace, 1:1 chats, groups, added members and meeting invitees must be active workspace members (`assertCanInclude`).
5. **Policy gates** — external chat / calls / files (`assertExternalAllowed`).
6. **Socket delivery filter** — conversation events only reach sockets whose workspace can see the conversation.

A mutation check confirmed layers 2 and 6 are each load-bearing (see `docs/testing/tenant-security-tests.md`).

## Media (WebRTC / mediasoup)

- `mediasoup:joinCall` requires an active participant (`Call` query → scope-filtered) and lobby admission.
- Transports require a peer created by `joinCall`; `consume` only allows producers of the caller's own call (`findProducerInCall`) — pre-existing, verified by test.
- TURN: short-lived HMAC credentials already exist when `TURN_SECRET` is set (`utils/network.ts`). *Correction to the Phase 1 audit, which wrongly said TURN was missing.*
- Not done: per-tenant participant/transport quotas, media-node allocation (Phase 5).

## Security gaps fixed in this increment

| Gap | Fix |
| --- | --- |
| `GET /web/users` returned every account **with email** to any user | Returns the active context's directory, no email |
| `GET /web/users/except-current` listed every user (global directory) | Workspace → members only; global → `globalDiscoverable` users only |
| `GET /web/user/:id` returned any user with email | 404 unless visible in the context; email only for yourself |
| People search listed every user | Same audience as the directory |
| `user:updated` broadcast to every connected socket | Sent to people who share a conversation |
| `user:created` broadcast to every socket | Global-context sockets only, and only if discoverable |
| No security headers | `helmet` (HSTS, nosniff, frame options…), `x-powered-by` off |
| No HTTP rate limiting | Per-IP global limit + stricter limit on upload, search, group/meeting creation, meeting join, external chat, policy changes |
| No socket abuse protection | Per-socket token bucket; dropped events + `rate-limited` notice |
| CORS allowed any origin if unset | Production refuses to start without `CORS_ORIGINS`; wildcards/paths rejected |
| JSON body limit 1000 MB | 2 MB default (`JSON_BODY_LIMIT`) |
| Socket message limit 100 MB | 5 MB default (`SOCKET_MAX_BUFFER_BYTES`) |
| Request log included query strings (search text) | Path only |
| Message delete by id had no conversation check | Must still be a member, in the right context |

## Known risks / limitations

- **ALS fail-open**: a request path that loses its AsyncLocalStorage context runs unscoped (as system). HTTP, multer and socket events are covered and tested; new code using unusual callback APIs must re-enter the context. *Mitigation idea for Phase 4: a request marker that turns "user request without context" into an error.*
- **Membership projection staleness**: a member removed in Clerk loses access immediately (their token no longer carries the org), but stays in the workspace directory and can still be *added* to workspace chats by others until a Clerk webhook sync exists. They still can't read those chats.
- **Derived records** (calls, meetings, recordings, notifications) of an external conversation are visible from any of the participant's contexts (per-user filters still apply).
- **Messages** are not stamped with `tenantId`; isolation relies on the conversation check that precedes every message query. Reviewed for list, search, delete, react, forward; any new message endpoint must check its conversation first.
- **Presence** (online/away) is shared with anyone who shares a conversation in any context. It names a user, not tenant data.
- **Legacy `/uploads` static folder** is served without authentication (pre-existing; left to avoid breaking old links).
- **Rate limits are per process and per IP** (in memory). With several instances or behind a proxy misconfiguration (`TRUST_PROXY`), limits are weaker or shared.
- **Guest join by meeting code** into workspace meetings is not supported (returns not found from other contexts).
- No security review by a second person has been done yet.

## Horizontal scaling blockers (next increment)

In-memory state that assumes one process: `userSockets`, `socketContexts`, mediasoup peers/rooms (`mediasoup.service`, `call-room.service`), `call-session` timers, presence and contacts caches, tenant/scope caches (safe to keep per instance), HTTP and socket rate-limit counters, recording live state. Needed: Socket.IO Redis adapter, shared presence store, Redis-backed rate limiting, sticky sessions or a signalling ↔ media-node map.

## Phase 4A update (2026-10-20)

Resolved:
- **ALS fail-open**: scoped models now refuse to run without a user or explicit system context. See `fail-closed-tenant-context.md`.
- **Membership projection staleness**: Clerk webhooks keep memberships current, and removal is enforced immediately through a tombstone checked against the token's `iat`. See `../integrations/clerk-webhooks.md`.
- **Messages not stamped**: messages now carry `tenantId`/`scope`, with a backfill and a consistency check.
- **New gap found and fixed**: the `screen:join` socket event let any authenticated socket join any call's room by id, receiving that call's broadcasts across workspaces. `screen:getState` revealed a call's screen sharer. Both now require an active participant.
- **Lazy-query bug**: `runAsSystem(() => Model.find())` executed outside the system context. Fixed in `runWithContext`/`runAsSystem`.

Still open:
- Derived records of external conversations are visible from any of the participant's contexts.
- Presence is shared across contexts.
- Legacy `/uploads` is public.
- Rate limits and the revocation cache are per process.
- No second-person security review yet.

## Phase 4B update (2026-10-21)

Resolved:
- **Public legacy `/uploads`:** now served only via signed, expiring links issued to authorized readers.
- **External records visible from any context:** host-workspace-only for members, personal-context-only for guests (`external-conversation-isolation.md`).
- **Presence shared across contexts:** gated per socket context.
- **Per-instance revocation:** `MEMBERSHIP_CHECK_CACHE_MS=0` gives immediate revocation via MongoDB, plus a live-socket revalidation sweep.

New surface: developer apps and scoped user tokens (`developer-platform-security.md`).

Still open:
- HTTP and socket rate limits and connection caps are per instance.
- No second-person review yet.
