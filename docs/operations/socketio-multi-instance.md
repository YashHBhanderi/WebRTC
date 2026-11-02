# Socket.IO across multiple backend instances

Implemented in Phase 5C. Real-time events (messages, typing, read receipts, presence, call rings and signalling, revocation) now reach users connected to **any** instance when `SOCKET_ADAPTER=mongo` is set on every instance.

## Design

- **Transport:** `@socket.io/mongo-adapter` **0.4.0** (maintained by the Socket.IO team). Peer dependency `socket.io-adapter ^2.5.2`; installed 2.5.5 with `socket.io` 4.8.1 and the `mongodb` 6.13 driver (no second driver copy). It uses MongoDB **change streams**, so it needs a **replica set** or sharded cluster. MongoDB Atlas always is one; local dev here is a single-node replica set (`rs0`).
- **Events collection:** `socket_io_events`, with a TTL index on `createdAt` (1 h). Events are needed for seconds only.
- **Authorization is not delegated to the adapter.**
  - Per-user events are re-published as "deliver to user X" (`io.serverSideEmit`). Each instance delivers only to **its own** sockets, after the same checks as on one instance: the socket's verified workspace, conversation visibility (`visibleIn`) and developer-app scopes.
  - Room broadcasts (conversation and call rooms) cross instances through the adapter. Rooms are joined only after the existing membership checks.
- **Presence:**
  - each first-party socket joins `user:<id>`;
  - "is connected" is answered cluster-wide (`fetchSockets`), so closing one instance's connection does not mark a user offline while they are connected elsewhere;
  - presence fan-out is judged on the instance holding each viewer's socket.
- **Revocation:** a Clerk webhook processed on one instance disconnects matching sockets on every instance immediately. The periodic revalidation sweep (`SOCKET_REVALIDATE_MS`) remains as the fallback.
- **Single-instance guard:**
  - every instance writes a heartbeat to `runtime_instances` (TTL 60 s);
  - if another live instance is seen and either one runs without the adapter, an error is logged and `GET /health/ready` returns **503** (`multiple instances without a shared Socket.IO adapter`).

## Configuration

| Variable | Value |
|---|---|
| `SOCKET_ADAPTER` | `mongo` on **every** instance when running more than one. Unset = single instance. Any other value refuses to start. |
| `MONGO_URI` | Must point to a replica set (e.g. `...?replicaSet=rs0`, or Atlas). Startup fails with a clear error otherwise. |
| `MEMBERSHIP_CHECK_CACHE_MS` | `0` recommended with several instances (immediate HTTP revocation everywhere) |

Load balancer:
- **Sticky sessions** for `/socket.io` (polling fallback needs them; websocket-only clients do not);
- `GET /health/ready` for readiness, `GET /health/live` for liveness.

## Verified (automated, two real processes, in-memory replica set): `test/multi-instance.test.ts`, 9/9

- A message sent on A is delivered live to the recipient on B.
- Typing and read receipts cross instances.
- Presence: a contact on B sees the user come online on A; one instance closing does not mark them offline.
- Calls: ring on B; accept on B reaches the caller on A; leaving ends it for both.
- Workspace context is enforced on the receiving instance (a global message never reaches a workspace socket on B).
- Cross-tenant: a socket of another tenant on B never receives a tenant conversation's events.
- External conversation: the guest's personal socket on B gets it; their own-workspace socket on B does not.
- Membership revocation via the Clerk webhook on A disconnects the member's socket on B immediately (the sweep on B was off).
- Readiness: an instance without the adapter is detected (`/health/ready` → 503).

Mutation checks:
- removing the cross-instance publish fails 5 of these tests;
- removing the per-socket visibility check fails 2.

**Not yet verified:** the real two-instance staging run with real Clerk sessions. The staging environment was lost with the machine restart and must be re-created; see the Phase 5C report.

## Known limitations

| Limitation | Impact | Status |
|---|---|---|
| **Media (mediasoup) is per instance.** Signalling crosses instances, but a call's media router lives on one instance. Participants whose sockets are on different instances will ring and connect signalling, but media will not flow. | Calls between users on different instances fail at media level | **Blocker for multi-instance calls.** Needs per-call routing (send all participants of a call to the instance hosting its router, e.g. LB routing by call id) or mediasoup `pipeToRouter` across hosts. Not implemented. |
| "One primary socket per user" is per instance | A user with devices on two instances receives events on both (multi-device) | Acceptable; documented |
| Call takeover ("answered on another device") is per instance | The other device may keep ringing until its ring times out | Minor |
| Adapter events while MongoDB is unavailable | Publishing fails (logged); local delivery still works; cross-instance events in that window are lost (no replay) | Clients recover state on reconnect (pending rings, history reload) |
| Rate limits stay per instance | Effective limit = limit × instances | Documented; shared limits only if needed |

## Operations

- Monitor `socket_io_events` size: it should stay small (TTL 1 h), and growth means change streams are stalled.
- After a MongoDB primary failover the adapter resumes its change stream (resume token). Events emitted during the failover may be lost.
