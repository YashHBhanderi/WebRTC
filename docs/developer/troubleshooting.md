# Troubleshooting

Find the symptom, check the cause, apply the fix. Errors from the SDK are `SpreeWeError` objects with a `code` (see the [SDK reference](./sdk-reference.md)), except for a few call-media and device paths that throw a plain `Error`.

## Connecting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every request returns **401**; `connect()` rejects with `HTTP … (401)` | The page origin isn't in the backend's `CLERK_AUTHORIZED_PARTIES`. Or the token isn't from the SpreeWe Clerk instance, or has expired. | Ask the operator to add your **exact** origin (scheme, host, port; no path or `*`) and restart the backend. Make `getToken` return `clerk.session.getToken({ skipCache: true })`. |
| Browser console: **CORS error** on REST | You call the backend directly and your origin isn't in `CORS_ORIGINS` | Add the origin to `CORS_ORIGINS`, or use a same-origin proxy (see [Getting started](./getting-started.md#reach-the-backend)) |
| `connect()` rejects with `NOT_SIGNED_IN` | `getToken` returned `null` (signed out), or `/web/user/me` returned no user | Sign the user in first. Call `connect()` after Clerk has a session. |
| `connect()` rejects with `NOT_CONNECTED` or `TIMEOUT` (15 s) | Socket.IO can't connect: wrong `socketUrl` or `socketPath`, a proxy without WebSocket upgrade, or a rejected handshake token | Check that the `/socket.io` request reaches the backend. Enable WebSocket proxying (`ws: true`). Look for `connect_error` in the `error` event. **Note:** after a timeout the socket keeps retrying in the background. Call `disconnect()` before retrying. |
| Production backend **refuses to start**: `CLERK_AUTHORIZED_PARTIES must be set…` or `CORS_ORIGINS must be set…` | Required production configuration is missing | Set both, as exact `https` origins. Run `NODE_ENV=production npm run check:config` in `webrtc-BE` to see every problem by name. |
| Works for a minute, then 401s | Something cached the ~60 s Clerk token | Never store the token. Always go through `getToken`. |
| Wrong conversations after switching organization | The SDK keeps the workspace it connected with | After `clerk.setActive(...)`, call `client.disconnect()` and `client.connect()` |

## Encryption

| Symptom | Likely cause | Fix |
|---|---|---|
| `connect()` rejects with `E2EE` "can't keep encryption keys…" | IndexedDB, WebCrypto or WebAssembly isn't available. Common causes are private-browsing modes and non-HTTPS pages. | Use HTTPS and a normal browser profile |
| `E2EE` on `connect()` with a 404 for `matrix_sdk_crypto_wasm_bg.wasm` | The WebAssembly file isn't served at `wasmUrl` | Copy it from `node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/` into your assets ([Getting started](./getting-started.md#serve-the-encryption-librarys-webassembly-file)) |
| Messages show `state: 'pending'` | The room key hasn't arrived yet. It's delivered separately from the message. | Re-read `messages.history()` on the `keys` event. It usually resolves within seconds. |
| Messages show `state: 'failed'` | This device never received the key: it was created after the message was sent, or the sender couldn't share with it. Or the sender's device couldn't be confirmed (`warning`). | Expected for history from before this device existed. There's no key backup. A new browser, or cleared site data, can't read older messages. |
| `messages.send` rejects with `E2EE` "Could not encrypt…" | Encryption isn't ready, or the key sharing request failed | Wait for `connect()` to resolve. Check the network for failed `/v1/e2ee/*` requests. |
| `message.rejected` with reason `unencrypted` | Something sent a message without an `e2ee` payload | Only send through the SDK. The server refuses plaintext text and media. |
| Odd decryption failures with **two tabs open** | Both tabs open the same encryption store at once (known defect) | Use one tab per user per browser profile until this is fixed |
| Device unexpectedly "new" after a refresh | Site data was cleared, or the page runs in a different origin or profile | The device lives in the origin's IndexedDB (`spreewe-sdk-e2ee-vault`). Keep a stable origin. |

## Chat

| Symptom | Likely cause | Fix |
|---|---|---|
| A new conversation isn't in `conversations.list()` | Direct conversations are listed only once they have a message | Keep the id from `openDirect()` and send a first message |
| `openDirect` fails with 403 or 404 | You may not contact that person in this workspace: blocked, outside the organization, or an external-communication policy | Use `users.directory()` for people you may contact. See [Organizations](./organizations.md). |
| `users.get(id)` returns "User not found" | That person isn't visible in your current context (no shared conversation or workspace) | Expected. The server answers 404 rather than revealing other users. |
| No typing events for a conversation | Typing goes to the conversation room only. You haven't joined it. | The SDK joins on `list`, `openDirect`, `createGroup` and on the first received message. Call `conversations.join(id)` for others. |
| A contact's presence updates late | The server caches presence visibility for up to 60 s for new contacts | Known limitation |
| Search finds nothing | The server can't search encrypted text | Not supported. Search the messages you've decrypted on the device. |
| Messages missing in the SpreeWe web app while the SDK is open (same user, same browser) | Per-user events go to the most recent connection only (SEC-008) | Known limitation. Conversation-room events still reach both. |

## Files

| Symptom | Likely cause | Fix |
|---|---|---|
| `sendAttachment` fails with `HTTP … (5xx)` or "Upload failed" | S3 isn't configured on the backend | The operator sets `S3_BUCKET` and AWS credentials and runs `npm run check:s3`. See [Files](./files.md). |
| Upload rejected (413 or "too large") | The file exceeds the upload size limit | See the limits in [Files](./files.md) |
| `attachment.download()` throws "No download link…" | The message carries no download URL | Re-read the message through `messages.history()`. Attachments aren't tested in a real browser yet; report the case. |

## Calls

| Symptom | Likely cause | Fix |
|---|---|---|
| `calls.join` throws "Calls need a browser with WebRTC" | Running in Node or a non-WebRTC environment | Calls are browser-only |
| `NotAllowedError` from `getUserMedia` | The user denied camera or microphone, or the page isn't HTTPS | Ask for permission. Serve over HTTPS. |
| Transport requests answer `NOT_JOINED` | Media transports were requested before the server admitted you to the call | Use `calls.join()`, which joins first. Don't call `mediasoup:*` events directly. |
| `joinCall` answers `IN_CALL_ELSEWHERE` | The user is already in a call on another device | Leave the other call first |
| Join hangs in the lobby | The meeting requires admission. The SDK waits with no timeout and doesn't handle `call:denied`. | A host admits you (`calls.controls.admit`). Add your own timeout in the UI. |
| Connected but no audio/video across networks | UDP blocked, wrong announced address, or no TURN server | The operator configures the mediasoup announced address and TURN ([Calling](./calling.md)) |
| A second incoming call keeps ringing for the caller | `spw-chat-app` ignores a ring while you're in a call and doesn't reject it | Known UI limitation |

## Bundling and Angular

| Symptom | Likely cause | Fix |
|---|---|---|
| webpack: `Can't resolve './client' … Did you mean 'client.js'?` | An SDK built from checkpoint `1dc6d13` or earlier | Rebuild the SDK from the current source (`npm run build` in `packages/chat-sdk`). Current builds use fully specified imports and bundle with webpack 5 defaults. |
| Angular runtime errors such as `NG0203` or "inject() must be called from an injection context" | Two copies of Angular: the linked package resolved its own `node_modules` | Set `"preserveSymlinks": true` in `angular.json` and install from `packages/chat-angular/dist` |
| `npm install` fails with `ERESOLVE` | Pre-existing peer-dependency conflicts in your app | `npm install … --legacy-peer-deps` |
| Theme colours don't change inside the chat | Variables set on `spw-chat-app` don't reach the nested components | Set them on each component with enough specificity ([Angular UI](./angular-ui.md)) |

## Running the backend yourself

| Symptom | Likely cause | Fix |
|---|---|---|
| mediasoup worker fails: `uv_udp_bind() failed … address already in use` | Another SpreeWe backend (or test) already uses the RTC port (default 40000) | Stop the other instance or set `MEDIASOUP_RTC_PORT` |
| `npm run check:config` reports FAIL | Missing production configuration | Fix every listed variable. The tool prints names only, never values. |

## Still stuck
Collect:
- the `SpreeWeError.code` and message;
- the failing network request (URL, status, response);
- the `connect_error` text, if any;
- browser and version.

Don't send session tokens or encryption keys to anyone; they aren't needed for diagnosis.
