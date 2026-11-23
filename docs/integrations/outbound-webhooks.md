# Outbound webhooks (for app developers)

SpreeWe can POST events to your server when something happens in chats your app's users have authorised. This page covers what you receive and how to verify it. For the threat model, see [../security/outbound-webhook-security.md](../security/outbound-webhook-security.md).

## Events

| Event | Required app scope | `data` contains |
|---|---|---|
| `message.created` | `messages:read` | `messageId`, `conversationId`, `senderId`, `type`, `createdAt`; `content` only for `text` messages, cut at 4,000 characters. File, recording and system payloads are never included; fetch them through the API with a user token. |
| `conversation.members_added` | `conversations:read` | `conversationId`, `userIds`, `actorId` |
| `conversation.members_removed` | `conversations:read` | `conversationId`, `userIds`, `actorId`, `reason` (`removed` or `left`) |
| `call.started` | `calls:read` | `callId`, `conversationId`, `callType`, `mode`, `initiatorId`, `startedAt` |
| `call.ended` | `calls:read` | `callId`, `conversationId`, `callType`, `status`, `endedAt` |
| `recording.available` | `recordings:read` | `recordingId`, `conversationId`, `title`, `startedAt`, `durationSeconds` (no media URL) |

`GET /v1/webhook-events` returns the live catalogue.

**Who triggers a delivery.** A delivery happens only if, at the moment of the event, at least one member of the conversation:
- has an active grant for your app that includes the event's scope; and
- can see that conversation in the context your app is bound to.

The payload's `audience.userIds` lists exactly those users. Use it to choose which user token to call back with.

## Envelope

```json
{
  "id": "evt_…",
  "type": "message.created",
  "createdAt": "2026-10-22T10:00:00.000Z",
  "appId": "…",
  "tenantId": "… or null",
  "data": { "…": "…" },
  "audience": { "userIds": ["…"] }
}
```

Bodies are capped at 64 KB.

## Headers and signature verification

```
SpreeWe-Webhook-Id:        dlv_…   (unique per delivery; same value on every retry)
SpreeWe-Webhook-Event:     message.created
SpreeWe-Webhook-Timestamp: 1792658400      (Unix seconds)
SpreeWe-Webhook-Signature: v1=<hex>[ v1=<hex>]
```

The signature is `hex(HMAC-SHA256(secret, "<id>.<timestamp>.<raw body>"))`. During a secret rotation the header carries one `v1=` entry per valid secret; accept the request if any entry matches.

To verify a request:
1. Use the **raw** request body. Do not re-serialise it.
2. Reject the request if the timestamp is more than 5 minutes from your clock.
3. Compare signatures in constant time.
4. Deduplicate on `SpreeWe-Webhook-Id`. Delivery is at-least-once, so the same id can arrive more than once.

Example (Node):

```ts
import crypto from "crypto";
function verify(secret: string, id: string, ts: string, sigHeader: string, raw: string): boolean {
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${id}.${ts}.${raw}`).digest();
  return sigHeader.split(" ").some((p) => {
    const hex = p.startsWith("v1=") ? p.slice(3) : "";
    const got = Buffer.from(hex, "hex");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}
```

## Endpoint lifecycle

1. **Create.** Send `POST /v1/apps/:appId/webhooks` with `{ url, events, confirm: "<app name>" }`.
   - The signing secret (`swh_…`) is returned **once**.
   - `events` must be within your app's scopes.
   - Limit: 5 endpoints per app.
2. **Verify.** Send `POST …/webhooks/:endpointId/verify`. SpreeWe posts a signed `webhook.verification` event with `data.challenge`. Answer with a 2xx status and either `{"challenge":"<value>"}` or the raw value. Only then does the endpoint become `active`. Changing the URL resets it to `pending_verification`.
3. **Rotate.** Send `POST …/rotate-secret` with `{ confirm, keepOldSeconds? }`. A new secret is returned once. The old secret keeps signing for `keepOldSeconds` (default 86,400; use 0 to revoke immediately).
4. **Disable / enable.** Re-enabling returns the endpoint to `pending_verification`, so it must pass the challenge again.
5. **Delete.** Pending deliveries are cancelled.

## Retries, dead letters and auto-disable

- Any 2xx response is success.
- Anything else counts as a failure: other status codes, redirects (never followed), timeouts (10 s by default) and connection errors.
- Retries use exponential backoff: 30 s · 2^(n−1), capped at 6 h, with 50–100 % jitter.
- After 8 attempts the delivery becomes `dead`. Its payload is kept, and `POST …/deliveries/:deliveryId/retry` re-queues it.
- After 15 consecutive failures the endpoint is `disabled` (`too_many_failures`) and an audit entry is written. To recover, fix your receiver, re-enable the endpoint and verify it again.
- While your app is suspended, deliveries pause without using up attempts. If the app is revoked, they are cancelled.
- Delivery history (`GET …/deliveries`) is kept for 7 days. It never includes payloads.
- Limits: at most 10,000 pending deliveries per app (events beyond that are dropped and counted), and at most 5 concurrent requests per app.

## Destination rules

- Production apps must use `https`, on port 443 or 8443.
- Development apps may also use `http`, on port 80 or 8080.
- The host must resolve only to public addresses. Private, loopback, link-local, CGNAT, multicast and reserved ranges are refused, including IPv4 embedded in IPv6.
- No credentials in the URL and no fragments.
- To test locally, expose your receiver through a public tunnel. Localhost is never reachable.
