# Fail-closed tenant context

Phase 4A replaced the Phase 2–3 behaviour, where a scoped query with no context ran **unfiltered**, with fail-closed rules.

## Rules

Every query or insert on a tenant-scoped model needs one of two contexts. With neither, it throws `TenantContextError`.

| Context | Created by | Effect on scoped models |
| --- | --- | --- |
| **User** — `{ userId, tenantId \| null, role }` | `verifyToken` (HTTP), Socket.IO handshake. Derived only from the verified Clerk session | Filtered to the active workspace (`tenantId`), or to the global context (`tenantId: null`) |
| **System** — `{ kind: "system", reason }` | Code only: `runAsSystem(fn, reason)` | Unfiltered. Never created from request input |
| *(none)* | — | **Refused** (`TenantContextError`, logged as a server error, generic 500 to the client) |

**Scoped models:** `Conversation`, `Message` (new in 4A), `calls`, `Meeting`, `Recording`, `Notification`, `SavedMessage`.

**Creation rules:**
- A new conversation in a user context is stamped with that context's scope.
- In a system context the code must set `tenantId` and `scope` explicitly, or the insert is refused.
- Records that belong to a conversation copy its scope. A record with no conversation needs a user context.

**Global operations are explicit.** A user whose session has no active organization gets a user context with `tenantId: null`. That is an authorized global context, not a fallback.

## Where system context is established (reviewed list)

| Path | Reason string |
| --- | --- |
| `runMigrations()` (server start and `npm run migrate`) | `migrations` |
| `migrations/legacy-media.ts` script | `migration:legacy-media` |
| `recordingService.recoverOnStartup()` at boot | `startup-recovery` |
| Meeting reminder interval | `meeting-reminders` |
| Recording compose queue | `recording-pipeline` |
| Transcription queue | `transcription-pipeline` |
| Clerk webhook processing and its ledger | `clerk-webhook`, `clerk-webhook-ledger` |
| Membership projection, revocation check, directory and scope-cache lookups | `membership-*`, `directory`, `internal-lookup` |

## Context propagation

- **HTTP:** `verifyToken` runs the rest of the request inside the context. Multer re-enters it after parsing.
- **Socket.IO:** every listener registered on a socket, including lifecycle events like `disconnect` that Socket.IO emits outside any request, runs in that socket's context. `socket.on` is wrapped per connection in `realtime/index.ts`.
- **Timers** started inside a request or socket event keep that context (Node's AsyncLocalStorage propagates through `setTimeout`/`setInterval`).
- **Bug found and fixed:** Mongoose queries are lazy. `runAsSystem(() => Model.find())` used to return the query and run it later, outside the context. That made such lookups run in the caller's context. `runWithContext`/`runAsSystem` now start the query inside the context.

## Bypass review

| Path | Status |
| --- | --- |
| `find / findOne / count / distinct / update* / delete* / findOneAnd* / replaceOne` | Filtered or refused (query middleware) |
| `aggregate` | `$match` prepended, or refused |
| `insertMany`, `save` (new docs) | Scope stamped in `pre("validate")`, or refused |
| `doc.save()` / `doc.deleteOne()` on loaded docs | Not intercepted, but the doc was loaded through a scoped query |
| `populate` | Runs a `find` on the target model → filtered |
| Raw driver (`Model.collection.*`, `mongoose.connection.db`) | **Not interceptable.** Allowed only in `migrations/` and `tenancy/consistency.ts`; enforced by a static test |
| `$lookup` into scoped collections | Allowed only in `services/conversationService.ts` (root is the scoped Conversation) and `tenancy/consistency.ts`; enforced by a static test |
| `bulkWrite` on scoped models | None exist; the static test fails if one is added |

## Defence in depth: message scope

Messages now carry their conversation's `tenantId`/`scope` (migration `2026-10-21-message-scope`). A copy can only disagree through raw writes or an interrupted backfill:

- **Detection:** `checkScopeConsistency()` reports mismatched and orphaned records per model. It runs inside the migration (result in the ledger) and can be run as system.
- **Effect of a mismatch:** fail-closed. The record is invisible in its conversation's context. It can go missing but cannot leak.
- **Repair:** `checkScopeConsistency({ fix: true })` copies the conversation's scope.

## Tests

`test/fail-closed.test.ts`:
- No-context reads and writes are refused.
- System and global operations work.
- No context leaks across 40 interleaved async tasks or 30 concurrent HTTP requests from two workspaces.
- Aggregation filtering.
- The static bypass scan.
- The consistency check and repair.

**Negative check:** making the no-context case `return` instead of `throw` fails the refusal test.

## Remaining risks

- Callbacks fired by mediasoup or child processes outside any request or socket context would now throw if they touched scoped models. Reviewed paths do not (`endTrack` is in-memory; the pipelines run as system), but this is **untested against a real mediasoup worker or FFmpeg**.
- A future developer can still call `runAsSystem` from request code. Every use carries a reason, which makes review greppable, but nothing technically prevents misuse.
