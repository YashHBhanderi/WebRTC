# @spreewe/core

Client, authentication, REST, Socket.IO and shared types. No UI, no framework. Every other package
builds on it.

```bash
npm install @spreewe/core
```

```ts
import { createClient, createOAuthClient } from "@spreewe/core";

const oauth = createOAuthClient({ baseUrl, clientId, redirectUri, scopes: ["profile:read", "realtime:connect"] });
const client = createClient({ baseUrl, auth: oauth });
const me = await client.loadMe();
```

Authentication modes, scopes and connection behaviour: [docs/authentication.md](../../docs/authentication.md).

## `createClient(options): SpreeWeClient`

| Option | Type | Default |
|---|---|---|
| `baseUrl` | `string` | required. API base, with or without `/api` |
| `auth` | `TokenProvider` | required |
| `socket.url` / `socket.path` / `socket.transports` / `socket.ackTimeoutMs` / `socket.factory` | | origin of `baseUrl` / `/socket.io` / Socket.IO default / 10 000 / `io()` |
| `timeoutMs` | `number` | 30 000 |
| `fetch` | `typeof fetch` | global `fetch` |

| Member | |
|---|---|
| `http: HttpClient` | REST (below) |
| `realtime: RealtimeClient` | Socket.IO (below) |
| `people: PeopleApi` | `directory({ q, limit, cursor })`, `profile(userId)`, `presence` store, `watchPresence(userId, fn)`, `seedPresence()`, `remember()` |
| `auth: TokenProvider` | |
| `me: ReadableStore<Me \| null>`, `loadMe({ refresh })`, `userId()` | `GET /v1/me` |
| `scopes()`, `hasScopes(...scopes)` | From the token's `scp` claim; `null` / `true` for session tokens |
| `config`, `loadConfig()`, `mediaUrl(keyOrUrl)` | `GET /config`; resolves storage keys (avatars) to URLs |
| `service(key, create)`, `peekService(key)` | One instance of a module service per client |
| `destroy()` | Disconnect and dispose every module service (sign-out) |

## Token providers

- `createOAuthClient({ baseUrl, clientId, redirectUri, scopes, storage?, storageKey?, refreshMarginMs?, fetch? })` →
  `OAuthClient`: `createAuthorizeUrl({ state? })`, `signIn()`, `isRedirectCallback(url?)`,
  `handleRedirectCallback(url?, { replaceUrl? })`, `getToken({ forceRefresh? })`, `signOut()`,
  `onSignedOut(fn)`, `isSignedIn`, `grantedScopes`, `status` store.
- `backendTokenProvider({ fetchToken, refreshMarginMs? })` — `fetchToken` returns `{ accessToken, expiresAt | expiresIn }` or a string.
- `sessionTokenProvider(getToken)` — SpreeWe (Clerk) session.
- Implement `TokenProvider` yourself: `{ kind: "app" | "session", getToken({ forceRefresh }) }`.

## Server client (`@spreewe/core/server`)

For YOUR backend only (Node.js 18+). It holds the app credential, so it is a separate entry point that
is not part of the browser bundle, and it refuses to start where a DOM exists.

```ts
import { createServerClient } from "@spreewe/core/server";

const spreewe = createServerClient({ baseUrl, keyId: process.env.SPREEWE_KEY_ID!, secret: process.env.SPREEWE_SECRET! });

// once per user (for example at sign-up, or on every sign-in with ensure)
await spreewe.users.ensure({ externalUserId: `user-${me.id}`, name: me.displayName, email: me.email });
// after YOUR session check: a short-lived token for your frontend (backendTokenProvider)
const { accessToken, expiresAt } = await spreewe.userToken(`user-${me.id}`);
```

| Member | |
|---|---|
| `users.register(input)` | `POST /v1/app-users`. Rejects with status 409 when the `externalUserId` exists |
| `users.ensure(input)` | Register, or return the existing user on 409 |
| `users.get(externalUserId)` | Rejects with 404 for an unknown id (including another app's users) |
| `users.list({ limit, cursor, status })` → `{ items, nextCursor }`, `users.all({ status })` | One page / an async iterator over every page |
| `users.update(externalUserId, { name, email, avatarUrl, active })` | `null` clears `email` / `avatarUrl` |
| `users.deactivate(externalUserId)`, `users.reactivate(externalUserId)` | Deactivating stops the user's tokens at once |
| `userToken(externalUserId, { scopes, ttlSeconds, forceRefresh })` | `POST /v1/app-tokens`; cached per user and scope set until 60 s before expiry |
| `revokeToken(accessToken)` | `POST /v1/app-tokens/revoke` (sign-out) |

These need an app with its own tenant (every app created from the personal context). The tenant always
comes from the credential; there is no tenant parameter. Users registered here can only find and talk
to other users of the same app. Guide: `docs/developer/app-users.md` in the SpreeWe repository.

## `HttpClient`

`get / post / put / patch / delete(path, body?, options)` unwrap the response envelope (`{ data }` on
`/v1`, `{ status|success, data, message }` on session routes). `page(path)` returns
`{ items, nextCursor }` for paginated `/v1` routes. `raw()` skips unwrapping. Options: `query`,
`body`, `form` (multipart), `headers`, `signal`, `timeoutMs`, `anonymous`, `onUploadProgress`.

## `RealtimeClient`

| | |
|---|---|
| `connect()` / `disconnect()` | Idempotent; `connect()` rejects only on fatal handshake errors |
| `state`, `lastError` | Stores: `idle \| connecting \| connected \| reconnecting \| offline \| failed` |
| `on(event, handler)` → unsubscribe | Survives reconnects |
| `onConnect(handler)` | After every (re)connect, rooms already re-joined |
| `emit(event, ...args)` | Fire and forget |
| `request(event, payload, { timeoutMs, raw })` | Ack as a promise; rejects with `ACK_TIMEOUT`, or `SOCKET_REFUSED` on `{ error }` |
| `joinConversation(id)` → release | Reference-counted room membership, re-joined after reconnects |

## Errors

Everything throws `SpreeWeError` (`code`, `message`, `status?`, `details?`, `retryAfterMs?`). Use
`isSpreeWeError(e, "RATE_LIMITED")`. Server `/v1` error codes pass through (`VALIDATION_ERROR`,
`NOT_FOUND_ERROR`, …).

## Other exports

`Store`, `derived`, `Emitter` (tiny observable primitives), `decodeJwt`, `isAppToken`,
`msUntilExpiry`, `SCOPES`, `FEATURE_SCOPES`, `scopesFor(features, { includeOptional })`,
`createPkcePair`, `codeChallengeS256`, `MemoryStorage`, `getE2ee(client)` and the E2EE contract
types, and the backend's data types (`Message`, `Conversation`, `UserSummary`, `PresenceUpdate`, …).
