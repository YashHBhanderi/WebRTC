# Authentication and configuration

The SDK never invents its own auth. It uses SpreeWe's existing mechanisms through a **token
provider**, which hands a fresh bearer token to every REST request and every Socket.IO (re)connect.

| Provider | When to use | Token |
|---|---|---|
| `createOAuthClient()` | Browser apps **without** a backend secret (SPA, static site) | Developer-app user token, refreshed with a rotating refresh token |
| `backendTokenProvider()` | You have a backend that holds the app credential | Developer-app user token from `POST /v1/app-tokens`, re-fetched before it expires |
| `sessionTokenProvider()` | The user signs in to SpreeWe itself (Clerk) in your client | The user's own SpreeWe session token (no scopes; the user's full permissions) |

Backend reference: [docs/developer/authentication.md](../../docs/developer/authentication.md) and
[OAuth](../../docs/developer/rest-api/oauth.md).

## 1. Register the app

In SpreeWe, **Account menu → Developer portal** (or `POST /v1/apps`):

- **Scopes**: only what you integrate. Use `scopesFor([...])` from `@spreewe/core` to compute them
  (table below). The user can untick scopes on the consent screen; check `oauth.grantedScopes`.
- **Allowed origins**: every origin your pages run on, exact (`https://app.example.com`, no paths).
  The backend adds them to CORS for REST and Socket.IO, and rejects an app token presented from
  another origin. Each server caches this list for 60 s after a change.
- **Callback URLs** (OAuth): the exact redirect URI(s). Development apps may use `http://localhost`.
- **Environment / quotas**: development apps are capped at **120 requests/minute for the whole app**
  (all users together); production apps can be raised to 6000. See [production.md](production.md#rate-limits).
- A **workspace** app (`tenantBound`) acts only inside one workspace; a **global** app in the user's
  personal context.

The OAuth `client_id` is the app's **id** (`_id`), not the `swk_…` credential key id.

## 2a. OAuth 2.0 + PKCE (browser, no backend)

```ts
import { createClient, createOAuthClient, scopesFor } from "@spreewe/core";

const oauth = createOAuthClient({
  baseUrl: "https://api.spreewe.example",
  clientId: "6650f0…",                       // app id
  redirectUri: "https://app.example.com/",    // must match a callback URL exactly
  scopes: scopesFor(["chat", "calls"], { includeOptional: true }),
  storage: "session",                         // default; "local" | "memory" | custom
});

if (oauth.isRedirectCallback()) await oauth.handleRedirectCallback(); // checks state, exchanges the code
if (!oauth.isSignedIn) await oauth.signIn();                          // → SpreeWe consent page

const client = createClient({ baseUrl: "https://api.spreewe.example", auth: oauth });
oauth.onSignedOut((reason) => client.destroy());                       // "revoked" | "signed-out" …
```

What the client does:

- PKCE S256 with a 64-character verifier from WebCrypto; random `state` (checked on return; a
  callback that doesn't match the pending sign-in throws `OAUTH_STATE_MISMATCH`).
- Codes are one-time and valid for 2 minutes; handle the callback right away.
- Access tokens are refreshed 60 s before expiry (`refreshMarginMs`). Refresh tokens **rotate**:
  presenting a used one revokes the whole family. The client therefore runs one refresh at a time,
  and with `storage: "local"` (shared between tabs) serialises refreshes across tabs with the Web
  Locks API. Without Web Locks, use the default per-tab `"session"` storage.
- A refused refresh (grant withdrawn, app revoked, token reused) clears the session and fires
  `onSignedOut("revoked")`. Sign in again.
- `signOut()` revokes the refresh token family on the server (best effort) and clears storage.

Security: tokens in Web Storage can be read by any script on your origin. Use a strict Content
Security Policy and keep third-party scripts off pages that hold tokens. `"memory"` avoids storage
at the cost of signing in on every reload.

## 2b. Backend token exchange

Your backend authenticates **its own** user, then calls SpreeWe with the credential:

```http
POST /v1/app-tokens
Authorization: Basic base64(swk_live_…:sws_…)
Content-Type: application/json

{ "userId": "<SpreeWe user id>" }        // or { "externalUserRef": "<your user id>" }
```

and returns `{ accessToken, expiresAt }` to its browser. In the browser:

```ts
import { backendTokenProvider, createClient } from "@spreewe/core";

const auth = backendTokenProvider({
  fetchToken: async () => (await fetch("/api/spreewe-token", { method: "POST", credentials: "include" })).json(),
});
const client = createClient({ baseUrl: "https://api.spreewe.example", auth });
```

- Tokens live 60–900 s (default 600). The provider caches the token and fetches a new one 60 s before
  expiry; concurrent callers share one fetch.
- The user must have approved the app once (consent request, `POST /v1/consent-requests`).
- Never ship the credential secret to a browser. [`examples/token-server`](../examples/token-server)
  is a minimal (deliberately unauthenticated, example-only) backend.

## 2c. SpreeWe session (Clerk)

```ts
const auth = sessionTokenProvider(() => clerk.session?.getToken());
```

Session tokens last about 60 s, so the SDK asks for one before every request and connect. Your
origin must be in the server's `CORS_ORIGINS` and `CLERK_AUTHORIZED_PARTIES` (set by whoever deploys
SpreeWe). `client.scopes()` returns `null` for session tokens: they carry the user's own permissions.

## 3. Scopes by module

`FEATURE_SCOPES` in `@spreewe/core` lists them; `scopesFor(["chat"])` returns the required ones.

| Module | Required | Optional (unlocks) |
|---|---|---|
| contacts | realtime:connect, directory:read, profile:read | contacts:write (start chats, block), profile:write (edit profile, presence) |
| chat | realtime:connect, profile:read, conversations:read, groups:read, messages:read | **e2ee:device + messages:write** (read content, send), messages:edit, messages:react, messages:delete, conversations:write, files:write (attachments), contacts:write, directory:read |
| groups | realtime:connect, profile:read, groups:read | groups:write, groups:manage, conversations:delete, files:write, directory:read |
| calls | realtime:connect, profile:read, calls:read, calls:write | calls:manage (host controls), recordings:read, recordings:write |
| meetings | profile:read, meetings:read | meetings:write, realtime:connect |
| files | profile:read, files:read | files:write, e2ee:device |
| notifications | notifications:read | notifications:write, realtime:connect |

`e2ee:device` is the most sensitive scope: the app's device can read the user's messages in every
conversation whose keys reach it, and the consent screen says so. Apps without it see that messages
exist (`bodyState: "withheld"`) but never their content.

Components hide or disable actions the token can't use (`client.hasScopes()`), but that's
convenience only. The server checks the scope **and** the user's own rights (membership, group
admin, call host, workspace role) on every request and event.

## 4. Client options

```ts
createClient({
  baseUrl: "https://api.spreewe.example", // REST base; "/api" prefix optional
  auth,                                     // a TokenProvider
  socket: {
    url: "https://api.spreewe.example",     // default: origin of baseUrl
    path: "/socket.io",                     // default
    transports: ["websocket"],              // default: WebSocket with polling fallback
    ackTimeoutMs: 10_000,
  },
  timeoutMs: 30_000,                        // REST timeout
  fetch,                                    // custom fetch (SSR, tests)
});
```

## 5. Connection management and errors

- **REST:** after a 401 the client force-refreshes the token and retries once. After a 429 with
  `Retry-After` ≤ 10 s it waits and retries once (a rate-limited request was not processed).
  Everything else throws `SpreeWeError` with a stable `code` (`VALIDATION_ERROR`, `FORBIDDEN`,
  `NOT_FOUND`, `RATE_LIMITED`, `NETWORK_ERROR`, `TIMEOUT`, `SIGNED_OUT`, …), `status` and `details`.
- **Socket:** one connection per client, shared by all modules, opened by the first module that
  needs it. `client.realtime.state` is `idle | connecting | connected | reconnecting | offline | failed`.
  - Network drops: Socket.IO reconnects by itself.
  - The server closes app sockets when the token expires or access is revoked; the client
    reconnects with a force-refreshed token and exponential backoff (up to 30 s).
  - Rooms are re-joined and each module re-syncs (messages, receipts, E2EE keys, call rings) after
    every reconnect.
  - `failed` means retrying can't help: the token lacks `realtime:connect` (`MISSING_SCOPE`), three
    handshakes were refused with fresh tokens, or the provider is signed out. Call `connect()` again
    after fixing the cause.
- Events the server refuses (missing scope, rate limit) are never acknowledged; `request()` rejects
  with `ACK_TIMEOUT` after `ackTimeoutMs`.

## 6. Personal vs workspace context

A token's context is fixed: a workspace app's tokens see only that workspace; a global app's tokens
see the personal context. To switch workspace, use a token for the other context (a new client).
