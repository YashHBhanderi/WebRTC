# SpreeWe Developer API: Postman collection

| File | What it is |
|---|---|
| `SpreeWe-Developer-API.postman_collection.json` | Every REST endpoint of the backend (156 routes), plus runnable end-to-end workflows (Postman Collection v2.1) |
| `SpreeWe-Developer-Environment.postman_environment.json` | All variables: base URL, app and credential, tokens, PKCE, and resource IDs |

The collection was generated from the backend code, not from the docs:

- the `/v1` route registry (`webrtc-BE/src/api/v1`, 102 routes);
- the OAuth router (`src/api/oauth.routes.ts`);
- the session routes that accept developer-app tokens (`src/routes/*.ts`);
- `src/app.ts`.

Each request's description names its source file, the scope it needs, its auth mode, the request and response shapes, and the variables it saves.

## 1. Import

1. In Postman, go to **Import** and select both JSON files.
2. In the environment selector (top right), choose **SpreeWe Developer (local)**.
3. Optional: in **Settings → General**, turn off **Send no-cache header**. This isn't required.

Command line (Newman):

```bash
npx newman run SpreeWe-Developer-API.postman_collection.json \
  -e SpreeWe-Developer-Environment.postman_environment.json \
  --folder "W1 App registration & server-to-server auth" --delay-request 500
```

## 2. Configure

Set these variables before running anything:

| Variable | Value |
|---|---|
| `base_url` | API base, e.g. `http://localhost:8080/api` (the server also answers without `/api`) |
| `clerk_session_token` | Your **test user's** SpreeWe session token. How to get it: sign in to the web app, open DevTools → Network, select any `/api/...` request, and copy the value after `Bearer ` in its `Authorization` header. These tokens are short-lived (Clerk's default is 60 s; check your Clerk instance). If a request is skipped with "expired", paste a fresh one. |
| `peer_user_id` / `peer_email` | A second test account. Needed for 1:1 chats, groups, meetings and E2EE. The directory requests fill `peer_user_id` automatically if it's empty. |
| `app_tenant_bound` | `false` = global app: create and approve it with **no** active organization in the session. `true` = workspace app: needed for the Workspace / Organization folders with app tokens. Create and approve it with the organization active. |
| `webhook_url` | Optional. A public **https** endpoint you control (private and localhost addresses are refused). |
| `allow_destructive` | Leave `false` unless you want to run deletes and revocations. |

### The three credential types

| Variable | Meaning |
|---|---|
| `app_id` = `oauth_client_id` | The app's id. This is the OAuth `client_id`. |
| `client_key_id` + `client_secret` | The server credential (`swk_test_…` / `sws_…`), sent as HTTP Basic. The portal calls the key id "Client ID", but it is **not** the OAuth `client_id`. |
| `access_token` | The developer-app user token used by almost every request. Renewed automatically (see below). |

Token, secret and PKCE variables are marked as Postman **secret** variables and are empty in the export. Don't commit an environment after a run: it will contain live secrets.

## 3. Execution order

Run the folders under **E2E Workflows** with the Collection Runner, in this order. Add a delay of 300–500 ms between requests: development apps are capped at 120 requests/min, and the sensitive endpoints at 60/min per IP.

| # | Workflow | Needs |
|---|---|---|
| W1 | App registration & server-to-server auth: register app → credential → consent request → user approves → token exchange | `clerk_session_token` |
| W2 | OAuth 2.0 + PKCE: authorize → consent → code exchange → one-time-code check → refresh rotation | W1 (app) |
| W3 | User & profile access | a token from W1 or W2 |
| W4 | One-to-one conversation & messages (history, state, save) | `peer_user_id` |
| W5 | Group lifecycle & member management | `peer_user_id` (deleting the group needs `allow_destructive`) |
| W6 | Files: encrypted upload, list, signed-link download | a file you choose (see §5) |
| W7 | Calls, meetings & recordings | recordings only exist after a recorded call |
| W8 | Notifications & realtime prerequisites | — |
| W9 | E2EE device registration & encrypted messaging | the `e2ee:device` scope, plus output from an Olm client |

The numbered reference folders (`00`–`99`) contain every endpoint once. Use them for single calls. Afterwards, run **99 Teardown** with `allow_destructive = true` to remove what the run created.

### Automation built into the collection

- **IDs and tokens are captured** from responses into the environment. Each request's description lists what it saves.
- **Auth is set per request:**
  - app endpoints use `{{access_token}}`;
  - first-party endpoints (Developer Portal, consent decisions, teams, org admin) use `{{clerk_session_token}}`;
  - credential endpoints use HTTP Basic.
- **Tokens renew themselves.** Before a request that uses `{{access_token}}`, the collection pre-request script checks whether the token is missing or expiring:
  - OAuth tokens: it calls `POST /oauth/token` with the refresh token;
  - server tokens: it calls `POST /v1/app-tokens` with the credential.

  Set `auto_refresh = false` to turn this off.
- **Missing prerequisites skip the request** with a console message instead of sending incomplete data. Examples: no consent yet, no peer user, no Olm output, no active workspace, or a destructive request with the flag off. A skipped request means "not tested", not "passed".

## 4. Testing the OAuth consent step

Approving consent is the **user's** decision. The collection approves with your test user's own session (`POST /v1/consent-requests/:id/approve`), which is exactly what the SpreeWe consent page does. In production, an app never holds a user's session: it sends the user's browser to `consent_url`.

To test the real page instead:

1. Open `{{consent_url}}` in the browser and approve.
2. Copy `code` (OAuth) or `grant` (server flow) from the redirect URL into `oauth_code` / `grant_id`.
3. Continue from the token-exchange step.

The `redirect_uri` (`http://localhost:8787/oauth/callback`) never needs to be reachable: the collection reads the code from the API response.

## 5. What needs manual setup or external services

Nothing below is faked. Each item either needs real input, or is skipped or fails honestly.

| Area | Requirement |
|---|---|
| Sending, editing and reacting to messages; typing; read receipts; call signaling and media; group admin events | **Socket.IO only**, no REST endpoint. Connect to `{{socket_url}}` (path `/socket.io`) with `auth: { token }`. **26 Realtime prerequisites** checks the token's scopes and logs which events each scope allows. `sendMessage` must carry a Megolm `e2ee` payload; plaintext is rejected. |
| E2EE key upload, Olm device messages | Paste the bodies your Olm/Megolm client generates (e.g. matrix-sdk-crypto `OlmMachine`) into `e2ee_keys_upload_body` / `e2ee_send_to_device_body`. Don't upload hand-made keys: a device's identity key can never change. |
| Encrypted attachment upload | Choose a file that is **already encrypted** by your client. The server can't tell plaintext from ciphertext, so uploading plaintext here breaks the end-to-end guarantee. |
| Group photo upload | Choose an image file. |
| Webhook verify | Your endpoint must verify the signature and echo the challenge (docs/integrations/outbound-webhooks.md). |
| Create organization | Creates a real **Clerk** organization (external service). |
| Recordings, transcripts | Need a recorded call, S3 storage, the composer and a transcription provider configured on the server. |
| Join requests, accepting invitations, meeting join as a guest | Run them as a **second** user (swap `clerk_session_token` or the token). |
| Platform admin listing | Only for platform admins: set `is_platform_admin = true`. |
| Account deletion | Session only, guarded by `allow_destructive` **and** `confirm_delete_account = DELETE MY ACCOUNT`. |
| Admin actions with app tokens | App tokens always act with the workspace `member` role. That's why owner/admin requests use the admin's session. |

## 6. Known issues found while generating

- **Backend bug:** `GET /v1/workspace/organization/members?includeRemoved=…` always returns 400 `VALIDATION_ERROR`. The parameter is declared with `S.bool`, which (unlike `S.int`) doesn't coerce query strings. The parameter is disabled in the collection until the schema is fixed.
- Postman's random source is used for the PKCE verifier and state. That's fine for testing; production clients must use a CSPRNG.

## 7. How it was validated

- **Structure:** Postman v2.1 shape, every path variable has a value, auth and body modes are valid, every one of the 461 scripts compiles, every `{{variable}}` exists in the environment, and secrets are empty.
- **Coverage, both ways:** all 156 backend routes have a request, and every request matches a real route.
- **Payloads:** every `/v1` sample body and query was run through the backend's **own** validator (`src/api/v1/schema.ts`, compiled). They are all accepted, except the mass-assignment negative test, which is correctly rejected.
- **Runtime:** Newman 6.2.1 ran the whole collection against local stub servers. With an empty environment, everything without its prerequisites was skipped. With filled variables, all 257 requests were sent, 0 pre-request/test scripts failed, and automatic renewal worked for both OAuth and server tokens.
- **Not yet done:** a full run against a live backend with real Clerk accounts. Run W1–W9 against staging before relying on the assertions.
