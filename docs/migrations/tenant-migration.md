# Tenant migration

## Migration `2026-10-20-tenancy-foundation`

Location: `webrtc-BE/src/migrations/index.ts`. Runs once (recorded in the `migrations` collection), automatically at server start unless `RUN_MIGRATIONS=false` (then `npm run migrate`).

What it does:

1. Creates indexes for the new `tenants` and `tenantmemberships` collections.
2. Ensures indexes on `conversations`, `calls`, `meetings`, `recordings`, `notifications`, `saved_messages` (new `{ tenantId: 1 }`, plus `{ tenantId, members, isGroup }` on conversations).
3. Verification: reports how many conversations already have a non-null `tenantId` (expected `0` before tenancy).

What it does **not** do: rewrite, backfill or reassign any document.

## How existing data maps

| Existing data | After migration |
| --- | --- |
| Users | Unchanged; `globalDiscoverable` reads as default `true` |
| Conversations, messages, groups | Global (`tenantId` missing ⇒ treated as `null`) |
| Calls, meetings, recordings, notifications, saved messages | Global |
| Files in S3 | Unchanged (accessed through their conversation) |

A missing `tenantId` matches `{ tenantId: null }` in MongoDB, so global scope filters include legacy documents without a backfill. Nothing becomes visible to any workspace, because workspace filters require `tenantId` equal to that workspace's id.

## Execution status

- Run against the **in-memory test database only** (as part of the automated tests).
- **Not run** against development, staging or production data. Index builds on large collections take time; run in a maintenance window or with `RUN_MIGRATIONS=false` and `npm run migrate` during low traffic.

## Rollback

The change is additive:

1. Deploy the previous build. Old code ignores the new fields and collections.
2. Optional cleanup: drop the `{ tenantId: 1 }` indexes and the `tenants` / `tenantmemberships` collections, and delete the ledger entry `2026-10-20-tenancy-foundation` from `migrations`.
3. **Data created in workspaces after deploy** (conversations with a `tenantId`) would become visible as ordinary conversations to their members under the old code (it has no scope filter). Before rolling back once workspaces are in use, decide whether to export or delete tenant conversations: `db.conversations.find({ tenantId: { $ne: null } })`.

## Validation checklist (for a real environment)

- [ ] Migration ledger shows `2026-10-20-tenancy-foundation` with `conversations already in a workspace: 0`.
- [ ] A pre-existing user signs in without an active organization and sees all their chats, groups, meetings, call history and recordings.
- [ ] The same user with an active organization sees none of their global chats.
- [ ] `db.conversations.countDocuments({ scope: { $exists: true } })` grows only with new conversations.

## Migration `2026-10-21-message-scope` (Phase 4A)

- Ensures `{ tenantId, conversationId, createdAt }` and `{ tenantId }` indexes on `messages`.
- Stamps messages of conversations that already have a non-null `tenantId` (global chats need nothing, since a missing `tenantId` means global). Written with `updateMany` per conversation, only where `tenantId` is missing or null, so it is idempotent.
- Runs `checkScopeConsistency()` and records the mismatched/orphaned counts in the ledger result.
- **Execution status:** in-memory test database only. Not run on any real environment.
- **Rollback:** additive. Old code ignores the fields. Optionally `$unset` `tenantId`/`scope` on messages and drop the new indexes. Note that the Phase 4A code with *unstamped* messages in workspace chats would hide those messages, which is why the backfill exists.
- **New collection:** `clerk_webhook_events` (ledger, 30-day TTL).
- **New fields:** `tenants.status` can be `deleted`, plus `tenants.deletedAt`/`clerkEventAt`; `tenantmemberships.removedAt`/`clerkEventAt`; `users.clerkDeletedAt`/`clerkBanned`.

## Phase 4B migrations

- `2026-10-22-external-guest-lists`: runs `checkScopeConsistency({ fix: true })`, which copies conversation guest lists onto external records and repairs scope drift. Reports per-model counts.
- `2026-10-23-developer-platform`: indexes for apps, credentials (unique key id), grants (unique app+user, unique app+externalUserRef), revoked tokens (TTL), usage (unique app+day) and audit.
- **Execution status:** in-memory test database only.
- **Rollback:** additive. Old code ignores the new collections and the `guestUserIds` field.
