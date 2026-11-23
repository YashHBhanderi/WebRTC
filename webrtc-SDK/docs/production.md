# Production checklist

## What has been verified, and what hasn't

| Area | Verified | How |
|---|---|---|
| Services of every module against the real backend | Yes | `integration/` runs the built packages against webrtc-BE in-process (Express, Socket.IO, /v1, OAuth, E2EE relay, in-memory MongoDB, Clerk test double). |
| OAuth 2.0 + PKCE, refresh rotation, revocation, sign-out | Yes | `integration/oauth-groups.test.ts` |
| End-to-end encryption between two app devices (text, edits, attachments) | Yes | Real Olm/Megolm (matrix-sdk-crypto-wasm 18.9.0) in Node, in-memory key store |
| Call signaling and SFU admission, produce / consume | Yes, signaling only | Real mediasoup worker; the client side uses mediasoup-client's FakeHandler. **No real ICE/DTLS/RTP.** |
| Client edge cases (401 / 429 retry, timeouts, OAuth state, socket recovery) | Yes | `packages/core/test` |
| Component wiring (provider, theme, strings) and one rendered component | Yes | `packages/ui/test` in jsdom |
| Selective bundling (chat without calls, calls without chat/crypto) | Yes | Vite builds of the examples, checked for foreign code |
| Components in a real browser, layout at 320 px, keyboard, screen readers | **No** | Needs a manual pass in Chrome, Firefox and Safari |
| Real audio / video, screen sharing, ICE restarts, TURN | **No** | Needs two browsers against a deployed backend with TURN |
| IndexedDB key storage and the one-tab Web Lock | **No** | Browser-only (Node tests use memory storage) |

Before production: run `examples/chat-only` and `examples/calls-only` in two browsers against a
staging backend and go through chat, attachments, a call with camera and screen share, reconnects
(toggle the network) and a reload during a call.

## Rate limits

Developer-app requests are limited **per app, shared by all of its users**
(`quotas.rateLimitPerMinute`): default 60/min, at most 120 for development apps and 6000 for
production apps (`webrtc-BE/src/developer/app.service.ts`, `app-request.ts`). A browser SDK multiplies
this by your number of active users.

What the SDK costs per user, roughly:

- Opening the chat: 3–4 requests (`/v1/me`, `/conversations`, `/groupConversations`, `/config`), plus
  2 per opened conversation (history, state).
- Encryption: 2–4 requests to start the device, 1 sync per `e2ee:to-device` event, and per sent
  message 1–4 key requests (members, device query at most every 30 s per room (`deviceListMaxAgeMs`),
  key claims and key shares when there are new devices).
- Socket events are limited separately (30/s per app and user, burst 120) and don't count here.

So: register production apps with a raised `rateLimitPerMinute`, and plan capacity with the SpreeWe
operators; a single app tops out at 6000 requests/minute for all its users together. If that's not
enough, it's a backend decision (per-user buckets), not something the SDK can fix. The SDK retries
a 429 once when `Retry-After` is ≤ 10 s, then surfaces `RATE_LIMITED`.

Also per app: `maxConnections` (sockets per server instance; development max 20) and 5 sockets per
user; `messagesPerDay` (development max 2000).

## Security

- **Credentials:** never put the `sws_…` secret in a browser bundle. Use OAuth + PKCE or your own
  backend exchange.
- **Tokens in the browser:** OAuth tokens live in `sessionStorage` by default. Any script on your
  origin can read them: use a strict CSP, avoid third-party scripts on these pages, sanitise any
  HTML you render. (The components render message text as text, never as HTML.)
- **CSP** needs: `connect-src` the API origin (https and wss), `img-src`/`media-src` the storage
  origin from `GET /config` (`s3BaseUrl`) plus `blob:`, `script-src 'wasm-unsafe-eval'` for encryption,
  `worker-src blob:` is not needed.
- **E2EE:** `e2ee:device` lets your app read and send the user's messages. Request it only if you
  show message content. Keys stay in the browser (IndexedDB, wrapped with a non-extractable key);
  no storage protects against malicious script running in your page. There is **no key backup**: a
  new browser is a new device and can't read older messages. One tab drives the device; other tabs
  report "Encryption is already active … in another tab".
- **Allowed origins** must be exact; an app token used from another origin is rejected.

## Browser support

Chrome/Edge 123+, Firefox 120+, Safari 17.5+ (see [installation.md](installation.md#browser-support)).

## Bundle sizes

Vite 6 production builds of the examples (gzip):

| Example | Initial JS | Loaded on demand |
|---|---|---|
| chat-only (core, ui, chat, e2ee) | 44 KB app + 13 KB socket.io | 25 KB crypto bindings + 2.1 MB crypto WASM when encryption starts |
| calls-only (core, ui, calls) | 35 KB app + 13 KB socket.io | 41 KB mediasoup-client on the first call |

The chat-only build contains no call code and the calls-only build no chat or crypto code (checked
by searching the output).

## Known backend issues found while building the SDK

None of these were changed in the backend. Fixes belong to a backend developer.

| Issue | Where | Effect on the SDK |
|---|---|---|
| Typing from apps holding `messages:read` **and** `e2ee:device` is dropped: the typing handler only accepts the `messages:read` room shadow, not `messages:read+e2ee` | `webrtc-BE/src/realtime/gateways/chat.gateway.ts:31` | Users don't see "typing…" from E2EE-enabled apps. Receiving typing works. Test: `it.fails` in `integration/core-chat.test.ts` |
| `GET /files` doesn't return the message `e2ee` payload | `webrtc-BE/src/services/search.service.ts:188` | The files module fetches `GET /conversations/:id/media` per conversation to decrypt names; files outside that list show as unavailable |
| `GET /conversations/:id/media` is capped at 300 items, no cursor | `webrtc-BE/src/services/message.service.ts:240` | Older encrypted files can't be decrypted from the files list |
| Encrypted uploads are stored with `originalName: "encrypted"` | `webrtc-BE/src/services/file.service.ts:239` | Server-side file search can't find encrypted files (by design it can't read names); the file list filters loaded items client-side |
| `/files` and `/notifications` page on `createdAt` only | `search.service.ts:186`, `notification.service.ts` | Items with the same millisecond at a page boundary can be skipped |
| `includeRemoved` query on `GET /v1/workspace/organization/members` always fails validation | `webrtc-BE/src/api/v1/organization.routes.ts:163` (`S.bool` doesn't coerce strings) | Not used by the SDK |
| Directory and profile responses reveal a user's real "Appear offline" status: they read users with `.lean()`, skipping the model's `toJSON` mask (`isOnline` is still false) | `webrtc-BE/src/api/v1/routes.ts:107-110`, `controllers/userController.ts:68`, mask in `models/userModel.ts:114` | Privacy leak on the server side; the SDK shows what it receives. Test: `it.fails` in `integration/contacts.test.ts` |
| Meeting `update()` doesn't enforce the 24-hour maximum that `create()` does | `webrtc-BE/src/services/meeting.service.ts:172-174` (vs 121-123) | The scheduler validates the same limit client-side. `it.fails` in `integration/meetings.test.ts` |
| Invitees removed from a meeting never get `meeting:updated` (recipients are the new invitee list) | `meeting.service.ts:198-201` | Their meeting list updates on the next reload / reconnect. `it.fails` in `integration/meetings.test.ts` |
| No endpoint lists the users someone has blocked | — | Block state is read per direct chat (`GET /conversations/:id/state`) |
| `call:media-state` isn't delivered to app sockets | `webrtc-BE/src/developer/scopes.ts` (not in `DELIVERED_EVENT_SCOPES`) | Apps infer a participant's mute state from their producers instead |
| Per-user events reach only the user's latest SpreeWe client socket (all app sockets get them) | `docs/developer/realtime-events.md` §6 | No effect on app sockets |

## Behaviour to know

- **Calls:** one media session per user. If the user is in the call in the SpreeWe app, the SDK
  shows "in this call on another device" with **Move the call here** (`takeOver()`). An app socket that
  reconnects is a new device; the SDK re-accepts, takes over and rejoins automatically. The server
  ends a call when its last participant leaves (also 1:1 calls).
- **Messages:** sending is always end-to-end encrypted; there is no plaintext fallback. Without
  `@spreewe/e2ee` (or the scopes) the composer explains that the app can only read metadata.
- **Forwarding** isn't supported by the server for any client.
- **Presence** flows only between people who share a conversation, and the server caches that
  relation for 60 s: after a new chat starts, presence can take up to a minute to appear. App
  sockets never mark the user online, and `user:updated` (name/picture changes) isn't delivered to
  app sockets, so those refresh on reload.
- **Directory visibility:** in the personal context the directory and profiles only show people the
  user shares a conversation with; `globalDiscoverable` only affects lookup by e-mail.
