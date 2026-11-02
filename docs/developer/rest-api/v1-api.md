# SpreeWe REST API v1 reference

This page documents every `/v1` endpoint the SpreeWe backend serves. It is based on the route definitions in `webrtc-BE/src/api/v1/*.ts`. Those definitions also generate the machine-readable spec in [`docs/api/openapi.yaml`](../../api/openapi.yaml). If this page and the code ever disagree, the code is correct.

Before you build a developer app, read [Developer-app tokens and end-to-end encryption](#developer-app-tokens-and-end-to-end-encryption). It covers what app tokens cannot do.

## Contents

- [Conventions](#conventions)
- [Developer-app tokens and end-to-end encryption](#developer-app-tokens-and-end-to-end-encryption)
- [Scope catalogue](#scope-catalogue)
- Reference: [Apps & credentials](#apps--credentials) · [Consent & grants](#consent--grants) · [App tokens](#app-tokens) · [Webhooks](#webhooks) · [E2EE devices & keys](#e2ee-devices--keys) · [Organizations](#organizations) · [Workspace admin](#workspace-admin) · [Teams & channels](#teams--channels) · [Contacts](#contacts) · [Me, workspace & directory](#me-workspace--directory) · [Conversations & messages](#conversations--messages) · [Calls](#calls) · [Recordings](#recordings)

---

## Conventions

### Base path

Every endpoint is served at both `/v1/...` and `/api/v1/...`. The server mounts the same router with and without the `/api` prefix. Behind nginx, use `/api/v1`. The examples on this page use:

```sh
export SPREEWE=https://your-spreewe-host/api   # base URL incl. /api
export TOKEN=...        # Clerk session token (first-party)
export APP_TOKEN=...    # developer-app user token from POST /v1/app-tokens
export KEY_ID=... SECRET=...   # developer-app server credential
```

### Authentication kinds

No `/v1` route is public. Each route uses one of three authentication modes (`AuthMode` in `registry.ts`):

| Auth kind | What is accepted | Notes |
|---|---|---|
| `user` (default) | A Clerk session token (`Authorization: Bearer`), **or** a developer-app user token, but only if the route declares a `scope` | If a route has no scope, an app token gets `403 "This endpoint needs a signed-in SpreeWe session"`. |
| `firstParty` | Clerk session token only | App tokens get `403`. This covers app management, consent, webhooks, E2EE, organizations, teams and contacts. |
| `appCredential` | The app's server credential: `Authorization: Basic base64(keyId:secret)` | Used only by `POST /v1/consent-requests`, `POST /v1/app-tokens` and `POST /v1/app-tokens/revoke`. Call these from your server only. |

How a token is checked:

- The server treats a bearer token as an app token when it is a three-part JWT whose header `kid` matches the app-token key id. Any other bearer token is verified as a Clerk session.
- App tokens are checked against the current state of the app, the user's grant and the user's workspace membership. Every failure returns the same response: `401 "Invalid or expired token"`. That includes expired or revoked tokens, a suspended app and a removed member. The server also checks the request's `Origin` against the app's `allowedOrigins`.
- **Scope check:** the route's `scope` must appear in the token's scopes. Otherwise the response is `403 "The token lacks the <scope> scope"`.
- **CSRF guard:** a non-GET request authenticated by a cookie, with no `Authorization` header, is refused with `403`. Send the session token in the `Authorization` header.
- Unknown `/v1` paths authenticate first and then return `404`. An unauthenticated request gets `401`, and an app token gets `403`.

### Context and workspace

- The **workspace** is the active organization in the verified session. For an app token, it is the app's tenant binding. No endpoint accepts a tenant id from the request.
- With no active organization, you are in the **global (personal) context**.
- Routes marked **Workspace: yes** (`x-requires-workspace` in OpenAPI) return `400 "This endpoint needs an active workspace"` in the global context.
- Ids are 24-character hex strings. A malformed id returns `400`. A resource you can't see returns `404`, never `403`, so the API does not reveal what exists in other workspaces.

### Response envelope

| Case | Status | Body |
|---|---|---|
| Success, `POST` | `201` | `{ "data": ... }` |
| Success, `GET` / `PATCH` / `DELETE` | `200` | `{ "data": ... }` |
| Paginated success | `200` | `{ "data": [ ... ], "page": { "nextCursor": "6650c1..." \| null } }` |
| Any failure | 4xx / 5xx | `{ "error": { "code": "...", "message": "...", "details": [ { "path": "...", "message": "..." } ] } }` |

Every successful `POST` returns `201`, including action endpoints such as `/revoke` and `/verify`. `details` appears only on validation errors and lists at most 20 issues. The server rejects unknown body or query fields (`"is not allowed"`).

### Error codes

| HTTP status | `error.code` |
|---|---|
| 400, 413, 415, 422 | `VALIDATION_ERROR` |
| 401 | `AUTHENTICATION_ERROR` |
| 403 | `PERMISSION_ERROR` |
| 404 | `NOT_FOUND_ERROR` |
| 409 | `CONFLICT_ERROR` |
| 429 | `RATE_LIMIT_ERROR` |
| 5xx | `SERVER_ERROR` (the message is generic; details are logged on the server) |

Every route can return 400, 401, 403, 429 and 500. The per-endpoint "Errors" lines below list only the additional statuses each route declares.

### Pagination

Paginated routes take `limit` (integer, minimum 1, maximum 100) and `cursor`. Pass the previous response's `page.nextCursor` as `cursor`. When `nextCursor` is `null`, there are no more pages.

The default `limit` is 20 for core lists and 50 for organization and workspace lists. Each route lists its own default. For most routes the cursor is a 24-character id. On `GET /v1/calls` it is an ISO timestamp. Treat cursors as opaque either way.

### Rate limits

| Limiter | Applies to | Default | Configured by |
|---|---|---|---|
| Per IP, global | All HTTP requests | 600 per window (60 s) | `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS` |
| Sensitive | Routes marked **Sensitive: yes** | 60 per window, per IP | `RATE_LIMIT_SENSITIVE_MAX` |
| Per app | Requests made with app tokens, shared by all users of the app | The app's `quotas.rateLimitPerMinute` (fallback 60/min) | App quotas |
| Per credential | `appCredential` routes | 120/min per `keyId` | `APP_CREDENTIAL_RATE_PER_MIN` |

Responses include draft-7 `RateLimit` headers. A `/v1` limiter returns `429` with the standard error envelope. The global per-IP limiter runs before the `/v1` router and returns `{ "success": false, "message": "Too many requests..." }` instead.

### Confirmation and recent sign-in

Some high-impact app, webhook and workspace actions take `confirm`, which must be the app's exact name. Organization delete takes the organization's exact name. If the Clerk session carries the `fva` claim, these actions also require a sign-in within the last 10 minutes. Otherwise the response is `403`.

### Status labels

- **Implemented (server tests):** a test in `webrtc-BE/test/*.test.ts` calls the route.
- **Implemented, not covered by tests:** the route exists but no server test calls it.

---

## Developer-app tokens and end-to-end encryption

> **Summary:** a developer-app token can read metadata, such as profiles, the directory, conversation lists, message metadata, call history and recordings. It **cannot send messages and cannot decrypt them**. This is intentional, not a bug.

SpreeWe messages are end-to-end encrypted on the user's own devices, and a developer app holds no device keys. The server enforces this in four places:

1. **No E2EE device for apps.** Every `/v1/e2ee/*` route is `firstParty`, so an app token gets `403` before reaching the handler. The E2EE service also rejects any context that carries an app (`e2ee.service.ts`: `"Apps can't take part in end-to-end encryption"`). An app therefore cannot register a device, upload or claim keys, or receive room keys.
2. **No sending.** `sendMessage` is the only inbound socket event an app socket may emit (scope `messages:write`). The server refuses it anyway. It emits `message:rejected` with `{ "reason": "e2ee", "message": "Apps can't send end-to-end encrypted messages" }` and fails the event (`webrtc-BE/src/realtime/index.ts`). There is no REST endpoint for sending messages.
3. **No ciphertext over sockets.** When an app socket receives `receiveMessage`, `message:updated` or `message:deleted` for an encrypted message, the server strips the encryption envelope. The payload carries `content: null` and `encrypted: true` (`webrtc-BE/src/realtime/io.ts`).
4. **No ciphertext over REST or webhooks.** `GET /v1/conversations/{id}/messages` with an app token returns encrypted messages as `{ ..., "content": null, "encrypted": true }`. The `message.created` webhook carries `encrypted: true` and `content: null` for encrypted messages.

**Known limitation: `messages:write` currently grants nothing.** The scope catalogue still lists it ("Send text messages over Socket.IO"), and apps can request it, receive consent for it and carry it in tokens. Every send attempt is still refused. Don't plan features around it.

There is no supported way for an app to read or send message content. Message content stays within the user's own SpreeWe clients.

---

## Scope catalogue

From `webrtc-BE/src/developer/scopes.ts`. No scope is granted by default.

| Scope | REST route | Socket events delivered to app | Socket events an app may send |
|---|---|---|---|
| `profile:read` | `GET /v1/me` | none | none |
| `directory:read` | `GET /v1/directory` | none | none |
| `conversations:read` | `GET /v1/conversations` | none | none |
| `messages:read` | `GET /v1/conversations/{id}/messages` | `receiveMessage`, `message:updated`, `message:deleted` (encrypted content removed) | none |
| `messages:write` | none | none | `sendMessage` is allow-listed but **always refused** (see above) |
| `calls:read` | `GET /v1/calls` | none | none |
| `recordings:read` | `GET /v1/recordings/{id}` | none | none |
| `realtime:connect` | none (needed to open a Socket.IO connection) | `user:presence`, `rate-limited` | none |

Webhook events and the scope each one needs: `message.created` requires `messages:read`. `conversation.members_added` and `conversation.members_removed` require `conversations:read`. `call.started` and `call.ended` require `calls:read`. `recording.available` requires `recordings:read`.

---

## Apps & credentials

Status: Implemented (server tests: `developer-platform.test.ts`, `p5-security.test.ts`, `webhooks.test.ts`, `examples.test.ts`), except `usage` and `audit`, which no test calls.

These routes are `firstParty`. Owners act on an app from the app's own context: a workspace app from inside its workspace, a global app from the personal context. Platform admins can read app metadata and suspend or reactivate apps. When you can't see an app, the response is `404`.

App object (`appDoc`):

```json
{ "_id": "6650c1a2b3c4d5e6f7a8b9c0", "name": "Acme CRM", "environment": "development",
  "status": "active", "tenantId": null, "scopes": ["profile:read", "conversations:read"],
  "allowedOrigins": ["https://crm.acme.example"], "callbackUrls": ["https://crm.acme.example/spreewe/callback"],
  "quotas": { "rateLimitPerMinute": 120, "maxConnections": 20, "messagesPerDay": 2000 } }
```

Credential object: `{ _id, keyId, hint, status: "active"|"rotated"|"revoked", graceUntil, expiresAt, lastUsedAt }`.

#### `POST /v1/apps`: register an app
Auth: firstParty · Scope: none · Workspace: no · Sensitive: yes · Errors: common · Implemented (server tests)

The app is global when created from the personal context. With `tenantBound: true`, it is bound to the active workspace, which requires the owner or admin role. Each owner can have at most 25 apps (`409`). Origins and callback URLs must use https; `http://localhost` is allowed only for development apps.

| Body field | Type | Required | Limits |
|---|---|---|---|
| `name` | string | yes | 2–80 |
| `environment` | `"development"` \| `"production"` | yes | |
| `tenantBound` | boolean | no | |
| `scopes` | scope[] | no | defaults to none |
| `allowedOrigins` | string[] | no | max 20, each max 300 |
| `callbackUrls` | string[] | no | max 20, each max 300 |
| `quotas` | `{ rateLimitPerMinute 1–6000, maxConnections 1–10000, messagesPerDay 0–1000000 }` | no | development apps are capped lower (120 / 20 / 2000) |

Response `201`: `{ "data": <app> }`

```sh
curl -X POST "$SPREEWE/v1/apps" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Acme CRM","environment":"development","scopes":["profile:read","conversations:read"],"callbackUrls":["https://crm.acme.example/spreewe/callback"]}'
```

#### `GET /v1/apps`: my apps in the active context
Auth: firstParty · Workspace: no · Sensitive: no · Errors: common · Implemented (server tests)

Response `200`: `{ "data": [ <app>, ... ] }`

```sh
curl "$SPREEWE/v1/apps" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/apps/{appId}`: app configuration
Auth: firstParty (owner or platform admin) · Workspace: no · Sensitive: no · Errors: 404 · Implemented (server tests)

Response `200`: `{ "data": <app> }`

```sh
curl "$SPREEWE/v1/apps/$APP_ID" -H "Authorization: Bearer $TOKEN"
```

#### `PATCH /v1/apps/{appId}`: update an app
Auth: firstParty (owner) · Workspace: no · Sensitive: yes · Errors: 404, 409 (app revoked) · Implemented (server tests)

Body: at least one of `name` (2–80), `scopes`, `allowedOrigins`, `callbackUrls`, `quotas`. The limits are the same as for create. Response `200`: `{ "data": <app> }`

```sh
curl -X PATCH "$SPREEWE/v1/apps/$APP_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"allowedOrigins":["https://crm.acme.example"]}'
```

#### `POST /v1/apps/{appId}/suspend`: suspend an app
Auth: firstParty (owner or platform admin) · Workspace: no · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

While an app is suspended, its credentials and tokens stop working. There is no request body. Response `201`: `{ "data": <app> }` with `"status": "suspended"`.

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/suspend" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/reactivate`: reactivate a suspended app
Auth: firstParty (owner or platform admin) · Workspace: no · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

There is no request body. Response `201`: `{ "data": <app> }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/reactivate" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/revoke`: permanently revoke an app
Auth: firstParty (owner) · Workspace: no · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

Body: `confirm` (string, max 80, the app's exact name, required). Response `201`: `{ "data": <app> }` with `"status": "revoked"`.

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/revoke" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

#### `POST /v1/apps/{appId}/tokens/revoke-all`: invalidate all issued user tokens
Auth: firstParty (owner) · Workspace: no · Sensitive: yes · Errors: 404 · Implemented (server tests)

Body: `confirm` (required). Response `201`: `{ "data": { "revoked": true } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/tokens/revoke-all" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

#### `GET /v1/apps/{appId}/usage`: daily usage counters
Auth: firstParty (owner or platform admin) · Workspace: no · Sensitive: no · Errors: 404 · Implemented, not covered by tests

Query: `days` (integer 1–90, default 30). Response `200`:

```json
{ "data": [ { "day": "2026-11-01", "apiRequests": 412, "tokensIssued": 37, "messagesSent": 0, "socketConnections": 12 } ] }
```

```sh
curl "$SPREEWE/v1/apps/$APP_ID/usage?days=7" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/apps/{appId}/audit`: audit trail of sensitive actions
Auth: firstParty (owner or platform admin) · Workspace: no · Sensitive: no · Errors: 404 · Implemented, not covered by tests

Response `200`: `{ "data": [ { "action": "credential.created", "actorKind": "owner", "actorUserId": "6650...", "at": "2026-11-01T10:00:00.000Z" } ] }`. The `action` values come from the server; this example value is illustrative.

```sh
curl "$SPREEWE/v1/apps/$APP_ID/audit" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/apps/{appId}/credentials`: list credentials
Auth: firstParty · Workspace: no · Sensitive: no · Errors: 404 · Implemented (server tests)

The response never includes secrets. Response `200`: `{ "data": [ <credential>, ... ] }`

```sh
curl "$SPREEWE/v1/apps/$APP_ID/credentials" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/credentials`: create a server credential
Auth: firstParty (owner) · Workspace: no · Sensitive: yes · Errors: 404, 409 (app not active, or the limit of 5 active credentials is reached) · Implemented (server tests)

Body: `confirm` (required) and `expiresInDays` (integer 1–365, default 180). The **secret appears only in this response.**

```json
{ "data": { "credential": { "_id": "6650...", "keyId": "swk_test_...", "hint": "...x9Q", "status": "active", "graceUntil": null, "expiresAt": "2027-05-01T00:00:00.000Z", "lastUsedAt": null }, "secret": "..." } }
```

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/credentials" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM","expiresInDays":90}'
```

#### `POST /v1/apps/{appId}/credentials/{credentialId}/rotate`: rotate a credential
Auth: firstParty (owner) · Workspace: no · Sensitive: yes · Errors: 404 · Implemented (server tests)

Rotation issues a new secret immediately. The old secret keeps working for the grace period, which is 1 hour by default. Body: `confirm` (required) and `expiresInDays` (1–365, default 180). Response `201`: `{ "data": { "credential": {...}, "secret": "...", "previous": { "keyId": "...", "validUntil": "..." } } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/credentials/$CRED_ID/rotate" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

#### `POST /v1/apps/{appId}/credentials/{credentialId}/revoke`: revoke a credential immediately
Auth: firstParty (owner) · Workspace: no · Sensitive: yes · Errors: 404 · Implemented (server tests)

Body: `confirm` (required). Response `201`: `{ "data": { "revoked": true } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/credentials/$CRED_ID/revoke" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

#### `GET /v1/admin/apps`: all apps' metadata (platform admins)
Auth: firstParty (platform admin only) · Workspace: no · Sensitive: no · Errors: 404 (any non-admin caller) · Implemented (server tests)

The response contains app metadata only, with no tenant content. Response `200`: `{ "data": [ <app>, ... ] }`

```sh
curl "$SPREEWE/v1/admin/apps" -H "Authorization: Bearer $TOKEN"
```

---

## Consent & grants

Status: Implemented (server tests: `developer-platform.test.ts`, `p5-security.test.ts`). `GET /consent-requests/{id}` and `/deny` are called only in `p5-security.test.ts`.

There are two ways a user can authorize an app: directly (`POST /apps/{appId}/grants`), or through an app-initiated consent request. A consent request ID is a 20–40 character string matching `[A-Za-z0-9_-]`.

#### `POST /v1/apps/{appId}/grants`: authorize an app for myself
Auth: firstParty · Workspace: no (but see below) · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

Authorize a workspace app from inside its workspace, and a global app from the personal context. Body: `scopes` (scope[], required, max 8). The scopes must be a subset of the app's scopes, with at least one. Linking an `externalUserRef` is possible only through a consent request.

```json
{ "data": { "_id": "6650...", "appId": "6650...", "appName": "Acme CRM", "scopes": ["profile:read"], "externalUserRef": null } }
```

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/grants" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"scopes":["profile:read"]}'
```

#### `GET /v1/me/app-grants`: apps I have authorized
Auth: firstParty · Workspace: no · Sensitive: no · Errors: common · Implemented (server tests)

Response `200`: `{ "data": [ { "_id": "...", "appId": "...", "appName": "Acme CRM", "scopes": ["profile:read"] } ] }`

```sh
curl "$SPREEWE/v1/me/app-grants" -H "Authorization: Bearer $TOKEN"
```

#### `DELETE /v1/me/app-grants/{grantId}`: withdraw an app's access
Auth: firstParty · Workspace: no · Sensitive: no · Errors: 404 · Implemented (server tests)

The app's tokens for you stop working immediately. Response `200`: `{ "data": { "revoked": true } }`

```sh
curl -X DELETE "$SPREEWE/v1/me/app-grants/$GRANT_ID" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/consent-requests`: app server starts a consent flow
Auth: appCredential (Basic) · Workspace: n/a · Sensitive: no (per-credential limit) · Errors: common · Implemented (server tests)

| Body field | Type | Required | Limits |
|---|---|---|---|
| `redirectUri` | string | yes | 8–300; must exactly match a registered callback URL |
| `scopes` | scope[] | yes | at least one, max 8 |
| `state` | string | yes | 8–200 printable ASCII; echoed back on the redirect. Check it against CSRF. |
| `externalUserRef` | string | no | 1–200, `[\w.:@\|-]`; bound to the approving user |

The request expires after 10 minutes and can be used once. Response `201`:

```json
{ "data": { "requestId": "Qm9vX2Jhcl9iYXpfcXV4XzEy", "consentUrl": "https://spreewe.example/consent?request=Qm9v...", "expiresAt": "2026-11-02T10:10:00.000Z" } }
```

```sh
curl -X POST "$SPREEWE/v1/consent-requests" -u "$KEY_ID:$SECRET" -H "Content-Type: application/json" \
  -d '{"redirectUri":"https://crm.acme.example/spreewe/callback","scopes":["profile:read"],"state":"r4nd0m-st4te","externalUserRef":"acme-user-42"}'
```

#### `GET /v1/consent-requests/{requestId}`: view what an app is asking for
Auth: firstParty · Workspace: no · Sensitive: no · Errors: 404 (invalid or expired) · Implemented (server tests)

Response `200`:

```json
{ "data": { "requestId": "Qm9v...", "app": { }, "scopes": [ { "scope": "profile:read", "description": "Read the user's own profile (GET /v1/me)", "sensitive": false } ],
  "redirectHost": "crm.acme.example", "contextMatches": true, "existingScopes": [] } }
```

The route schema does not specify the fields of `app`.

```sh
curl "$SPREEWE/v1/consent-requests/$REQUEST_ID" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/consent-requests/{requestId}/approve`: approve selected scopes
Auth: firstParty · Workspace: the app's context (a workspace app requires that workspace to be active; a global app requires the personal context; otherwise `403`) · Sensitive: yes · Errors: 404, 409 (`externalUserRef` already linked to another account) · Implemented (server tests)

Body: `scopes` (scope[], required, a non-empty subset of the request). Response `201`: `{ "data": { "redirectUrl": "https://crm.acme.example/spreewe/callback?...state=...", "scopes": ["profile:read"] } }`

```sh
curl -X POST "$SPREEWE/v1/consent-requests/$REQUEST_ID/approve" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"scopes":["profile:read"]}'
```

#### `POST /v1/consent-requests/{requestId}/deny`: deny a request
Auth: firstParty · Workspace: no · Sensitive: yes · Errors: 404 · Implemented (server tests)

There is no request body. Response `201`: `{ "data": { "redirectUrl": "...", "scopes": [] } }`. The exact query parameters on `redirectUrl` are set by `decideConsentRequest`; this page does not document them.

```sh
curl -X POST "$SPREEWE/v1/consent-requests/$REQUEST_ID/deny" -H "Authorization: Bearer $TOKEN"
```

---

## App tokens

Status: Implemented (server tests: `developer-platform.test.ts`, `p5-security.test.ts`, `webhooks.test.ts`).

Call these endpoints from your server only, never from a browser or mobile app.

#### `POST /v1/app-tokens`: exchange the credential for a short-lived user token
Auth: appCredential · Workspace: n/a (the tenant is the app's binding) · Sensitive: no · Errors: common · Implemented (server tests)

| Body field | Type | Required | Limits |
|---|---|---|---|
| `userId` | id | exactly one of `userId` / `externalUserRef` | |
| `externalUserRef` | string | ″ | 1–200 |
| `scopes` | scope[] | no | must be within the grant and the app's scopes (otherwise `403`) |
| `ttlSeconds` | integer | no | schema allows 60–3600. The server caps it at `APP_TOKEN_MAX_TTL_SECONDS` (default **900**, so larger values return `400`). The default is 600. |

If the user has not authorized the app, the response is `403 "This user has not authorised the app"`. Response `201`:

```json
{ "data": { "accessToken": "eyJ...", "tokenType": "Bearer", "expiresIn": 600, "expiresAt": "2026-11-02T10:20:00.000Z",
  "scopes": ["profile:read"], "tokenId": "...", "tenantId": null } }
```

```sh
curl -X POST "$SPREEWE/v1/app-tokens" -u "$KEY_ID:$SECRET" -H "Content-Type: application/json" -d '{"externalUserRef":"acme-user-42","scopes":["profile:read"]}'
```

#### `POST /v1/app-tokens/revoke`: revoke one user token
Auth: appCredential · Sensitive: no · Errors: common · Implemented (server tests)

Body: `token` (string 20–4096, required, not trimmed). The token must belong to this app; otherwise the response is `400 "Invalid token"`. Response `201`: `{ "data": { "revoked": true } }`

```sh
curl -X POST "$SPREEWE/v1/app-tokens/revoke" -u "$KEY_ID:$SECRET" -H "Content-Type: application/json" -d "{\"token\":\"$APP_TOKEN\"}"
```

---

## Webhooks

Status: Implemented (server tests: `webhooks.test.ts`) for list, create, verify, enable, rotate-secret, deliveries and retry. `GET /webhook-events`, `PATCH`, `disable` and `delete` are Implemented, not covered by tests.

These routes are `firstParty`, and only the app owner can use them, from the app's context. An endpoint can subscribe only to events whose scope the app holds.

Endpoint object: `{ _id, url, description, events[], status: "pending_verification"|"active"|"disabled", consecutiveFailures, disabledReason, verifiedAt, secrets: [{ id, hint, expiresAt }] }`.
Delivery object: `{ _id, eventId, eventType, status: "pending"|"delivering"|"retrying"|"succeeded"|"dead"|"cancelled", attempts, lastStatusCode, lastError, nextAttemptAt, deliveredAt }`. `_id` is the `SpreeWe-Webhook-Id`; de-duplicate on it.

#### `GET /v1/webhook-events`: event catalog
Auth: firstParty · Sensitive: no · Errors: common · Implemented, not covered by tests

Response `200`: `{ "data": [ { "type": "message.created", "scope": "messages:read", "description": "..." }, ... ] }`

```sh
curl "$SPREEWE/v1/webhook-events" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/apps/{appId}/webhooks`: list endpoints
Auth: firstParty (owner) · Sensitive: no · Errors: 404 · Implemented (server tests)

Response `200`: `{ "data": [ <endpoint>, ... ] }`

```sh
curl "$SPREEWE/v1/apps/$APP_ID/webhooks" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/webhooks`: add an endpoint
Auth: firstParty (owner) · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

The URL is checked for SSRF. Production apps must use https on port 443 or 8443. Development apps may also use ports 80 and 8080. The URL must resolve to a public address.

| Body field | Type | Required | Limits |
|---|---|---|---|
| `url` | string | yes | 10–500 |
| `events` | event type[] | yes | max 6; each event must be covered by the app's scopes |
| `description` | string | no | max 200 |
| `confirm` | string | yes | the app's exact name |

The signing secret appears only in this response. Call `/verify` next. Response `201`:

```json
{ "data": { "endpoint": { "_id": "6650...", "url": "https://hooks.acme.example/spreewe", "events": ["message.created"], "status": "pending_verification", "consecutiveFailures": 0, "disabledReason": null, "verifiedAt": null, "secrets": [ { "id": "...", "hint": "...", "expiresAt": null } ] }, "secret": "swh_..." } }
```

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"url":"https://hooks.acme.example/spreewe","events":["message.created"],"confirm":"Acme CRM"}'
```

#### `PATCH /v1/apps/{appId}/webhooks/{endpointId}`: change URL, events or description
Auth: firstParty (owner) · Sensitive: yes · Errors: 404 · Implemented, not covered by tests

Body: at least one of `url` (10–500), `events` (max 6) or `description` (max 200). A new URL must be verified again. Response `200`: `{ "data": <endpoint> }`

```sh
curl -X PATCH "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"events":["message.created","call.ended"]}'
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/verify`: send a verification challenge
Auth: firstParty (owner) · Sensitive: yes · Errors: 404 · Implemented (server tests)

The server sends a signed challenge to the endpoint. The endpoint must answer with a 2xx status and `{"challenge":"..."}`. On success, the endpoint becomes active. Response `201`: `{ "data": { "verified": true, "error": null } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/verify" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/disable`: stop deliveries
Auth: firstParty (owner) · Sensitive: no · Errors: 404 · Implemented, not covered by tests

Response `201`: `{ "data": <endpoint> }` with `"status": "disabled"`.

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/disable" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/enable`: re-enable
Auth: firstParty (owner) · Sensitive: no · Errors: 404 · Implemented (server tests)

The endpoint returns to `pending_verification`; call `/verify` again. Response `201`: `{ "data": <endpoint> }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/enable" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/rotate-secret`: new signing secret
Auth: firstParty (owner) · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

Body: `confirm` (required) and `keepOldSeconds` (integer 0–604800). With the default of 86400, old secrets keep signing for one day. `0` revokes them now. The new secret appears only in this response. Response `201`: `{ "data": { "secret": "swh_...", "keptSecrets": 1 } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/rotate-secret" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM","keepOldSeconds":3600}'
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/delete`: delete an endpoint
Auth: firstParty (owner) · Sensitive: yes · Errors: 404 · Implemented, not covered by tests

Body: `confirm` (required). Pending deliveries are cancelled. Response `201`: `{ "data": { "deleted": true } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/delete" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

#### `GET /v1/apps/{appId}/webhooks/{endpointId}/deliveries`: delivery history (paginated)
Auth: firstParty (owner) · Sensitive: no · Errors: 404 · Implemented (server tests)

Query: `status` (one of the delivery statuses), `limit` (1–100, default 20) and `cursor` (id). Payloads are never returned. Response `200`:

```json
{ "data": [ { "_id": "6650...", "eventId": "...", "eventType": "message.created", "status": "dead", "attempts": 8, "lastStatusCode": 500, "lastError": "http_500", "nextAttemptAt": null, "deliveredAt": null } ], "page": { "nextCursor": null } }
```

```sh
curl "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/deliveries?status=dead&limit=50" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/deliveries/{deliveryId}/retry`: re-queue a dead delivery
Auth: firstParty (owner) · Sensitive: no · Errors: 404 · Implemented (server tests)

A dead delivery can be retried only while its payload is still kept, which is up to 7 days. Response `201`: `{ "data": <delivery> }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/deliveries/$DELIVERY_ID/retry" -H "Authorization: Bearer $TOKEN"
```

---

## E2EE devices & keys

Status: Implemented (server tests: `e2ee.test.ts`, `e2ee-real-crypto.test.ts`).

All of these routes are **`firstParty`**; app tokens get `403` (see [the E2EE section](#developer-app-tokens-and-end-to-end-encryption)). The caller's device is identified by the **`X-SpreeWe-Device`** header, matching `^[A-Za-z0-9_-]{4,64}$`. The routes that need a device return `400` when the header is missing.

Request bodies for keys and device messages follow the Olm/Megolm client library's request formats. The server validates only that each body is a JSON object within a size limit, and the E2EE service validates the content. The server only ever handles public keys and ciphertext. See [`docs/security/end-to-end-encryption.md`](../../security/end-to-end-encryption.md). These endpoints exist for SpreeWe's own clients. Third-party integrations cannot use them.

#### `POST /v1/e2ee/devices`: register or touch this device
Auth: firstParty · Sensitive: yes · Errors: 400 (missing or invalid device header), 403 (the device was revoked) · Implemented (server tests)

Body: `displayName` (string, max 100, optional). Response `201`: `{ "data": { "deviceId": "WEB7F3A2", "userId": "..." } }`

```sh
curl -X POST "$SPREEWE/v1/e2ee/devices" -H "Authorization: Bearer $TOKEN" -H "X-SpreeWe-Device: WEB7F3A2" -H "Content-Type: application/json" -d '{"displayName":"Chrome on laptop"}'
```

#### `GET /v1/e2ee/devices`: my devices
Auth: firstParty · Sensitive: no · Errors: common · Implemented (server tests)

Response `200`: `{ "data": [ { "deviceId": "WEB7F3A2", "displayName": "Chrome on laptop", "ed25519": "base64...", "revoked": false } ] }`

```sh
curl "$SPREEWE/v1/e2ee/devices" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/e2ee/devices/{deviceId}/revoke`: remove one of my devices
Auth: firstParty · Sensitive: yes · Errors: 404 · Implemented (server tests)

`deviceId` is at most 64 characters. A revoked device stops receiving keys and device messages, and your contacts are notified. Response `201`: `{ "data": { "revoked": true } }`

```sh
curl -X POST "$SPREEWE/v1/e2ee/devices/WEB7F3A2/revoke" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/e2ee/keys/upload`: publish device and one-time keys
Auth: firstParty · Sensitive: no · Errors: 400, 403 (keys not for your account or this device), 404 · Implemented (server tests)

Body: a JSON object of at most 128 KiB (Olm key upload format). Response `201`: `{ "data": { ... } }` (an object, such as one-time key counts; the route schema does not specify its fields).

```sh
curl -X POST "$SPREEWE/v1/e2ee/keys/upload" -H "Authorization: Bearer $TOKEN" -H "X-SpreeWe-Device: WEB7F3A2" -H "Content-Type: application/json" -d @keys-upload.json
```

#### `POST /v1/e2ee/keys/query`: device keys of people I share a conversation with
Auth: firstParty · Sensitive: no · Errors: common · Implemented (server tests)

Body: a JSON object of at most 64 KiB. Users you share no conversation with are listed as failures. Response `201`: `{ "data": { ... } }`

```sh
curl -X POST "$SPREEWE/v1/e2ee/keys/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @keys-query.json
```

#### `POST /v1/e2ee/keys/claim`: claim one-time prekeys
Auth: firstParty · Sensitive: yes · Errors: common · Implemented (server tests)

Body: a JSON object of at most 64 KiB. Each claimed key is consumed. Response `201`: `{ "data": { ... } }`

```sh
curl -X POST "$SPREEWE/v1/e2ee/keys/claim" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @keys-claim.json
```

#### `POST /v1/e2ee/sendToDevice/{eventType}/{txnId}`: send device messages
Auth: firstParty · Sensitive: no · Errors: 400 (event type not allowed), 403 · Implemented (server tests)

`eventType` and `txnId` are each at most 128 characters. Body: a JSON object of at most 2 MiB (Olm ciphertext or verification messages). You can send only to people you share a conversation with. Response `201`: `{ "data": { ... } }`

```sh
curl -X POST "$SPREEWE/v1/e2ee/sendToDevice/m.room.encrypted/txn-0001" -H "Authorization: Bearer $TOKEN" -H "X-SpreeWe-Device: WEB7F3A2" -H "Content-Type: application/json" -d @to-device.json
```

#### `GET /v1/e2ee/sync`: pending device messages and key state
Auth: firstParty · Sensitive: no · Errors: common · Implemented (server tests)

Query: `ack` (string, max 64; acknowledges the previous batch with the `next` value it returned), `since` (integer ≥ 0) and `limit` (1–500). The response contains pending device messages, key counts and contacts' device-list changes. Response `200`: `{ "data": { "events": [ ... ], "next": "...", ... } }`

```sh
curl "$SPREEWE/v1/e2ee/sync?ack=$NEXT" -H "Authorization: Bearer $TOKEN" -H "X-SpreeWe-Device: WEB7F3A2"
```

#### `GET /v1/e2ee/rooms/{conversationId}/members`: encryption identities of a conversation's members
Auth: firstParty · Sensitive: no · Errors: common · Implemented (server tests)

Response `200`: `{ "data": { "roomId": "...", "members": ["...", "..."] } }`

```sh
curl "$SPREEWE/v1/e2ee/rooms/$CONV_ID/members" -H "Authorization: Bearer $TOKEN"
```

---

## Organizations

Status: Implemented (server tests: `organizations.test.ts` and others), except `POST /me/join-requests/{id}/cancel`, which no test calls.

All of these routes are `firstParty` and work in any context. Organization card: `{ organizationId, clerkOrgId, name, slug, description, avatar, discoverable, joinPolicy: "invite"|"request"|"open" }`.

#### `POST /v1/organizations`: create an organization
Auth: firstParty · Workspace: no · Sensitive: yes · Errors: 409 (slug taken), 429 · Implemented (server tests)

| Body field | Type | Required | Limits |
|---|---|---|---|
| `name` | string | yes | 2–80 |
| `slug` | string | yes | 3–40, `^[a-z0-9-]+$` |
| `description` | string | no | max 500 |
| `discoverable` | boolean | no | |
| `joinPolicy` | `invite`\|`request`\|`open` | no | |
| `allowExternalChat` | boolean | no | |

You become the owner. To switch to the new organization, use the returned `clerkOrgId` in Clerk. Response `201`: `{ "data": { "organizationId": "...", "clerkOrgId": "org_...", "name": "Acme", "slug": "acme" } }`

```sh
curl -X POST "$SPREEWE/v1/organizations" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"Acme","slug":"acme"}'
```

#### `GET /v1/organizations/mine`: organizations I belong to
Auth: firstParty · Sensitive: no · Errors: common · Implemented (server tests)

Response `200`: `{ "data": [ { ...card, "role": "owner", "managedBy": "...", "status": "active", "active": true } ] }`

```sh
curl "$SPREEWE/v1/organizations/mine" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/organizations/discover`: search discoverable organizations
Auth: firstParty · Sensitive: yes · Errors: common · Implemented (server tests)

Query: `q` (max 80) and `limit` (1–50, default 20). Private organizations are never listed. Response `200`: `{ "data": [ { ...card, "myStatus": "none" } ] }`, where `myStatus` is `member`, `requested` or `none`.

```sh
curl "$SPREEWE/v1/organizations/discover?q=acme" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/organizations/{organizationId}/join`: join by code, or directly if open
Auth: firstParty · Sensitive: yes · Errors: 404 · Implemented (server tests)

Body: `code` (string 6–20, optional). Response `201`: `{ "data": { ...card, "role": "member", "outcome": "added" } }`, where `outcome` is `added` or `already`.

```sh
curl -X POST "$SPREEWE/v1/organizations/$ORG_ID/join" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"code":"K7PQ2XZD"}'
```

#### `POST /v1/organizations/{organizationId}/join-requests`: ask to join
Auth: firstParty · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

Use this for discoverable organizations whose join policy is `request`. Body: `message` (max 500, optional). Response `201`: `{ "data": { "requestId": "...", "status": "pending" } }`

```sh
curl -X POST "$SPREEWE/v1/organizations/$ORG_ID/join-requests" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"message":"Joining the design team"}'
```

#### `GET /v1/me/join-requests`: my join requests
Auth: firstParty · Sensitive: no · Errors: common · Implemented (server tests)

Response `200`: `{ "data": [ { "requestId": "...", "status": "pending", "organization": { ...card } } ] }`

```sh
curl "$SPREEWE/v1/me/join-requests" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/me/join-requests/{requestId}/cancel`: withdraw a pending request
Auth: firstParty · Sensitive: no · Errors: 404 · Implemented, not covered by tests

Response `201`: `{ "data": { "cancelled": true } }`

```sh
curl -X POST "$SPREEWE/v1/me/join-requests/$JR_ID/cancel" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/me/organization-invitations`: invitations to my verified emails
Auth: firstParty · Sensitive: no · Errors: common · Implemented (server tests)

Response `200`: `{ "data": [ { ...card, "invitationId": "...", "role": "member", "expiresAt": "..." } ] }`

```sh
curl "$SPREEWE/v1/me/organization-invitations" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/organization-invitations/preview`: preview an invitation
Auth: firstParty · Sensitive: yes · Errors: 404 · Implemented (server tests)

Body: at least one of `token` (link token, max 200) or `invitationId` (id). The invitation must be addressed to one of your verified emails. Response `201`: `{ "data": { ...card, "invitationId": "...", "role": "member", "expiresAt": "..." } }`

```sh
curl -X POST "$SPREEWE/v1/organization-invitations/preview" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"token":"inv_..."}'
```

#### `POST /v1/organization-invitations/accept`: accept an invitation (single use)
Auth: firstParty · Sensitive: yes · Errors: 404, 503 · Implemented (server tests)

The body is the same as for preview. Response `201`: `{ "data": { ...card, "role": "member", "outcome": "added" } }`

```sh
curl -X POST "$SPREEWE/v1/organization-invitations/accept" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"invitationId":"6650..."}'
```

---

## Workspace admin

Status: Implemented (server tests: `organizations.test.ts`, `teams-channels.test.ts`, `p5-security.test.ts`).

These routes act on the **active** organization and need **Workspace: yes**. The organization routes (`/workspace/organization*`, `/workspace/invitations*`, `/workspace/join-requests*`, `/workspace/join-code`, `/workspace/audit`, `/workspace/leave`) are `firstParty`. The three routes in `workspace.routes.ts` (`/workspace/members`, `/workspace/apps`, `/workspace/apps/{id}/revoke-grants`) use the `user` mode without a scope, which also means app tokens get `403`.

#### `GET /v1/workspace/organization`: active organization overview
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: 404 · Implemented (server tests)

The response contains details, your role and permissions, and settings for owners and admins. The route schema declares it only as `object`; see `organization.service overview()` for the exact fields.

```sh
curl "$SPREEWE/v1/workspace/organization" -H "Authorization: Bearer $TOKEN"
```

#### `PATCH /v1/workspace/organization`: update details and settings (owners / admins)
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

Body: at least one of `name` (2–80), `description` (max 500), `slug` (3–40, `^[a-z0-9-]+$`), and `settings` { `discoverable`, `joinPolicy`, `allowedEmailDomains` (max 20, each max 190), `membersCanInvite`, `membersCanCreateTeams`, `guestAccess` }. Response `200`: `{ "data": { ... } }` (object, not specified in the schema).

```sh
curl -X PATCH "$SPREEWE/v1/workspace/organization" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"settings":{"joinPolicy":"request","discoverable":true}}'
```

#### `POST /v1/workspace/organization/delete`: delete the organization (owners)
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (server tests)

Body: `confirm` (the organization's exact name, max 80). Access ends immediately, and the data is kept. Response `201`: `{ "data": { "deleted": true } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/organization/delete" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme"}'
```

#### `POST /v1/workspace/organization/transfer`: transfer ownership (owners)
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: common · Implemented (server tests)

Body: `userId` (id, required). You become an admin. Response `201`: `{ "data": { "owner": "6650..." } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/organization/transfer" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"userId":"6650c1a2b3c4d5e6f7a8b9c0"}'
```

#### `POST /v1/workspace/leave`: leave the active organization
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: 409 (the last owner must transfer ownership first) · Implemented (server tests)

Response `201`: `{ "data": { "left": true } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/leave" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/workspace/organization/members`: members (paginated)
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: common · Implemented (server tests)

Query: `limit` (1–100, default 50), `cursor` (id) and `includeRemoved` (boolean; owners and admins only). Response `200`:

```json
{ "data": [ { "userId": "...", "username": "dana", "avatar": "", "role": "member", "status": "active", "joinedAt": "2026-10-01T09:00:00.000Z", "source": null } ], "page": { "nextCursor": null } }
```

```sh
curl "$SPREEWE/v1/workspace/organization/members?limit=50" -H "Authorization: Bearer $TOKEN"
```

#### `PATCH /v1/workspace/organization/members/{userId}`: change a member's role
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

Owners can set any role. Admins can change members to guests and back. You cannot change your own role. Body: `role` (`owner`\|`admin`\|`member`\|`guest`). Response `200`: `{ "data": { "userId": "...", "role": "admin" } }`

```sh
curl -X PATCH "$SPREEWE/v1/workspace/organization/members/$USER_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"role":"admin"}'
```

#### `POST /v1/workspace/organization/members/{userId}/remove`: remove a member
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

Access ends on every server instance within `MEMBERSHIP_CHECK_CACHE_MS`. Response `201`: `{ "data": { "removed": true } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/organization/members/$USER_ID/remove" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/invitations`: invite by email
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 409 · Implemented (server tests)

Body: `emails` (string[], max 50, each max 254), `role` (`admin`\|`member`\|`guest`) and `expiresInDays` (1–30, optional). No email provider is configured, so the response returns each single-use link once and `emailed` is `false`. Response `201`:

```json
{ "data": { "results": [ { "email": "dana@acme.example", "status": "invited", "invitationId": "...", "link": "https://.../invite?token=...", "emailed": false } ] } }
```

```sh
curl -X POST "$SPREEWE/v1/workspace/invitations" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"emails":["dana@acme.example"],"role":"member"}'
```

#### `GET /v1/workspace/invitations`: list invitations (paginated)
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: common · Implemented (server tests)

Query: `status` (`pending`\|`accepted`\|`revoked`\|`expired`), `limit` (default 50) and `cursor`. Response `200`: `{ "data": [ { "invitationId": "...", "email": "...", "role": "member", "status": "pending", "expiresAt": "...", "sentCount": 1 } ], "page": { "nextCursor": null } }`

```sh
curl "$SPREEWE/v1/workspace/invitations?status=pending" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/invitations/{invitationId}/resend`: new link for a pending invitation
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (server tests)

The previous link stops working. Response `201`: `{ "data": { "invitationId": "...", "link": "...", "emailed": false, "expiresAt": "..." } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/invitations/$INV_ID/resend" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/invitations/{invitationId}/revoke`: revoke a pending invitation
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: 404 · Implemented (server tests)

Response `201`: `{ "data": { "revoked": true } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/invitations/$INV_ID/revoke" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/workspace/join-requests`: join requests (owners / admins)
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: common · Implemented (server tests)

Query: `status` (`pending` (default), `approved`, `rejected` or `cancelled`). This route is not paginated. Response `200`: `{ "data": [ { "requestId": "...", "userId": "...", "username": "dana", "email": "dana@...", "message": "...", "status": "pending" } ] }`

```sh
curl "$SPREEWE/v1/workspace/join-requests" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/join-requests/{requestId}/approve`: approve
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404, 503 · Implemented (server tests)

Response `201`: `{ "data": { "requestId": "...", "status": "approved" } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/join-requests/$JR_ID/approve" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/join-requests/{requestId}/reject`: reject
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404, 503 · Implemented (server tests)

Response `201`: `{ "data": { "requestId": "...", "status": "rejected" } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/join-requests/$JR_ID/reject" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/join-code`: create or disable the join code
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: common · Implemented (server tests)

Body: `enable` (boolean, required). A new code replaces the old one and is shown only once. Response `201`: `{ "data": { "enabled": true, "code": "K7PQ2XZD", "link": "..." } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/join-code" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"enable":true}'
```

#### `GET /v1/workspace/audit`: organization audit log (owners / admins, paginated)
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: common · Implemented (server tests)

Query: `limit` (1–100, default 50) and `cursor`. Response `200`: `{ "data": [ { "id": "...", "action": "member.removed", "actorId": "...", "target": { }, "at": "..." } ], "page": { "nextCursor": null } }`. The `action` value in this example is illustrative.

```sh
curl "$SPREEWE/v1/workspace/audit" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/workspace/members`: workspace members (paginated)
Auth: user (no scope, so Clerk session only) · Workspace: yes · Sensitive: no · Errors: common (`403` for guests) · Implemented (server tests)

Query: `limit` (default 50) and `cursor`. Removed members are listed only to owners and admins. Response `200`: `{ "data": [ { "userId": "...", "username": "dana", "avatar": "", "role": "member", "status": "active", "lastSeenAt": "..." } ], "page": { "nextCursor": null } }`

```sh
curl "$SPREEWE/v1/workspace/members" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/workspace/apps`: apps bound to this workspace (owners / admins)
Auth: user (no scope, so Clerk session only) · Workspace: yes · Sensitive: no · Errors: common · Implemented (server tests)

The response lists at most 200 apps. Response `200`: `{ "data": [ { "_id": "...", "name": "Acme CRM", "environment": "production", "status": "active", "scopes": ["profile:read"], "grants": 14 } ] }`

```sh
curl "$SPREEWE/v1/workspace/apps" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/apps/{appId}/revoke-grants`: withdraw every member's authorization
Auth: user (no scope, so Clerk session only; owners and admins) · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (server tests)

Body: `confirm` (the app's exact name). Affected members' tokens stop working. Response `201`: `{ "data": { "revoked": 14 } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/apps/$APP_ID/revoke-grants" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

---

## Teams & channels

Status: Implemented (server tests: `teams-channels.test.ts` and others), except the channel member removal and channel delete routes, which no test calls.

These routes are `firstParty` and need **Workspace: yes**. A channel id is a conversation id. Channel messages, files and calls use the conversation endpoints and sockets.

Team: `{ teamId, name, description, avatar, visibility: "public"|"private" }`. Channel: `{ channelId, name, description, type: "standard"|"private"|"shared", external, memberCount, isMember, isFavorite }`.

#### `GET /v1/teams`: teams I can see
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: common · Implemented (server tests)

The response includes public teams and teams you belong to. Guests see only their own teams. Response `200`: `{ "data": [ { ...team, "memberCount": 12, "myRole": "member" } ] }`

```sh
curl "$SPREEWE/v1/teams" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/teams`: create a team
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 409 · Implemented (server tests)

Owners and admins can create teams. Members can too if the organization allows it. You become the team owner, and a General channel is created. Body: `name` (2–80, required), `description` (max 500) and `visibility` (`public`\|`private`). Response `201`: `{ "data": { "teamId": "...", "name": "Design", "visibility": "public" } }`

```sh
curl -X POST "$SPREEWE/v1/teams" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"Design","visibility":"public"}'
```

#### `GET /v1/teams/{teamId}`: a team
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: 404 (also for private teams you are not in) · Implemented (server tests)

Response `200`: `{ "data": { ...team, "myRole": "owner", "canManage": true } }`

```sh
curl "$SPREEWE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $TOKEN"
```

#### `PATCH /v1/teams/{teamId}`: update a team
Auth: firstParty (team owners; organization owners and admins) · Workspace: yes · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

Body: at least one of `name` (2–80), `description` (max 500), `visibility`, and `settings` { `membersCanCreateChannels`, `membersCanAddMembers` }. Response `200`: `{ "data": { ... } }` (object, not specified in the schema).

```sh
curl -X PATCH "$SPREEWE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"settings":{"membersCanCreateChannels":false}}'
```

#### `POST /v1/teams/{teamId}/archive`: delete (archive) a team and its channels
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (server tests)

History is kept, but nobody can read it. Response `201`: `{ "data": { "archived": true } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/archive" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/teams/{teamId}/join`: join a public team
Auth: firstParty (organization members, not guests) · Workspace: yes · Sensitive: no · Errors: 404 · Implemented (server tests)

Response `201`: `{ "data": { "joined": true } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/join" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/teams/{teamId}/members`: team members
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: 404 · Implemented (server tests)

Response `200`: `{ "data": [ { "userId": "...", "username": "dana", "avatar": "", "role": "manager" } ] }`, where `role` is `owner`, `manager` or `member`.

```sh
curl "$SPREEWE/v1/teams/$TEAM_ID/members" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/teams/{teamId}/members`: add organization members
Auth: firstParty (team owners / managers) · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (server tests)

Body: `userIds` (id[], max 200, required) and `role` (`owner`\|`manager`\|`member`, default `member`). Response `201`: `{ "data": { "added": 3 } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/members" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"userIds":["6650c1a2b3c4d5e6f7a8b9c0"]}'
```

#### `PATCH /v1/teams/{teamId}/members/{userId}`: change a team role
Auth: firstParty (team owners) · Workspace: yes · Sensitive: yes · Errors: 404, 409 · Implemented (server tests)

Body: `role` (required). Response `200`: `{ "data": { "userId": "...", "role": "manager" } }`

```sh
curl -X PATCH "$SPREEWE/v1/teams/$TEAM_ID/members/$USER_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"role":"manager"}'
```

#### `POST /v1/teams/{teamId}/members/{userId}/remove`: remove a member or leave
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404, 409 (the last owner can't leave) · Implemented (server tests)

To leave the team, pass your own id. Response `201`: `{ "data": { "removed": true } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/members/$USER_ID/remove" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/teams/{teamId}/channels`: channels of a team
Auth: firstParty · Workspace: yes · Sensitive: no · Errors: 404 · Implemented (server tests)

Private channels are listed only to their members. Response `200`: `{ "data": [ { "channelId": "...", "name": "General", "description": "", "type": "standard", "external": false, "memberCount": 12, "isMember": true, "isFavorite": false } ] }`

```sh
curl "$SPREEWE/v1/teams/$TEAM_ID/channels" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/teams/{teamId}/channels`: create a channel
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (server tests)

| Body field | Type | Required | Limits |
|---|---|---|---|
| `name` | string | yes | 1–60 |
| `description` | string | no | max 500 |
| `type` | `standard`\|`private`\|`shared` | yes | `shared` requires the organization's policy to allow it |
| `memberIds` | id[] | no | max 200 |
| `externalUserIds` | id[] | no | max 50 (shared channels only) |

Response `201`: `{ "data": <channel> }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/channels" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"launch","type":"private","memberIds":["6650c1a2b3c4d5e6f7a8b9c0"]}'
```

#### `POST /v1/teams/{teamId}/channels/{channelId}/members`: add members to a private or shared channel
Auth: firstParty (channel or team owners) · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (server tests)

Body: `userIds` (id[], max 200). Response `201`: `{ "data": { "added": 2 } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/channels/$CHANNEL_ID/members" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"userIds":["6650c1a2b3c4d5e6f7a8b9c0"]}'
```

#### `POST /v1/teams/{teamId}/channels/{channelId}/members/{userId}/remove`: remove from a channel, or leave it
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented, not covered by tests

Response `201`: `{ "data": { "removed": true } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/channels/$CHANNEL_ID/members/$USER_ID/remove" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/teams/{teamId}/channels/{channelId}/delete`: delete (archive) a channel
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented, not covered by tests

Response `201`: `{ "data": { "deleted": true } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/channels/$CHANNEL_ID/delete" -H "Authorization: Bearer $TOKEN"
```

---

## Contacts

Status: Implemented (server tests: `contacts.test.ts`).

These routes look people up by exact email; there is no directory browsing. They use `POST` so the address never appears in URLs or logs. Both work in the personal and organization contexts.

Body for both routes: `email` (string, max 254, required) and `scope` (`member`\|`external`, optional). `scope` applies only in an organization context and defaults to `member`.

#### `POST /v1/contacts/lookup`: find an eligible person by exact email
Auth: firstParty · Workspace: no · Sensitive: yes · Errors: 400, 403, 429 · Implemented (server tests)

Unregistered, blocked and unavailable people all return `found: false`. Response `201`:

```json
{ "data": { "found": true, "user": { "_id": "...", "username": "dana", "avatar": "" }, "external": false, "conversationId": null } }
```

```sh
curl -X POST "$SPREEWE/v1/contacts/lookup" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"email":"dana@acme.example"}'
```

#### `POST /v1/contacts/start`: open (or reuse) a direct conversation
Auth: firstParty · Workspace: no · Sensitive: yes · Errors: 400, 403, 404, 429 · Implemented (server tests)

External conversations open only where the organization allows them. Response `201`: `{ "data": { "conversationId": "...", "external": false } }`

```sh
curl -X POST "$SPREEWE/v1/contacts/start" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"email":"dana@acme.example","scope":"external"}'
```

---

## Me, workspace & directory

Status: Implemented (server tests: `api-v1.test.ts`, `developer-platform.test.ts`). `GET /v1/workspaces` is called only in a test that checks app tokens are refused.

#### `GET /v1/me`: the signed-in user and active context
Auth: user · **Scope: `profile:read`** · Workspace: no · Sensitive: no · Errors: common · Implemented (server tests)

Response `200`:

```json
{ "data": { "user": { "_id": "...", "username": "dana", "email": "dana@acme.example", "avatar": "", "globalDiscoverable": false },
            "context": { "tenantId": "6650...", "role": "member" } } }
```

```sh
curl "$SPREEWE/v1/me" -H "Authorization: Bearer $APP_TOKEN"
```

#### `GET /v1/workspace`: active workspace summary
Auth: user (no scope, so Clerk session only) · Workspace: yes · Sensitive: no · Errors: common · Implemented (server tests)

Response `200`:

```json
{ "data": { "_id": "...", "name": "Acme", "slug": "acme", "status": "active", "role": "admin",
  "policies": { "allowExternalChat": true, "allowExternalCalls": false, "allowExternalFiles": false, "membersCanStartExternal": false },
  "permissions": { "updatePolicies": true, "startExternal": true } } }
```

```sh
curl "$SPREEWE/v1/workspace" -H "Authorization: Bearer $TOKEN"
```

#### `PATCH /v1/workspace/policies`: change workspace policies (owners / admins)
Auth: user (no scope, so Clerk session only) · Workspace: yes · Sensitive: yes · Errors: common · Implemented (server tests)

Body: at least one of `allowExternalChat`, `allowExternalCalls`, `allowExternalFiles` or `membersCanStartExternal` (all boolean). Response `200`: the same shape as `GET /v1/workspace`.

```sh
curl -X PATCH "$SPREEWE/v1/workspace/policies" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"allowExternalChat":true}'
```

#### `GET /v1/workspaces`: workspaces I have used
Auth: user (no scope, so Clerk session only) · Workspace: no · Sensitive: no · Errors: common · Implemented (server tests)

To switch workspaces, use Clerk. Response `200`: `{ "data": [ { "tenantId": "...", "clerkOrgId": "org_...", "name": "Acme", "slug": "acme", "role": "member", "active": true } ] }`

```sh
curl "$SPREEWE/v1/workspaces" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/directory`: people I can start a conversation with (paginated)
Auth: user · **Scope: `directory:read`** · Workspace: no · Sensitive: no · Errors: common · Implemented (server tests)

In a workspace context, the directory lists active workspace members. In the global context, it lists users in the global directory. Emails are never included. Query: `q` (name filter, max 100), `limit` (default 20) and `cursor`. Response `200`:

```json
{ "data": [ { "_id": "...", "username": "dana", "avatar": "", "isOnline": true, "status": "available", "statusMessage": "" } ], "page": { "nextCursor": "6650..." } }
```

```sh
curl "$SPREEWE/v1/directory?q=da&limit=20" -H "Authorization: Bearer $APP_TOKEN"
```

---

## Conversations & messages

Status: Implemented (server tests: `api-v1.test.ts`, `developer-platform.test.ts`), except `POST /conversations/external`, which no test calls.

To send messages, use the Socket.IO gateway; there is no REST send endpoint. App tokens cannot send messages (see [the E2EE section](#developer-app-tokens-and-end-to-end-encryption)).

#### `GET /v1/conversations`: my conversations, newest first (paginated)
Auth: user · **Scope: `conversations:read`** · Workspace: no · Sensitive: no · Errors: common · Implemented (server tests)

Query: `limit` (default 20) and `cursor`. Response `200`:

```json
{ "data": [ { "_id": "...", "isGroup": true, "name": "Launch", "scope": "tenant", "external": false, "memberCount": 5, "createdAt": "2026-10-20T08:00:00.000Z" } ], "page": { "nextCursor": null } }
```

`scope` is `global`, `tenant` or `external`.

```sh
curl "$SPREEWE/v1/conversations" -H "Authorization: Bearer $APP_TOKEN"
```

#### `GET /v1/conversations/{conversationId}/messages`: messages, newest first (paginated)
Auth: user · **Scope: `messages:read`** · Workspace: no · Sensitive: no · Errors: 404 (also when you are not a member) · Implemented (server tests)

Query: `limit` (default 20) and `cursor`. First-party sessions receive the encrypted payload to decrypt on the device. **App tokens receive encrypted messages with `content: null` and `encrypted: true`.** Response `200` (app token):

```json
{ "data": [ { "_id": "...", "conversationId": "...", "type": "text", "content": null, "encrypted": true,
  "author": { "_id": "...", "username": "dana", "avatar": "" }, "replyToId": null, "editedAt": null, "createdAt": "2026-11-02T09:15:00.000Z" } ],
  "page": { "nextCursor": "6650..." } }
```

```sh
curl "$SPREEWE/v1/conversations/$CONV_ID/messages?limit=50" -H "Authorization: Bearer $APP_TOKEN"
```

#### `POST /v1/conversations/external`: start or reopen an external 1:1 chat
Auth: user (no scope, so Clerk session only) · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented, not covered by tests

The workspace policy must enable `allowExternalChat`. You also need the admin role unless `membersCanStartExternal` is on. Body: `userId` (id of the outside person, required). Response `201`: `{ "data": { "conversationId": "...", "scope": "external" } }`

```sh
curl -X POST "$SPREEWE/v1/conversations/external" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"userId":"6650c1a2b3c4d5e6f7a8b9c0"}'
```

---

## Calls

Status: Implemented, not covered by tests. The tests call the legacy `/calls` route, not `/v1/calls`.

#### `GET /v1/calls`: my call history in the active context (paginated)
Auth: user · **Scope: `calls:read`** · Workspace: no · Sensitive: no · Errors: common · Implemented, not covered by tests

Query: `limit` (default 20), `cursor` (ISO timestamp string from `page.nextCursor`, max 40), and `filter` (`missed`\|`incoming`\|`outgoing`). The route schema does not specify the item fields: items are call-history entries as returned by `call-history.service list()`. Response `200`: `{ "data": [ { ... } ], "page": { "nextCursor": "2026-11-01T18:22:04.512Z" } }`

```sh
curl "$SPREEWE/v1/calls?filter=missed" -H "Authorization: Bearer $APP_TOKEN"
```

---

## Recordings

Status: Implemented (server tests: `api-v1.test.ts`).

#### `GET /v1/recordings/{recordingId}`: recording details with short-lived links
Auth: user · **Scope: `recordings:read`** · Workspace: no · Sensitive: no · Errors: 404 (also when the recording isn't visible in the active context) · Implemented (server tests)

The response contains recording metadata. `playbackUrl` and `downloadUrl` are short-lived signed links, or `null`. The route schema does not specify the other fields. Response `200`: `{ "data": { "_id": "...", "playbackUrl": "https://...", "downloadUrl": "https://...", ... } }`

```sh
curl "$SPREEWE/v1/recordings/$RECORDING_ID" -H "Authorization: Bearer $APP_TOKEN"
```
