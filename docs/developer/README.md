# SpreeWe developer documentation

SpreeWe provides end-to-end encrypted messaging, audio/video calling and organization workspaces that you can add to your own application.

> **Status: prototype (`0.1.0-prototype`).** The packages are not published to npm. Read [What is supported](#what-is-supported) before you plan an integration. Real-browser testing of calling, attachments and the UI components is **still outstanding**.

## Start here

| I want to… | Read |
|---|---|
| Understand how the pieces fit together | [Architecture](#architecture) |
| Get a first message sent in a web app | [Getting started](./getting-started.md) |
| Follow a complete walk-through | [Integration tutorial](./tutorials.md) |
| Choose between user sessions and developer apps | [Authentication and security](./authentication.md) |
| Drop a ready-made chat UI into an Angular app | [Angular UI library](./angular-ui.md) |
| Build my own UI (React, Vue, plain TypeScript) | [Other frameworks](./other-frameworks.md) and the [SDK reference](./sdk-reference.md) |
| Fix a problem | [Troubleshooting](./troubleshooting.md) |

## All documents

**Guides**
- [Getting started](./getting-started.md): prerequisites, installation, configuration, first integration.
- [Integration tutorial](./tutorials.md): register, authenticate, connect, chat, attachments, calls, ready-made UI.
- [Authentication and security](./authentication.md): user sessions, Clerk, developer apps and scopes, tokens, origins, E2EE devices.
- [Organizations and workspaces](./organizations.md): personal and organization context, membership, isolation.
- [Chat](./chat.md): direct and group chat, encrypted messages, history, replies, edits, deletes, reactions, typing, receipts, presence.
- [Files and attachments](./files.md): encrypted upload and download, storage, formats, limits.
- [Audio and video calling](./calling.md): call lifecycle, media, participants, mediasoup, STUN/TURN, network.
- [Recording and transcription](./recordings.md).
- [Angular UI library](./angular-ui.md): `spw-chat-app` and the individual components.
- [Other frameworks](./other-frameworks.md): React, Vue and plain TypeScript with the headless SDK.
- [Troubleshooting](./troubleshooting.md).

**Reference**
- [SDK reference](./sdk-reference.md): `@spreewe/chat-sdk`, every namespace, method, type and event.
- [Real-time events](./realtime-events.md): Socket.IO connection, client→server and server→client events.
- [REST API: session endpoints](./rest-api/session-api.md): the endpoints the browser SDK uses.
- [REST API: v1](./rest-api/v1-api.md): versioned API, including developer applications, consent, app tokens, webhooks, organizations and E2EE key endpoints.
- Machine-readable v1 spec: [`../api/openapi.yaml`](../api/openapi.yaml). It is generated from the server's route definitions, and a test keeps it in sync.

**Examples**
- [`examples/angular-app`](../../examples/angular-app): a separate Angular app ("Acme Support") with Clerk sign-in, a workspace switcher and the ready-made UI.
- [`docs/developer/examples/headless-chat.ts`](./examples/headless-chat.ts): a framework-free TypeScript integration, type-checked against the SDK.
- [`docs/integrations/examples`](../integrations/examples): a server-to-server developer-app example (app credentials stay on your server).

## Architecture

```
Your web app (browser)                                   SpreeWe backend
┌──────────────────────────────────────────┐            ┌───────────────────────────────────────────┐
│ Your sign-in (Clerk, SpreeWe instance)   │            │ REST (session routes, /v1)                │
│        │ session token (getToken)        │  HTTPS     │ Socket.IO (chat, presence, calls signaling)│
│ @spreewe/chat-angular (optional UI)      │ ─────────► │ mediasoup SFU (call media, UDP/TCP)        │
│ @spreewe/chat-sdk                        │  WSS       │ MongoDB (ciphertext + metadata only)       │
│   ├─ E2EE device (Olm/Megolm, WASM)      │            │ S3 (encrypted attachments, recordings)     │
│   │  keys in this browser's IndexedDB    │  WebRTC    │ Whisper (optional transcription)           │
│   └─ mediasoup-client (call media)       │ ─────────► │                                            │
└──────────────────────────────────────────┘            └───────────────────────────────────────────┘
Your server (optional): developer-app credentials → /v1 server-to-server, webhooks
```

- **Two ways to integrate.** See [Authentication](./authentication.md) for the decision table.
  - **User session (browser SDK).** Your page signs the user in with the SpreeWe Clerk instance and gives the SDK a function that returns the user's session token. The SDK does everything else. This is the only mode that can **send and read encrypted messages**.
  - **Developer application (server to server).** Your server holds app credentials, gets user consent, exchanges for scoped user tokens and calls `/v1`, plus webhooks. App tokens **cannot send or decrypt messages**: they have no encryption device, and the server refuses app message sends. This is by design. Don't try to work around it.
- **End-to-end encryption.**
  - Message text, edits, reply quotes and attachment keys are encrypted on the user's device before they leave it.
  - The server stores and relays ciphertext only, and refuses plaintext text and media messages.
  - Each browser (each SDK instance) is its own encryption device.
- **Workspaces.** The Clerk session's **active organization** decides which workspace a request runs in: personal (no organization) or an organization. The server enforces membership and isolation on every request. Clients never send an organization id.

## What is supported

The status labels used throughout these docs:

| Label | Meaning |
|---|---|
| **Implemented and tested** | Exercised end to end by an automated test against the real backend, database and encryption library, with sign-in (Clerk) simulated. For the SDK this is `webrtc-BE/test/sdk-e2e.test.ts`. |
| **Implemented, not tested in a real browser** | The code exists and compiles, but needs a real browser (WebRTC, camera/mic) or real cloud storage (S3) that the automated tests don't have. Nobody has tested it in a real browser yet. |
| **Partially supported** | Works with stated restrictions. |
| **Not implemented** | Not available. Don't build on it. |

| Capability | Status |
|---|---|
| Connect, create or load an E2EE device, list or revoke devices | Implemented and tested |
| Direct chat: send, receive live, decrypt, history; server stores ciphertext only | Implemented and tested |
| Replies, edits (re-encrypted), deletes, reactions, pins, typing, read receipts | Implemented and tested |
| Group chat: create, encrypted group messages, removing a member stops delivery to their connection | Implemented and tested (single connection per user; see the two rows below) |
| **Names and members of listed direct conversations** | **Known defect:** `conversations.list()` returns direct conversations with empty `members` and the name `"Conversation"`. The server returns `sender`/`receiver` rather than `members`. The ready-made sidebar shows that name. The raw server row is in `Conversation.raw`. |
| **Listing group conversations** (`conversations.list()`, `spw-conversation-list`) | **Not implemented, known defect:** `list()` returns direct conversations only, because the server's `GET /conversations` excludes groups. Groups you create or are added to reach you through `createGroup()`'s result and `conversation.added`, but don't appear in later `list()` calls. |
| **Removed group member with several open tabs/devices** | **Known security issue:** the server removes only the member's most recent connection from the group's realtime room. Their other open connections keep receiving the group's room events (new messages as ciphertext, typing, reactions) until they reconnect. Fix pending (backend). |
| Call signaling: start (ring), incoming, accept, participant joined, state, active, end | Implemented and tested |
| Presence (own updates), notifications, recordings list | Implemented and tested |
| Organization workspace chat and isolation from the personal context | Implemented and tested |
| Developer apps, consent, scoped tokens, webhooks (`/v1`) | Implemented and tested by server tests (not through the browser SDK) |
| **Call audio/video** (`calls.join`, `spw-call`) | Implemented, not tested in a real browser |
| **Encrypted attachments** (upload, send, download, decrypt) | Implemented, not tested in a real browser (needs S3) |
| **Recording start/stop, transcripts from the SDK/UI** | Implemented, not tested in a real browser (needs live call media) |
| **Angular UI components and the example app** | Build passes (strict templates); not tested in a real browser |
| Contacts' presence | Partially supported: a new contact's presence can take up to 60 s to appear (server cache) |
| Bundling the SDK with webpack 5 (React, Vue CLI…) | Partially supported: needs one config line, see [Other frameworks](./other-frameworks.md#bundler-requirements) |
| Same user in the SDK and in the SpreeWe web app in one browser | Partially supported: direct per-user events reach only the most recent connection (SEC-008) |
| Message search over encrypted text | Not implemented (the server can't read message text) |
| Screen sharing through the SDK | Not implemented in the SDK (the server has `screen:*` events) |
| Organization administration from the SDK | Not implemented in the SDK (available as `/v1` REST) |
| Encryption key backup and recovery | Not implemented: a new browser can't read older history |
| Sending messages with developer-app tokens | Not implemented, by design |
| UI components for React or Vue | Not implemented (use the headless SDK) |

## Versions and requirements
- **SpreeWe backend:** this repository's `webrtc-BE` (Node.js, Express 4, Socket.IO 4, mediasoup 3, MongoDB).
- **`@spreewe/chat-sdk` 0.1.0-prototype.** Peer dependencies:
  - `socket.io-client` ^4.8.1
  - `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0
  - `mediasoup-client` ^3.23.1
- **`@spreewe/chat-angular` 0.1.0-prototype:** Angular `>=16.2.0 <17`.
- **Browser:** HTTPS (required for camera and microphone), IndexedDB, WebCrypto, WebAssembly. Calls need WebRTC.
