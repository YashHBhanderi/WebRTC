# App users: your application's own users

An application registered from your personal account gets **its own tenant**: an independent communication workspace. Its users are the ones **you register**, from your server, with your application's credentials. They sign in to *your* product, not to SpreeWe, and they can only find and talk to other users of the same application.

This guide covers registration, authentication, the list / read / update / deactivate APIs, external user IDs, isolation, errors and the integration workflow. Reference: tag **App users** in [`../api/openapi.yaml`](../api/openapi.yaml).

| | |
|---|---|
| Applies to | Applications with `dedicatedTenant: true` (every application registered from the personal context) |
| Does not apply to | Workspace applications (`tenantBound`) and applications created before dedicated tenants. Those link SpreeWe accounts by consent / OAuth ([authentication](./authentication.md)) and answer `403` on every endpoint here |
| Caller | Your **server**, with HTTP Basic credentials. Never a browser or a mobile app |

## 1. How it fits together

```
 your user ──(your login)──▶ YOUR backend ──(client ID + secret)──▶ SpreeWe
                                 │   1. POST /v1/app-users      register the user (once)
                                 │   2. POST /v1/app-tokens     short-lived token for that user
 your frontend ◀── token ────────┘
      └──(Bearer user token)──▶ SpreeWe /v1 REST + Socket.IO   (acts only in your tenant)
```

1. Register the application in the Developer Portal and create a credential (client ID `swk_test_…` / `swk_live_…`, secret `sws_…`, shown once).
2. When someone signs up or first signs in to your product, **register** them (section 3).
3. After your own session check, **exchange** your credentials for a short-lived user token (section 5) and give it to your frontend.
4. The frontend calls the API and opens a socket with that token.
5. When someone leaves your product, **deactivate** them (section 4).

## 2. Authentication

Every endpoint in sections 3 to 5 uses HTTP Basic with the application's credential:

```
Authorization: Basic base64(clientId:clientSecret)
```

- The **tenant comes from the credential**. There is no tenant parameter, and a request that sends one (`tenantId`, `appId`, `role`, …) is rejected with `400`.
- A user token or a SpreeWe session is refused here (`401`).
- Keep the secret in a secret manager or environment variable on your server. Rotate it in the portal; the old secret keeps working for the grace period (one hour by default).
- Requests are limited per credential (120 per minute by default) and count against the application's usage.

The application's **owner** can do the same from the Developer Portal (Users tab), which uses the owner's SpreeWe session and never holds the secret: `GET|POST /v1/apps/{appId}/users`, `GET|PATCH /v1/apps/{appId}/users/{externalUserId}`. Anyone else gets `404`.

## 3. Register a user

```http
POST /api/v1/app-users
Authorization: Basic …
Content-Type: application/json

{ "externalUserId": "yourapp-user-42", "name": "Asha Rao", "email": "asha@example.com", "avatarUrl": "https://cdn.example.com/u/42.png" }
```

```json
201
{ "data": {
    "_id": "6b01c2e4f1a2b3c4d5e6f701",
    "externalUserId": "yourapp-user-42",
    "name": "Asha Rao",
    "email": "asha@example.com",
    "avatarUrl": "https://cdn.example.com/u/42.png",
    "status": "active",
    "tenantId": "6ad9c2e4f1a2b3c4d5e6f700",
    "createdAt": "2026-11-16T09:30:00.000Z",
    "deactivatedAt": null
} }
```

| Field | Rules |
|---|---|
| `externalUserId` | Required. **Your own ID** for this person. 1–200 characters: letters, digits and `. _ : @ \| -`. Unique within your application. It can't be changed later |
| `name` | Required. Display name, 3–30 characters: letters (any language), digits, spaces and `. _ ' -` |
| `email` | Optional. Lets your other users find this person by email. Never used for sign-in, and never linked to a SpreeWe account |
| `avatarUrl` | Optional. An `https` URL of a picture you host (`http://localhost` is allowed for development applications) |

- `_id` is the SpreeWe user ID. Use it wherever the API takes a user ID (starting a conversation, adding group members, inviting to a meeting).
- Registering an existing `externalUserId` answers `409`. To make "register on first sign-in" safe to repeat, treat `409` as "already there" and read the user (the SDK's `users.ensure()` does this).
- Limits: 1,000 registered users for development applications, 100,000 for production applications (active and deactivated together).

### External user IDs

- Use a **stable, opaque** ID from your own system (a database key or UUID). Don't use an email address or anything else that can change, and don't reuse an ID for a different person.
- IDs are scoped to your application: `user-42` in your application and `user-42` in someone else's are two unrelated users.
- The same person in two of your applications is two users. Nothing links them.
- The ID appears in URLs: encode it (`encodeURIComponent`) when it contains `:`, `@` or `|`.

## 4. List, read, update, deactivate

```http
GET /api/v1/app-users?limit=50&status=active&cursor=6b01c2e4f1a2b3c4d5e6f701
```

```json
200
{ "data": [ { "_id": "…", "externalUserId": "yourapp-user-42", "name": "Asha Rao", "status": "active", "…": "…" } ],
  "page": { "nextCursor": "6b01c2e4f1a2b3c4d5e6f7a0" } }
```

- `limit` 1–100 (default 20); `status` is `active` or `deactivated` (omit for both); pass `page.nextCursor` as `cursor` until it is `null`. Oldest first.
- Only your application's users are ever returned.

```http
GET /api/v1/app-users/yourapp-user-42
→ 200 { "data": { … } }          404 if your application has no such user
```

```http
PATCH /api/v1/app-users/yourapp-user-42
{ "name": "Asha R.", "email": "", "avatarUrl": "" }
→ 200 { "data": { … } }
```

- Send only what changes (at least one field). An empty string clears `email` or `avatarUrl`.

```http
DELETE /api/v1/app-users/yourapp-user-42          (same as PATCH { "active": false })
→ 200 { "data": { "deactivated": true } }

PATCH /api/v1/app-users/yourapp-user-42
{ "active": true }                                 → reactivates
```

**Deactivating** a user:

- stops their tokens **immediately** for REST and for new socket connections; an open socket is closed by the server's next revalidation pass;
- refuses new tokens for them (`403`) and removes them from your directory;
- revokes your application's encryption devices for them;
- keeps the record and their past messages (conversations still show their name). There is no hard delete.

Reactivating brings the user back with the same `_id`. Tokens issued before the deactivation stay invalid.

## 5. Tokens for your users

```http
POST /api/v1/app-tokens
Authorization: Basic …
{ "externalUserRef": "yourapp-user-42", "scopes": ["profile:read", "realtime:connect"], "ttlSeconds": 600 }
```

```json
201
{ "data": { "accessToken": "eyJ…", "tokenType": "Bearer", "expiresIn": 600, "expiresAt": "2026-11-16T09:40:00.000Z",
            "scopes": ["profile:read", "realtime:connect"], "tokenId": "…", "tenantId": "6ad9c2e4f1a2b3c4d5e6f700" } }
```

- `externalUserRef` is the `externalUserId` you registered (or send `userId` = the SpreeWe `_id`; exactly one of the two).
- `scopes` is optional (default: all of your application's scopes) and must be within them. There is **no consent screen**: these accounts are yours.
- Tokens last 600 seconds by default (60–900). There is no refresh token: ask for a new one before `expiresAt`.
- `tenantId` is always your application's tenant.
- On sign-out call `POST /v1/app-tokens/revoke { "token": "…" }`.

The frontend then uses the token exactly as described in [Authentication](./authentication.md), the [REST reference](./rest-api/v1-api.md) and [Real-time events](./realtime-events.md): `Authorization: Bearer <accessToken>` for REST and `io(url, { auth: { token } })` for Socket.IO. The page's origin must be in the application's allowed origins.

## 6. Tenant isolation and security

What the server guarantees, for every request and every socket event:

| Your users can | Your users can never |
|---|---|
| List and search the other users of your application | See, search or open the profile of a SpreeWe account or of another application's user (answers look like an unknown ID) |
| Start conversations, groups, calls and meetings with them | Add someone from outside your application to a conversation, group, call or meeting |
| Read their own conversations, messages, files, call history, recordings and notifications | Read, join or receive events from anything in another tenant, even with its ID |

- Isolation is enforced on the server: in authentication (the token is bound to your tenant and re-checked on every request), in authorization (membership of your tenant), and in every database query (conversations, messages, calls, meetings, recordings, notifications and people are filtered by tenant). Nothing depends on what a client shows.
- SpreeWe accounts can't find your users by ID, by email or in search, and can't start a conversation with them. Signing in to SpreeWe with the same email as one of your users creates a separate SpreeWe account; the two are never linked.
- Your tenant is closed: no external conversations, no guests, no joining, not discoverable. Tokens act as an ordinary member and can't change that.
- Another application's credential can't read, change, list or get tokens for your users (`404` / `403`).
- Suspending the application in the portal stops every credential and token; deleting it closes the tenant for good (data is kept, access is refused).
- Your responsibilities: authenticate your own users before asking for a token for them, never expose the secret, and ask for the narrowest scopes each client needs.

## 7. Errors

All errors use the `/v1` envelope:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [ { "path": "name", "message": "must be at least 3 characters" } ] } }
```

| Status | `code` | When | What to do |
|---|---|---|---|
| `400` | `VALIDATION_ERROR` | Bad `externalUserId`, `name`, `email` or `avatarUrl`; unknown field (including any tenant field); empty `PATCH` | Fix the request; `details` names the field |
| `401` | `AUTHENTICATION_ERROR` | Missing, wrong, expired or revoked credential; a user token or session used on these endpoints | Check the client ID and secret |
| `403` | `PERMISSION_ERROR` | The application has no tenant of its own (workspace or legacy application); the application is disabled; token request for an unknown or deactivated user, or for scopes outside the application | Register a new application for own users; enable the application; register or reactivate the user |
| `404` | `NOT_FOUND_ERROR` | No user with that `externalUserId` in **your** application | Register the user first |
| `409` | `CONFLICT_ERROR` | `externalUserId` already registered; user limit reached | Read the existing user instead; contact SpreeWe for a higher limit |
| `429` | `RATE_LIMIT_ERROR` | Too many requests with this credential | Wait for `Retry-After`, then retry |
| `503` | `SERVER_ERROR` | The server is not ready for application tenants yet (deployment in progress) | Retry later |

The same answer is given for "no such user" and "user of another application", so IDs can't be probed.

## 8. With the SDK (`@spreewe/core/server`)

```ts
import { createServerClient } from "@spreewe/core/server";

const spreewe = createServerClient({ baseUrl: process.env.SPREEWE_API!, keyId: process.env.SPREEWE_CLIENT_ID!, secret: process.env.SPREEWE_CLIENT_SECRET! });

// sign-up, or every sign-in (idempotent)
await spreewe.users.ensure({ externalUserId: `user-${me.id}`, name: me.displayName, email: me.email });

// your token endpoint, after YOUR session check
app.post("/spreewe/token", requireLogin, async (req, res) => {
  const { accessToken, expiresAt } = await spreewe.userToken(`user-${req.user.id}`);
  res.json({ accessToken, expiresAt });
});

// offboarding
await spreewe.users.deactivate(`user-${me.id}`);
```

`users.register / ensure / get / list / all / update / deactivate / reactivate`, `userToken`, `revokeToken`; errors are `SpreeWeError` with `status` and `code`. The server client is a separate entry point and refuses to start in a browser. In the frontend use `createClient({ baseUrl, auth: backendTokenProvider({ fetchToken }) })`.

## 9. Checklist

- [ ] Application registered from the personal account (`dedicatedTenant: true`), credential stored on the server only.
- [ ] Allowed origins set for every frontend that uses user tokens.
- [ ] Users registered with stable, opaque external IDs; `409` handled.
- [ ] Tokens requested only after your own authentication, with the scopes the client needs.
- [ ] Deactivation wired to your offboarding; token revoked on sign-out.
- [ ] `401` from the API handled by fetching a new token; `429` handled with `Retry-After`.
