# SpreeWe developer documentation

SpreeWe is a communication backend: messaging, groups, organizations, calls, recordings, notifications and realtime events. Third-party applications integrate it through a REST API, Socket.IO and OAuth 2.0. There is no SDK: you call the API directly.

**Start here: [Integration guide](./integration-guide.md)**, step by step from registering an app to going to production.

## Developer Portal

Sign in to the SpreeWe web app and open **Account menu → Developer portal** (`/developer`):

- register an application (name, description, website, environment, global or workspace-bound);
- create, rotate and revoke server credentials (client ID `swk_test_…` / `swk_live_…`, secret `sws_…`, each secret shown once);
- choose permissions (scopes);
- set allowed origins, redirect URLs and limits (quotas);
- add webhook endpoints, verify them and see their deliveries;
- see usage (requests, errors, tokens, messages, sockets) and activity.

End users approve applications on the SpreeWe consent page (`/consent?request=…`). A short summary of the steps is at `/developer/docs` in the web app. Everything the portal does is also available through the `/v1` API.

## Documents

| Topic | Page |
|---|---|
| Step-by-step integration: auth flows, API, realtime, encrypted messaging, files, calls, webhooks, production | [Integration guide](./integration-guide.md) |
| Authentication: developer applications, credentials, consent, scoped user tokens, scopes, CORS and origins, E2EE devices | [Authentication and security](./authentication.md) |
| OAuth 2.0: authorization code with PKCE, token endpoint, refresh-token rotation, revocation | [OAuth 2.0](./rest-api/oauth.md) |
| Personal and organization (workspace) context, membership, roles, isolation, organization scopes | [Organizations and workspaces](./organizations.md) |
| Every `/v1` endpoint: developer apps, consent, app tokens, webhooks, E2EE keys, conversations, organizations, teams, workspace | [REST API v1](./rest-api/v1-api.md) |
| Session routes (also reachable with app tokens, one scope per route): users, conversations, groups, messages, uploads, calls, meetings, recordings, notifications | [REST API: session endpoints](./rest-api/session-api.md) |
| Socket.IO: connecting, every client→server and server→client event, payloads, delivery rules, app sockets | [Real-time events](./realtime-events.md) |
| Outbound webhooks: events, envelope, signatures, retries | [Outbound webhooks](../integrations/outbound-webhooks.md) |
| Machine-readable spec of `/v1`, generated from the route definitions and kept in sync by a test | [`../api/openapi.yaml`](../api/openapi.yaml) and [`../api/v1.md`](../api/v1.md) |
| Server-to-server example (credentials stay on your server) | [`../integrations/examples`](../integrations/examples) |

## Key facts

- **Two kinds of tokens.**
  - **End-user session tokens** (Clerk): used by SpreeWe's own clients; full access as that user.
  - **Developer-application user tokens:** short-lived and scoped, for one user who authorised your app. Get them by server token exchange (`POST /v1/app-tokens`) or OAuth 2.0 with PKCE (`/oauth/authorize`, `/oauth/token`). See [Authentication](./authentication.md) and [OAuth 2.0](./rest-api/oauth.md).
- **Nothing is granted by default.** A token carries only the scopes in the app, the user's grant and the token request. The user's own permissions still apply.
- **Messages and attachments are end-to-end encrypted** (Olm/Megolm).
  - The server stores and relays ciphertext only, and refuses plaintext text, media and attachments.
  - To read or send messages, an app registers its own encryption device for the user (`e2ee:device`). Such an app can read the user's messages; the server cannot. There is no key backup.
- **Workspace context comes from the session**: the Clerk active organization, or the app's workspace binding. It's never passed as a parameter. The server enforces membership and isolation on every request.

## Test status

Status labels in these pages mean:

- **Tested**: covered by server tests that call the real HTTP API and Socket.IO in Node (`webrtc-BE/test/`).
- **Not tested in a real client**: no test has run it in a real browser or mobile app.

Calls with real audio/video, encrypted attachments end to end, OAuth redirects through a real browser, and app sockets from a browser or mobile app have **not** been tested in a real client. See [Integration guide §10](./integration-guide.md#what-is-not-tested-yet).

