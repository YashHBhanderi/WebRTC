# Getting started

This guide takes a web application from nothing to a first end-to-end encrypted message with the browser SDK. For a fuller walk-through (attachments, calls, ready-made UI), continue with the [Integration tutorial](./tutorials.md).

> The packages are a **prototype** and aren't published to npm. You build them from this repository. Real-browser testing of calling, attachments and the UI components is outstanding. See [What is supported](./README.md#what-is-supported).

## 1. Prerequisites

You need the following from whoever operates the SpreeWe backend.

| What | Why | Where it comes from |
|---|---|---|
| **Backend URL** (e.g. `https://spreewe.example.com`) | REST, `/v1` and Socket.IO | The SpreeWe operator |
| **Your web origin allow-listed** (e.g. `https://app.example.com`) | Browsers send the session token from your origin. The backend accepts it only if the origin is in `CORS_ORIGINS` and, in production, in `CLERK_AUTHORIZED_PARTIES`. Exact origins only: scheme, host and port, no path or `*`. | The SpreeWe operator adds it to the backend environment and restarts. Production refuses to start if `CLERK_AUTHORIZED_PARTIES` is missing or invalid. |
| **Sign-in with the SpreeWe Clerk instance** | The SDK uses the signed-in user's SpreeWe session token | The Clerk publishable key is public. The backend returns it from `GET /config` as `data.clerkPublishableKey`. The Clerk instance must also allow your domain. |
| **Users** | Each person needs a SpreeWe account | They sign up or in through Clerk. The backend creates the SpreeWe user on first sign-in. |

**Your app also needs:**
- **HTTPS**, including local development. Browsers allow the camera and microphone only on secure origins.
- **A bundler that handles ES modules and WebAssembly assets:** Angular CLI 16 (verified), esbuild/Vite, or webpack 5 with one extra setting (see [Other frameworks](./other-frameworks.md#bundler-requirements)).
- **Node.js and npm** to build the packages.

You do **not** need a developer application for the browser SDK. Developer applications are for server-to-server integrations; see [Authentication](./authentication.md).

## 2. Build and install the packages

From a checkout of this repository:

```bash
# Headless SDK
cd packages/chat-sdk
npm install
npm run build                      # → packages/chat-sdk/dist

# Optional: Angular UI components (Angular 16 apps)
cd ../chat-angular
npm install --legacy-peer-deps
npm run build                      # → packages/chat-angular/dist
```

In your application:

```bash
npm install /path/to/webrtc/packages/chat-sdk \
  socket.io-client@^4.8.1 mediasoup-client@^3.23.1 @matrix-org/matrix-sdk-crypto-wasm@18.9.0
# Angular UI (optional):
npm install /path/to/webrtc/packages/chat-angular/dist --legacy-peer-deps
```

`--legacy-peer-deps` is only needed if your dependency tree already has peer conflicts (the SpreeWe web app does).

## 3. Configure your app

### Serve the encryption library's WebAssembly file
The SDK loads `matrix_sdk_crypto_wasm_bg.wasm` from the `wasmUrl` you give it. Copy it from `node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/` into your static assets. For Angular, add this to the build `assets` in `angular.json`:

```json
{ "glob": "matrix_sdk_crypto_wasm_bg.wasm", "input": "node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg", "output": "assets/crypto" }
```

### Angular only: `preserveSymlinks`
Packages installed from a local path are symlinked. Set `"preserveSymlinks": true` in the build options in `angular.json`, so the linked packages use your app's single copy of Angular.

### Reach the backend
Pick one:

- **Same origin (recommended in development).** Proxy `/api/*` to the backend, stripping `/api`, and proxy `/socket.io` (with WebSocket support). Then use `apiUrl: origin + '/api'` and `socketUrl: origin`. `examples/angular-app/proxy.conf.js` is a working Angular dev-server proxy.
- **Direct.** Use `apiUrl: 'https://spreewe.example.com'` and `socketUrl: 'https://spreewe.example.com'`. Your origin must be in the backend's `CORS_ORIGINS`.

The backend serves its REST routes both without a prefix and under `/api`. The Socket.IO path is the default `/socket.io`. `socketPath` only needs changing if a proxy moves it.

## 4. First integration

```ts
import { SpreeWeClient } from '@spreewe/chat-sdk';

// Your app has signed the user in with the SpreeWe Clerk instance (`clerk` below is that Clerk object)
const client = new SpreeWeClient({
  apiUrl: `${location.origin}/api`,
  socketUrl: location.origin,
  getToken: () => clerk.session?.getToken({ skipCache: true }) ?? Promise.resolve(null),
  wasmUrl: new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI),
  deviceLabel: 'My App',   // shown in the user's device list
});

const me = await client.connect();     // user + this browser's E2EE device + realtime

client.events.on('message', (m) => {
  if (m.state === 'ok') console.log(`${m.senderId}: ${m.text}`);   // already decrypted
});

const [someone] = (await client.users.directory()).filter((u) => u._id !== me._id);
const conversationId = await client.conversations.openDirect(someone._id);
await client.messages.send(conversationId, 'Hello, encrypted world');
```

**Check it works:**
1. Sign in as user A in one browser profile and as user B in another. Use separate profiles, because each profile is a separate encryption device.
2. Run the snippet as A. B (connected with the same code) gets a `message` event whose `text` is `Hello, encrypted world`.
3. In the network panel, the `sendMessage` Socket.IO frame contains an `e2ee.ciphertext` and an empty `content`. Your plain text never appears.

A complete, type-checked version is in [`examples/headless-chat.ts`](./examples/headless-chat.ts).

**`getToken` notes:**
- **Always return a fresh token.** Clerk session tokens live about a minute, and the SDK calls `getToken` before every request and every socket (re)connect.
- **Never return** a developer-app credential or any server secret.
- **Workspace context follows the session.** Switching the active organization in Clerk (`clerk.setActive({ organization })`) changes the workspace. Call `client.disconnect()` and `connect()` again afterwards.

## 5. Next steps
- [Integration tutorial](./tutorials.md): group chat, attachments, calls, ready-made UI.
- [Chat guide](./chat.md), [Calling guide](./calling.md), [Files](./files.md).
- [SDK reference](./sdk-reference.md) and [Real-time events](./realtime-events.md).
- [Troubleshooting](./troubleshooting.md) if something doesn't connect.
