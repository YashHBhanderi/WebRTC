# SpreeWe developer API documentation

SpreeWe exposes its communication backend (messaging, groups, organizations, calls, recordings, notifications and realtime events) to third-party applications through a REST API and Socket.IO.

> **This documentation is being reworked to cover the backend API only.**
> The browser SDK, the Angular UI library and the example apps were removed. Some status labels in the pages below still say **"Tested via SDK"**. They referred to an end-to-end test that was removed with the SDK. Until each label is re-checked, treat it as **"Implemented, test coverage being re-verified"**. The "SDK method" and "SDK event" columns and the SDK code samples in [Real-time events](./realtime-events.md) and the [session endpoints](./rest-api/session-api.md) describe the removed SDK. Ignore them; the server event and endpoint information next to them is current.

## Developer Portal

Sign in to the SpreeWe web app and open **Account menu → Developer portal** (`/developer`):
- register an application (name, description, website, environment);
- generate, regenerate and revoke client secrets (each shown once);
- choose permissions (scopes);
- set allowed origins and redirect URLs;
- add webhook endpoints and see their deliveries;
- see usage (requests, errors, tokens, sockets) and activity.

End users approve applications on the SpreeWe consent page (`/consent?request=…`). A summary of the integration steps is also at `/developer/docs`.

## Documents

| Topic | Page |
|---|---|
| Authentication, developer applications, credentials, consent, scoped tokens, scopes, CORS and origins, E2EE devices | [Authentication and security](./authentication.md) |
| Personal and organization (workspace) context, membership, isolation | [Organizations and workspaces](./organizations.md) |
| Every `/v1` endpoint: developer apps, consent, app tokens, webhooks, E2EE keys, organizations, teams, workspace | [REST API v1](./rest-api/v1-api.md) |
| Endpoints used by signed-in end users (session token): users, conversations, groups, messages, uploads, calls, meetings, recordings, notifications | [REST API: session endpoints](./rest-api/session-api.md) |
| Socket.IO: connecting, every client→server and server→client event, payloads, delivery rules | [Real-time events](./realtime-events.md) |
| Machine-readable spec of `/v1`, generated from the route definitions and kept in sync by a test | [`../api/openapi.yaml`](../api/openapi.yaml) and [`../api/v1.md`](../api/v1.md) |
| Server-to-server example (developer-app credentials stay on your server) | [`../integrations/examples`](../integrations/examples) |

## Key facts
- **Two ways to authenticate.**
  - **End-user session tokens** (Clerk): full access as that user.
  - **Developer-application tokens:** scoped, obtained with app credentials and user consent. See [Authentication](./authentication.md).
- **Messages are end-to-end encrypted on the client.**
  - The server stores and relays ciphertext only, and refuses plaintext text and media messages.
  - Developer-application tokens can't register encryption devices, so they can't send or decrypt message content.
- **Workspace context comes from the session.** It's the Clerk active organization, or the app grant's tenant. It's never passed as a parameter. The server enforces membership and isolation on every request.
