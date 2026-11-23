# SpreeWe REST API v1 reference

This page documents every `/v1` endpoint the SpreeWe backend serves. It is based on the route definitions in `webrtc-BE/src/api/v1/*.ts`. Those definitions also generate the machine-readable spec in [`docs/api/openapi.yaml`](../../api/openapi.yaml). If this page and the code ever disagree, the code is correct.

Before you build a developer app, read [Developer-app tokens and end-to-end encryption](#developer-app-tokens-and-end-to-end-encryption). It covers what app tokens can and cannot reach, including message content. The OAuth 2.0 endpoints (`/oauth/*`) are documented in [oauth.md](./oauth.md).

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
export APP_TOKEN=...    # developer-app user token from POST /v1/app-tokens or POST /oauth/token
export KEY_ID=... SECRET=...   # developer-app server credential
```

### Authentication kinds

No `/v1` route is public. Each route uses one of three authentication modes (`AuthMode` in `webrtc-BE/src/api/v1/registry.ts`). Every route below states its mode and, where it has one, its scope, exactly as the route definition declares them. For how tokens are obtained, see [Authentication](../authentication.md) and [OAuth 2.0](./oauth.md).

| Auth kind | What is accepted | Notes |
|---|---|---|
| `user` (default) | A SpreeWe (Clerk) session token (`Authorization: Bearer`), **or** a developer-app user token, but only if the route declares a `scope` and the token carries it | A `user` route without a scope refuses app tokens with `403 "This endpoint needs a signed-in SpreeWe session"`. |
| `firstParty` | SpreeWe (Clerk) session token only | App tokens get `403`, even when the route also declares a scope (see the teams routes). Covers app management, consent decisions, webhooks, organization delete / transfer, join-request decisions, teams and channels, `/workspace/apps` and the platform-admin route. |
| `appCredential` | The app's server credential: `Authorization: Basic base64(keyId:secret)` | Used only by `POST /v1/consent-requests`, `POST /v1/app-tokens` and `POST /v1/app-tokens/revoke`. Call these from your server only. |

How a token is checked:

- The server treats a bearer token as an app token when it is a three-part JWT whose header `kid` matches the app-token key id. Any other bearer token is verified as a Clerk session.
- App tokens (from `POST /v1/app-tokens` or `POST /oauth/token`) are checked against the current state of the app, the user's grant and the user's workspace membership. Every failure returns the same response: `401 "Invalid or expired token"`. That includes expired or revoked tokens, a suspended app and a removed member. The server also checks the request's `Origin` against the app's `allowedOrigins`.
- **Scope check:** the route's `scope` must appear in the token's scopes. Otherwise the response is `403 "The token lacks the <scope> scope"`.
- **CSRF guard:** a non-GET request authenticated by a cookie, with no `Authorization` header, is refused with `403`. Send the session token in the `Authorization` header.
- The server still applies the user's own permissions (membership, roles, workspace policies) after the scope check. An `organizations:manage` token cannot do anything the user's role does not allow.
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

- **Implemented (tests: ...):** the listed files in `webrtc-BE/test/` send a request to this method and path. Some calls only check that the route refuses a caller.
- **Implemented, not covered by tests:** the route exists but no server test sends a request to it.

---

## Developer-app tokens and end-to-end encryption

> **Summary:** without `e2ee:device`, an app token can read metadata (profiles, the directory, conversation lists, message metadata, call history, recordings) but never message ciphertext or content. With `e2ee:device`, and the user's consent, the app registers its own encryption device for the user. That device receives room keys like any of the user's devices, so **an app with `e2ee:device` can read the user's encrypted messages** in conversations its device receives keys for, and can send and edit messages as the user with `messages:write` / `messages:edit`. The SpreeWe server never sees plaintext in either case: decryption happens in the app's own code.

SpreeWe messages are end-to-end encrypted on the user's devices. The server stores and relays only public keys and ciphertext. An app takes part in encryption the same way a SpreeWe client does, through an **app encryption device**.

### The app encryption device

1. **Scope and consent.** The app must be configured with `e2ee:device`, and the user must grant it (consent screen, `POST /v1/apps/{appId}/grants`, or OAuth). The consent screen marks `e2ee:device` as sensitive. Its description states that the app's device can read the user's messages.
2. **Registration.** With a token carrying `e2ee:device`, the app calls `POST /v1/e2ee/devices` with its own device id in `X-SpreeWe-Device`. The server records the device as owned by the app and always labels it `"<app name> (app)"`; a `displayName` sent by an app is ignored. A device id belongs to the client that registered it for its whole life: an app can't use a SpreeWe client's device, a SpreeWe client can't use an app's device, and an app can't use another app's device (`403 "This encryption device belongs to another client"`).
3. **Own device only.** Every `/v1/e2ee/*` call made with an app token must name one of that app's active devices for the user in `X-SpreeWe-Device` (`404` if unregistered, `403` if revoked or owned by another client). `POST /v1/e2ee/devices/{deviceId}/revoke` with an app token can only revoke the app's own devices.
4. **Visible to the user.** `GET /v1/e2ee/devices` lists every device of the user, with `appId` set for app devices (`null` for SpreeWe clients). The user can revoke an app device from a SpreeWe session like any other device.
5. **Keys and messages.** The device publishes keys, claims prekeys, sends and receives device messages, and syncs, through the same `/v1/e2ee/*` routes as SpreeWe clients. Room keys reach it only from contacts' clients that share them with the user's devices.

### Sending and editing

- There is no REST endpoint for sending messages. Apps send over Socket.IO: `sendMessage` needs `messages:write`, `message:edit` needs `messages:edit` (`SOCKET_EVENT_SCOPES` in `webrtc-BE/src/developer/scopes.ts`).
- The gateway accepts an app's `sendMessage` / `message:edit` only when `e2ee.device_id` in the payload is an active device **this app** registered for the user (`webrtc-BE/src/realtime/index.ts`). Otherwise it emits `message:rejected` with `reason: "e2ee"`. The usual checks then apply: membership, an encrypted payload, author-only edits.
- New messages count against the app's daily `messagesPerDay` quota; when it is used up, `message:rejected` carries `reason: "quota"`.
- `messages:write` and `messages:edit` without `e2ee:device` grant nothing usable: the app has no device to send from.

### Who receives ciphertext

| Channel | App token **with** `e2ee:device` | App token **without** `e2ee:device` |
|---|---|---|
| `GET /v1/conversations/{id}/messages` (`messages:read`) | Messages as stored, including the `e2ee` envelope | Encrypted messages have `e2ee` removed, `content: null` and `encrypted: true` (`webrtc-BE/src/api/v1/routes.ts`) |
| Session API responses ([session-api.md](./session-api.md)) | Ciphertext included | Ciphertext removed (`authMiddleware.ts`) |
| Socket.IO `receiveMessage`, `message:updated`, `message:deleted` ([realtime events](../realtime-events.md)) | Ciphertext included when the token has both `messages:read` and `e2ee:device` | `content: null`, `encrypted: true` (`webrtc-BE/src/realtime/io.ts`) |
| Socket.IO `e2ee:to-device`, `e2ee:devices-changed` | Delivered (scope `e2ee:device`) | Not delivered |
| `message.created` webhook | Never ciphertext: `encrypted: true`, `content: null` | Same |

### Automatic device revocation

The server revokes an app's encryption devices (they stop receiving keys and device messages, their pending device messages and one-time keys are deleted, and the user's contacts are told to re-check the user's devices) when:

| Event | Devices revoked |
|---|---|
| The user withdraws the grant (`DELETE /v1/me/app-grants/{grantId}`) | That user's devices for the app |
| The user re-grants the app without `e2ee:device` (`POST /v1/apps/{appId}/grants`, or approving a consent request / OAuth request without it) | That user's devices for the app |
| The owner removes `e2ee:device` from the app's scopes (`PATCH /v1/apps/{appId}`) | All devices of the app |
| The owner deletes the app (`POST /v1/apps/{appId}/revoke`) | All devices of the app |
| A workspace owner or admin withdraws all grants (`POST /v1/workspace/apps/{appId}/revoke-grants`) | All devices of the app |

Suspending an app does not revoke its devices; its tokens fail while it is suspended. A revoked device id can't be registered again (`403`); the app must set up a new device.

### What this means for users and integrators

- An app with `e2ee:device` can decrypt and read the user's messages, and with `messages:write` send messages that appear as the user's. Request it only if your app needs message content. Users should grant it only to apps they trust with their messages.
- The SpreeWe server never sees plaintext. Your app is responsible for protecting the device's private keys and the decrypted content it holds.
- Tests: `webrtc-BE/test/developer-api-e2ee.test.ts` (an app device reads and sends with a SpreeWe user while the server sees no plaintext; own-device-only rules; no ciphertext without `e2ee:device`; revocation on grant withdrawal, scope removal and app deletion). Workspace `revoke-grants` is covered by `p5-security.test.ts`, which does not check devices. Revocation on a re-grant without `e2ee:device` is not covered by tests.

---

## Scope catalogue

From `webrtc-BE/src/developer/scopes.ts`. No scope is granted by default. `UNAVAILABLE_SCOPES` is currently empty, so `GET /v1/scopes` returns `available: true` for every scope. A token carries only scopes present in the app, the user's grant and the token request.

| Scope | `/v1` routes | Socket.IO (see [realtime events](../realtime-events.md)) |
|---|---|---|
| `profile:read` | `GET /v1/me` | none |
| `directory:read` | `GET /v1/directory`, `POST /v1/contacts/lookup` | none |
| `contacts:write` | `POST /v1/contacts/start` | sends `chat:block`, `chat:unblock` |
| `conversations:read` | `GET /v1/conversations` | none |
| `conversations:write` | `POST /v1/conversations/external` | sends `chat:archive`, `chat:unarchive`, `chat:favorite`, `chat:unfavorite`, `chat:clear` |
| `messages:read` | `GET /v1/conversations/{id}/messages` | receives message, typing and receipt events; sends `joinConversation`, `typing`, `stopTyping`, `markMessagesRead`, `message:delivered` |
| `messages:write` | none | sends `sendMessage` (from the app's own encryption device) |
| `messages:edit` | none | sends `message:edit` (from the app's own encryption device) |
| `e2ee:device` | all `/v1/e2ee/*` routes | receives `e2ee:to-device`, `e2ee:devices-changed` |
| `calls:read` | `GET /v1/calls` | receives call lifecycle events |
| `recordings:read` | `GET /v1/recordings/{id}` | receives `recording:updated`, `call:recording` |
| `organizations:read` | `GET /v1/organizations/mine`, `GET /v1/organizations/discover`, `GET /v1/me/join-requests`, `GET /v1/me/organization-invitations`, `POST /v1/organization-invitations/preview`, `GET /v1/workspace`, `GET /v1/workspaces`, `GET /v1/workspace/organization`, `GET /v1/workspace/organization/members`, `GET /v1/workspace/members` | none |
| `organizations:write` | `POST /v1/organizations`, `POST /v1/organizations/{id}/join`, `POST /v1/organizations/{id}/join-requests`, `POST /v1/me/join-requests/{id}/cancel`, `POST /v1/organization-invitations/accept`, `POST /v1/workspace/leave` | none |
| `organizations:manage` | `PATCH /v1/workspace/organization`, `PATCH /v1/workspace/policies`, `PATCH` / `POST .../remove` on `/v1/workspace/organization/members/{userId}`, `/v1/workspace/invitations*`, `GET /v1/workspace/join-requests`, `POST /v1/workspace/join-code`, `GET /v1/workspace/audit` | none |

The teams and channels routes declare `organizations:read` / `write` / `manage`, but they are `firstParty`, so app tokens can't reach them. Joining-request decisions (`/v1/workspace/join-requests/{id}/approve|reject`) are `firstParty` too.

The remaining scopes (`profile:write`, `conversations:delete`, `groups:read|write|manage`, `messages:react`, `messages:delete`, `files:read|write`, `calls:write|manage`, `meetings:read|write`, `recordings:write`, `notifications:read|write`, `search:read`, `realtime:connect`) have no `/v1` route. They gate session API routes ([session-api.md](./session-api.md)) and Socket.IO events. `realtime:connect` is needed to open a Socket.IO connection at all. Call `GET /v1/scopes` for the description of each scope.

Webhook events and the scope each one needs: `message.created` requires `messages:read`. `conversation.members_added` and `conversation.members_removed` require `conversations:read`. `call.started` and `call.ended` require `calls:read`. `recording.available` requires `recordings:read`.

---

## Apps & credentials

Status: Implemented. Each route lists its tests.

These routes are `firstParty`. Owners act on an app from the app's own context: a workspace app from inside its workspace, a global app from the personal context. Platform admins can read app metadata and suspend or reactivate apps; workspace owners and admins can also suspend or reactivate apps bound to their workspace (`setAppStatus` in `app.service.ts`; covered by `p5-security.test.ts`). When you can't see an app, the response is `404`.

App object (`appDoc`):

```json
{ "_id": "6650c1a2b3c4d5e6f7a8b9c0", "name": "Acme CRM", "description": "CRM sync for Acme sales teams",
  "websiteUrl": "https://crm.acme.example", "environment": "development",
  "status": "active", "tenantId": null, "scopes": ["profile:read", "conversations:read"],
  "allowedOrigins": ["https://crm.acme.example"], "callbackUrls": ["https://crm.acme.example/spreewe/callback"],
  "quotas": { "rateLimitPerMinute": 120, "maxConnections": 20, "messagesPerDay": 2000 } }
```

Credential object: `{ _id, keyId, hint, status: "active"|"rotated"|"revoked", graceUntil, expiresAt, lastUsedAt }`.

#### `GET /v1/scopes`: permission catalogue
Auth: firstParty · Workspace: no · Errors: common · Implemented (tests: developer-portal.test.ts)

Every scope an app can request, for showing to developers. `sensitive` scopes are highlighted on the consent screen. `available: false` would mark a scope that exists but grants nothing yet; no scope is unavailable today, so every entry has `available: true`.

```json
{ "data": [ { "scope": "profile:read", "description": "Read the user's own profile (GET /v1/me, GET /web/user/me) and profiles of people visible to the user", "sensitive": false, "available": true },
             { "scope": "e2ee:device", "description": "Register an end-to-end encryption device for the user. …", "sensitive": true, "available": true } ] }
```

#### `POST /v1/apps`: register an app
Auth: firstParty · Workspace: no · Sensitive: yes · Errors: common · Implemented (tests: developer-api-access.test.ts, developer-api-calls.test.ts, developer-api-e2ee.test.ts, developer-oauth.test.ts, developer-platform.test.ts, developer-portal.test.ts, examples.test.ts, p5-security.test.ts, webhooks.test.ts)

The app is global when created from the personal context. With `tenantBound: true`, it is bound to the active workspace, which requires the owner or admin role. Each owner can have at most 25 apps (`409`). Origins and callback URLs must use https; `http://localhost` is allowed only for development apps.

| Body field | Type | Required | Limits |
|---|---|---|---|
| `name` | string | yes | 2–80 |
| `description` | string | no | max 500; plain text, shown on the consent screen |
| `websiteUrl` | string | no | absolute `http(s)` URL without credentials, max 300; empty for none |
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
Auth: firstParty · Workspace: no · Sensitive: no · Errors: common · Implemented (tests: developer-platform.test.ts)

Response `200`: `{ "data": [ <app>, ... ] }`

```sh
curl "$SPREEWE/v1/apps" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/apps/{appId}`: app configuration
Auth: firstParty · Who: owner or platform admin · Workspace: no · Sensitive: no · Errors: 404 · Implemented (tests: developer-platform.test.ts, developer-portal.test.ts)

Response `200`: `{ "data": <app> }`

```sh
curl "$SPREEWE/v1/apps/$APP_ID" -H "Authorization: Bearer $TOKEN"
```

#### `PATCH /v1/apps/{appId}`: update an app
Auth: firstParty · Who: owner · Workspace: no · Sensitive: yes · Errors: 404, 409 (app revoked) · Implemented (tests: developer-api-e2ee.test.ts, developer-platform.test.ts, developer-portal.test.ts)

Body: at least one of `name` (2–80), `description` (max 500), `websiteUrl` (absolute `http(s)` URL, or `""` to clear), `scopes`, `allowedOrigins`, `callbackUrls`, `quotas`. The limits are the same as for create. Removing `e2ee:device` from `scopes` revokes every encryption device the app holds, for all users. Response `200`: `{ "data": <app> }`

```sh
curl -X PATCH "$SPREEWE/v1/apps/$APP_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"allowedOrigins":["https://crm.acme.example"]}'
```

#### `POST /v1/apps/{appId}/suspend`: suspend an app
Auth: firstParty · Who: owner, platform admin, or (for a workspace app) a workspace owner / admin · Workspace: no · Sensitive: yes · Errors: 404, 409 · Implemented (tests: developer-platform.test.ts, developer-portal.test.ts, p5-security.test.ts)

While an app is suspended, its credentials and tokens stop working. Its encryption devices are kept. There is no request body. Response `201`: `{ "data": <app> }` with `"status": "suspended"`.

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/suspend" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/reactivate`: reactivate a suspended app
Auth: firstParty · Who: owner, platform admin, or (for a workspace app) a workspace owner / admin · Workspace: no · Sensitive: yes · Errors: 404, 409 · Implemented (tests: developer-platform.test.ts, developer-portal.test.ts)

There is no request body. Response `201`: `{ "data": <app> }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/reactivate" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/revoke`: permanently revoke an app
Auth: firstParty · Who: owner · Workspace: no · Sensitive: yes · Errors: 404, 409 · Implemented (tests: developer-api-e2ee.test.ts, developer-platform.test.ts, developer-portal.test.ts)

Body: `confirm` (string, max 80, the app's exact name, required). Revoking also revokes all of the app's encryption devices and OAuth refresh tokens. Response `201`: `{ "data": <app> }` with `"status": "revoked"`.

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/revoke" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

#### `POST /v1/apps/{appId}/tokens/revoke-all`: invalidate all issued user tokens
Auth: firstParty · Who: owner · Workspace: no · Sensitive: yes · Errors: 404 · Implemented (tests: developer-oauth.test.ts, developer-platform.test.ts)

Body: `confirm` (required). OAuth refresh tokens of the app stop working too. Response `201`: `{ "data": { "revoked": true } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/tokens/revoke-all" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

#### `GET /v1/apps/{appId}/usage`: daily usage counters
Auth: firstParty · Who: owner or platform admin · Workspace: no · Sensitive: no · Errors: 404 · Implemented (tests: developer-api-access.test.ts, developer-portal.test.ts)

Query: `days` (integer 1–90, default 30). Response `200`:

```json
{ "data": [ { "day": "2026-11-01", "apiRequests": 412, "apiErrors": 9, "tokensIssued": 37, "messagesSent": 0, "socketConnections": 12 } ] }
```

`apiErrors` counts the app's authenticated requests that ended with status 400 or higher. Requests with an invalid or expired token can't be attributed to an app and aren't counted.

```sh
curl "$SPREEWE/v1/apps/$APP_ID/usage?days=7" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/apps/{appId}/audit`: audit trail of sensitive actions
Auth: firstParty · Who: owner or platform admin · Workspace: no · Sensitive: no · Errors: 404 · Implemented (tests: developer-portal.test.ts)

Response `200`: `{ "data": [ { "action": "credential.created", "actorKind": "owner", "actorUserId": "6650...", "at": "2026-11-01T10:00:00.000Z" } ] }`. The `action` values come from the server; this example value is illustrative.

```sh
curl "$SPREEWE/v1/apps/$APP_ID/audit" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/apps/{appId}/credentials`: list credentials
Auth: firstParty · Workspace: no · Sensitive: no · Errors: 404 · Implemented (tests: developer-platform.test.ts, developer-portal.test.ts, p5-security.test.ts)

The response never includes secrets. Response `200`: `{ "data": [ <credential>, ... ] }`

```sh
curl "$SPREEWE/v1/apps/$APP_ID/credentials" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/credentials`: create a server credential
Auth: firstParty · Who: owner · Workspace: no · Sensitive: yes · Errors: 404, 409 (app not active, or the limit of 5 active credentials is reached) · Implemented (tests: developer-api-access.test.ts, developer-api-calls.test.ts, developer-api-e2ee.test.ts, developer-oauth.test.ts, developer-platform.test.ts, developer-portal.test.ts, examples.test.ts, p5-security.test.ts, webhooks.test.ts)

Body: `confirm` (required) and `expiresInDays` (integer 1–365, default 180). The **secret appears only in this response.**

```json
{ "data": { "credential": { "_id": "6650...", "keyId": "swk_test_...", "hint": "...x9Q", "status": "active", "graceUntil": null, "expiresAt": "2027-05-01T00:00:00.000Z", "lastUsedAt": null }, "secret": "..." } }
```

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/credentials" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM","expiresInDays":90}'
```

#### `POST /v1/apps/{appId}/credentials/{credentialId}/rotate`: rotate a credential
Auth: firstParty · Who: owner · Workspace: no · Sensitive: yes · Errors: 404 · Implemented (tests: developer-platform.test.ts, developer-portal.test.ts, p5-security.test.ts)

Rotation issues a new secret immediately. The old secret keeps working for the grace period, which is 1 hour by default. Body: `confirm` (required) and `expiresInDays` (1–365, default 180). Response `201`: `{ "data": { "credential": {...}, "secret": "...", "previous": { "keyId": "...", "validUntil": "..." } } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/credentials/$CRED_ID/rotate" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

#### `POST /v1/apps/{appId}/credentials/{credentialId}/revoke`: revoke a credential immediately
Auth: firstParty · Who: owner · Workspace: no · Sensitive: yes · Errors: 404 · Implemented (tests: developer-platform.test.ts, developer-portal.test.ts)

Body: `confirm` (required). Response `201`: `{ "data": { "revoked": true } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/credentials/$CRED_ID/revoke" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

#### `GET /v1/admin/apps`: all apps' metadata (platform admins)
Auth: firstParty · Who: platform admin only · Workspace: no · Sensitive: no · Errors: 404 (any non-admin caller) · Implemented (tests: developer-platform.test.ts)

The response contains app metadata only, with no tenant content. Response `200`: `{ "data": [ <app>, ... ] }`

```sh
curl "$SPREEWE/v1/admin/apps" -H "Authorization: Bearer $TOKEN"
```

---

## Consent & grants

Status: Implemented. Each route lists its tests.

There are three ways a user can authorize an app: directly (`POST /apps/{appId}/grants`), through an app-initiated consent request (`POST /v1/consent-requests`), or through OAuth 2.0 (`GET /oauth/authorize`, see [oauth.md](./oauth.md)), which creates a consent request carrying a PKCE challenge. Granting without `e2ee:device` revokes the app's encryption devices for that user. A consent request ID is a 20–40 character string matching `[A-Za-z0-9_-]`.

#### `POST /v1/apps/{appId}/grants`: authorize an app for myself
Auth: firstParty · Workspace: no (but see below) · Sensitive: yes · Errors: 404, 409 · Implemented (tests: developer-api-access.test.ts, developer-api-calls.test.ts, developer-api-e2ee.test.ts, developer-platform.test.ts, developer-portal.test.ts, p5-security.test.ts, webhooks.test.ts)

Authorize a workspace app from inside its workspace, and a global app from the personal context. Body: `scopes` (scope[], required; the schema allows up to the number of defined scopes). The scopes must be a subset of the app's scopes, with at least one. Linking an `externalUserRef` is possible only through a consent request.

```json
{ "data": { "_id": "6650...", "appId": "6650...", "appName": "Acme CRM", "scopes": ["profile:read"], "externalUserRef": null } }
```

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/grants" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"scopes":["profile:read"]}'
```

#### `GET /v1/me/app-grants`: apps I have authorized
Auth: firstParty · Workspace: no · Sensitive: no · Errors: common · Implemented (tests: developer-api-e2ee.test.ts, developer-oauth.test.ts, developer-platform.test.ts)

Response `200`: `{ "data": [ { "_id": "...", "appId": "...", "appName": "Acme CRM", "scopes": ["profile:read"] } ] }`

```sh
curl "$SPREEWE/v1/me/app-grants" -H "Authorization: Bearer $TOKEN"
```

#### `DELETE /v1/me/app-grants/{grantId}`: withdraw an app's access
Auth: firstParty · Workspace: no · Sensitive: no · Errors: 404 · Implemented (tests: developer-api-e2ee.test.ts, developer-oauth.test.ts, developer-platform.test.ts)

The app's tokens for you stop working immediately. The app's encryption devices for you are revoked and its OAuth refresh tokens for you end. Response `200`: `{ "data": { "revoked": true } }`

```sh
curl -X DELETE "$SPREEWE/v1/me/app-grants/$GRANT_ID" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/consent-requests`: app server starts a consent flow
Auth: appCredential (HTTP Basic `keyId:secret`) · Workspace: n/a · Sensitive: no (per-credential limit) · Errors: common · Implemented (tests: developer-platform.test.ts, p5-security.test.ts)

| Body field | Type | Required | Limits |
|---|---|---|---|
| `redirectUri` | string | yes | 8–300; must exactly match a registered callback URL |
| `scopes` | scope[] | yes | at least one, within the app's scopes |
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
Auth: firstParty · Workspace: no · Sensitive: no · Errors: 404 (invalid or expired) · Implemented (tests: p5-security.test.ts)

Response `200`:

```json
{ "data": { "requestId": "Qm9v...", "app": { }, "scopes": [ { "scope": "profile:read", "description": "Read the user's own profile (GET /v1/me)", "sensitive": false } ],
  "redirectHost": "crm.acme.example", "contextMatches": true, "existingScopes": [] } }
```

The route schema is loose: `app` is typed only as an object, and the handler also returns fields the schema doesn't list. Per `viewConsentRequest` in `app.service.ts`, `app` has `_id`, `name`, `description`, `websiteUrl`, `environment`, `ownerName`, `tenantBound`, `tenantId`; each scope also has `available`; and the response has `expiresAt`. Treat undeclared fields as subject to change.

```sh
curl "$SPREEWE/v1/consent-requests/$REQUEST_ID" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/consent-requests/{requestId}/approve`: approve selected scopes
Auth: firstParty · Workspace: the app's context (a workspace app requires that workspace to be active; a global app requires the personal context; otherwise `403`) · Sensitive: yes · Errors: 404, 409 (`externalUserRef` already linked to another account) · Implemented (tests: developer-oauth.test.ts, developer-platform.test.ts, examples.test.ts, p5-security.test.ts)

Body: `scopes` (scope[], required, a non-empty subset of the request). Response `201`: `{ "data": { "redirectUrl": "...", "scopes": ["profile:read"] } }`. `redirectUrl` is the request's `redirectUri` with `state` and:

- for a consent request created by `POST /v1/consent-requests`: `result=approved&grant=<grantId>`;
- for an OAuth request (created by `GET /oauth/authorize`): `code=<one-time code>`, to exchange at `POST /oauth/token` (see [oauth.md](./oauth.md)).

```sh
curl -X POST "$SPREEWE/v1/consent-requests/$REQUEST_ID/approve" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"scopes":["profile:read"]}'
```

#### `POST /v1/consent-requests/{requestId}/deny`: deny a request
Auth: firstParty · Workspace: no · Sensitive: yes · Errors: 404 · Implemented (tests: developer-oauth.test.ts, p5-security.test.ts)

There is no request body. Response `201`: `{ "data": { "redirectUrl": "...", "scopes": [] } }`. `redirectUrl` is the request's `redirectUri` with `state` and `error=access_denied`.

```sh
curl -X POST "$SPREEWE/v1/consent-requests/$REQUEST_ID/deny" -H "Authorization: Bearer $TOKEN"
```

---

## App tokens

Status: Implemented. Each route lists its tests.

Call these endpoints from your server only, never from a browser or mobile app. Apps without a backend use OAuth 2.0 with PKCE instead ([oauth.md](./oauth.md)).

#### `POST /v1/app-tokens`: exchange the credential for a short-lived user token
Auth: appCredential (HTTP Basic `keyId:secret`) · Workspace: n/a (the tenant is the app's binding) · Sensitive: no · Errors: common · Implemented (tests: developer-api-access.test.ts, developer-api-calls.test.ts, developer-api-e2ee.test.ts, developer-platform.test.ts, developer-portal.test.ts, p5-security.test.ts, webhooks.test.ts)

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
Auth: appCredential (HTTP Basic `keyId:secret`) · Sensitive: no · Errors: common · Implemented (tests: developer-platform.test.ts)

Body: `token` (string 20–4096, required, not trimmed). The token must belong to this app; otherwise the response is `400 "Invalid token"`. Response `201`: `{ "data": { "revoked": true } }`

```sh
curl -X POST "$SPREEWE/v1/app-tokens/revoke" -u "$KEY_ID:$SECRET" -H "Content-Type: application/json" -d "{\"token\":\"$APP_TOKEN\"}"
```

---

## Webhooks

Status: Implemented. `GET /webhook-events`, `PATCH`, `disable` and `delete` are not covered by tests; each route lists its tests.

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
Auth: firstParty · Who: owner · Sensitive: no · Errors: 404 · Implemented (tests: developer-portal.test.ts, webhooks.test.ts)

Response `200`: `{ "data": [ <endpoint>, ... ] }`

```sh
curl "$SPREEWE/v1/apps/$APP_ID/webhooks" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/webhooks`: add an endpoint
Auth: firstParty · Who: owner · Sensitive: yes · Errors: 404, 409 · Implemented (tests: developer-portal.test.ts, webhooks.test.ts)

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
Auth: firstParty · Who: owner · Sensitive: yes · Errors: 404 · Implemented, not covered by tests

Body: at least one of `url` (10–500), `events` (max 6) or `description` (max 200). A new URL must be verified again. Response `200`: `{ "data": <endpoint> }`

```sh
curl -X PATCH "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"events":["message.created","call.ended"]}'
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/verify`: send a verification challenge
Auth: firstParty · Who: owner · Sensitive: yes · Errors: 404 · Implemented (tests: webhooks.test.ts)

The server sends a signed challenge to the endpoint. The endpoint must answer with a 2xx status and `{"challenge":"..."}`. On success, the endpoint becomes active. Response `201`: `{ "data": { "verified": true, "error": null } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/verify" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/disable`: stop deliveries
Auth: firstParty · Who: owner · Sensitive: no · Errors: 404 · Implemented, not covered by tests

Response `201`: `{ "data": <endpoint> }` with `"status": "disabled"`.

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/disable" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/enable`: re-enable
Auth: firstParty · Who: owner · Sensitive: no · Errors: 404 · Implemented (tests: webhooks.test.ts)

The endpoint returns to `pending_verification`; call `/verify` again. Response `201`: `{ "data": <endpoint> }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/enable" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/rotate-secret`: new signing secret
Auth: firstParty · Who: owner · Sensitive: yes · Errors: 404, 409 · Implemented (tests: webhooks.test.ts)

Body: `confirm` (required) and `keepOldSeconds` (integer 0–604800). With the default of 86400, old secrets keep signing for one day. `0` revokes them now. The new secret appears only in this response. Response `201`: `{ "data": { "secret": "swh_...", "keptSecrets": 1 } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/rotate-secret" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM","keepOldSeconds":3600}'
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/delete`: delete an endpoint
Auth: firstParty · Who: owner · Sensitive: yes · Errors: 404 · Implemented, not covered by tests

Body: `confirm` (required). Pending deliveries are cancelled. Response `201`: `{ "data": { "deleted": true } }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/delete" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

#### `GET /v1/apps/{appId}/webhooks/{endpointId}/deliveries`: delivery history (paginated)
Auth: firstParty · Who: owner · Sensitive: no · Errors: 404 · Implemented (tests: webhooks.test.ts)

Query: `status` (one of the delivery statuses), `limit` (1–100, default 20) and `cursor` (id). Payloads are never returned. Response `200`:

```json
{ "data": [ { "_id": "6650...", "eventId": "...", "eventType": "message.created", "status": "dead", "attempts": 8, "lastStatusCode": 500, "lastError": "http_500", "nextAttemptAt": null, "deliveredAt": null } ], "page": { "nextCursor": null } }
```

```sh
curl "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/deliveries?status=dead&limit=50" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/apps/{appId}/webhooks/{endpointId}/deliveries/{deliveryId}/retry`: re-queue a dead delivery
Auth: firstParty · Who: owner · Sensitive: no · Errors: 404 · Implemented (tests: webhooks.test.ts)

A dead delivery can be retried only while its payload is still kept, which is up to 7 days. Response `201`: `{ "data": <delivery> }`

```sh
curl -X POST "$SPREEWE/v1/apps/$APP_ID/webhooks/$EP_ID/deliveries/$DELIVERY_ID/retry" -H "Authorization: Bearer $TOKEN"
```

---

## E2EE devices & keys

Status: Implemented. Each route lists its tests (`e2ee.test.ts`, `e2ee-real-crypto.test.ts`, `developer-api-e2ee.test.ts`).

All of these routes use auth `user` with scope **`e2ee:device`**: SpreeWe sessions, and app tokens that carry `e2ee:device` (see [the E2EE section](#developer-app-tokens-and-end-to-end-encryption)). The caller's device is identified by the **`X-SpreeWe-Device`** header, matching `^[A-Za-z0-9_-]{4,64}$`. The routes that need a device return `400` when the header is missing. With an app token, every route except device revoke needs the header, and it must name an active device that this app registered for the user (`404` if unregistered, `403` if revoked or registered by another client).

Request bodies for keys and device messages follow the Olm/Megolm client library's request formats. The server validates only that each body is a JSON object within a size limit, and the E2EE service validates the content. The server only ever handles public keys and ciphertext. See [`docs/security/end-to-end-encryption.md`](../../security/end-to-end-encryption.md). Apps use them through their own encryption device only.

#### `POST /v1/e2ee/devices`: register or touch this device
Auth: user · Scope: `e2ee:device` · Sensitive: yes · Errors: 400 (missing or invalid device header), 403 (the device was revoked) · Implemented (tests: developer-api-e2ee.test.ts, e2ee.test.ts)

Body: `displayName` (string, max 100, optional). For an app token, `displayName` is ignored and the device is labelled `"<app name> (app)"`; registering a device id owned by another client returns `403`. Response `201`: `{ "data": { "deviceId": "WEB7F3A2", "userId": "..." } }`

```sh
curl -X POST "$SPREEWE/v1/e2ee/devices" -H "Authorization: Bearer $TOKEN" -H "X-SpreeWe-Device: WEB7F3A2" -H "Content-Type: application/json" -d '{"displayName":"Chrome on laptop"}'
```

#### `GET /v1/e2ee/devices`: my devices
Auth: user · Scope: `e2ee:device` · Sensitive: no · Errors: common · Implemented (tests: developer-api-e2ee.test.ts, e2ee.test.ts)

Response `200`: `{ "data": [ { "deviceId": "WEB7F3A2", "displayName": "Chrome on laptop", "ed25519": "base64...", "createdAt": "...", "lastSeenAt": "...", "revoked": false, "appId": null } ] }`. `appId` is the id of the app that registered the device, or `null` for SpreeWe clients. The route's response schema lists only `deviceId`, `displayName`, `ed25519` and `revoked`; `createdAt`, `lastSeenAt` and `appId` come from the handler (`myDevices`) and are not in `openapi.yaml`.

```sh
curl "$SPREEWE/v1/e2ee/devices" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/e2ee/devices/{deviceId}/revoke`: remove one of my devices
Auth: user · Scope: `e2ee:device` · Sensitive: yes · Errors: 404 · Implemented (tests: developer-api-e2ee.test.ts, e2ee.test.ts)

`deviceId` is at most 64 characters. A revoked device stops receiving keys and device messages, and your contacts are notified. A SpreeWe session can revoke any of the user's devices, including app devices; an app token can revoke only the app's own devices (`404` otherwise). Response `201`: `{ "data": { "revoked": true } }`

```sh
curl -X POST "$SPREEWE/v1/e2ee/devices/WEB7F3A2/revoke" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/e2ee/keys/upload`: publish device and one-time keys
Auth: user · Scope: `e2ee:device` · Sensitive: no · Errors: 400, 403 (keys not for your account or this device), 404 · Implemented (tests: developer-api-e2ee.test.ts, e2ee.test.ts)

Body: a JSON object of at most 128 KiB (Olm key upload format). Response `201`: `{ "data": { ... } }` (an object, such as one-time key counts; the route schema does not specify its fields).

```sh
curl -X POST "$SPREEWE/v1/e2ee/keys/upload" -H "Authorization: Bearer $TOKEN" -H "X-SpreeWe-Device: WEB7F3A2" -H "Content-Type: application/json" -d @keys-upload.json
```

#### `POST /v1/e2ee/keys/query`: device keys of people I share a conversation with
Auth: user · Scope: `e2ee:device` · Sensitive: no · Errors: common · Implemented (tests: developer-api-e2ee.test.ts, e2ee.test.ts)

Body: a JSON object of at most 64 KiB. Users you share no conversation with are listed as failures. Response `201`: `{ "data": { ... } }`

```sh
curl -X POST "$SPREEWE/v1/e2ee/keys/query" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @keys-query.json
```

#### `POST /v1/e2ee/keys/claim`: claim one-time prekeys
Auth: user · Scope: `e2ee:device` · Sensitive: yes · Errors: common · Implemented (tests: developer-api-e2ee.test.ts, e2ee.test.ts)

Body: a JSON object of at most 64 KiB. Each claimed key is consumed. Response `201`: `{ "data": { ... } }`

```sh
curl -X POST "$SPREEWE/v1/e2ee/keys/claim" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @keys-claim.json
```

#### `POST /v1/e2ee/sendToDevice/{eventType}/{txnId}`: send device messages
Auth: user · Scope: `e2ee:device` · Sensitive: no · Errors: 400 (event type not allowed), 403 · Implemented (tests: developer-api-e2ee.test.ts, e2ee.test.ts)

`eventType` and `txnId` are each at most 128 characters. Body: a JSON object of at most 2 MiB (Olm ciphertext or verification messages). You can send only to people you share a conversation with. Response `201`: `{ "data": { ... } }`

```sh
curl -X POST "$SPREEWE/v1/e2ee/sendToDevice/m.room.encrypted/txn-0001" -H "Authorization: Bearer $TOKEN" -H "X-SpreeWe-Device: WEB7F3A2" -H "Content-Type: application/json" -d @to-device.json
```

#### `GET /v1/e2ee/sync`: pending device messages and key state
Auth: user · Scope: `e2ee:device` · Sensitive: no · Errors: common · Implemented (tests: developer-api-e2ee.test.ts, e2ee.test.ts)

Query: `ack` (string, max 64; acknowledges the previous batch with the `next` value it returned), `since` (integer ≥ 0) and `limit` (1–500). The response contains pending device messages, key counts and contacts' device-list changes. Response `200`: `{ "data": { "events": [ ... ], "next": "...", ... } }`

```sh
curl "$SPREEWE/v1/e2ee/sync?ack=$NEXT" -H "Authorization: Bearer $TOKEN" -H "X-SpreeWe-Device: WEB7F3A2"
```

#### `GET /v1/e2ee/rooms/{conversationId}/members`: encryption identities of a conversation's members
Auth: user · Scope: `e2ee:device` · Sensitive: no · Errors: common · Implemented (tests: e2ee.test.ts, e2ee-real-crypto.test.ts)

Response `200`: `{ "data": { "roomId": "...", "members": ["...", "..."] } }`

```sh
curl "$SPREEWE/v1/e2ee/rooms/$CONV_ID/members" -H "Authorization: Bearer $TOKEN"
```

---

## Organizations

Status: Implemented. `POST /me/join-requests/{id}/cancel` is not covered by tests; each route lists its tests.

These routes use auth `user` with an `organizations:read` or `organizations:write` scope, so app tokens with that scope can call them. They work in any context. Organization card: `{ organizationId, clerkOrgId, name, slug, description, avatar, discoverable, joinPolicy: "invite"|"request"|"open" }`.

#### `POST /v1/organizations`: create an organization
Auth: user · Scope: `organizations:write` · Workspace: no · Sensitive: yes · Errors: 409 (slug taken), 429 · Implemented (tests: contacts.test.ts, favorites.test.ts, organizations.test.ts, organizations-realtime.test.ts, saved-messages-scope.test.ts, teams-channels.test.ts)

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
Auth: user · Scope: `organizations:read` · Sensitive: no · Errors: common · Implemented (tests: contacts.test.ts, developer-api-access.test.ts, organizations.test.ts)

Response `200`: `{ "data": [ { ...card, "role": "owner", "managedBy": "...", "status": "active", "active": true } ] }`

```sh
curl "$SPREEWE/v1/organizations/mine" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/organizations/discover`: search discoverable organizations
Auth: user · Scope: `organizations:read` · Sensitive: yes · Errors: common · Implemented (tests: organizations.test.ts)

Query: `q` (max 80) and `limit` (1–50, default 20). Private organizations are never listed. Response `200`: `{ "data": [ { ...card, "myStatus": "none" } ] }`, where `myStatus` is `member`, `requested` or `none`.

```sh
curl "$SPREEWE/v1/organizations/discover?q=acme" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/organizations/{organizationId}/join`: join by code, or directly if open
Auth: user · Scope: `organizations:write` · Sensitive: yes · Errors: 404 · Implemented (tests: organizations.test.ts)

Body: `code` (string 6–20, optional). Response `201`: `{ "data": { ...card, "role": "member", "outcome": "added" } }`, where `outcome` is `added` or `already`.

```sh
curl -X POST "$SPREEWE/v1/organizations/$ORG_ID/join" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"code":"K7PQ2XZD"}'
```

#### `POST /v1/organizations/{organizationId}/join-requests`: ask to join
Auth: user · Scope: `organizations:write` · Sensitive: yes · Errors: 404, 409 · Implemented (tests: organizations.test.ts, organizations-realtime.test.ts)

Use this for discoverable organizations whose join policy is `request`. Body: `message` (max 500, optional). Response `201`: `{ "data": { "requestId": "...", "status": "pending" } }`

```sh
curl -X POST "$SPREEWE/v1/organizations/$ORG_ID/join-requests" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"message":"Joining the design team"}'
```

#### `GET /v1/me/join-requests`: my join requests
Auth: user · Scope: `organizations:read` · Sensitive: no · Errors: common · Implemented (tests: organizations.test.ts)

Response `200`: `{ "data": [ { "requestId": "...", "status": "pending", "organization": { ...card } } ] }`

```sh
curl "$SPREEWE/v1/me/join-requests" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/me/join-requests/{requestId}/cancel`: withdraw a pending request
Auth: user · Scope: `organizations:write` · Sensitive: no · Errors: 404 · Implemented, not covered by tests

Response `201`: `{ "data": { "cancelled": true } }`

```sh
curl -X POST "$SPREEWE/v1/me/join-requests/$JR_ID/cancel" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/me/organization-invitations`: invitations to my verified emails
Auth: user · Scope: `organizations:read` · Sensitive: no · Errors: common · Implemented (tests: organizations.test.ts)

Response `200`: `{ "data": [ { ...card, "invitationId": "...", "role": "member", "expiresAt": "..." } ] }`

```sh
curl "$SPREEWE/v1/me/organization-invitations" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/organization-invitations/preview`: preview an invitation
Auth: user · Scope: `organizations:read` · Sensitive: yes · Errors: 404 · Implemented (tests: organizations.test.ts)

Body: at least one of `token` (link token, max 200) or `invitationId` (id). The invitation must be addressed to one of your verified emails. Response `201`: `{ "data": { ...card, "invitationId": "...", "role": "member", "expiresAt": "..." } }`

```sh
curl -X POST "$SPREEWE/v1/organization-invitations/preview" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"token":"inv_..."}'
```

#### `POST /v1/organization-invitations/accept`: accept an invitation (single use)
Auth: user · Scope: `organizations:write` · Sensitive: yes · Errors: 404, 503 · Implemented (tests: contacts.test.ts, organizations.test.ts, organizations-realtime.test.ts, saved-messages-scope.test.ts, teams-channels.test.ts)

The body is the same as for preview. Response `201`: `{ "data": { ...card, "role": "member", "outcome": "added" } }`

```sh
curl -X POST "$SPREEWE/v1/organization-invitations/accept" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"invitationId":"6650..."}'
```

---

## Workspace admin

Status: Implemented. Each route lists its tests.

These routes act on the **active** organization and need **Workspace: yes**. For an app token, that is the workspace the app is bound to. Most use auth `user` with `organizations:read`, `organizations:write` or `organizations:manage`; the user's own role still decides what is allowed. These stay SpreeWe-session only: organization delete and transfer and join-request approve / reject (`firstParty`), and `GET /workspace/apps` and `POST /workspace/apps/{id}/revoke-grants` (`user` without a scope, so app tokens get `403`).

#### `GET /v1/workspace/organization`: active organization overview
Auth: user · Scope: `organizations:read` · Workspace: yes · Sensitive: no · Errors: 404 · Implemented (tests: contacts.test.ts, organizations.test.ts)

The response contains details, your role and permissions, and settings for owners and admins. The route schema declares it only as `object`; see `organization.service overview()` for the exact fields.

```sh
curl "$SPREEWE/v1/workspace/organization" -H "Authorization: Bearer $TOKEN"
```

#### `PATCH /v1/workspace/organization`: update details and settings (owners / admins)
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: yes · Errors: 404, 409 · Implemented (tests: contacts.test.ts, organizations.test.ts, organizations-realtime.test.ts, teams-channels.test.ts)

Body: at least one of `name` (2–80), `description` (max 500), `slug` (3–40, `^[a-z0-9-]+$`), and `settings` { `discoverable`, `joinPolicy`, `allowedEmailDomains` (max 20, each max 190), `membersCanInvite`, `membersCanCreateTeams`, `guestAccess` }. Response `200`: `{ "data": { ... } }` (object, not specified in the schema).

```sh
curl -X PATCH "$SPREEWE/v1/workspace/organization" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"settings":{"joinPolicy":"request","discoverable":true}}'
```

#### `POST /v1/workspace/organization/delete`: delete the organization (owners)
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (tests: organizations.test.ts)

Body: `confirm` (the organization's exact name, max 80). Access ends immediately, and the data is kept. Response `201`: `{ "data": { "deleted": true } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/organization/delete" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme"}'
```

#### `POST /v1/workspace/organization/transfer`: transfer ownership (owners)
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: common · Implemented (tests: organizations.test.ts)

Body: `userId` (id, required). You become an admin. Response `201`: `{ "data": { "owner": "6650..." } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/organization/transfer" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"userId":"6650c1a2b3c4d5e6f7a8b9c0"}'
```

#### `POST /v1/workspace/leave`: leave the active organization
Auth: user · Scope: `organizations:write` · Workspace: yes · Sensitive: no · Errors: 409 (the last owner must transfer ownership first) · Implemented (tests: organizations.test.ts)

Response `201`: `{ "data": { "left": true } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/leave" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/workspace/organization/members`: members (paginated)
Auth: user · Scope: `organizations:read` · Workspace: yes · Sensitive: no · Errors: common · Implemented (tests: teams-channels.test.ts)

Query: `limit` (1–100, default 50), `cursor` (id) and `includeRemoved` (boolean; owners and admins only). Response `200`:

```json
{ "data": [ { "userId": "...", "username": "dana", "avatar": "", "role": "member", "status": "active", "joinedAt": "2026-10-01T09:00:00.000Z", "source": null } ], "page": { "nextCursor": null } }
```

```sh
curl "$SPREEWE/v1/workspace/organization/members?limit=50" -H "Authorization: Bearer $TOKEN"
```

#### `PATCH /v1/workspace/organization/members/{userId}`: change a member's role
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: yes · Errors: 404, 409 · Implemented (tests: organizations.test.ts, organizations-realtime.test.ts, teams-channels.test.ts)

Owners can set any role. Admins can change members to guests and back. You cannot change your own role. Body: `role` (`owner`\|`admin`\|`member`\|`guest`). Response `200`: `{ "data": { "userId": "...", "role": "admin" } }`

```sh
curl -X PATCH "$SPREEWE/v1/workspace/organization/members/$USER_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"role":"admin"}'
```

#### `POST /v1/workspace/organization/members/{userId}/remove`: remove a member
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: yes · Errors: 404, 409 · Implemented (tests: organizations.test.ts, organizations-realtime.test.ts, teams-channels.test.ts)

Access ends on every server instance within `MEMBERSHIP_CHECK_CACHE_MS`. Response `201`: `{ "data": { "removed": true } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/organization/members/$USER_ID/remove" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/invitations`: invite by email
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: yes · Errors: 409 · Implemented (tests: contacts.test.ts, organizations.test.ts, organizations-realtime.test.ts, saved-messages-scope.test.ts, teams-channels.test.ts)

Body: `emails` (string[], max 50, each max 254), `role` (`admin`\|`member`\|`guest`) and `expiresInDays` (1–30, optional). No email provider is configured, so the response returns each single-use link once and `emailed` is `false`. Response `201`:

```json
{ "data": { "results": [ { "email": "dana@acme.example", "status": "invited", "invitationId": "...", "link": "https://.../invite?token=...", "emailed": false } ] } }
```

```sh
curl -X POST "$SPREEWE/v1/workspace/invitations" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"emails":["dana@acme.example"],"role":"member"}'
```

#### `GET /v1/workspace/invitations`: list invitations (paginated)
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: no · Errors: common · Implemented (tests: organizations.test.ts)

Query: `status` (`pending`\|`accepted`\|`revoked`\|`expired`), `limit` (default 50) and `cursor`. Response `200`: `{ "data": [ { "invitationId": "...", "email": "...", "role": "member", "status": "pending", "expiresAt": "...", "sentCount": 1 } ], "page": { "nextCursor": null } }`

```sh
curl "$SPREEWE/v1/workspace/invitations?status=pending" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/invitations/{invitationId}/resend`: new link for a pending invitation
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (tests: organizations.test.ts)

The previous link stops working. Response `201`: `{ "data": { "invitationId": "...", "link": "...", "emailed": false, "expiresAt": "..." } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/invitations/$INV_ID/resend" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/invitations/{invitationId}/revoke`: revoke a pending invitation
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: no · Errors: 404 · Implemented (tests: organizations.test.ts)

Response `201`: `{ "data": { "revoked": true } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/invitations/$INV_ID/revoke" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/workspace/join-requests`: join requests (owners / admins)
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: no · Errors: common · Implemented (tests: organizations.test.ts)

Query: `status` (`pending` (default), `approved`, `rejected` or `cancelled`). This route is not paginated. Response `200`: `{ "data": [ { "requestId": "...", "userId": "...", "username": "dana", "email": "dana@...", "message": "...", "status": "pending" } ] }`

```sh
curl "$SPREEWE/v1/workspace/join-requests" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/join-requests/{requestId}/approve`: approve
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404, 503 · Implemented (tests: organizations.test.ts)

Response `201`: `{ "data": { "requestId": "...", "status": "approved" } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/join-requests/$JR_ID/approve" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/join-requests/{requestId}/reject`: reject
Auth: firstParty · Workspace: yes · Sensitive: yes · Errors: 404, 503 · Implemented (tests: organizations.test.ts)

Response `201`: `{ "data": { "requestId": "...", "status": "rejected" } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/join-requests/$JR_ID/reject" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/join-code`: create or disable the join code
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: yes · Errors: common · Implemented (tests: organizations.test.ts)

Body: `enable` (boolean, required). A new code replaces the old one and is shown only once. Response `201`: `{ "data": { "enabled": true, "code": "K7PQ2XZD", "link": "..." } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/join-code" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"enable":true}'
```

#### `GET /v1/workspace/audit`: organization audit log (owners / admins, paginated)
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: no · Errors: common · Implemented (tests: organizations.test.ts)

Query: `limit` (1–100, default 50) and `cursor`. Response `200`: `{ "data": [ { "id": "...", "action": "member.removed", "actorId": "...", "target": { }, "at": "..." } ], "page": { "nextCursor": null } }`. The `action` value in this example is illustrative.

```sh
curl "$SPREEWE/v1/workspace/audit" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/workspace/members`: workspace members (paginated)
Auth: user · Scope: `organizations:read` · Workspace: yes · Sensitive: no · Errors: common (`403` for guests) · Implemented (tests: p5-security.test.ts, teams-channels.test.ts)

Query: `limit` (default 50) and `cursor`. Removed members are listed only to owners and admins. Response `200`: `{ "data": [ { "userId": "...", "username": "dana", "avatar": "", "role": "member", "status": "active", "lastSeenAt": "..." } ], "page": { "nextCursor": null } }`

```sh
curl "$SPREEWE/v1/workspace/members" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/workspace/apps`: apps bound to this workspace (owners / admins)
Auth: user, no scope (SpreeWe session only: app tokens get `403`) · Workspace: yes · Sensitive: no · Errors: common · Implemented (tests: p5-security.test.ts)

The response lists at most 200 apps. Response `200`: `{ "data": [ { "_id": "...", "name": "Acme CRM", "environment": "production", "status": "active", "scopes": ["profile:read"], "grants": 14 } ] }`

```sh
curl "$SPREEWE/v1/workspace/apps" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/workspace/apps/{appId}/revoke-grants`: withdraw every member's authorization
Auth: user, no scope (SpreeWe session only: app tokens get `403`) · Who: owners and admins · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (tests: p5-security.test.ts)

Body: `confirm` (the app's exact name). Affected members' tokens stop working, and every encryption device the app holds is revoked. Response `201`: `{ "data": { "revoked": 14 } }`

```sh
curl -X POST "$SPREEWE/v1/workspace/apps/$APP_ID/revoke-grants" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"confirm":"Acme CRM"}'
```

---

## Teams & channels

Status: Implemented. The channel member removal and channel delete routes are not covered by tests; each route lists its tests.

These routes are `firstParty` and need **Workspace: yes**. Each declares an `organizations:*` scope, but `firstParty` refuses app tokens before the scope is checked, so app tokens get `403` (`developer-api-access.test.ts` checks this for `GET /v1/teams`). A channel id is a conversation id. Channel messages, files and calls use the conversation endpoints and sockets.

Team: `{ teamId, name, description, avatar, visibility: "public"|"private" }`. Channel: `{ channelId, name, description, type: "standard"|"private"|"shared", external, memberCount, isMember, isFavorite }`.

#### `GET /v1/teams`: teams I can see
Auth: firstParty · Scope: `organizations:read` declared but unreachable (firstParty refuses app tokens before the scope check) · Workspace: yes · Sensitive: no · Errors: common · Implemented (tests: contacts.test.ts, developer-api-access.test.ts, organizations.test.ts, teams-channels.test.ts)

The response includes public teams and teams you belong to. Guests see only their own teams. Response `200`: `{ "data": [ { ...team, "memberCount": 12, "myRole": "member" } ] }`

```sh
curl "$SPREEWE/v1/teams" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/teams`: create a team
Auth: firstParty · Scope: `organizations:write` declared but unreachable (firstParty refuses app tokens before the scope check) · Workspace: yes · Sensitive: yes · Errors: 409 · Implemented (tests: favorites.test.ts, organizations.test.ts, organizations-realtime.test.ts, teams-channels.test.ts)

Owners and admins can create teams. Members can too if the organization allows it. You become the team owner, and a General channel is created. Body: `name` (2–80, required), `description` (max 500) and `visibility` (`public`\|`private`). Response `201`: `{ "data": { "teamId": "...", "name": "Design", "visibility": "public" } }`

```sh
curl -X POST "$SPREEWE/v1/teams" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"Design","visibility":"public"}'
```

#### `GET /v1/teams/{teamId}`: a team
Auth: firstParty · Scope: `organizations:read` declared but unreachable (firstParty refuses app tokens before the scope check) · Workspace: yes · Sensitive: no · Errors: 404 (also for private teams you are not in) · Implemented (tests: teams-channels.test.ts)

Response `200`: `{ "data": { ...team, "myRole": "owner", "canManage": true } }`

```sh
curl "$SPREEWE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $TOKEN"
```

#### `PATCH /v1/teams/{teamId}`: update a team
Auth: firstParty · Scope: `organizations:manage` declared but unreachable (firstParty refuses app tokens before the scope check) · Who: team owners; organization owners and admins · Workspace: yes · Sensitive: yes · Errors: 404, 409 · Implemented (tests: teams-channels.test.ts)

Body: at least one of `name` (2–80), `description` (max 500), `visibility`, and `settings` { `membersCanCreateChannels`, `membersCanAddMembers` }. Response `200`: `{ "data": { ... } }` (object, not specified in the schema).

```sh
curl -X PATCH "$SPREEWE/v1/teams/$TEAM_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"settings":{"membersCanCreateChannels":false}}'
```

#### `POST /v1/teams/{teamId}/archive`: delete (archive) a team and its channels
Auth: firstParty · Scope: `organizations:manage` declared but unreachable (firstParty refuses app tokens before the scope check) · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (tests: teams-channels.test.ts)

History is kept, but nobody can read it. Response `201`: `{ "data": { "archived": true } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/archive" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/teams/{teamId}/join`: join a public team
Auth: firstParty · Scope: `organizations:write` declared but unreachable (firstParty refuses app tokens before the scope check) · Who: organization members, not guests · Workspace: yes · Sensitive: no · Errors: 404 · Implemented (tests: teams-channels.test.ts)

Response `201`: `{ "data": { "joined": true } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/join" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/teams/{teamId}/members`: team members
Auth: firstParty · Scope: `organizations:read` declared but unreachable (firstParty refuses app tokens before the scope check) · Workspace: yes · Sensitive: no · Errors: 404 · Implemented (tests: teams-channels.test.ts)

Response `200`: `{ "data": [ { "userId": "...", "username": "dana", "avatar": "", "role": "manager" } ] }`, where `role` is `owner`, `manager` or `member`.

```sh
curl "$SPREEWE/v1/teams/$TEAM_ID/members" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/teams/{teamId}/members`: add organization members
Auth: firstParty · Scope: `organizations:write` declared but unreachable (firstParty refuses app tokens before the scope check) · Who: team owners / managers · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (tests: organizations-realtime.test.ts, teams-channels.test.ts)

Body: `userIds` (id[], max 200, required) and `role` (`owner`\|`manager`\|`member`, default `member`). Response `201`: `{ "data": { "added": 3 } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/members" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"userIds":["6650c1a2b3c4d5e6f7a8b9c0"]}'
```

#### `PATCH /v1/teams/{teamId}/members/{userId}`: change a team role
Auth: firstParty · Scope: `organizations:manage` declared but unreachable (firstParty refuses app tokens before the scope check) · Who: team owners · Workspace: yes · Sensitive: yes · Errors: 404, 409 · Implemented (tests: teams-channels.test.ts)

Body: `role` (required). Response `200`: `{ "data": { "userId": "...", "role": "manager" } }`

```sh
curl -X PATCH "$SPREEWE/v1/teams/$TEAM_ID/members/$USER_ID" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"role":"manager"}'
```

#### `POST /v1/teams/{teamId}/members/{userId}/remove`: remove a member or leave
Auth: firstParty · Scope: `organizations:manage` declared but unreachable (firstParty refuses app tokens before the scope check) · Workspace: yes · Sensitive: yes · Errors: 404, 409 (the last owner can't leave) · Implemented (tests: organizations-realtime.test.ts, teams-channels.test.ts)

To leave the team, pass your own id. Response `201`: `{ "data": { "removed": true } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/members/$USER_ID/remove" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/teams/{teamId}/channels`: channels of a team
Auth: firstParty · Scope: `organizations:read` declared but unreachable (firstParty refuses app tokens before the scope check) · Workspace: yes · Sensitive: no · Errors: 404 · Implemented (tests: favorites.test.ts, organizations-realtime.test.ts, teams-channels.test.ts)

Private channels are listed only to their members. Response `200`: `{ "data": [ { "channelId": "...", "name": "General", "description": "", "type": "standard", "external": false, "memberCount": 12, "isMember": true, "isFavorite": false } ] }`

```sh
curl "$SPREEWE/v1/teams/$TEAM_ID/channels" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/teams/{teamId}/channels`: create a channel
Auth: firstParty · Scope: `organizations:write` declared but unreachable (firstParty refuses app tokens before the scope check) · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (tests: organizations-realtime.test.ts, teams-channels.test.ts)

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
Auth: firstParty · Scope: `organizations:write` declared but unreachable (firstParty refuses app tokens before the scope check) · Who: channel or team owners · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented (tests: teams-channels.test.ts)

Body: `userIds` (id[], max 200). Response `201`: `{ "data": { "added": 2 } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/channels/$CHANNEL_ID/members" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"userIds":["6650c1a2b3c4d5e6f7a8b9c0"]}'
```

#### `POST /v1/teams/{teamId}/channels/{channelId}/members/{userId}/remove`: remove from a channel, or leave it
Auth: firstParty · Scope: `organizations:manage` declared but unreachable (firstParty refuses app tokens before the scope check) · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented, not covered by tests

Response `201`: `{ "data": { "removed": true } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/channels/$CHANNEL_ID/members/$USER_ID/remove" -H "Authorization: Bearer $TOKEN"
```

#### `POST /v1/teams/{teamId}/channels/{channelId}/delete`: delete (archive) a channel
Auth: firstParty · Scope: `organizations:manage` declared but unreachable (firstParty refuses app tokens before the scope check) · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented, not covered by tests

Response `201`: `{ "data": { "deleted": true } }`

```sh
curl -X POST "$SPREEWE/v1/teams/$TEAM_ID/channels/$CHANNEL_ID/delete" -H "Authorization: Bearer $TOKEN"
```

---

## Contacts

Status: Implemented. Each route lists its tests.

Both routes accept app tokens: lookup with `directory:read`, start with `contacts:write`. These routes look people up by exact email; there is no directory browsing. They use `POST` so the address never appears in URLs or logs. Both work in the personal and organization contexts.

Body for both routes: `email` (string, max 254, required) and `scope` (`member`\|`external`, optional). `scope` applies only in an organization context and defaults to `member`.

#### `POST /v1/contacts/lookup`: find an eligible person by exact email
Auth: user · Scope: `directory:read` · Workspace: no · Sensitive: yes · Errors: 400, 403, 429 · Implemented (tests: contacts.test.ts, developer-api-access.test.ts)

Unregistered, blocked and unavailable people all return `found: false`. Response `201`:

```json
{ "data": { "found": true, "user": { "_id": "...", "username": "dana", "avatar": "" }, "external": false, "conversationId": null } }
```

```sh
curl -X POST "$SPREEWE/v1/contacts/lookup" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"email":"dana@acme.example"}'
```

#### `POST /v1/contacts/start`: open (or reuse) a direct conversation
Auth: user · Scope: `contacts:write` · Workspace: no · Sensitive: yes · Errors: 400, 403, 404, 429 · Implemented (tests: contacts.test.ts)

External conversations open only where the organization allows them. Response `201`: `{ "data": { "conversationId": "...", "external": false } }`

```sh
curl -X POST "$SPREEWE/v1/contacts/start" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"email":"dana@acme.example","scope":"external"}'
```

---

## Me, workspace & directory

Status: Implemented. Each route lists its tests.

#### `GET /v1/me`: the signed-in user and active context
Auth: user · Scope: `profile:read` · Workspace: no · Sensitive: no · Errors: common · Implemented (tests: api-v1.test.ts, developer-oauth.test.ts, developer-platform.test.ts, developer-portal.test.ts, examples.test.ts, p5-security.test.ts)

Response `200`:

```json
{ "data": { "user": { "_id": "...", "username": "dana", "email": "dana@acme.example", "avatar": "", "globalDiscoverable": false },
            "context": { "tenantId": "6650...", "role": "member" } } }
```

```sh
curl "$SPREEWE/v1/me" -H "Authorization: Bearer $APP_TOKEN"
```

#### `GET /v1/workspace`: active workspace summary
Auth: user · Scope: `organizations:read` · Workspace: yes · Sensitive: no · Errors: common · Implemented (tests: api-v1.test.ts, teams-channels.test.ts)

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
Auth: user · Scope: `organizations:manage` · Workspace: yes · Sensitive: yes · Errors: common · Implemented (tests: api-v1.test.ts, contacts.test.ts, teams-channels.test.ts)

Body: at least one of `allowExternalChat`, `allowExternalCalls`, `allowExternalFiles` or `membersCanStartExternal` (all boolean). Response `200`: the same shape as `GET /v1/workspace`.

```sh
curl -X PATCH "$SPREEWE/v1/workspace/policies" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"allowExternalChat":true}'
```

#### `GET /v1/workspaces`: workspaces I have used
Auth: user · Scope: `organizations:read` · Workspace: no · Sensitive: no · Errors: common · Implemented (tests: developer-platform.test.ts)

To switch workspaces, use Clerk. Response `200`: `{ "data": [ { "tenantId": "...", "clerkOrgId": "org_...", "name": "Acme", "slug": "acme", "role": "member", "active": true } ] }`

```sh
curl "$SPREEWE/v1/workspaces" -H "Authorization: Bearer $TOKEN"
```

#### `GET /v1/directory`: people I can start a conversation with (paginated)
Auth: user · Scope: `directory:read` · Workspace: no · Sensitive: no · Errors: common · Implemented (tests: api-v1.test.ts, developer-platform.test.ts, teams-channels.test.ts)

In a workspace context, the directory lists active workspace members. In the global context, it lists users in the global directory. Emails are never included. Query: `q` (name filter, max 100), `limit` (default 20) and `cursor`. Response `200`:

```json
{ "data": [ { "_id": "...", "username": "dana", "avatar": "", "isOnline": true, "status": "available", "statusMessage": "" } ], "page": { "nextCursor": "6650..." } }
```

```sh
curl "$SPREEWE/v1/directory?q=da&limit=20" -H "Authorization: Bearer $APP_TOKEN"
```

---

## Conversations & messages

Status: Implemented. `POST /conversations/external` is not covered by tests; each route lists its tests.

To send messages, use the Socket.IO gateway ([realtime events](../realtime-events.md)); there is no REST send endpoint. Apps send with `messages:write` from their own encryption device only (see [the E2EE section](#developer-app-tokens-and-end-to-end-encryption)).

#### `GET /v1/conversations`: my conversations, newest first (paginated)
Auth: user · Scope: `conversations:read` · Workspace: no · Sensitive: no · Errors: common · Implemented (tests: api-v1.test.ts, developer-oauth.test.ts, developer-platform.test.ts, developer-portal.test.ts, examples.test.ts, organizations.test.ts)

Query: `limit` (default 20) and `cursor`. Response `200`:

```json
{ "data": [ { "_id": "...", "isGroup": true, "name": "Launch", "scope": "tenant", "external": false, "memberCount": 5, "createdAt": "2026-10-20T08:00:00.000Z" } ], "page": { "nextCursor": null } }
```

`scope` is `global`, `tenant` or `external`.

```sh
curl "$SPREEWE/v1/conversations" -H "Authorization: Bearer $APP_TOKEN"
```

#### `GET /v1/conversations/{conversationId}/messages`: messages, newest first (paginated)
Auth: user · Scope: `messages:read` · Workspace: no · Sensitive: no · Errors: 404 (also when you are not a member) · Implemented (tests: api-v1.test.ts, developer-api-e2ee.test.ts, developer-platform.test.ts, teams-channels.test.ts)

Query: `limit` (default 20) and `cursor`. SpreeWe sessions and app tokens with `e2ee:device` receive the encrypted payload (`e2ee`) to decrypt on their device. **App tokens without `e2ee:device` receive encrypted messages with `e2ee` removed, `content: null` and `encrypted: true`.** The response schema does not list `e2ee` or `encrypted`. Response `200` (app token without `e2ee:device`):

```json
{ "data": [ { "_id": "...", "conversationId": "...", "type": "text", "content": null, "encrypted": true,
  "author": { "_id": "...", "username": "dana", "avatar": "" }, "replyToId": null, "editedAt": null, "createdAt": "2026-11-02T09:15:00.000Z" } ],
  "page": { "nextCursor": "6650..." } }
```

```sh
curl "$SPREEWE/v1/conversations/$CONV_ID/messages?limit=50" -H "Authorization: Bearer $APP_TOKEN"
```

#### `POST /v1/conversations/external`: start or reopen an external 1:1 chat
Auth: user · Scope: `conversations:write` · Workspace: yes · Sensitive: yes · Errors: 404 · Implemented, not covered by tests

The workspace policy must enable `allowExternalChat`. You also need the admin role unless `membersCanStartExternal` is on. Body: `userId` (id of the outside person, required). Response `201`: `{ "data": { "conversationId": "...", "scope": "external" } }`

```sh
curl -X POST "$SPREEWE/v1/conversations/external" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"userId":"6650c1a2b3c4d5e6f7a8b9c0"}'
```

---

## Calls

Status: Implemented, not covered by tests. The tests call the legacy `/calls` route, not `/v1/calls`.

#### `GET /v1/calls`: my call history in the active context (paginated)
Auth: user · Scope: `calls:read` · Workspace: no · Sensitive: no · Errors: common · Implemented, not covered by tests

Query: `limit` (default 20), `cursor` (ISO timestamp string from `page.nextCursor`, max 40), and `filter` (`missed`\|`incoming`\|`outgoing`). The route schema does not specify the item fields: items are call-history entries as returned by `call-history.service list()`. Response `200`: `{ "data": [ { ... } ], "page": { "nextCursor": "2026-11-01T18:22:04.512Z" } }`

```sh
curl "$SPREEWE/v1/calls?filter=missed" -H "Authorization: Bearer $APP_TOKEN"
```

---

## Recordings

Status: Implemented. Each route lists its tests.

#### `GET /v1/recordings/{recordingId}`: recording details with short-lived links
Auth: user · Scope: `recordings:read` · Workspace: no · Sensitive: no · Errors: 404 (also when the recording isn't visible in the active context) · Implemented (tests: api-v1.test.ts)

The response contains recording metadata. `playbackUrl` and `downloadUrl` are short-lived signed links, or `null`. The route schema does not specify the other fields. Response `200`: `{ "data": { "_id": "...", "playbackUrl": "https://...", "downloadUrl": "https://...", ... } }`

```sh
curl "$SPREEWE/v1/recordings/$RECORDING_ID" -H "Authorization: Bearer $APP_TOKEN"
```
