# Registering a developer app

> **Developer Portal:** everything on this page can also be done in the SpreeWe web app under **Account menu → Developer portal** (`/developer`): register applications, generate and regenerate secrets, choose permissions, set origins and redirect URLs, configure webhooks, and see usage and activity. The portal calls the same endpoints described here.

All management calls use your **SpreeWe session** (`Authorization: Bearer <Clerk session token>`), not app credentials. The full reference is `docs/api/openapi.yaml`, under the tags "Developer apps", "App consent" and "App tokens".

## 1. Create the app

- **Global app:** call from your personal context (no active organization).
- **Workspace app:** call from inside the workspace, as owner or admin, with `"tenantBound": true`. It can only ever act in that workspace.

```http
POST /api/v1/apps
{ "name": "Acme Support Bot", "environment": "development",
  "scopes": ["profile:read", "conversations:read", "messages:read", "realtime:connect"],
  "allowedOrigins": ["http://localhost:4200"] }
→ 201 { "data": { "_id": "6ad8…", "status": "active", "scopes": [ … ], "quotas": { … } } }
```

- Scopes default to none. Ask only for what you use (see `docs/security/developer-platform-security.md`).
- `allowedOrigins`: browser origins allowed to use your user tokens. Production requires `https`; development may use `http://localhost`.
- `callbackUrls` (shown as "Redirect URLs" in the Developer Portal) are where SpreeWe sends the user back after a consent decision. A consent request's `redirectUri` must match one exactly.

## 2. Create a server credential (shown once)

```http
POST /api/v1/apps/{appId}/credentials
{ "confirm": "Acme Support Bot", "expiresInDays": 90 }
→ 201 { "data": { "credential": { "keyId": "swk_test_…", "hint": "a1B2" }, "secret": "sws_…" } }
```

- Store `keyId` and `secret` on your **server** (a secret manager or environment variables). The secret is never shown again.
- If you sign in through Clerk and your session reports `fva`, you must have signed in within the last 10 minutes.

## 3. Rotate and revoke

```http
POST /api/v1/apps/{appId}/credentials/{credentialId}/rotate   { "confirm": "<app name>" }
→ new secret now; the old secret keeps working for the grace period (default 1 hour)

POST /api/v1/apps/{appId}/credentials/{credentialId}/revoke   { "confirm": "<app name>" }
→ immediate
```

**Recommended rotation:**
1. Rotate.
2. Deploy the new secret to all your servers within the grace period.
3. Optionally revoke the old credential early.

## 4. Users authorise your app (consent)

Each user authorises your app **themselves**, from their signed-in SpreeWe session:
- **Workspace apps:** from inside that workspace.
- **Global apps:** from their personal context.

```http
POST /api/v1/apps/{appId}/grants
{ "scopes": ["messages:read", "realtime:connect"], "externalUserRef": "yourapp-user-42" }
```

- `externalUserRef` is the id **your** system uses for this person. Your server then asks for their token by that reference.
- A reference can be linked to only one SpreeWe account per app.
- Users see their authorised apps at `GET /v1/me/app-grants` and withdraw access with `DELETE /v1/me/app-grants/{grantId}`, which stops their tokens immediately.

> **App-initiated consent (recommended):** your server calls `POST /v1/consent-requests` and sends the user to the returned `consentUrl`. That opens the SpreeWe consent page (`/consent?request=…`), where the user approves or denies and is redirected to your `redirectUri`. See `docs/developer/authentication.md` (section 5).

## 5. Usage, audit, suspension

- `GET /v1/apps/{id}/usage?days=30`: daily API requests, API errors (authenticated requests with status ≥ 400), tokens issued, messages sent, socket connections.
- `GET /v1/apps/{id}/audit`: who did what, without secrets.
- `POST /v1/apps/{id}/suspend` and `/reactivate`: credentials and tokens stop working while suspended.
- `POST /v1/apps/{id}/revoke`: permanent.

## Environments

- **`development`:** `swk_test_` keys, lower quota caps, `http://localhost` origins allowed.
- **`production`:** `swk_live_` keys, `https` origins only.
- A token carries its app's environment; it is rejected if the app's environment differs.
