# Authentication and authorization

This page covers how a client proves who it is to SpreeWe, which context (personal or workspace) a request runs in, and how end-to-end encryption (E2EE) devices are set up.

Related: [Getting started](./getting-started.md) · [SDK reference](./sdk-reference.md) · [Realtime events](./realtime-events.md) · [/v1 REST API](./rest-api/v1-api.md) · [Session API](./rest-api/session-api.md) · [Organizations and workspaces](./organizations.md)

Every path below works with and without an `/api` prefix (for example `/api/v1/me` and `/v1/me`).

> **Important: developer-application tokens cannot use end-to-end encryption.**
> In the current implementation, a developer-application token cannot register an encryption device, upload or claim keys, or send end-to-end encrypted messages. Every E2EE endpoint refuses app tokens ("Apps can't take part in end-to-end encryption"). Every chat message is end-to-end encrypted, so an app cannot send messages.
> The `messages:write` scope exists, but **it currently grants nothing**. The server rejects every `sendMessage` from an app socket and emits `message:rejected` with `reason: "e2ee"`.
> With `messages:read`, an app receives message events with the encrypted content removed (`content: null`, `encrypted: true`).
> If your product needs to send or read message content, use the user-session mode (A).

---

## 1. The two integration modes

### (A) User session: the browser SDK

The end user signs in to SpreeWe (Clerk) inside your web app. You give the SDK a function that returns the user's **own** Clerk session token. `@spreewe/chat-sdk` calls this function before every request and every Socket.IO (re)connect.

- The SDK acts as the user, with the same permissions the user has in the SpreeWe web app.
- E2EE works: the browser becomes one of the user's encryption devices.
- The active workspace is the user's Clerk active organization.

Status: **Implemented and tested** at the protocol level (`webrtc-BE/test/sdk-e2e.test.ts`). **Implemented, not tested in a real browser**: nobody has tested the SDK in a real browser yet.

### (B) Developer applications: server credentials and scoped user tokens

Your backend holds an app credential (a key id and a secret). It asks the user for consent once. After that it exchanges the credential for short-lived, scoped tokens for that user. Those tokens work on `/v1` REST endpoints and on an app Socket.IO connection.

- Access is limited to the scopes in [section 7](#7-scopes).
- No E2EE: no devices, no sending, and no message content (see the box above).
- No calls, media, uploads, group management, workspace administration or app management.

Status: **Implemented and tested** (`webrtc-BE/test/developer-platform.test.ts`).

### Which mode to use

| You need to... | Use |
|---|---|
| Embed chat (send and read messages) in a web app where the user signs in to SpreeWe | A |
| Read or send end-to-end encrypted message content | A (B cannot) |
| Calls, media, uploads, groups | A |
| Read a user's profile, directory, conversation list, call history or recording links from your server | B |
| Learn on your server that messages were created, edited or deleted (without their content) | B with `messages:read` |
| Work while the user's browser is closed | B (read-only scopes) |
| Send messages from a bot or a backend | Neither. This is not supported today |

---

## 2. Clerk integration (mode A)

1. Fetch the publishable key. `GET /config` needs no authentication and returns `{ status, data: { clerkPublishableKey, s3BaseUrl }, message }`.
2. Initialise Clerk in your app with that key and sign the user in.
3. Pass `getToken: () => clerk.session?.getToken()` (or your framework's equivalent) to the SDK.

Rules:

- **Clerk session tokens last about 60 seconds.** Call `getToken()` right before each use and never cache the token. The SDK already does this on every request and every socket (re)connect.
- **Clock skew.** If `CLERK_CLOCK_SKEW_MS` is set, the server uses that value. Otherwise it allows 5 seconds in production and with live keys. It allows 3 minutes only outside production with a `pk_test_` key. Keep server clocks synchronised with NTP, because in production an expired token is refused almost at once.
- REST calls send `Authorization: Bearer <token>`.
- The socket handshake sends `auth: { token, deviceId }`:
  - `auth.token` is a fresh Clerk session token in mode A, or an app token in mode B.
  - `auth.deviceId` is optional and must match `^[\w-]{8,64}$`. If it doesn't, the server uses the socket id. The SDK sends `sdk-<encryption device id>`.
- The token's active organization decides which workspace a request runs in ([section 8](#8-personal-vs-workspace-context)).

---

## 3. `CORS_ORIGINS` and `CLERK_AUTHORIZED_PARTIES`

Whoever deploys SpreeWe (a DevOps or platform engineer) sets these on the server. If your web app's origin is missing from them, the browser cannot call the API.

| Variable | Purpose | Development | Production |
|---|---|---|---|
| `CORS_ORIGINS` | Browser origins that may call the API and open sockets | May be left unset, which accepts any origin. If set, use full origins such as `http://localhost:4200`, with no `*` and no paths | **Required.** Every entry must start with `https://`, or the server refuses to start |
| `CLERK_AUTHORIZED_PARTIES` | Origins that may present Clerk session tokens, checked against the token's `azp` claim | Optional | **Required.** Exact `https` origins only, such as `https://app.example.com`: no `*`, paths, query strings, credentials or `http`. The server refuses to start otherwise |

What this means for deployments:

- A new web origin, such as a customer domain or a staging domain, must be added to both variables, and the server must be restarted.
- Origins must match exactly on scheme, host and port. `https://example.com` does not cover `https://www.example.com`.
- The `allowedOrigins` of active developer apps are added to CORS for `/v1` and Socket.IO only. Each server caches this list for 60 seconds. An app token presented from a different app's origin is still rejected.

Status: **Implemented and tested** (`webrtc-BE/test/security-config.test.ts`).

### Known limitation: sockets without an `Origin` header

The server checks `azp` on a socket handshake only when the handshake has an `Origin` header. Browsers always send this header, so browser connections are always checked. A client that sends no `Origin` header, such as a native app, is not checked against `CLERK_AUTHORIZED_PARTIES`. The token's signature, expiry and other checks still apply. This limitation stays until native-client authentication is redesigned.

---

## 4. Registering a developer application (mode B)

Management endpoints use the signed-in user's Clerk session. High-impact actions require a `confirm` field set to the app's exact name.

1. **Choose the context.**
   - A *global* app is created from the personal (global) context, when the user has no active organization.
   - A *workspace* app is created with `tenantBound: true` while that workspace is active. Only workspace owners and admins can create one, and the app acts only in that workspace.
2. **Create the app** with `POST /v1/apps`. Send `name` (2–80 characters), `environment` (`development` or `production`), `scopes`, `allowedOrigins` (up to 20) and `callbackUrls` (up to 20). Scopes default to none.
3. **Create a credential** with `POST /v1/apps/{appId}/credentials`. Send `confirm` and, optionally, `expiresInDays` (default 180). The response has the key id (`swk_live_…` or `swk_test_…`) and the secret. Keep the secret on your server only.
4. **Manage the app** with these endpoints:
   - `GET /v1/apps`
   - `GET /v1/apps/{appId}` and `PATCH /v1/apps/{appId}`
   - `GET /v1/apps/{appId}/credentials`
   - `POST /v1/apps/{appId}/credentials/{credentialId}/rotate`
   - `POST /v1/apps/{appId}/credentials/{credentialId}/revoke`
   - `GET /v1/apps/{appId}/usage` and `GET /v1/apps/{appId}/audit`
   - `POST /v1/apps/{appId}/revoke`
   - `POST /v1/apps/{appId}/tokens/revoke-all`

When you rotate a credential, the old one keeps working for a grace period. The period is set by `APP_CREDENTIAL_ROTATION_GRACE_SECONDS`: 3600 seconds by default, 86,400 at most.

Server-to-server calls use HTTP Basic authentication: `Authorization: Basic base64(keyId:secret)`.

---

## 5. Consent

1. Your server calls `POST /v1/consent-requests` with Basic auth. Send `redirectUri`, which must exactly match one of the app's `callbackUrls`, along with `scopes`, `state` and, optionally, `externalUserRef` (your own user id).
2. The response contains `consentUrl` and `expiresAt`. **A consent request expires after 10 minutes** and works only once.
3. Send the user's browser to `consentUrl`. The user signs in to SpreeWe and approves some or all of the scopes, or denies the request. The SpreeWe consent page calls `POST /v1/consent-requests/{id}/approve` or `/deny`.
4. The browser is redirected to your `redirectUri` with your `state`. Check that `state` matches.

Users can list and revoke their own grants with `GET /v1/me/app-grants` and `DELETE /v1/me/app-grants/{grantId}`. Workspace admins can list workspace apps with `GET /v1/workspace/apps` and revoke an app's grants with `POST /v1/workspace/apps/{appId}/revoke-grants`.

---

## 6. Scoped user tokens

### Exchange

Call `POST /v1/app-tokens` with Basic auth. The body must contain exactly one of `userId` or `externalUserRef`. It may also contain `scopes` and `ttlSeconds`.

The response is `{ accessToken, tokenType: "Bearer", expiresIn, expiresAt, scopes, tokenId, tenantId }`.

### Lifetime

| Setting | Default | Limits |
|---|---|---|
| `ttlSeconds` (in the request) | `APP_TOKEN_DEFAULT_TTL_SECONDS`, which defaults to **600 s** | From 60 s up to the maximum |
| Maximum | `APP_TOKEN_MAX_TTL_SECONDS`, which defaults to **900 s** | Clamped to 60–3600 s |

### Refresh

There is no refresh token. When a token is close to expiry, your server calls `POST /v1/app-tokens` again. **The server disconnects an app socket when its token expires**, so reconnect with a new token.

### Effective scopes

A token's effective scopes are the scopes present in all three of: the token, the user's grant, and the app's configured scopes. The server re-checks this on every request, so narrowing a grant or an app also restricts tokens that were already issued.

### Revocation

| Action | Endpoint |
|---|---|
| Revoke one token | `POST /v1/app-tokens/revoke` (Basic auth) |
| Revoke all of an app's tokens | `POST /v1/apps/{appId}/tokens/revoke-all` |
| User revokes their grant | `DELETE /v1/me/app-grants/{grantId}` |
| Revoke a credential | `POST /v1/apps/{appId}/credentials/{credentialId}/revoke` |
| Disable the app | `POST /v1/apps/{appId}/revoke` |

Origins: when a token is used from a browser, the `Origin` must be in that app's `allowedOrigins`.

Status: **Implemented and tested** (`developer-platform.test.ts`, `token-validation.test.ts`).

---

## 7. Scopes

Nothing is granted by default. App tokens have no access to anything outside this table, including group calls, media, uploads, recording control, workspace administration, app management and E2EE.

| Scope | What it grants | Sensitive\* |
|---|---|---|
| `profile:read` | `GET /v1/me` | |
| `directory:read` | `GET /v1/directory`: people the user can contact in the app's context | yes |
| `conversations:read` | `GET /v1/conversations` | |
| `messages:read` | `GET /v1/conversations/{id}/messages`, plus the socket events `receiveMessage`, `message:updated` and `message:deleted`. Encrypted content is removed before it reaches apps | yes |
| `messages:write` | **Nothing at present.** Every `sendMessage` from an app is rejected because of E2EE | yes |
| `calls:read` | `GET /v1/calls` | |
| `recordings:read` | `GET /v1/recordings/{id}` and short-lived download links | yes |
| `realtime:connect` | Opening a Socket.IO connection, plus the `user:presence` events for people visible in the app's context and `rate-limited` events | |

\*Sensitive scopes are highlighted on the consent screen.

App sockets never join conversation rooms. The server refuses `joinConversation`, typing, receipts, calls and every other client event with "Not available to this app".

---

## 8. Personal vs workspace context

Each request runs in exactly one context:

- **Workspace context:** the Clerk session has an active organization. The server maps it to a SpreeWe workspace and checks that the user is an active member. The request sees only that workspace's data.
- **Global (personal) context:** there is no active organization. The request sees global data and the external conversations the user is a guest in.

Context resolution fails closed. An invalid organization id returns 401. A suspended or deleted workspace returns 403, and so does a user who is not, or is no longer, a member. The server never falls back to a different context.

App tokens carry their context in `tenantId`, taken from the app and the grant. A workspace-bound app acts only in its own workspace.

See [Organizations and workspaces](./organizations.md) for details. Status: **Implemented and tested** (`tenant-isolation.test.ts`, `fail-closed.test.ts`, `global.test.ts`).

---

## 9. E2EE device lifecycle (mode A only)

Messages are encrypted in the browser with Olm/Megolm, using the Matrix Rust crypto library. The server stores and routes ciphertext and public keys.

1. **The first connect creates a device.** The SDK registers it with `POST /v1/e2ee/devices`. Every E2EE request names the device in the `X-SpreeWe-Device` header.
2. **Keys.** The device uploads its identity keys and one-time keys (`POST /v1/e2ee/keys/upload`). It looks up other users' devices (`/keys/query`) and claims their one-time keys (`/keys/claim`) to open sessions. Lookups only return people the user shares a conversation with.
3. **To-device sync.** Room keys travel as to-device messages. They are sent with `POST /v1/e2ee/sendToDevice/{eventType}/{txnId}` and fetched with `GET /v1/e2ee/sync`. The socket event `e2ee:to-device` announces new ones.
4. **Room keys.** Megolm room keys go to the devices of the conversation members **as listed by the server** (`GET /v1/e2ee/rooms/{conversationId}/members`). This means the client trusts the server's member list.
5. **Sender check.** When decrypting, the SDK checks that the sending device's key belongs to the claimed sender. If it doesn't, the message is not shown.
6. **Storage.** Private keys stay in the browser's IndexedDB. The SDK uses its own database (`spreewe-sdk-e2ee-vault`), separate from the SpreeWe web app's. The library's key store is encrypted with a random passphrase, and that passphrase is wrapped by a non-extractable AES-GCM key. Keys survive a page refresh and are never sent to the server or written to `localStorage`. This protects keys at rest. It does not protect against malicious script running in the page.
7. **A new browser, or cleared site data, means a new device.** The new device **cannot read messages sent before it existed**. **There is no key backup.**
8. **Revocation.** `GET /v1/e2ee/devices` lists the user's devices and `POST /v1/e2ee/devices/{deviceId}/revoke` removes one. A revoked device id cannot be registered again, so that browser has to set up a new device.

What the server **can** see: who talks to whom and when, conversation membership, message metadata, device public keys and to-device message routing.
What the server **cannot** see: message plaintext and private keys.

Status: **Implemented and tested** at the protocol level (`e2ee.test.ts`, `e2ee-real-crypto.test.ts`, `sdk-e2e.test.ts`). **Implemented, not tested in a real browser**, including IndexedDB persistence and behaviour across several tabs.

To repeat: **every E2EE endpoint refuses developer-application tokens.**
