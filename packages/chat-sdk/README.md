# @spreewe/chat-sdk (prototype)

A TypeScript client for SpreeWe chat with **on-device end-to-end encryption**. It runs in the end user's browser under that user's own SpreeWe (Clerk) session.

> Status: **prototype, `0.1.0-prototype`**. Not published. Not production-ready. See "Not supported" below.

## How it works (security model)

- **Signed-in user only.** The host app passes a `getToken()` that returns the signed-in user's Clerk session token. The SDK never accepts a developer-app secret. Developer-app tokens (`/api/v1`, server to server) are a separate integration and can't send messages.
- **The SDK is its own encryption device.** On first `connect()` it creates its own Olm/Megolm device for the user and keeps it in the browser's IndexedDB (`spreewe-sdk-e2ee-vault`, separate from the SpreeWe web app's store). Private keys never leave the device. The server stores public keys and ciphertext only.
- **Same crypto as the web app.** The crypto is a framework-free port of `webrtc-FE/src/app/core/crypto/e2ee.service.ts`: the same `@matrix-org/matrix-sdk-crypto-wasm`, the same `/v1/e2ee` server API, and the same sender-device check on decrypt.
- **Workspace comes from the session.** Personal vs organization context is the Clerk session's active organization. The server enforces membership and tenant isolation. The SDK never sends an organization id.

## Install (local)

```bash
cd packages/chat-sdk && npm install && npm run build
cd ../../your-app && npm install ../packages/chat-sdk   # add --legacy-peer-deps if your tree needs it
```

Peer dependencies are `socket.io-client@^4.8.1` and `@matrix-org/matrix-sdk-crypto-wasm@18.9.0`. Serve `node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm` as a static asset. `webrtc-FE/angular.json` shows how.

## Use

```ts
import { SpreeWeClient } from '@spreewe/chat-sdk';

const client = new SpreeWeClient({
  apiUrl: 'https://your-spreewe-backend',          // REST + /v1/e2ee
  socketUrl: 'https://your-spreewe-backend',       // Socket.IO (defaults to apiUrl)
  getToken: () => clerk.session!.getToken(),       // the signed-in user's session token
  wasmUrl: new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI),
  deviceLabel: 'My App',                           // shown in the user's device list
});

const me = await client.connect();                 // user + E2EE device + realtime
const conversations = await client.listConversations();
const id = await client.openDirect(otherUserId);   // the server decides who you may contact
client.onMessage((m) => console.log(m.senderId, m.state, m.text)); // decrypted on this device
client.onError((e) => console.warn(e.code, e.message));
await client.send(id, 'hello');                    // encrypted before it leaves the browser
const history = await client.history(id);          // oldest first, decrypted
client.disconnect();
```

The message `state` is one of:

- `ok`: decrypted.
- `pending`: the room key hasn't arrived yet. Call `history()` again on `onKeysChanged`.
- `failed`: can't be decrypted on this device, or the sender's device couldn't be confirmed.
- `plain`: a system or call notice that isn't encrypted.

## Backend requirements

The host app's origin must be in the backend's `CORS_ORIGINS` and, in production, in `CLERK_AUTHORIZED_PARTIES`. The user signs in through Clerk on that origin.

## Demo and tests

- **Angular demo:** `webrtc-FE` route `/sdk-demo`. Sign in, then open `https://<dev-host>/sdk-demo` in two browsers as two different users. Source: `webrtc-FE/src/app/sdk-demo/`.
  - `spw-chat.component.ts` is the reusable standalone chat component. It depends only on the SDK.
  - `sdk-demo.component.ts` is the host page. It supplies the token.
- **End-to-end test:** `webrtc-BE/test/sdk-e2e.test.ts`. It runs this SDK's code for two users against the real backend routes, Socket.IO and the database, with the real crypto library. Clerk is the test double, as in all backend tests. Run it with:

  ```bash
  cd webrtc-BE && npx vitest run test/sdk-e2e.test.ts
  ```

  It covers personal and organization conversations, encrypted send, live receive, decrypt, history, ciphertext-only storage, and workspace isolation.

## Not supported in this prototype

- Group creation from the SDK. Existing groups are listed and work for send and receive.
- Attachments, edits, deletes, reactions, replies, read receipts and typing indicators.
- Calls.
- Device verification UI, key backup and recovery. A new browser can't read older history.
- Sending messages with developer-app tokens. Blocked by design until the delegated-device design is approved.
- Pagination beyond the latest page in `history()`.

Known limitation (SEC-008): the server delivers direct-message events to the user's most recent socket. While the SDK is connected, a SpreeWe web-app tab of the same user in the same browser may miss live events until it reconnects. Conversation-room delivery, which the SDK uses, is unaffected.
