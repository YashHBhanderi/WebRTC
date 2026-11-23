# OAuth 2.0 reference

SpreeWe supports the OAuth 2.0 authorization code flow ([RFC 6749](https://www.rfc-editor.org/rfc/rfc6749)) with PKCE ([RFC 7636](https://www.rfc-editor.org/rfc/rfc7636), `S256` only), rotating refresh tokens, and token revocation ([RFC 7009](https://www.rfc-editor.org/rfc/rfc7009)). Use it for apps without a backend (mobile, single-page) or for backends that prefer a standard flow over `POST /v1/consent-requests` + `POST /v1/app-tokens`.

Source: `webrtc-BE/src/api/oauth.routes.ts` and `webrtc-BE/src/developer/oauth.service.ts`. The consent decision is `decideConsentRequest` in `webrtc-BE/src/developer/app.service.ts`. If this page and the code disagree, the code is correct.

Related: [Authentication](../authentication.md) · [REST API v1](./v1-api.md) · [Session API](./session-api.md) · [Realtime events](../realtime-events.md)

## Contents

- [Overview](#overview)
- [Before you start](#before-you-start)
- [The flow](#the-flow)
- [Generating a PKCE pair](#generating-a-pkce-pair)
- [`GET /oauth/authorize`](#get-oauthauthorize)
- [The consent decision](#the-consent-decision)
- [`POST /oauth/token`](#post-oauthtoken)
- [`POST /oauth/revoke`](#post-oauthrevoke)
- [Errors](#errors)
- [Security notes](#security-notes)
- [Configuration](#configuration)
- [Tests](#tests)

---

## Overview

| Endpoint | Purpose |
|---|---|
| `GET /oauth/authorize` | Browser navigation. Validates the request and redirects to the SpreeWe consent page. |
| `POST /oauth/token` | Exchanges an authorization code (`grant_type=authorization_code`) or a refresh token (`grant_type=refresh_token`) for an access token and a new refresh token. |
| `POST /oauth/revoke` | Revokes a refresh token and every token in its family. |

- **Base path.** The endpoints are served at both `/oauth/...` and `/api/oauth/...` (the server mounts the same router with and without `/api`). They are not under `/v1`, do not use the `/v1` `{ data }` / `{ error: {...} }` envelope, and are not in `docs/api/openapi.yaml`.
- **Client identification.** `client_id` is the app's id (the `_id` from `POST /v1/apps`). The endpoints are public: there is no client secret requirement. PKCE binds the code to the client instance that started the flow. An app with a backend may also send its server credential as HTTP Basic; if it does, the credential must belong to `client_id`.
- **Access tokens** are the same short-lived developer-app user tokens as `POST /v1/app-tokens` issues. They carry the approved scopes and are re-checked against the app, the grant and the user's membership on every request. See the [scope catalogue](./v1-api.md#scope-catalogue).
- **Bodies** of `POST /oauth/token` and `POST /oauth/revoke` can be JSON or `application/x-www-form-urlencoded`.

## Before you start

1. Register the app (`POST /v1/apps`) with the scopes it may request and at least one entry in `callbackUrls`. Those are the allowed `redirect_uri` values; matching is exact (no prefix or wildcard matching). Callback URLs must use `https`; `http://localhost` is allowed only for development apps.
2. For a browser app, add its origin to `allowedOrigins`. App tokens sent with an `Origin` header are checked against this list.
3. A workspace-bound app can be approved only by an active member of that workspace, from inside that workspace. A global app is approved from the user's personal context.

## The flow

1. The app creates a PKCE pair and a random `state`, and keeps both.
2. The app sends the browser to `GET /oauth/authorize?response_type=code&client_id=...&redirect_uri=...&scope=...&state=...&code_challenge=...&code_challenge_method=S256`.
3. SpreeWe validates the request, creates a consent request that carries the PKCE challenge, and redirects (`302`) to the SpreeWe consent page: `<APP_PUBLIC_URL>/consent?request=<requestId>`. The consent request expires after 10 minutes.
4. The signed-in user reviews the app and each requested scope, and approves a subset of them or denies. The consent page does this through `POST /v1/consent-requests/{requestId}/approve` or `/deny` ([v1-api.md](./v1-api.md#consent--grants)).
5. The browser is sent to `redirect_uri` with `state` and either `code` (approved) or `error=access_denied` (denied).
6. The app checks that `state` matches the value it stored, then calls `POST /oauth/token` with `grant_type=authorization_code`, the `code`, the same `redirect_uri`, and the `code_verifier`.
7. The response contains `access_token` (short-lived) and `refresh_token`. The app calls the API with `Authorization: Bearer <access_token>`.
8. Before the access token expires, the app calls `POST /oauth/token` with `grant_type=refresh_token`. Each refresh returns a new refresh token; the old one stops working.
9. On sign-out, the app calls `POST /oauth/revoke` with the refresh token.

## Generating a PKCE pair

The verifier is 43–128 characters from `[A-Za-z0-9._~-]`. The challenge is the base64url-encoded (no padding) SHA-256 of the verifier, 43–128 characters from `[A-Za-z0-9_-]`. Only `S256` is accepted; `plain` is refused.

```sh
# 32 random bytes -> 43-character base64url verifier
CODE_VERIFIER=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 | tr '+/' '-_' | tr -d '=\n')
STATE=$(openssl rand -hex 16)
echo "$CODE_VERIFIER $CODE_CHALLENGE $STATE"
```

Node.js equivalent (the server tests use this):

```js
const crypto = require("crypto");
const verifier = crypto.randomBytes(48).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
```

---

## `GET /oauth/authorize`

Browser navigation, not an API call. Rate limited (see [Security notes](#security-notes)).

| Query parameter | Required | Rules |
|---|---|---|
| `response_type` | yes | Must be `code` |
| `client_id` | yes | The app id (24-character hex). The app must exist and be `active`. |
| `redirect_uri` | yes | Must be a valid URL that, after URL normalization, exactly matches one of the app's `callbackUrls` |
| `scope` | yes | Space-separated scopes. At least one; each must be a known scope that the app is configured with. |
| `state` | yes | 8–200 visible ASCII characters (`!` to `~`). Returned unchanged on the redirect. SpreeWe requires it, although RFC 6749 only recommends it. |
| `code_challenge` | yes | 43–128 characters, `[A-Za-z0-9_-]` |
| `code_challenge_method` | yes | Must be `S256` |

HTTP Basic client credentials are not checked on this endpoint.

**Responses**

| Case | Response |
|---|---|
| Valid request | `302` to `<APP_PUBLIC_URL>/consent?request=<requestId>` |
| Unknown, malformed or inactive `client_id` | `401` JSON `{ "error": "invalid_client", "error_description": "..." }`. No redirect. |
| `redirect_uri` missing, invalid or not registered | `400` JSON `{ "error": "invalid_request", "error_description": "..." }`. No redirect: SpreeWe never redirects to an unverified URI. |
| `response_type` is not `code` | `302` to `redirect_uri?error=unsupported_response_type&error_description=...&state=...` |
| PKCE missing, not `S256`, or malformed challenge | `302` to `redirect_uri?error=invalid_request&...` |
| `state` missing or outside 8–200 visible characters | `302` to `redirect_uri?error=invalid_request&...` (`state` is echoed only if one was sent) |
| No scopes, an unknown scope, or a scope the app isn't configured with | `302` to `redirect_uri?error=invalid_scope&...` |
| Too many requests | `429` JSON `{ "error": "slow_down", ... }` |

```sh
# Open this URL in the user's browser (shown with curl to see the redirect)
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' -G "$SPREEWE/oauth/authorize" \
  --data-urlencode "response_type=code" \
  --data-urlencode "client_id=$APP_ID" \
  --data-urlencode "redirect_uri=https://app.example.com/oauth/callback" \
  --data-urlencode "scope=profile:read conversations:read" \
  --data-urlencode "state=$STATE" \
  --data-urlencode "code_challenge=$CODE_CHALLENGE" \
  --data-urlencode "code_challenge_method=S256"
# 302 https://spreewe.example/consent?request=Qm9v...
```

## The consent decision

The consent page shows what `GET /v1/consent-requests/{requestId}` returns. Nothing is pre-selected. Approval (`POST /v1/consent-requests/{requestId}/approve`, `firstParty`):

- must be made in the app's context (the app's workspace for a workspace app, the personal context for a global app), otherwise `403`;
- approves a non-empty subset of the requested scopes;
- is one-time and atomic: a request can be decided once;
- creates or updates the user's grant for the app with exactly the approved scopes. If `e2ee:device` is not among them, the app's encryption devices for this user are revoked (see [the E2EE section](./v1-api.md#developer-app-tokens-and-end-to-end-encryption)).

What the redirect carries depends on how the consent request was created:

| Created by | Approved | Denied |
|---|---|---|
| `GET /oauth/authorize` (has a PKCE challenge) | `redirect_uri?state=...&code=swc_...` | `redirect_uri?state=...&error=access_denied` |
| `POST /v1/consent-requests` (server flow) | `redirect_uri?state=...&result=approved&grant=<grantId>` | `redirect_uri?state=...&error=access_denied` |

The OAuth code starts with `swc_`. It is valid for **2 minutes**, can be used **once**, and is bound to the app (`client_id`), the `redirect_uri` and the `code_challenge` of the authorization request.

---

## `POST /oauth/token`

Rate limited. Responses carry `Cache-Control: no-store` and `Pragma: no-cache`. Body: JSON or form-encoded. Optional `Authorization: Basic base64(keyId:secret)` with one of the app's server credentials; when present it must be valid and belong to `client_id`, otherwise `401 invalid_client`.

### `grant_type=authorization_code`

| Field | Required | Rules |
|---|---|---|
| `grant_type` | yes | `authorization_code` |
| `client_id` | yes | The app id; the app must be `active` |
| `code` | yes | The `code` from the redirect |
| `redirect_uri` | yes | Must equal the redirect URI stored with the code. The server stores the normalized form (`new URL(...).toString()`), so send the URI exactly as registered in `callbackUrls`. |
| `code_verifier` | yes | 43–128 characters, `[A-Za-z0-9._~-]`; its S256 hash must equal the `code_challenge` |

The code is claimed before `redirect_uri` and `code_verifier` are compared. A failed exchange with a valid, unexpired code for this client therefore **consumes the code**; restart the flow. A different `client_id` can't consume another app's code.

```sh
curl -X POST "$SPREEWE/oauth/token" -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "client_id=$APP_ID" \
  --data-urlencode "code=$CODE" \
  --data-urlencode "redirect_uri=https://app.example.com/oauth/callback" \
  --data-urlencode "code_verifier=$CODE_VERIFIER"
```

### `grant_type=refresh_token`

| Field | Required | Rules |
|---|---|---|
| `grant_type` | yes | `refresh_token` |
| `client_id` | yes | The app the refresh token was issued to |
| `refresh_token` | yes | The most recent refresh token (`swr_...`) |
| `scope` | no | Space-separated. Can only narrow the token's scopes; any scope outside them returns `invalid_scope`. Omitted: the same scopes as the presented token. |

Each refresh token works **once**. The response contains a new refresh token in the same family; its lifetime starts again (sliding expiry, `OAUTH_REFRESH_TTL_DAYS`). If a refresh token that was already used or revoked is presented again, the server assumes it was stolen and **revokes the whole family**, including the newest token held by the legitimate client. The user must then go through authorization again.

Every token request (code or refresh) re-checks the user's grant, the requested scopes, the user's account and, for a workspace app, the user's membership. If that check fails (grant withdrawn or narrowed, user removed from the workspace, scopes removed from the app), the family is revoked and the response is `400 invalid_grant` with the reason in `error_description`.

```sh
curl -X POST "$SPREEWE/oauth/token" -H "Content-Type: application/json" \
  -d "{\"grant_type\":\"refresh_token\",\"client_id\":\"$APP_ID\",\"refresh_token\":\"$REFRESH_TOKEN\"}"
```

With the app's server credential (optional):

```sh
curl -X POST "$SPREEWE/oauth/token" -u "$KEY_ID:$SECRET" -H "Content-Type: application/json" \
  -d "{\"grant_type\":\"refresh_token\",\"client_id\":\"$APP_ID\",\"refresh_token\":\"$REFRESH_TOKEN\"}"
```

### Success response

`200`:

```json
{ "access_token": "eyJ...", "token_type": "Bearer", "expires_in": 600,
  "refresh_token": "swr_...", "scope": "profile:read conversations:read" }
```

| Field | Meaning |
|---|---|
| `access_token` | Developer-app user token. Send as `Authorization: Bearer`. |
| `token_type` | Always `Bearer` |
| `expires_in` | Seconds until the access token expires. Default 600, capped by `APP_TOKEN_MAX_TTL_SECONDS` (default 900). The client can't choose the lifetime on this endpoint. |
| `refresh_token` | New refresh token; replaces the one you sent |
| `scope` | Space-separated scopes of this access token |

No ID token or other fields are returned.

```sh
curl "$SPREEWE/v1/me" -H "Authorization: Bearer $ACCESS_TOKEN"
```

---

## `POST /oauth/revoke`

Rate limited. Responses carry `Cache-Control: no-store`. Body: JSON or form-encoded. Optional HTTP Basic client credentials, with the same rule as `/oauth/token`.

| Field | Required | Rules |
|---|---|---|
| `client_id` | yes | The app id |
| `token` | yes | A refresh token issued to this app |

Revoking a refresh token revokes its whole family. Unknown tokens, and tokens of another app, are not an error (RFC 7009). The response is `200` with body `{}`.

This endpoint handles refresh tokens only. An access token already issued stays valid until it expires (at most `APP_TOKEN_MAX_TTL_SECONDS`). To end access tokens early, the app's server can call `POST /v1/app-tokens/revoke` for one token, or the owner can call `POST /v1/apps/{appId}/tokens/revoke-all` for all of them ([v1-api.md](./v1-api.md#app-tokens)). `token_type_hint` is not read.

```sh
curl -X POST "$SPREEWE/oauth/revoke" -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode "client_id=$APP_ID" --data-urlencode "token=$REFRESH_TOKEN"
```

### Other ways refresh tokens end

| Event | Refresh tokens revoked |
|---|---|
| The user withdraws the grant (`DELETE /v1/me/app-grants/{grantId}`) | That user's tokens for the app |
| The owner revokes the app (`POST /v1/apps/{appId}/revoke`) | All of the app's tokens |
| The owner calls `POST /v1/apps/{appId}/tokens/revoke-all` | All of the app's tokens |
| Reuse of an already-used refresh token | That family |
| A token request whose grant check fails | That family |
| Expiry (`OAUTH_REFRESH_TTL_DAYS` after the last refresh) | That token |

---

## Errors

Errors use the RFC 6749 format, not the `/v1` envelope:

```json
{ "error": "invalid_grant", "error_description": "The code is invalid, expired or already used" }
```

| `error` | HTTP status | When |
|---|---|---|
| `invalid_client` | 401 | `client_id` missing, malformed, unknown or not `active`; Basic credentials invalid or belonging to another app |
| `invalid_request` | 400 | Missing or malformed parameters (`code`, `code_verifier`, `refresh_token`, `token`, `redirect_uri` on authorize) |
| `invalid_grant` | 400 | Code invalid, expired, already used, issued to another client, or `redirect_uri` / `code_verifier` mismatch; refresh token invalid, expired, used or revoked; the user's authorization is no longer valid |
| `invalid_scope` | 400 (token) / redirect (authorize) | Refresh asks for scopes outside the token's; authorize asks for scopes the app isn't configured with |
| `unsupported_grant_type` | 400 | `grant_type` other than `authorization_code` or `refresh_token` |
| `unsupported_response_type` | redirect | `response_type` other than `code` |
| `access_denied` | redirect | The user denied the request |
| `slow_down` | 429 | Rate limit exceeded. This code is not one of the RFC 6749 token endpoint codes; handle it as "retry later". |
| `server_error` | 500 | Unexpected failure; details are logged on the server only |

The `401 invalid_client` response does not include a `WWW-Authenticate` header.

---

## Security notes

- **PKCE is mandatory** for every client, with or without a backend. Generate a new verifier for every authorization request and never send the verifier to the browser URL.
- **Check `state`** on the redirect before exchanging the code. SpreeWe echoes it but does not verify it for you.
- **Exact redirect matching.** Register each redirect URI in full. Problems with `client_id` or `redirect_uri` are never redirected.
- **Codes** are short-lived (2 minutes), single-use and bound to client, redirect URI and challenge. Codes and refresh tokens are stored only as SHA-256 hashes.
- **Refresh token storage.** Store refresh tokens in the platform's secure storage (Keychain, Keystore). In a browser, prefer keeping them out of JavaScript-readable storage where your architecture allows it. Reuse detection revokes the family, so a stolen token used by an attacker also locks out the legitimate client.
- **Scopes.** Request only what the app needs. The user can approve a subset; read `scope` in the token response rather than assuming the requested set. `e2ee:device` lets the app's encryption device read the user's messages; see [the E2EE section](./v1-api.md#developer-app-tokens-and-end-to-end-encryption).
- **Rate limits.** All three endpoints share the per-IP sensitive limiter: `RATE_LIMIT_SENSITIVE_MAX` requests (default 60) per `RATE_LIMIT_WINDOW_MS` (default 60 s). The global per-IP limit applies as well. API calls made with the access token count against the app's own per-app limit.
- **Caching.** Token and revoke responses are sent with `Cache-Control: no-store`. The authorize redirect does not set it.
- **Origins.** App tokens used from a browser are accepted only from origins in the app's `allowedOrigins`.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `OAUTH_REFRESH_TTL_DAYS` | 30 | Refresh-token lifetime in days, sliding on each refresh. Values outside 1–365 fall back to 30. |
| `APP_TOKEN_DEFAULT_TTL_SECONDS` | 600 | Access-token lifetime (capped by the maximum) |
| `APP_TOKEN_MAX_TTL_SECONDS` | 900 | Maximum access-token lifetime (clamped to 60–3600) |
| `APP_PUBLIC_URL` | none | Base URL of the SpreeWe web app; the consent page is `<APP_PUBLIC_URL>/consent?request=<id>` |
| `RATE_LIMIT_SENSITIVE_MAX`, `RATE_LIMIT_WINDOW_MS` | 60, 60000 | Rate limit for the three endpoints |

A server operator (DevOps) sets these.

## Tests

`webrtc-BE/test/developer-oauth.test.ts` covers:

- the full flow: authorize, consent approval, code exchange (`Cache-Control: no-store`, `token_type`, `scope`, `swr_` refresh token), an API call limited to the approved scope, and refresh rotation;
- rejection of a wrong `code_verifier` (which consumes the code), a reused code, a different `redirect_uri`, and another client's code (without consuming it);
- refresh-token reuse revoking the whole family;
- refresh stopping after grant withdrawal, `POST /oauth/revoke` (and `200` for an unknown token), and `revoke-all`;
- authorize validation: unknown client (`401`, no redirect), unregistered redirect (`400`, no redirect), `plain` method or missing challenge (`invalid_request`), a scope the app lacks (`invalid_scope`), `response_type=token` (`unsupported_response_type`), and denial returning `access_denied`;
- HTTP Basic credentials that must belong to `client_id`, `unsupported_grant_type`, and form-encoded bodies.

Not covered by tests: the `slow_down` rate-limit response, the `scope` parameter on refresh, refresh-token expiry, and an approval without `e2ee:device` revoking the app's devices. `developer-api-e2ee.test.ts` tests device revocation on grant withdrawal, scope removal and app deletion, but not on a re-grant without `e2ee:device` by any path.
