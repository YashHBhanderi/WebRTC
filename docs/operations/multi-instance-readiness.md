# Multi-instance readiness

Tested 2026-10-22 with two backend instances on one MongoDB (staging). **Verdict: not ready for more than one instance.** One instance is the supported topology until B2 below is fixed.

## Measured behaviour

| Concern | Result | Status |
|---|---|---|
| Same Clerk session accepted by both instances | Yes | Staging |
| Message stored on A, readable through B | Yes | Staging |
| **Real-time event from A reaches a socket on B** | **No.** Messages, call rings, presence and typing are emitted per process. | **FAILED** |
| Membership removal (webhook on A): live socket on B | Disconnected after 746 ms (revalidation sweep, `SOCKET_REVALIDATE_MS`) | Staging |
| Membership removal (webhook on A): HTTP on B | Pre-removal token still accepted right after; up to `MEMBERSHIP_CHECK_CACHE_MS` (default 15 s) | By design. Set `0` for immediate revocation |
| Consent single use, approvals split across instances | 10 concurrent → exactly 1 success | Staging |
| Credential rotation, split across instances | 6 concurrent → exactly 1 success | Staging |
| Per-IP rate limits | Enforced per instance; effective limit = limit × instances | Staging |
| Daily app message quota | Shared (MongoDB conditional update) | Mock only |
| Webhook workers in parallel | Lease-based claims and a unique (endpoint, event) index | Mock only (no approved destination) |
| Recording lifecycle rule on startup | Read-modify-write. Two instances starting together could drop each other's change to a *different* rule. | Code review |
| mediasoup | Each instance has its own workers. A call's participants must reach the instance hosting the room. | Code review. Needs sticky routing per call |
| Webhook origin cache, scope cache, tenant cache | Per process, short TTLs (60 s / 30 s) | Code review |

## Is Redis (or another shared mechanism) required?

**A shared pub/sub for Socket.IO is required** before running more than one instance. That conclusion comes from the failed cross-instance delivery test, not from the roadmap. Options:

1. **MongoDB adapter** (`@socket.io/mongo-adapter`). Uses the existing MongoDB, so no new infrastructure. Its exact topology requirements (replica set or capped collection) must be confirmed against the current version's docs before adopting it.
2. **Redis adapter.** A new service to run and secure.

Everything else that matters for correctness (consent, rotation, quotas, tombstones, webhook leases) already coordinates through MongoDB and passed under concurrency.

Rate limits would become global only with shared state. That is optional; decide from the instance count.

## Also required for multiple instances

- Load balancer with **sticky sessions** for Socket.IO, and per-call routing for mediasoup (all participants of a call on the instance hosting its router).
- Identical `PLATFORM_TOKEN_SECRET`, `LEGACY_FILES_SECRET` and `WEBHOOK_SECRET_KEY` on every instance.
- Shared `LEGACY_UPLOADS_DIR` (read-only mount), or legacy files served from one instance.
- `MEMBERSHIP_CHECK_CACHE_MS=0` if immediate cross-instance HTTP revocation is required.
- NTP on every host.
- Graceful shutdown or restart under traffic: **not tested**.

## Process-crash limitations (MongoDB-backed webhook queue)

- A crash mid-delivery leaves the row `delivering`. It is retried after its lease expires, so the receiver may get it twice: at-least-once delivery, and receivers must deduplicate on `SpreeWe-Webhook-Id`.
- Events published in the `setImmediate` window before the row is written are lost on a crash. Webhooks are best-effort notifications, not a transactional outbox.
- The queue throughput limit has not been measured.
