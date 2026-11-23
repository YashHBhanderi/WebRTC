# Clerk webhooks (organizations, memberships, users)

Endpoint: `POST /webhooks/clerk` (also `/api/webhooks/clerk`). Code: `webrtc-BE/src/integrations/clerk-webhooks.ts`.

## Manual Clerk dashboard setup (not done by us — no live settings were changed)

1. Clerk Dashboard → **Webhooks** → **Add endpoint**: `https://<your-api-host>/api/webhooks/clerk`.
2. Subscribe to:
   - `organization.created`, `organization.updated`, `organization.deleted`
   - `organizationMembership.created`, `organizationMembership.updated`, `organizationMembership.deleted`
   - `user.updated`, `user.deleted`
3. Copy the endpoint's **Signing Secret** (`whsec_…`) into the server environment as `CLERK_WEBHOOK_SIGNING_SECRET`. Never commit it. Without it the endpoint answers `503` and logs that once.
4. nginx must forward the request body unchanged (no body rewriting). The route reads the raw bytes.
5. Use Clerk's "Send test event" and check the server log and the `clerk_webhook_events` collection.

## Security

- **Signature:** verified by Clerk's `verifyWebhook` (Svix) over the raw body, before anything else. Missing, invalid or wrong-key signatures, a tampered body, and timestamps outside Svix's tolerance (replays) get `400` and are not processed. Error responses give no detail.
- **No session auth on this route:** the signature is the authentication. It still goes through the global per-IP rate limit and the 1 MB body cap.
- **Webhooks never grant permissions.**
  - The membership role stored from a webhook is display-only. Access decisions use the role in each verified session token.
  - Organization payloads only set name and slug, never status or policies.
- **No payloads in logs:** the ledger stores the event id, type, timestamps, attempts and a short outcome.

## Processing guarantees

| Concern | Behaviour |
| --- | --- |
| Duplicate delivery | The `svix-id` is the ledger primary key. A processed id answers `200 {duplicate: true}` and is not re-applied |
| Concurrent duplicate | A second worker gets `409` while the first is processing; Svix retries later |
| Out of order | Each tenant and membership stores `clerkEventAt`. Older events are ignored (`outcome: "stale"`), so a late `created` can't undo a `deleted` |
| Transient failure | `500`, ledger marked `failed`; Svix's retry re-runs it (`attempts` incremented). A stuck `processing` row is retried after 2 minutes |
| Signed but malformed | `400`, ledger marked done (`malformed`). Retrying won't help |
| Unknown local user | `200`, `skipped:user-not-provisioned`. Users are created locally on their first sign-in; no account is invented from a webhook |
| Ledger retention | TTL index, 30 days |

## Effects

| Event | Effect |
| --- | --- |
| `organization.created` / `.updated` | Upsert tenant name and slug (secure default policies on create). Never resurrects a deleted tenant |
| `organization.deleted` | Tenant `status: "deleted"`. All memberships become `removed`. Live sockets in that workspace are disconnected. **Data is kept**; deletion and retention is a separate decision |
| `organizationMembership.created` / `.updated` | Membership `active`, display role updated |
| `organizationMembership.deleted` | Membership `removed` with `removedAt` (tombstone). That user's live sockets in the workspace are disconnected |
| `user.updated` | `clerkBanned` from the payload. Banned users are hidden from directories and disconnected |
| `user.deleted` | `clerkDeletedAt` set, all memberships removed, all sockets disconnected, hidden from directories |

## Immediate revocation (not only directory sync)

Clerk session tokens stay valid for about a minute after a membership is removed. On every request and socket connection, `resolveContext` checks the membership tombstone:

- **Removed, and the token was issued (`iat`) at or before `removedAt`:** `403 You are no longer a member of this workspace`.
- **Removed, and the token was issued after the removal:** Clerk only issues such tokens if the user was re-added. The membership is reactivated.
- **Tenant deleted or suspended:** `403` for everyone.

The check is cached 15 seconds per user and workspace. Webhook handling clears the cache in the process that received it. **With several instances, the others can lag up to 15 seconds** (see the scaling notes).

## Tests (`test/clerk-webhooks.test.ts`, real Svix verification with a test-only secret)

- Signature failures: missing, forged, wrong key, tampered body, replay.
- Malformed payload.
- `organization.created` can't set status or policies.
- Duplicate delivery and out-of-order delivery.
- Webhook "admin" role grants nothing.
- Transient failure then successful retry.
- Unknown user skipped.
- Membership removal refuses old tokens (HTTP and socket), disconnects the live socket, updates the directory, leaves the global context working, and re-adding works.
- Organization deletion ends access and can't be resurrected.
- `user.deleted` clears directories.

**Not verified:** delivery from Clerk's real servers, and the dashboard configuration.
