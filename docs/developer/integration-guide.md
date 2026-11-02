# Integration guide: SpreeWe as your communication backend

This guide takes you from nothing to a working integration: register an app, get user tokens, call the API, receive realtime events, send and read end-to-end encrypted messages, upload files, run calls, receive webhooks and go to production.

Reference pages: [Authentication](./authentication.md) · [OAuth 2.0](./rest-api/oauth.md) · [REST API v1](./rest-api/v1-api.md) · [Session REST API](./rest-api/session-api.md) · [Realtime events](./realtime-events.md) · [Organizations](./organizations.md) · [Webhooks](../integrations/outbound-webhooks.md)

**Status labels used here**

- **Tested**: covered by server tests that call the real API (HTTP and Socket.IO) in Node. The test file is named.
- **Not tested in a real client**: no test has run this in a real browser, mobile app or with real audio/video. The server side works in tests; your client side is your responsibility to verify.

Conventions in the examples:

- `$SPREEWE_API` is the backend base URL. Every route is served both at the root and under `/api` (`/v1/me` and `/api/v1/me` are the same).
- `/v1` responses are wrapped: `{ "data": ... }`, or `{ "data": [...], "page": { "nextCursor" } }` for lists. `POST` routes answer `201`. The OAuth endpoints (`/oauth/*`) and the session routes (`/conversations`, `/upload`, …) are **not** wrapped this way; each section shows the shape.

---

## 1. Register your app

### 1.1 Account and Developer Portal

1. Create a SpreeWe account and sign in to the SpreeWe web app.
2. Open **Account menu → Developer portal** (`/developer`).
3. Click **Register an application**: name (2–80 characters), description, website, environment, permissions (scopes).
4. Open the app. Its tabs cover:
   - **Overview**: the **Application ID** (`_id`; this is also the OAuth `client_id`), details, status (suspend, reactivate, revoke).
   - **Credentials**: create, rotate and revoke server credentials.
   - **Permissions (scopes)**, **Allowed origins**, **Redirect URLs**, **Limits** (quotas).
   - **Webhooks**: add endpoints, verify them, see deliveries.
   - **Usage, last 30 days** and **Activity** (audit trail).

A short summary of the same steps is at `/developer/docs` in the web app.

Who can register:
- **Global app**: register it from your personal context (no active workspace). Any SpreeWe user can authorise it.
- **Workspace app** (`tenantBound: true`): register it from inside a workspace where you are owner or admin. It only works inside that workspace.
- Limit: 25 apps per owner.

### 1.2 Or register with the API

The `/v1/apps` endpoints need a signed-in SpreeWe session (a Clerk session token). App tokens are refused.

```bash
curl -X POST "$SPREEWE_API/v1/apps" \
  -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Support",
    "environment": "development",
    "scopes": ["profile:read", "realtime:connect", "conversations:read", "conversations:write",
               "messages:read", "messages:write", "e2ee:device"],
    "allowedOrigins": ["http://localhost:5173"],
    "callbackUrls": ["http://localhost:5173/spreewe/callback"]
  }'
```

Fields (`POST /v1/apps`): `name`, `description?`, `websiteUrl?`, `environment` (`development` | `production`), `tenantBound?`, `scopes?` (default: none), `allowedOrigins?` (max 20), `callbackUrls?` (max 20), `quotas?`. Change them later with `PATCH /v1/apps/{appId}`. `GET /v1/scopes` lists every scope with its description.

### 1.3 Environments

| | `development` | `production` |
|---|---|---|
| Client ID prefix | `swk_test_` | `swk_live_` |
| Origins and redirect URLs | `https`, or `http://localhost` | `https` only |
| Webhook URLs | `http` (ports 80/8080) or `https` (443/8443) | `https` only (443/8443) |
| Quota ceilings | 120 requests/min, 20 sockets, 2,000 messages/day | up to 6,000 / 10,000 / 1,000,000 |

Defaults for a new app are 60 requests/min, 20 sockets, 1,000 messages/day. The environment is fixed when the app is created: create a second app for production (see [section 10](#10-going-to-production)).

### 1.4 Client ID and secret

A server credential is a pair:

- **Client ID** (key id): `swk_test_…` or `swk_live_…`.
- **Secret**: `sws_…`. **Shown once**, in the response that creates it. SpreeWe stores only a hash. If you lose it, create a new one.

Create one in the portal (Credentials tab) or with the API. High-impact actions need `confirm` set to the app's exact name, and may ask you to sign in again if your last sign-in was more than 10 minutes ago.

```bash
curl -X POST "$SPREEWE_API/v1/apps/$APP_ID/credentials" \
  -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{ "confirm": "Acme Support", "expiresInDays": 180 }'
# → 201 { "data": { "credential": { "_id", "keyId": "swk_test_…", "hint", "status", "expiresAt", … },
#                   "secret": "sws_…" } }
```

- `expiresInDays`: 1–365, default 180.
- At most 5 active credentials per app.
- Keep the secret on your server only. Never ship it in a browser bundle or a mobile app.

The credential authenticates your server with HTTP Basic: `Authorization: Basic base64("<keyId>:<secret>")`. Every failure is the same `401 Invalid app credentials`.

### 1.5 Permissions (scopes)

Nothing is granted by default. A user token carries only the scopes that are in **all three**: the app's configured scopes, the user's grant, and the token request. The server still applies the user's own permissions (membership, roles, workspace policies). The full list and what each scope unlocks is in [Authentication §7](./authentication.md#7-scopes) and `GET /v1/scopes`. A typical chat integration needs:

| Need | Scopes |
|---|---|
| Who is the user | `profile:read` |
| Socket.IO connection | `realtime:connect` |
| List and open conversations | `conversations:read`, `conversations:write` |
| Groups | `groups:read`, `groups:write`, `groups:manage` |
| Read and send messages | `messages:read`, `messages:write`, `e2ee:device` |
| Attachments | `files:read`, `files:write` |
| Calls | `calls:read`, `calls:write` (+ `calls:manage`, `recordings:write` for host controls and recording) |

Request only what you use. Scopes marked `sensitive` are highlighted on the consent screen.

### 1.6 Allowed origins and redirect URLs

- **Allowed origins** (`allowedOrigins`): browser origins that may call the API and open sockets with your app's tokens, e.g. `https://app.example.com`. An origin has no path or query. When a request carries an `Origin` header that is not on the list, the token is refused. Requests without `Origin` (servers, native apps) are not origin-checked.
- **Redirect URLs** (`callbackUrls`): where SpreeWe sends the user's browser after consent. They must match **exactly** (after URL normalisation) the `redirectUri` / `redirect_uri` you send.

---

## 2. Get user tokens: choose an auth flow

Both flows end with the same kind of access token: a short-lived, scoped **user token** that acts as one SpreeWe user who authorised your app. Send it as `Authorization: Bearer <token>`.

| Your app | Use |
|---|---|
| Has a backend that can keep a secret | **(a) Consent request + token exchange**, or OAuth with client credentials |
| Mobile app or single-page app without a backend | **(b) OAuth 2.0 authorization code + PKCE** |
| You prefer a standard OAuth library | **(b)** |

Details of every field and error: [Authentication](./authentication.md) and [OAuth 2.0](./rest-api/oauth.md).

### 2a. App with a backend: consent request + token exchange

Status: **Tested** (`developer-platform.test.ts`, `developer-api-access.test.ts`). Browser redirect **not tested in a real browser**.

**Step 1. Your server creates a consent request** (Basic auth with your credential):

```ts
const basic = "Basic " + Buffer.from(`${process.env.SPREEWE_KEY_ID}:${process.env.SPREEWE_SECRET}`).toString("base64");

const state = crypto.randomBytes(16).toString("base64url");   // store it in the user's session
const res = await fetch(`${SPREEWE_API}/v1/consent-requests`, {
  method: "POST",
  headers: { Authorization: basic, "Content-Type": "application/json" },
  body: JSON.stringify({
    redirectUri: "https://app.example.com/spreewe/callback", // exactly a registered callback URL
    scopes: ["profile:read", "realtime:connect", "messages:read", "messages:write", "e2ee:device"],
    state,                                  // 8–200 visible ASCII characters
    externalUserRef: "acme-user-42",        // optional: YOUR id for this user ([\w.:@|-], ≤ 200)
  }),
});
const { data } = await res.json();          // { requestId, consentUrl, expiresAt }
// Redirect the user's browser to data.consentUrl (valid 10 minutes, usable once)
```

**Step 2. The user approves** on the SpreeWe consent page (`/consent?request=…`). They must be signed in to SpreeWe, in the right context (personal for a global app, the app's workspace for a workspace app). They can untick scopes.

**Step 3. SpreeWe redirects the browser** to your callback:

- Approved: `https://app.example.com/spreewe/callback?state=…&result=approved&grant=<grantId>`
- Denied: `…?state=…&error=access_denied`

Check that `state` equals the value you stored (CSRF protection).

**Step 4. Your server exchanges its credential for a user token** whenever it needs one:

```ts
const tok = await fetch(`${SPREEWE_API}/v1/app-tokens`, {
  method: "POST",
  headers: { Authorization: basic, "Content-Type": "application/json" },
  body: JSON.stringify({
    externalUserRef: "acme-user-42",   // or userId: "<SpreeWe user id>" — exactly one of the two
    scopes: ["messages:read"],         // optional: narrow; default = everything granted
    ttlSeconds: 600,                   // optional: 60 … max (server default 600, max 900 unless configured)
  }),
});
const { data: t } = await tok.json();
// 201 { accessToken, tokenType: "Bearer", expiresIn, expiresAt, scopes, tokenId, tenantId }
```

```bash
curl -X POST "$SPREEWE_API/v1/app-tokens" -u "$SPREEWE_KEY_ID:$SPREEWE_SECRET" \
  -H "Content-Type: application/json" -d '{ "externalUserRef": "acme-user-42" }'
```

- There is **no refresh token** in this flow: call `/v1/app-tokens` again before `expiresAt`.
- If the user has not authorised the app (or withdrew it) you get `403 This user has not authorised the app`, the same answer whether or not the user exists.
- Hand the access token to your own front end if it talks to SpreeWe directly; the secret never leaves your server.
- On sign-out: `POST /v1/app-tokens/revoke` `{ "token": "<accessToken>" }` (Basic auth).

### 2b. App without a backend: OAuth 2.0 authorization code + PKCE

Status: **Tested** (`developer-oauth.test.ts`: full flow, wrong verifier, code reuse, refresh rotation and reuse detection, revocation). **Not tested** with a real browser redirect or a mobile app.

- `client_id` is the **Application ID** (`_id`), not the `swk_` key id.
- PKCE with `S256` is mandatory.
- Codes live 2 minutes and work once.
- Refresh tokens (`swr_…`) work once; each refresh returns a new one. Presenting a used refresh token revokes the whole token family. Refresh tokens expire after 30 days by default, sliding on each refresh.

**Step 1. Send the browser to `/oauth/authorize`:**

```ts
// PKCE (browser: crypto.subtle; Node: crypto)
const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));          // 43–128 chars [A-Za-z0-9._~-]
const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
sessionStorage.setItem("pkce", JSON.stringify({ verifier, state }));

const url = new URL(`${SPREEWE_API}/oauth/authorize`);
url.search = new URLSearchParams({
  response_type: "code",
  client_id: APP_ID,
  redirect_uri: "https://app.example.com/callback",
  scope: "profile:read realtime:connect messages:read",   // space-separated, within the app's scopes
  state,
  code_challenge: challenge,
  code_challenge_method: "S256",
}).toString();
location.assign(url.toString());

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
```

SpreeWe redirects to its consent page. Errors with `client_id` or `redirect_uri` are answered directly (JSON); other errors are sent back to your `redirect_uri` as `?error=…&error_description=…&state=…`.

**Step 2. The callback** receives `?state=…&code=swc_…` (or `?state=…&error=access_denied`). Check `state`.

**Step 3. Exchange the code** (`POST /oauth/token`, JSON or form-encoded):

```ts
const res = await fetch(`${SPREEWE_API}/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    grant_type: "authorization_code",
    client_id: APP_ID,
    code,
    redirect_uri: "https://app.example.com/callback",   // same as in step 1
    code_verifier: verifier,
  }),
});
const t = await res.json();
// { access_token, token_type: "Bearer", expires_in, refresh_token: "swr_…", scope: "profile:read …" }
```

A backend may also send `Authorization: Basic …`; the credential must then belong to `client_id`.

**Refresh** (each use returns a new refresh token; store it and drop the old one):

```bash
curl -X POST "$SPREEWE_API/oauth/token" -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=refresh_token&client_id=$APP_ID&refresh_token=$REFRESH_TOKEN"
# optional: &scope=<subset>  (a refresh can only narrow)
```

**Revoke** on sign-out (RFC 7009, always `200 {}`):

```bash
curl -X POST "$SPREEWE_API/oauth/revoke" -H "Content-Type: application/json" \
  -d "{\"client_id\":\"$APP_ID\",\"token\":\"$REFRESH_TOKEN\"}"
```

OAuth errors are `{ "error": "invalid_grant", "error_description": "…" }`, status 400 (401 for `invalid_client`, 429 `slow_down`).

If the user withdraws the grant, the app is suspended/revoked, or `revoke-all` is used, the next refresh fails with `invalid_grant` and the family is revoked: send the user through step 1 again.

---

## 3. Call the API

Status: **Tested** (`developer-api-access.test.ts`, `developer-api-calls.test.ts`, `developer-api-e2ee.test.ts`).

User tokens work on two surfaces:

- **`/v1`**: the versioned API ([REST API v1](./rest-api/v1-api.md), OpenAPI at [`../api/openapi.yaml`](../api/openapi.yaml)).
- **Session routes** (`/conversations`, `/messages/…`, `/upload`, `/calls`, `/meetings`, `/notifications`, `/search`, …) ([Session REST API](./rest-api/session-api.md)). Each route that accepts app tokens names one scope (`webrtc-BE/src/routes/routes.ts`). Routes without a scope (e.g. account deletion) answer `403 This endpoint needs a signed-in SpreeWe session`.

```ts
const me = await fetch(`${SPREEWE_API}/v1/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
// 200 { data: { … the user and active context … } }   (scope profile:read)

const convs = await fetch(`${SPREEWE_API}/v1/conversations?limit=20`, { headers: { Authorization: `Bearer ${accessToken}` } });
// 200 { data: [...], page: { nextCursor } }   — pass ?cursor=<nextCursor> for the next page
```

The workspace is never a parameter: a workspace app's tokens act in its workspace, a global app's in the user's personal context. See [Organizations](./organizations.md).

### Errors

| Surface | Shape |
|---|---|
| `/v1` | `{ "error": { "code": "PERMISSION_ERROR", "message": "The token lacks the messages:write scope", "details"? } }` |
| Session routes | `{ "status": false, "success": false, "data": null, "message": "…", "error": { "code", "message", "actionable" } }`; token failures are `{ "success": false, "message": "Invalid or expired token" }` (401) |
| `/oauth/*` | `{ "error", "error_description" }` |

`code` values: `VALIDATION_ERROR` (400/413/415/422), `AUTHENTICATION_ERROR` (401), `PERMISSION_ERROR` (403), `NOT_FOUND_ERROR` (404), `CONFLICT_ERROR` (409), `RATE_LIMIT_ERROR` (429), `SERVER_ERROR` (5xx).

- **401**: token expired, revoked, grant withdrawn, app suspended, user removed from the workspace, or origin not allowed. All give the same answer: get a new token; if that fails too, the user must authorise again.
- **403**: missing scope, or the user is not allowed to do this.
- **404**: also used for resources in another workspace or outside the user's membership, so their existence is not revealed.

### Rate limits and quotas

| Limit | Value | Scope |
|---|---|---|
| Requests per minute (`quotas.rateLimitPerMinute`) | default 60 (dev max 120, prod max 6,000) | per app, shared by `/v1` and session routes, all users and IPs |
| Token exchange / revoke | 120/min (server setting `APP_CREDENTIAL_RATE_PER_MIN`) | per credential |
| Sensitive routes and `/oauth/*` | `RATE_LIMIT_SENSITIVE_MAX` per window (default 60/min) | per IP |
| Messages per day (`quotas.messagesPerDay`) | default 1,000 (dev max 2,000) | per app; over quota, `sendMessage` gets `message:rejected` `reason: "quota"` |
| Sockets (`quotas.maxConnections`) | default 20 | per app **and per server instance**; plus 5 sockets per app user |
| Socket events | 30/s refill, burst 120 | per app user, per instance |

429 responses carry draft-7 `RateLimit` / `RateLimit-Policy` headers. Back off and retry.

---

## 4. Realtime (Socket.IO)

Status: **Tested** in Node with `socket.io-client` (`developer-api-access.test.ts`, `developer-api-e2ee.test.ts`, `developer-api-calls.test.ts`). **Not tested** from a real browser or mobile app.

```ts
import { io } from "socket.io-client";

const socket = io(SPREEWE_API, {
  transports: ["websocket", "polling"],
  // Called on every connect AND reconnect: always hand over a fresh token
  auth: (cb) => { getFreshUserToken().then((token) => cb({ token })); },
});

socket.on("connect", () => {
  for (const id of openConversationIds) socket.emit("joinConversation", id);   // messages:read
});
socket.on("connect_error", (err) => console.warn(err.message));
// "Authentication error" | "Invalid token" | "The token lacks the realtime:connect scope"

socket.on("receiveMessage", (m) => { /* decrypt, see section 6 */ });
socket.on("message:rejected", (r) => console.warn(r.reason, r.message));
socket.on("rate-limited", (p) => { /* back off */ });
socket.on("disconnect", (reason) => { /* socket.io reconnects automatically unless reason is "io server disconnect" */ });
```

Rules for app sockets (`webrtc-BE/src/realtime/index.ts`, `setUpAppSocket`):

- The token needs `realtime:connect`.
- **The server disconnects the socket when the token expires** (a timer set to the token's `exp`). Your client must reconnect with a fresh token. A server-initiated disconnect (`reason === "io server disconnect"`) is **not** retried automatically by socket.io-client: call `socket.connect()` yourself after getting a new token.
- Every event you send needs its scope (`SOCKET_EVENT_SCOPES` in `webrtc-BE/src/developer/scopes.ts`); unlisted events are refused. Events delivered to you are filtered by scope (`DELIVERED_EVENT_SCOPES`). The tables are in [Realtime events §6](./realtime-events.md#6-developer-app-sockets).
- Room membership does not survive a reconnect: emit `joinConversation` again on every `connect`, and run an E2EE sync (section 6).
- Over the connection cap you get `rate-limited` `{ event: "connect", reason: "connection limit" }`, then a disconnect.
- The app socket's `deviceId` is always its `socket.id`.

Main events delivered to apps: `receiveMessage`, `message:updated`, `message:deleted`, `message:rejected`, `messageReactionUpdated`, `userTyping`, `receipts:updated` (`messages:read`); `group:added`, `group:removed`, `group:updated` (`groups:read`); `user:presence`, `rate-limited` (`realtime:connect`); `notification:new` (`notifications:read`); `e2ee:to-device`, `e2ee:devices-changed` (`e2ee:device`); `call:*` and `mediasoup:*` (calls scopes).

---

## 5. Conversations and groups

Status: **Tested** for creation and membership through the API. Payload shapes: [Session REST API](./rest-api/session-api.md).

| Action | Request | Scope | Response |
|---|---|---|---|
| Open (or get) a direct conversation | `POST /conversations` `{ "receiverId": "<userId>" }` | `conversations:write` | `{ "conversationId" }` (no envelope) |
| List direct conversations | `GET /v1/conversations` or `GET /conversations` | `conversations:read` | |
| Message history | `GET /v1/conversations/{id}/messages?limit&cursor` or `GET /messages/{id}` | `messages:read` | |
| Create a group | `POST /conversations/group` (JSON or multipart with optional `image`) | `groups:write` | `201 { status, data: <group>, message }` |
| List groups | `GET /groupConversations` | `groups:read` | |
| Group details | `GET /conversations/{id}/group` | `groups:read` | |
| Add members | `PUT /conversations/group/{id}/add-member` `{ "userIds": [...] }` | `groups:manage` | |
| Remove a member | `PUT /conversations/group/{id}/remove-member` `{ "userId" }` | `groups:manage` | |
| Delete a group (admin) | `DELETE /conversations/{id}` | `conversations:delete` | |
| Update / leave / admins | socket `group:update`, `group:leave`, `group:promote-admin`, `group:remove-admin`, `group:add-member`, `group:remove-member` | `groups:write` / `groups:manage` | |
| Find people | `GET /v1/directory` or `GET /web/users` | `directory:read` | |

Create a group: `groupMembers` is a **JSON string** of user ids (the creator is added automatically). A group needs a name and at least 2 other members.

```ts
const res = await fetch(`${SPREEWE_API}/conversations/group`, {
  method: "POST",
  headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    groupName: "Support team",
    groupDescription: "Optional",
    groupMembers: JSON.stringify([bobId, carolId]),
  }),
});
const { data: group } = await res.json();   // group._id is the conversation id
```

You can only add people the user is allowed to reach in the current context (workspace membership, blocks, external-chat policy).

---

## 6. End-to-end encrypted messaging

Status: **Tested** with real Olm/Megolm on both sides, in Node, against the real API (`developer-api-e2ee.test.ts`). **Not tested** in a browser or mobile app built by a third party.

### What you need to know first

- **Every text and media message is end-to-end encrypted.** The server stores and relays ciphertext only and refuses plaintext (`message:rejected`, `reason: "unencrypted"`).
- To read or send messages, your app must run its **own encryption device** for each user, with the `e2ee:device` scope. It uses the Matrix **Olm/Megolm** protocol. SpreeWe clients use `@matrix-org/matrix-sdk-crypto-wasm` **18.9.0**; use the same library (the example below does).
- **An app with `e2ee:device` can read the user's messages** in every conversation it receives room keys for. The user sees the device in their device list as "<app name> (app)" and can revoke it.
- **The SpreeWe server never sees plaintext.** Your app does; protect it accordingly.
- **There is no key backup.** If your device's keys are lost, it cannot decrypt older messages again. In general, a new device receives keys only for messages encrypted after it is known to the sender, so it cannot read history from before it was registered.
- Without `e2ee:device`, history responses mark messages as encrypted and contain no ciphertext; you cannot send messages (`messages:write` and `messages:edit` require it).
- The device is removed automatically when the user withdraws the grant, when `e2ee:device` is removed from the app, or when the app is revoked.

Required scopes: `e2ee:device`, `messages:read`, `messages:write`, `realtime:connect` (+ `conversations:read` to list conversations).

### Identifiers

| Thing | Format |
|---|---|
| Matrix user id | `@<SpreeWe user id>:spreewe.local` |
| Matrix room id | `!<conversation id>:spreewe.local` |
| Device id | You choose it: 4–64 characters `[A-Za-z0-9_-]`. Send it on every `/v1/e2ee` call as `X-SpreeWe-Device`. Keep it stable per user. |

### Endpoints (`/v1/e2ee`, scope `e2ee:device`, header `X-SpreeWe-Device`)

| Request | Purpose |
|---|---|
| `POST /devices` `{ displayName? }` | Register this device (apps: the name is always "<app name> (app)") |
| `GET /devices` | The user's devices |
| `POST /keys/upload` | Publish identity keys and one-time/fallback keys (public only) |
| `POST /keys/query` | Device keys of people the user shares a conversation with |
| `POST /keys/claim` | Claim one-time keys to start Olm sessions |
| `POST /sendToDevice/{eventType}/{txnId}` | Send Olm-encrypted device messages (room keys) |
| `GET /sync?ack&since&limit` | Pending device messages, key counts, device-list changes |
| `GET /rooms/{conversationId}/members` | Members of a conversation as Matrix user ids |

Bodies use the crypto library's own request formats: you pass them through unchanged. An app can only use devices it registered itself (`403` otherwise).

### Worked example: an app device in Node

Adapted from `webrtc-BE/test/developer-api-e2ee.test.ts`. It keeps the Olm state **in memory**: a production app must persist the device's crypto store between restarts, or it loses its keys (there is no backup). Check the library's documentation for the store options available in your runtime; this is not covered by SpreeWe's tests.

```ts
import * as sdk from "@matrix-org/matrix-sdk-crypto-wasm";   // 18.9.0

const SERVER = "spreewe.local";
const mUser = (id: string) => `@${id}:${SERVER}`;
const mRoom = (id: string) => `!${id}:${SERVER}`;

export class AppDevice {
  machine!: sdk.OlmMachine;
  private ack: string | null = null;
  private since = 0;

  constructor(
    readonly api: string,                      // $SPREEWE_API
    readonly userId: string,                   // SpreeWe user id
    readonly getToken: () => Promise<string>,  // fresh user token with e2ee:device
    readonly deviceId: string,                 // stable, [A-Za-z0-9_-]{4,64}
  ) {}

  private async data(method: "GET" | "POST", path: string, body?: unknown) {
    const res = await fetch(`${this.api}/v1/e2ee${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await this.getToken()}`,
        "X-SpreeWe-Device": this.deviceId,
        "Content-Type": "application/json",
      },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
    return json.data;
  }

  /** 1. Register the device, create the Olm machine, upload its keys */
  async start(): Promise<this> {
    await sdk.initAsync();
    await this.data("POST", "/devices", {});
    this.machine = await sdk.OlmMachine.initialize(new sdk.UserId(mUser(this.userId)), new sdk.DeviceId(this.deviceId));
    await this.flush();   // sends the KeysUpload request
    return this;
  }

  /** Answer one outgoing request of the machine through the SpreeWe API */
  private async answer(r: any): Promise<void> {
    let res: unknown = {};
    switch (r.type) {
      case sdk.RequestType.KeysUpload: res = await this.data("POST", "/keys/upload", JSON.parse(r.body)); break;
      case sdk.RequestType.KeysQuery:  res = await this.data("POST", "/keys/query",  JSON.parse(r.body)); break;
      case sdk.RequestType.KeysClaim:  res = await this.data("POST", "/keys/claim",  JSON.parse(r.body)); break;
      case sdk.RequestType.ToDevice:
        res = await this.data("POST", `/sendToDevice/${encodeURIComponent(r.event_type)}/${encodeURIComponent(r.txn_id)}`, JSON.parse(r.body));
        break;
    }
    await this.machine.markRequestAsSent(r.id, r.type, JSON.stringify(res));
  }

  private async flush(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const rs = await this.machine.outgoingRequests();
      if (!rs.length) return;
      for (const r of rs as any[]) await this.answer(r);
    }
  }

  /** 2. Sync: room keys and device changes for this device. Call on connect and on e2ee:to-device. */
  async sync(): Promise<void> {
    const q = new URLSearchParams();
    if (this.ack) q.set("ack", this.ack);       // acknowledges what the previous sync delivered
    if (this.since) q.set("since", String(this.since));
    const res = await this.data("GET", `/sync?${q}`);
    await this.machine.receiveSyncChanges(
      JSON.stringify(res.events.map((e: any) => ({ sender: e.sender, type: e.type, content: e.content }))),
      new sdk.DeviceLists((res.device_lists?.changed || []).map((u: string) => new sdk.UserId(u)), []),
      new Map(Object.entries(res.one_time_key_counts || {})),
      new Set(res.unused_fallback_keys || []),
    );
    this.since = res.now;
    if (res.next) this.ack = res.next;
    await this.flush();   // e.g. replenish one-time keys
  }

  /** 3. Encrypt: query/claim keys of the members, share the room key, encrypt */
  async encrypt(conversationId: string, content: { text?: string; file?: unknown }) {
    const room = () => new sdk.RoomId(mRoom(conversationId));
    const { members } = await this.data("GET", `/rooms/${conversationId}/members`);
    const users = () => members.map((m: string) => new sdk.UserId(m));
    await this.machine.updateTrackedUsers(users());
    await this.flush();
    await this.answer(this.machine.queryKeysForUsers(users()));          // POST /keys/query
    const claim = await this.machine.getMissingSessions(users());         // POST /keys/claim
    if (claim) await this.answer(claim);
    for (const s of await this.machine.shareRoomKey(room(), users(), new sdk.EncryptionSettings())) {
      await this.answer(s);                                               // POST /sendToDevice (m.room.encrypted)
    }
    const e = JSON.parse(await this.machine.encryptRoomEvent(room(), "m.room.message",
      JSON.stringify({ msgtype: "spreewe.v1", ...content })));
    return { algorithm: "m.megolm.v1.aes-sha2", ciphertext: e.ciphertext, session_id: e.session_id, sender_key: e.sender_key, device_id: e.device_id };
  }

  /** 4. Decrypt a received message, and check the sending device belongs to the claimed sender */
  async decrypt(m: { _id: string; conversationId: string; e2ee: any; user?: { _id: string }; userId?: any; createdAt?: string }) {
    const sender = String(m.user?._id || m.userId?._id || m.userId);
    const event = {
      type: "m.room.encrypted", event_id: `$${m._id}`, sender: mUser(sender),
      origin_server_ts: m.createdAt ? Date.parse(m.createdAt) : Date.now(), content: m.e2ee,
    };
    const r: any = await this.machine.decryptRoomEvent(JSON.stringify(event), new sdk.RoomId(mRoom(String(m.conversationId))),
      new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted));
    if (!(await this.deviceKeyBelongsTo(sender, r.senderCurve25519Key))) {
      throw new Error("The sender of this message could not be confirmed");
    }
    return JSON.parse(r.event).content as { text?: string; file?: EncryptedFileInfo & { storageKey: string } };
  }

  /** Megolm binds a session to a device key, not to a user id: confirm the key is one of the sender's devices */
  private async deviceKeyBelongsTo(userId: string, curve25519: string): Promise<boolean> {
    const has = async () => (await this.machine.getUserDevices(new sdk.UserId(mUser(userId))))
      .devices().some((d) => d.curve25519Key?.toBase64() === curve25519);
    if (await has()) return true;
    await this.machine.updateTrackedUsers([new sdk.UserId(mUser(userId))]);
    await this.flush();
    return has();
  }
}
```

The sender check in `decrypt` is what SpreeWe's own web client does (`webrtc-FE/src/app/core/crypto/e2ee.service.ts`). The test file decrypts without it; do not skip it in your app, or a relay could attribute a message to the wrong person.

### Putting it together

```ts
const device = await new AppDevice(SPREEWE_API, userId, getFreshUserToken, "ACMEAPP001").start();

socket.on("connect", () => { void device.sync(); /* + joinConversation for each open conversation */ });
socket.on("e2ee:to-device", () => void device.sync());          // a room key or device message is waiting
socket.on("e2ee:devices-changed", () => void device.sync());

// Receive
socket.on("receiveMessage", async (m) => {
  if (!m.e2ee) return;   // system / call messages
  try {
    const { text } = await device.decrypt(m);
    console.log(text);
  } catch {
    // Missing room key: it is sent separately and may arrive with the next sync. Retry after sync().
  }
});

// Send (user._id must be the token's user; the payload's device_id must be your app's device)
socket.emit("sendMessage", {
  user: { _id: userId },
  conversationId,
  type: "text",
  content: "",
  e2ee: await device.encrypt(conversationId, { text: "Hello from Acme" }),
});
```

- The `e2ee` object must match `webrtc-BE/src/e2ee/payload.ts`: `algorithm` `"m.megolm.v1.aes-sha2"`; `ciphertext` base64, ≤ 128 KiB; `session_id` and `sender_key` base64, ≤ 128 characters; `device_id` `[A-Za-z0-9_-]{4,64}`. Other fields are dropped.
- If `device_id` is not a device your app registered for this user, you get `message:rejected` `{ reason: "e2ee" }`. Over the daily quota: `reason: "quota"`.
- History over REST (`GET /v1/conversations/{id}/messages`) includes `e2ee` for apps with `e2ee:device`; decrypt it the same way.
- Edits: `message:edit` (`messages:edit`), also encrypted, author-only. See [Realtime events](./realtime-events.md).

---

## 7. Files (encrypted attachments)

Status: upload with an app token **Tested** (`developer-api-calls.test.ts`, storage mocked). Encrypt → upload → send → download → decrypt by a third-party client: **not tested**.

Attachments are end-to-end encrypted too. The server refuses plaintext attachments (`400 Attachments must be end-to-end encrypted`).

1. **Encrypt the file** with a fresh random AES-256-GCM key and 12-byte IV. Compute the SHA-256 of the ciphertext. (SpreeWe clients: `webrtc-FE/src/app/core/crypto/attachment-crypto.ts`.)
2. **Upload the ciphertext** (`files:write`):

   ```bash
   curl -X POST "$SPREEWE_API/upload" -H "Authorization: Bearer $TOKEN" \
     -F purpose=message -F conversationId=$CONV_ID -F encrypted=1 -F kind=pdf \
     -F "file=@ciphertext.bin;type=application/octet-stream"
   # → 200 { "storageKey": "…", "type": "pdf", "size": 12345, "encrypted": true }
   ```

   `kind` is one of `image` (10 MB), `video` (100 MB), `audio` (25 MB), `pdf` (25 MB), `file` (50 MB). It is visible metadata used for size limits and folders. The user must be a member of the conversation; blocks and the workspace's external-files policy apply.
3. **Send the message** with `type` = the returned `type`, `storageKey`, and the file key **inside the encrypted content**:

   ```ts
   const e2ee = await device.encrypt(conversationId, {
     text: "Invoice attached",
     file: { storageKey, key: keyB64, iv: ivB64, sha256: sha256B64, mimeType: "application/pdf", name: "invoice.pdf", size: plain.byteLength },
   });
   socket.emit("sendMessage", { user: { _id: userId }, conversationId, type: "pdf", content: "", storageKey, e2ee });
   ```

   The key, IV, real type and file name never reach the server. The server only checks that `storageKey` is a file this user uploaded to this conversation.
4. **Receive**: messages with attachments carry a short-lived signed `fileUrl` (`files:read` for `GET /files` and `GET /conversations/{id}/media`). Download the ciphertext, check its SHA-256 against `file.sha256` from the decrypted content, then decrypt with `file.key` and `file.iv`.

Group photos (`purpose=group-avatar`, `groupId`) and profile pictures (`PATCH /web/user/profile`) are not encrypted.

---

## 8. Calls (signaling and media)

Status: signaling, joining media and creating transports, host controls and recording control **Tested** in Node (`developer-api-calls.test.ts`). **No real audio or video** has been sent or received by an app in a test, and nothing has been tested in a real browser or mobile app.

Media runs through a **mediasoup** SFU. In a browser, use **mediasoup-client** (the browser library) to drive WebRTC; for other runtimes you need a mediasoup-compatible client. The app joins a call as **another device of the user**.

Scopes: `calls:read` (rings, call state, lifecycle events), `calls:write` (start, accept, media, screen share), `calls:manage` (host controls), `recordings:write` (start/stop recording), plus `realtime:connect`.

### Signaling

```ts
const ack = <T = any>(event: string, payload: unknown) => new Promise<T>((r) => socket.emit(event, payload, r));

// Start (no ack: answer is the call:started event, or call:error)
socket.once("call:started", ({ callId }) => { /* … */ });
socket.emit("call:start", { groupId: conversationId, callType: "audio", mode: "ring" });   // mode: "ring" | "meetNow"

// Incoming (calls:read)
socket.on("call:incoming", async ({ callId }) => {
  const res = await ack("call:accept", { callId });     // { success, callId } | { error }
});
socket.emit("call:reject", { callId });
socket.emit("call:leave", { callId });
await ack("call:end", { callId });                      // group calls: hosts only
socket.on("call:participant-joined", (p) => {}); socket.on("call:participant-left", (p) => {});
socket.on("call:ended", (p) => {}); socket.on("call:error", (e) => {});
```

### Media (mediasoup-client)

```ts
import { Device } from "mediasoup-client";

const { rtpCapabilities } = await ack("mediasoup:getRouterRtpCapabilities", {});
const device = new Device();
await device.load({ routerRtpCapabilities: rtpCapabilities });

const joined = await ack("mediasoup:joinCall", { callId, callType: "audio" });
// { success: true, producers: [...] } | { lobby: true } (wait for call:admitted) | { error, code? }

const s = await ack("mediasoup:createSendTransport", {});   // { id, iceParameters, iceCandidates, dtlsParameters, … }
const send = device.createSendTransport(s);
send.on("connect", ({ dtlsParameters }, ok, fail) =>
  ack("mediasoup:connectTransport", { transportId: send.id, dtlsParameters }).then((r: any) => r.error ? fail(new Error(r.error)) : ok()));
send.on("produce", ({ kind, rtpParameters, appData }, ok, fail) =>
  ack("mediasoup:produce", { transportId: send.id, kind, rtpParameters, appData }).then((r: any) => r.error ? fail(new Error(r.error)) : ok({ id: r.id })));
await send.produce({ track: micTrack });

const rcv = device.createRecvTransport(await ack("mediasoup:createRecvTransport", {}));
rcv.on("connect", ({ dtlsParameters }, ok, fail) =>
  ack("mediasoup:connectTransport", { transportId: rcv.id, dtlsParameters }).then((r: any) => r.error ? fail(new Error(r.error)) : ok()));

async function consume(producerId: string) {
  const c = await ack("mediasoup:consume", { producerId, rtpCapabilities: device.rtpCapabilities });
  const consumer = await rcv.consume(c);
  await ack("mediasoup:resumeConsumer", { consumerId: c.id });
  return consumer.track;
}
for (const p of joined.producers) await consume(p.producerId);
socket.on("mediasoup:newProducer", (p) => consume(p.producerId));
socket.on("mediasoup:producerClosed", (p) => { /* drop that consumer */ });
// After a reconnect or to resync: ack("mediasoup:syncProducers", { callId }) → { producers }
```

Rules:

- **`NOT_JOINED`**: `createSendTransport`, `createRecvTransport`, `connectTransport`, `restartIce` and `syncProducers` answer `{ error: "Join the call before using media", code: "NOT_JOINED" }` until this socket has completed a successful, non-lobby `mediasoup:joinCall` and the user is still an active participant.
- **One media session per user**: if the user is already in a call on another device (for example SpreeWe's own app), `mediasoup:joinCall` answers `{ error: "You're already in a call on another device", code: "IN_CALL_ELSEWHERE" }`. `call:session` tells you whether the user is live elsewhere; `call:takeover` `{ callId }` moves the session to your socket.
- `ice:getServers` returns STUN/TURN configuration with per-user credentials.
- **Host controls** (`calls:manage`, host or co-host of a group call): `call:mute-participant`, `call:mute-all`, `call:remove-participant`, `call:admit`, `call:deny`, `call:set-cohost`, `call:settings`. The muted client receives `call:force-muted` and is expected to mute itself.
- **Recording** (`recordings:write`): `call:record-start` / `call:record-stop` `{ callId }`. The server decides whether recording can start (host role, server configuration). Read results with `recordings:read` (`GET /recordings/{id}`, `GET /v1/recordings/{id}`, `recording:updated`).
- Screen share: `screen:join`, `screen:start`, `screen:stop`, `screen:getState`; produce with `appData: { source: "screen" }`.

Payloads and every error: [Realtime events §3](./realtime-events.md#calls).

---

## 9. Webhooks

Status: **Tested** (`webhooks.test.ts`: signing, verification challenge, retries, dead letters, auto-disable, SSRF rules, tenant isolation). Full reference: [Outbound webhooks](../integrations/outbound-webhooks.md).

1. **Pick events.** `GET /v1/webhook-events` lists them with the scope each needs: `message.created` (`messages:read`), `conversation.members_added` and `conversation.members_removed` (`conversations:read`), `call.started` and `call.ended` (`calls:read`), `recording.available` (`recordings:read`).
2. **Create the endpoint** (portal Webhooks tab, or `POST /v1/apps/{appId}/webhooks` `{ url, events, description?, confirm }`). The signing secret `swh_…` is returned **once**. Max 5 endpoints per app.
3. **Verify it.** `POST /v1/apps/{appId}/webhooks/{endpointId}/verify`. SpreeWe posts a signed `webhook.verification` event with `data.challenge`. Answer 2xx with `{"challenge":"<value>"}` or the raw value. Only then does the endpoint become `active`.
4. **Verify every delivery**:

```ts
import crypto from "crypto";
import express from "express";

const app = express();
app.post("/spreewe/webhooks", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body.toString("utf8");
  const id = req.header("SpreeWe-Webhook-Id")!;
  const ts = req.header("SpreeWe-Webhook-Timestamp")!;
  const sig = req.header("SpreeWe-Webhook-Signature") || "";
  if (!verify(process.env.SPREEWE_WEBHOOK_SECRET!, id, ts, sig, raw)) return res.sendStatus(401);
  const event = JSON.parse(raw);
  if (event.type === "webhook.verification") return res.json({ challenge: event.data.challenge });
  if (alreadyProcessed(id)) return res.sendStatus(200);   // at-least-once delivery: de-duplicate
  queue(event);                                            // answer fast (timeout 10 s)
  res.sendStatus(200);
});

function verify(secret: string, id: string, ts: string, header: string, raw: string): boolean {
  if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${id}.${ts}.${raw}`).digest();
  return header.split(/[ ,]+/).some((part) => {
    if (!part.startsWith("v1=")) return false;
    const got = Buffer.from(part.slice(3), "hex");
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
}
```

- Envelope: `{ id, type, createdAt, appId, tenantId, data, audience: { userIds } }`. `audience.userIds` are the users who authorised your app for this event: use one of their tokens to call back.
- `message.created` `data.content` is only included for `text` messages. Because messages are end-to-end encrypted, expect it to be empty or a placeholder; decrypt the message through the API with an `e2ee:device` app device instead.
- **Retries**: any non-2xx, redirect, timeout or connection error is retried with exponential backoff (30 s · 2^(n−1), capped at 6 h, 50–100 % jitter). After 8 attempts the delivery is `dead` (re-queue with `POST …/deliveries/{deliveryId}/retry`). After 15 consecutive failures the endpoint is disabled; re-enable and verify again.
- **Rotate the secret**: `POST …/rotate-secret` `{ confirm, keepOldSeconds? }`. Both secrets sign during the grace period (default 86,400 s).
- URLs must resolve to public addresses; localhost is never reachable. Use a public tunnel for local testing.

---

## 10. Going to production

1. **Create a production app** (`environment: "production"`). Its client IDs start with `swk_live_`. Origins, redirect URLs and webhook URLs must be `https`. Re-enter scopes, origins, redirect URLs and webhooks; users authorise it again (grants belong to an app).
2. **Set quotas** (`PATCH /v1/apps/{appId}` `quotas`) for your expected traffic. Connection caps are per server instance.
3. **Secrets**:
   - Keep `sws_` and `swh_` secrets in a secret manager on your server.
   - Rotate credentials before they expire (default 180 days): `POST /v1/apps/{appId}/credentials/{credentialId}/rotate` `{ confirm }`. The old secret keeps working for a grace period (default 1 hour); the response gives `previous.validUntil`.
   - Revoke a leaked credential immediately: `POST …/credentials/{credentialId}/revoke` `{ confirm }`.
4. **Revoking access**:
   - One token: `POST /v1/app-tokens/revoke`; one refresh family: `POST /oauth/revoke`.
   - Every user token of the app: `POST /v1/apps/{appId}/tokens/revoke-all` `{ confirm }`.
   - Pause the app: `POST /v1/apps/{appId}/suspend` (credentials and tokens stop working; `reactivate` undoes it). Permanent: `POST /v1/apps/{appId}/revoke` `{ confirm }`.
   - Users withdraw access themselves (`DELETE /v1/me/app-grants/{grantId}`); workspace admins can revoke all grants of an app in their workspace (`POST /v1/workspace/apps/{appId}/revoke-grants`, SpreeWe session).
5. **Monitor**: the portal's **Usage, last 30 days** (`GET /v1/apps/{appId}/usage?days=`: `apiRequests`, `apiErrors`, `tokensIssued`, `messagesSent`, `socketConnections`) and **Activity** (`GET /v1/apps/{appId}/audit`), plus webhook delivery history.
6. **Handle expiry and loss**: refresh tokens before they expire, reconnect sockets with fresh tokens, persist your encryption device's state.

### What is not tested yet

Be aware of these before you rely on them:

- **No real browser or mobile testing** of: calls with real audio/video (mediasoup-client), encrypted attachments end to end, OAuth redirects through a real browser, and app sockets from a browser or mobile app. All of these are exercised only by server tests in Node.
- **No key backup** for encryption devices. Lost device state means lost access to older messages.
- **Persistence of the Olm/Megolm state** for an app device is not covered by SpreeWe's tests; the worked example keeps it in memory.
- Socket connection caps and socket event limits are per server instance, not cluster-wide.
