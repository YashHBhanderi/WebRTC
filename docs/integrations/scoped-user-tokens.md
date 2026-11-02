# Scoped user tokens: integrating SpreeWe into your app

```
 your browser / mobile app ──(your login)──▶ YOUR backend ──(app credential)──▶ SpreeWe POST /v1/app-tokens
          │                                        │                                   │
          │◀──────────── short-lived user token ───┘◀───────────── user token ─────────┘
          │
          └──(Bearer user token)──▶ SpreeWe /v1 REST  +  Socket.IO
```

**Rules:**
- The app credential (`keyId` + `secret`) lives only on your backend. Never put it in JavaScript bundles, mobile apps, public SDKs or logs.
- Your users log in to **your** app with **your** authentication. SpreeWe does not trust your user ids. Your backend can only get a token for a person who authorised your app in SpreeWe and linked your `externalUserRef` to their SpreeWe account.
- Tokens are short-lived (10 minutes by default, 15 at most) and carry only the scopes the user granted, within your app's scopes.

## 1. Backend: exchange the credential for a user token

Working helper: [`examples/backend/spreewe-server-client.ts`](./examples/backend/spreewe-server-client.ts). Express route: [`examples/backend/server.ts`](./examples/backend/server.ts).

```ts
const spreewe = new SpreeWeServerClient(process.env.SPREEWE_API!, process.env.SPREEWE_KEY_ID!, process.env.SPREEWE_SECRET!);
// after YOUR session check:
const { accessToken, expiresAt } = await spreewe.userToken(`yourapp-user-${me.id}`, ["realtime:connect", "messages:read"]);
```

Raw call:

```http
POST /api/v1/app-tokens
Authorization: Basic base64(swk_test_…:sws_…)
{ "externalUserRef": "yourapp-user-42", "scopes": ["messages:read"], "ttlSeconds": 600 }
→ 201 { "data": { "accessToken": "eyJ…", "tokenType": "Bearer", "expiresIn": 600, "scopes": ["messages:read"], "tenantId": null } }
```

| Response | Meaning |
| --- | --- |
| `401` | Bad, expired or revoked credential |
| `403` | The user hasn't authorised your app, or withdrew; a scope is beyond their grant; your app is suspended; for a workspace app, the user is no longer a member |
| `400` | Both or neither of `userId`/`externalUserRef`; `ttlSeconds` out of range; unknown fields (for example `tenantId`, which you can't choose) |
| `429` | Per-credential rate limit |

## 2. Frontend: REST and Socket.IO with the user token

Working client: [`examples/frontend/spreewe-browser-client.ts`](./examples/frontend/spreewe-browser-client.ts). It asks your backend for tokens and never sees the credential.

```ts
const client = new SpreeWeBrowserClient("https://api.example.com/api", "https://api.example.com", () =>
  fetch("/spreewe/token", { method: "POST", credentials: "include" }).then((r) => r.json()));
const me = await client.get("/v1/me");                       // needs profile:read
await client.connect((message) => render(message));          // needs realtime:connect (+ messages:read to receive)
// Sending messages isn't available to apps: every message is end-to-end encrypted on the user's own devices
```

- REST: `Authorization: Bearer <accessToken>` on `/api/v1/...` routes that list the scope (`x-required-scope` in OpenAPI). Other routes answer `403`, and legacy (non-`/v1`) routes answer `401`.
- Socket.IO: `io(url, { auth: { token: accessToken } })`. Your page's origin must be in the app's `allowedOrigins`.
- **App sockets can:**
  - ~~send text messages (`sendMessage`)~~: no longer possible; messages are end-to-end encrypted, and apps receive incoming ones only as `{ encrypted: true }` notices;
  - receive `receiveMessage`, `message:updated` and `message:deleted`;
  - receive presence of people visible in the app's context.
- **App sockets cannot:** join calls or media, manage groups, upload files, or receive notifications.

## 3. Expiry and revocation

- On a `401` from REST, fetch a new token from your backend and retry once. The example client does this.
- The server **closes app sockets when the token expires**, so reconnect with a fresh token. The example client does this too.
- On sign-out, have your backend call `POST /v1/app-tokens/revoke` with the token.
- **Tokens stop working immediately, on every instance, when:**
  - the user withdraws consent;
  - your app is suspended or revoked, or you call revoke-all;
  - (workspace apps) the user leaves the workspace or the organization is deleted;
  - the user is deleted or banned in Clerk.
- Removing a scope from your app (or the user's grant) removes that scope from existing tokens at once; their other scopes keep working.

## 4. Tenant boundaries

- **Global app:** tokens act in the user's personal context (global chats, and external chats they're a guest in).
- **Workspace app:** tokens act only in that workspace and only while the user is a member. A workspace app can't see global or other workspaces' data, and nothing in a request can change that.

## 5. Errors and rate limits

All `/v1` errors look like:

```json
{ "error": { "code": "…", "message": "…", "details": [] } }
```

The full table is in `docs/api/v1.md`. Rate limits (`RateLimit-*` headers):
- per IP;
- per app (`quotas.rateLimitPerMinute`);
- per credential for token exchange;
- a daily message quota, enforced across all instances.

Per-minute limits are enforced **per server instance**; see `docs/security/developer-platform-security.md`.
