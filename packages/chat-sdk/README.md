# SpreeWe SDK and UI (prototype)

| Package | What it is |
|---|---|
| `@spreewe/chat-sdk` (`packages/chat-sdk`) | Headless TypeScript client: auth, users, conversations, messages, files, calls, recordings, organizations, events. End-to-end encryption on the user's device. |
| `@spreewe/chat-angular` (`packages/chat-angular`) | Angular 16 standalone components built on the SDK: the complete chat app, or the individual pieces. |
| `examples/angular-app` | A separate Angular app ("Acme Support") that embeds SpreeWe chat and calling with Clerk sign-in. |

> **Status: prototype `0.1.0-prototype`.** Not published, not production-ready. See "Support matrix".

## Security model
- **The browser uses the signed-in user's own SpreeWe (Clerk) session token.** The host app supplies it through `getToken()`. Developer-app secrets never go in the browser. Server-to-server integrations use `/api/v1` with app credentials (see `docs/integrations`).
- **The SDK is its own E2EE device.** It uses Olm/Megolm through `@matrix-org/matrix-sdk-crypto-wasm`, the same crypto and server API as the SpreeWe web app. Private keys stay in this browser's IndexedDB.
- **The server only ever receives ciphertext.** Message text, edits, reply quotes and attachment keys travel encrypted. Attachments are AES-GCM encrypted before upload.
- **The workspace comes from the session.** Personal vs organization is the Clerk session's active organization. The server enforces membership and tenant isolation on every call. The SDK never sends an organization id.

## Build and install (local)
```bash
cd packages/chat-sdk && npm install && npm run build
cd ../chat-angular && npm install --legacy-peer-deps && npm run build      # → packages/chat-angular/dist
cd your-angular-app
npm install ../packages/chat-sdk ../packages/chat-angular/dist --legacy-peer-deps
```

Then do two things in the host app's `angular.json`:
- Set `"preserveSymlinks": true` in the build options, so the linked packages use the app's Angular.
- Add the crypto asset:

```json
{ "glob": "matrix_sdk_crypto_wasm_bg.wasm", "input": "node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg", "output": "assets/crypto" }
```

Peer dependencies: `socket.io-client@^4.8.1`, `@matrix-org/matrix-sdk-crypto-wasm@18.9.0`, `mediasoup-client@^3.23.1`, Angular `16.2.x`.

## Use: ready-made UI
```ts
const client = new SpreeWeClient({
  apiUrl: 'https://your-host/api',            // SpreeWe REST (directly, or through your proxy)
  socketUrl: 'https://your-host',             // Socket.IO
  getToken: () => clerk.session!.getToken(),  // signed-in user's session token
  wasmUrl: new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI),
});
await client.connect();
```
```html
<spw-chat-app [client]="client"></spw-chat-app>
```

The individual components are:

- `spw-conversation-list`
- `spw-chat-window`
- `spw-composer`
- `spw-attachment`
- `spw-presence-badge`
- `spw-call`

To theme them, set the `--spw-*` CSS variables (for example `--spw-brand`, `--spw-accent`, `--spw-radius`, `--spw-font`) on **each** component element, with a selector specific enough to beat the component's own defaults. Each component declares its defaults on its own host, so values set only on an ancestor don't reach nested components. See `docs/developer/angular-ui.md`. The components don't add any global CSS.

## Use: headless
```ts
await client.connect();
const convs = await client.conversations.list();
const id = await client.conversations.openDirect(userId);
client.events.on('message', (m) => console.log(m.text, m.state));  // decrypted on this device
await client.messages.send(id, 'hello', { replyTo });
await client.messages.edit(id, messageId, 'fixed');
client.messages.react(id, messageId, '👍');
await client.files.sendAttachment(id, file);
const call = await client.calls.start(id, 'video');               // ring
const media = await client.calls.join(call.callId, 'video', { onRemoteStream: (userId, stream) => {} });
```

| Namespace | Methods |
|---|---|
| `auth` | `connect`, `disconnect`, `devices`, `revokeDevice` |
| `users` | `me`, `directory`, `get`, `updateProfile`, `setPresence`, `setIdle` |
| `conversations` | `list`, `openDirect`, `createGroup`, `info`, `addMembers`, `removeMember`, `delete`, `join` |
| `messages` | `send`, `history`, `edit`, `delete`, `react`, `pin`, `markRead`, `markDelivered` |
| `chat` | `typing`, `notifications.list`, `notifications.unreadCount`, `notifications.markRead` |
| `files` | `sendAttachment`, `shared`. Received attachments have `attachment.download()`, which decrypts locally. |
| `calls` | `start`, `accept`, `reject`, `leave`, `end`, `state`, `active`, `history`, `join` (browser media), and `controls.*` (mute or remove a participant, admit, deny, set co-host, start or stop recording, media state) |
| `recordings` | `list`, `get`, `transcript` |
| `organizations` | `mine`, `members` |
| `events` | `on(name, handler)`. Events: `message`, `message.updated`, `message.deleted`, `reaction.updated`, `typing`, `presence`, `messages.read`, `notification`, `call.*`, `recording.updated`, `keys`, `error`, … |

Errors are `SpreeWeError` objects with a `code`: `NOT_SIGNED_IN`, `HTTP`, `REJECTED`, `E2EE`, `NOT_CONNECTED`, `TIMEOUT` or `UNSUPPORTED`.

## Support matrix
**Tested end to end:** `webrtc-BE/test/sdk-e2e.test.ts`. It runs the real SDK code for two or three users against the real REST, Socket.IO and database, with the real crypto library. Clerk is simulated, as in all backend tests.

| Feature | Status |
|---|---|
| Connect, E2EE device, devices list | Tested |
| Direct chat: send, live receive, decrypt, history; ciphertext-only storage | Tested |
| Reply, edit (re-encrypted), react, pin, delete, typing, read receipts | Tested |
| Groups: create, encrypted group messages, removed member stops receiving | Tested |
| Calls signaling: start (ring), incoming, accept, participant joined, state, active, end | Tested |
| Presence (own echo), notifications, recordings list | Tested |
| Organization workspace chat; personal context can't list or read it | Tested |
| **Call media** (`calls.join`: mic/camera, remote streams) | **Built, not tested.** It needs a real browser (WebRTC). It follows the web app's mediasoup flow. |
| **Attachments** (encrypt, upload, send, download, decrypt) | **Built, not tested.** It needs S3. Same crypto as the web app. |
| Recording start/stop, transcripts in the UI | Built. Recording needs live call media, so not tested. |
| Angular components, example app | **Build passes** with strict templates. **Not yet used in a real browser.** |

**Not supported:**

- message search (the server can't search encrypted text)
- screen sharing
- device switching
- simulcast layer control
- organization admin actions (invite, roles)
- key backup and recovery (a new browser can't read older history)
- sending with developer-app tokens (blocked by design)
- a React or Vue UI

**Known limitations:**

- A brand-new contact's presence can lag up to 60 s, because the server caches it.
- If the SDK and the SpreeWe web app are open as the same user in the same browser, direct-message events go to the most recent socket only (SEC-008).
- A conversation with no messages yet doesn't appear in `list()`.

## Run the separate example app
1. **Backend:** `cd webrtc-BE && npm run dev`. Add the example's origin to `.env` and restart:
   - `CLERK_AUTHORIZED_PARTIES=…,https://localhost:4300`
   - `CORS_ORIGINS`, if you set it.

   The example reaches the backend through its own dev proxy, so the browser only ever talks to `https://localhost:4300`.
2. **Build the packages:** see "Build and install" above.
3. **Example:** `cd examples/angular-app && npm install --legacy-peer-deps && npm start`. Open `https://localhost:4300`, accept the dev certificate and sign in with a SpreeWe account.
4. **Second user:** in a second browser profile, sign in as another user. Start a chat or a call from the sidebar or the header.
5. **Organization context:** switch the workspace in the header. Workspace conversations only appear in that organization.
