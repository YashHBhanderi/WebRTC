# @spreewe/chat-sdk reference

Package: `@spreewe/chat-sdk` `0.1.0-prototype` (private, not published to npm). Source: `packages/chat-sdk/src`.

> **Testing status.** The SDK has **not yet been tested in a real browser**. The only end-to-end test is
> `webrtc-BE/test/sdk-e2e.test.ts`, which runs the real SDK in Node (with `fake-indexeddb`) against the real
> backend (REST, `/v1`, Socket.IO, database) and the real Olm/Megolm library. Clerk is simulated in that test.
> Call media (WebRTC) and encrypted file upload/download are not covered by any test.
>
> Status labels used below:
> - **Tested** — exercised by `sdk-e2e.test.ts`.
> - **Implemented, not tested** — code exists, no test exercises it.
> - **Implemented, not tested in a real browser (needs WebRTC / S3)** — needs browser media or object storage that the Node test cannot provide.

Related references: [Session REST API](./rest-api/session-api.md), [v1 REST API](./rest-api/v1-api.md), [Real-time events](./realtime-events.md).

---

## 1. Installation and requirements

The package is consumed as a local `file:` dependency (see [angular-ui.md](./angular-ui.md#installation) for a full build order).

```bash
cd packages/chat-sdk && npm install && npm run build   # tsc → dist/
```

Peer dependencies (from `package.json`) that the host app must install:

| Package | Range |
|---|---|
| `@matrix-org/matrix-sdk-crypto-wasm` | `18.9.0` (exact) |
| `socket.io-client` | `^4.8.1` |
| `mediasoup-client` | `^3.23.1` (loaded lazily, only by `calls.join`) |

The package is ESM (`"type": "module"`), entry `dist/index.js`, types `dist/index.d.ts`.

Runtime requirements:

- **Browser** with IndexedDB, WebCrypto (`crypto.subtle`) and WebAssembly. Without them `connect()` fails with `SpreeWeError('E2EE')`.
- The host app must **serve `matrix_sdk_crypto_wasm_bg.wasm`** (from `node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/`) and pass its URL as `wasmUrl`.
- WebRTC (`RTCPeerConnection`, `navigator.mediaDevices`) only for `calls.join`.
- A signed-in SpreeWe (Clerk) user. The SDK takes the user's session token from `getToken`; it never accepts an app secret. Server-to-server integrations use `/api/v1` with app credentials instead (see [v1 REST API](./rest-api/v1-api.md)).

Workspace: the active workspace (personal or organization) is the Clerk session's active organization. The server resolves and enforces it; the SDK never sends an organization id. To switch workspace, call Clerk's `setActive` in the host app, then `disconnect()` and create/connect a client again (this is what `examples/angular-app` does).

---

## 2. Exports

```ts
export { SpreeWeClient, SpreeWeError } from './client';
export type { SpreeWeClientOptions, ChatUser, PresenceStatus, Conversation, ChatMessage, Attachment, Reaction,
  Notification, CallInfo, SpreeWeEvents, SpreeWeEventName, SpreeWeErrorCode } from './client';
export { CallMedia } from './calls-media';
export type { CallMediaOptions } from './calls-media';
export type { EncryptedPayload, Decrypted, DecryptState } from './e2ee';
```

---

## 3. Constructor

```ts
new SpreeWeClient(options: SpreeWeClientOptions)
```

The constructor does no I/O. Call `connect()` next.

### SpreeWeClientOptions

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `apiUrl` | `string` | yes | — | Backend base URL. REST paths are appended directly (e.g. `${apiUrl}/conversations`, `${apiUrl}/v1/e2ee/sync`). Behind a proxy this may be `${origin}/api`. No trailing slash. |
| `socketUrl` | `string` | no | `apiUrl` | Socket.IO server URL. |
| `socketPath` | `string` | no | Socket.IO default (`/socket.io`) | Socket.IO `path` option. |
| `getToken` | `() => Promise<string \| null>` | yes | — | Returns a fresh Clerk session token. Called before **every** REST request and on every socket (re)connect. Returning `null` makes REST calls fail with `NOT_SIGNED_IN`. Clerk tokens are short-lived; use `getToken({ skipCache: true })` or equivalent. |
| `wasmUrl` | `string \| URL` | yes | — | URL where the host app serves `matrix_sdk_crypto_wasm_bg.wasm`. |
| `deviceLabel` | `string` | no | `'SpreeWe SDK'` | Display name of this browser's encryption device in the user's device list. |

```ts
import { SpreeWeClient } from '@spreewe/chat-sdk';

const client = new SpreeWeClient({
  apiUrl: `${location.origin}/api`,
  socketUrl: location.origin,
  getToken: () => clerk.session?.getToken({ skipCache: true }) ?? Promise.resolve(null),
  wasmUrl: new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI),
  deviceLabel: 'Acme Support',
});
await client.connect();
```

---

## 4. Top-level members

| Member | Signature | Status |
|---|---|---|
| `connect()` | `connect(): Promise<ChatUser>` — shorthand for `auth.connect()` | Tested |
| `disconnect()` | `disconnect(): void` — shorthand for `auth.disconnect()` | Tested (called in test teardown only) |
| `me` | `get me(): ChatUser \| null` — the user loaded by `connect()`; `null` before. Not cleared by `disconnect()`. | Tested |
| `deviceId` | `get deviceId(): string` — this browser's E2EE device id (10 chars, `[A-Z2-9]`); `''` before `connect()`. | Tested |

---

## 5. Error model

All SDK-level failures are `SpreeWeError`:

```ts
class SpreeWeError extends Error {
  code: SpreeWeErrorCode;
  message: string;
  detail?: unknown;
}
type SpreeWeErrorCode = 'NOT_SIGNED_IN' | 'HTTP' | 'REJECTED' | 'E2EE' | 'NOT_CONNECTED' | 'TIMEOUT' | 'UNSUPPORTED';
```

| Code | When |
|---|---|
| `NOT_SIGNED_IN` | `getToken()` returned no token (any REST call), or `GET /web/user/me` returned no user (`connect()`). |
| `HTTP` | A REST call returned a non-2xx status. `message` is the server's `message`/`error` if JSON, else `"<METHOD> <path> failed (<status>)"`. `detail` is an object with `status` and `message` (status text). Also: upload response without `storageKey`; attachment without a download link or a failed download. |
| `REJECTED` | A socket acknowledgement returned `{ error }` (`detail` = the full ack), `call:error` during `calls.start`, or a `message:rejected` server event (delivered through the `error` event, not thrown). |
| `E2EE` | Encryption could not start in `connect()`, or encryption failed before sending (`"Could not encrypt, so nothing was sent"`). |
| `NOT_CONNECTED` | A method that needs the socket was called while it is not connected; or a socket `connect_error` (also emitted on the `error` event). |
| `TIMEOUT` | Socket acknowledgement not received within 10 s; `calls.start` got no `call:started` within 10 s; the initial socket connection took more than 15 s. |
| `UNSUPPORTED` | Declared in the type, **not thrown anywhere in the current code**. |

Not every failure is a `SpreeWeError` (see [Known issues](#13-known-issues-and-limitations)): `auth.devices()` / `auth.revokeDevice()` throw a plain `Error` subclass with `status`; `CallMedia` throws plain `Error`s.

Method styles you will see below:

- **REST** — `fetch` with `Authorization: Bearer <token>`. Unless noted, the promise resolves to the response's `data` field verbatim.
- **Ack** — socket emit with an acknowledgement callback, 10 s timeout. Resolves to the raw ack object (typed `any`); rejects with `REJECTED` if the ack has `error`, `TIMEOUT`, or `NOT_CONNECTED` (thrown synchronously inside the returned promise path — see below).
- **Fire-and-forget** — plain socket emit. Returns whatever `socket?.emit` returns (the Socket.IO `Socket`, or `undefined` if not connected); treat it as `void`. No acknowledgement, no error is thrown; if the socket is not connected the call silently does nothing. Failures, if the server reports any, arrive only as events.

Note: `requireSocket()` throws synchronously, so for Ack methods built on `this.ack(...)` (a non-async arrow) a missing connection is thrown **synchronously** from the call rather than as a rejected promise. `await` inside `try/catch` handles both.

---

## 6. Namespaces

### 6.1 `auth`

#### `auth.connect(): Promise<ChatUser>` — Tested
Loads the signed-in user, opens (or creates) this browser's E2EE device, then opens the real-time connection.

Steps and server calls:
1. `GET {apiUrl}/web/user/me` → user (`data`). No `_id` → `NOT_SIGNED_IN`.
2. E2EE start: loads the WASM from `wasmUrl`; reads/creates the device record in IndexedDB; `POST /v1/e2ee/devices` (registers the device; on `403` the device was revoked — local keys are wiped and a new device is created); uploads keys; `GET /v1/e2ee/sync`. Any failure → `E2EE`.
3. Socket.IO connect with `auth: { token, deviceId: 'sdk-<deviceId>' }`. Resolves on first `connect`; rejects with `NOT_CONNECTED` if the client gives up reconnecting, or `TIMEOUT` after 15 s.

Resolves to the `ChatUser` from step 1. Context: browser.

```ts
const me = await client.auth.connect();
console.log(me.name, client.deviceId);
```

#### `auth.disconnect(): void` — Tested (teardown)
Closes the socket, stops E2EE (closes the crypto store, stops the 60 s sync timer, clears caches) and forgets joined rooms. Event listeners registered with `events.on` are kept. The device stays registered and its keys stay in IndexedDB.

#### `auth.devices(): Promise<{ deviceId: string; displayName: string; ed25519: string | null; revoked: boolean; current: boolean }[]>` — Tested
The user's encryption devices (public fingerprints only). `GET /v1/e2ee/devices`; `current` is `true` for this browser's device. Requires `connect()` first (sends `X-SpreeWe-Device`). Errors: plain `Error` with `status` (not `SpreeWeError`).

#### `auth.revokeDevice(deviceId: string): Promise<void>` — Implemented, not tested
`POST /v1/e2ee/devices/{deviceId}/revoke`. If `deviceId` is this device, local keys (IndexedDB) are deleted and E2EE is stopped; the socket stays open, so call `disconnect()` yourself. Errors: plain `Error` with `status`.

---

### 6.2 `users`

| Method | Server call | Resolves to | Status |
|---|---|---|---|
| `me(): Promise<ChatUser>` | `GET /web/user/me` | `data` | Implemented, not tested (the same call inside `connect()` is tested) |
| `directory(): Promise<ChatUser[]>` | `GET /web/users` | `data`, or `[]` if empty | Implemented, not tested |
| `get(userId: string): Promise<ChatUser>` | `GET /web/user/{userId}` | `data` | Tested |
| `updateProfile(update: { name?: string; username?: string; bio?: string; [k: string]: unknown }): Promise<ChatUser>` | `PATCH /web/user/profile` (JSON body = `update`) | `data` | Implemented, not tested |
| `setPresence(status: PresenceStatus, statusMessage?: string): Promise<any>` | Ack `presence:set` `{ status, statusMessage }` | raw ack (test checks `ack.presence` is set) | Tested |
| `setIdle(idle: boolean)` | Fire-and-forget `presence:idle` `{ idle }` | — | Implemented, not tested |

- `directory()` returns people the user may contact in the active workspace (server rule).
- `get()` returns a user only if visible to the caller (e.g. they share a conversation); otherwise `HTTP`.
- REST methods need a token, not a socket. `setPresence` needs the socket.

```ts
await client.users.setPresence('Busy', 'In a meeting');
const people = await client.users.directory();
```

---

### 6.3 `conversations`

| Method | Server call | Resolves to | Status |
|---|---|---|---|
| `list(): Promise<Conversation[]>` | `GET /conversations` | normalized `Conversation[]`; joins each room | Tested |
| `openDirect(userId: string): Promise<string>` | `POST /conversations` `{ receiverId }` | conversation id; joins the room | Tested |
| `createGroup(input: { name: string; memberIds: string[]; description?: string }): Promise<Conversation>` | `POST /conversations/group` `{ groupName, groupDescription, groupMembers: JSON.stringify(memberIds) }` | normalized `Conversation`; joins the room | Tested |
| `info(conversationId: string): Promise<Conversation>` | `GET /conversations/{id}/group` | normalized `Conversation` | Implemented, not tested |
| `addMembers(conversationId: string, userIds: string[]): Promise<any>` | `PUT /conversations/group/{id}/add-member` `{ userIds }` | `data` | Implemented, not tested |
| `removeMember(conversationId: string, userId: string): Promise<any>` | `PUT /conversations/group/{id}/remove-member` `{ userId }` | `data` | Tested |
| `delete(conversationId: string): Promise<any>` | `DELETE /conversations/{id}` | `data` | Implemented, not tested |
| `join(conversationId: string): void` | Socket `joinConversation` (id) | — | Tested |

Notes:
- `list()` returns the **direct** conversations of the active workspace. **Conversations without messages are not listed** (server behaviour; a new direct conversation from `openDirect` appears only after its first message).
- **Known defect: group conversations are not returned.** `GET /conversations` filters `isGroup: false`, and the SDK doesn't call the groups route (`GET /groupConversations`). Keep the `Conversation` returned by `createGroup()`, listen for `conversation.added`, and use `conversations.info(id)`. (The SDK's own code comment "direct + groups" is wrong.)
- `openDirect` reads the raw response body (not just `data`) and takes `conversationId`, else `data._id`, else `_id`. The server decides whether you may contact the user (`HTTP` error otherwise).
- `join()` is idempotent per client session and fire-and-forget; the server checks membership. Rooms are joined automatically by `list`, `openDirect`, `createGroup` and on receiving a message. Joining is needed for typing and other room events (the group test calls `join` explicitly for members who did not create the group).
- `info()` calls a group endpoint; behaviour for direct conversations is not verified.
- Removing a member: the removed member stops receiving messages and `messages.history` for that conversation fails with `HTTP` (tested). The sender's next encryption rotates the room key because membership shrank.

`Conversation` normalization: `id = String(_id)`, `isGroup = !!isGroup`, `members` (ids are wrapped as `{ _id }`), `name` = `groupName || name || 'Group'` for groups, else the other members' `name || username || email || 'User'` joined with `, ` (or `'Conversation'`), `raw` = the server object.

```ts
const id = await client.conversations.openDirect(otherUserId);
const group = await client.conversations.createGroup({ name: 'Support', memberIds: [a, b] });
```

---

### 6.4 `messages`

| Method | Server call | Resolves to | Status |
|---|---|---|---|
| `send(conversationId: string, text: string, options?: { replyTo?: string; mentions?: string[] }): Promise<void>` | Encrypt, then socket `sendMessage` (no ack) | `void` once emitted | Tested (incl. `replyTo`; `mentions` not tested) |
| `history(conversationId: string, options?: { limit?: number; page?: number }): Promise<ChatMessage[]>` | `GET /messages/{id}?limit=&page=` (defaults 30, 1) | decrypted `ChatMessage[]`, oldest first | Tested |
| `edit(conversationId: string, messageId: string, text: string): Promise<void>` | Encrypt, then Ack `message:edit` `{ messageId, e2ee }` | `void` | Tested |
| `delete(messageId: string): Promise<any>` | `DELETE /messages/{id}` | `data` | Tested |
| `react(conversationId: string, messageId: string, emoji: string)` | Fire-and-forget `reactToMessage` `{ conversationId, messageId, emoji }` — toggles | — | Tested |
| `pin(messageId: string, pinned = true): Promise<any>` | Ack `message:pin` `{ messageId, pinned }` | raw ack | Tested (`pinned = true`) |
| `markRead(conversationId: string)` | Fire-and-forget `markMessagesRead` (id) | — | Tested |
| `markDelivered(conversationIds: string[])` | Fire-and-forget `message:delivered` `{ conversationIds }` | — | Implemented, not tested |

`send` details:
- Requires a connected socket (`NOT_CONNECTED`, thrown before encryption) and running E2EE.
- Encryption: `GET /v1/e2ee/rooms/{id}/members` (the server's member list decides who gets the room key — never a client list), key queries/claims, room-key sharing via `/v1/e2ee/sendToDevice/...`, then Megolm encryption. Failure → `E2EE`, nothing sent.
- The emitted payload has `content: ''` and the ciphertext in `e2ee`. Plaintext never leaves the device (the test checks the stored message contains no plaintext).
- The promise resolves when the message is handed to the socket, **not** when the server accepts it. Server rejections arrive as `message.rejected` and `error` events.
- Your own message also arrives back as a `message` event (if the server echoes it to your room).

`history` details: each message is decrypted on this device; ids are added to the dedupe set. Messages whose key has not arrived have `state: 'pending'`. Fails with `HTTP` if you are not (or no longer) a member, or the conversation belongs to another workspace (tested).

`edit` re-encrypts the new text; other members receive `message.updated`. Only your own messages (server-enforced).

`delete`: other members receive `message.deleted`; the message appears in history with `deleted: true` or not at all.

`react`, `markRead`, `markDelivered` are fire-and-forget: they return immediately, do nothing if not connected, and report results only through events (`reaction.updated`, `messages.read`, `receipts.updated`).

```ts
await client.messages.send(id, 'Hello', { replyTo: someMessage.id });
const page = await client.messages.history(id, { limit: 50 });
client.messages.react(id, page[0].id, '👍');
client.messages.markRead(id);
```

---

### 6.5 `chat`

#### `chat.typing(conversationId: string, isTyping: boolean)` — Tested (`true` only)
Fire-and-forget `typing` (when `isTyping`) or `stopTyping` with the conversation id. Room members receive a `typing` event. Requires that you joined the room.

#### `chat.notifications`

| Method | Server call | Resolves to | Status |
|---|---|---|---|
| `list(options?: { before?: string; limit?: number }): Promise<{ items: Notification[]; nextCursor: string \| null }>` | `GET /notifications?before=&limit=` | `{ items: data.items \|\| [], nextCursor: data.nextCursor ?? null }`, newest first | Tested |
| `unreadCount(): Promise<number>` | `GET /notifications/unread-count` | `Number(data.unread ?? 0)` | Tested |
| `markRead(ids?: string[]): Promise<any>` | `POST /notifications/read` `{ ids }` | `data` | Implemented, not tested |

Pagination: pass the previous `nextCursor` as `before`. `markRead()` without ids sends `{ ids: undefined }`; whether the server then marks all as read is server behaviour (see the session API reference).

New notifications arrive live as the `notification` event.

---

### 6.6 `files`

#### `files.sendAttachment(conversationId: string, file: Blob & { name?: string }, caption = ''): Promise<void>` — Implemented, not tested in a real browser (needs WebRTC / S3)
1. Encrypts the file on this device with AES-256-GCM (WebCrypto), a fresh random key and IV per file; computes SHA-256 of the ciphertext.
2. Uploads only the ciphertext: `POST /upload` (multipart: `purpose=message`, `conversationId`, `encrypted=1`, `kind`, `file=encrypted.bin`). Reads the raw body; no `storageKey` → `HTTP` (`"Upload failed"`).
3. Sends an encrypted message (`sendMessage`) whose ciphertext contains caption, key, IV, hash, real MIME type, name and size. The server sees only the `kind` (`image` for jpeg/png/gif/webp, `video`, `audio`, `pdf`, `file`), the storage key and the ciphertext size.

Same delivery semantics as `messages.send` (resolves once emitted). The whole file is read into memory; there is no client-side size limit.

#### `files.shared(conversationId: string): Promise<any>` — Implemented, not tested
`GET /conversations/{id}/media` → `data` verbatim (server metadata; contents stay encrypted).

#### `Attachment.download(): Promise<Blob>` — Implemented, not tested in a real browser (needs WebRTC / S3)
On a decrypted message with a file. Fetches `fileUrl` (or `downloadUrl`) from the server message **without** an Authorization header (expects a pre-signed URL), checks the SHA-256, decrypts with AES-GCM and returns a `Blob` with the original MIME type. Errors: `HTTP` (`"No download link for this attachment"` if the message carried no URL; `"Download failed (<status>)"`), plain `Error` `"This file was changed or replaced, so it was not opened."` on hash mismatch, WebCrypto `OperationError` if the GCM tag fails.

```ts
await client.files.sendAttachment(id, fileInput.files[0], 'Invoice');
const blob = await message.attachment!.download();
```

---

### 6.7 `calls`

All `calls` methods except `history` need a connected socket.

| Method | Server call | Resolves to | Status |
|---|---|---|---|
| `start(conversationId: string, callType: 'audio' \| 'video', mode: 'ring' \| 'meetNow' = 'ring'): Promise<CallInfo>` | Socket `call:start` `{ groupId, callType, mode }`, waits for `call:started` with matching `groupId` | `CallInfo` | Tested (`ring`, `audio`) |
| `accept(callId: string): Promise<any>` | Ack `call:accept` | raw ack | Tested |
| `reject(callId: string)` | Fire-and-forget `call:reject` | — | Implemented, not tested |
| `leave(callId: string)` | Fire-and-forget `call:leave` | — | Implemented, not tested |
| `end(callId: string): Promise<any>` | Ack `call:end` | raw ack | Tested |
| `state(callId: string): Promise<any>` | Ack `call:getState` | raw ack | Tested |
| `active(conversationId: string): Promise<any \| null>` | Ack `call:getActive` `{ groupId }` | `ack.call` or `null` | Tested |
| `history(): Promise<any>` | `GET /calls` | `data` | Implemented, not tested |
| `join(callId: string, callType: 'audio' \| 'video', options?: CallMediaOptions): Promise<CallMedia>` | mediasoup signaling (below) | `CallMedia` | Implemented, not tested in a real browser (needs WebRTC / S3) |

`start` errors: `REJECTED` if the server emits `call:error` (any `call:error` received while waiting, not only for this conversation), `TIMEOUT` after 10 s. `mode: 'meetNow'` opens a meeting instead of ringing.

Callee flow: receive `call.incoming` → `accept(callId)` (members receive `call.participant-joined`) → `join(...)` for media. Decline with `reject(callId)`. `end` ends the call for everyone (server checks permission); everyone receives `call.ended`. `leave` leaves only yourself; call `CallMedia.close()` as well.

#### `calls.controls`

| Method | Server event | Status |
|---|---|---|
| `muteParticipant(callId: string, userId: string): Promise<any>` | Ack `call:mute-participant` | Implemented, not tested |
| `removeParticipant(callId: string, userId: string): Promise<any>` | Ack `call:remove-participant` | Implemented, not tested |
| `admit(callId: string, userId?: string): Promise<any>` | Ack `call:admit` `{ callId, userId }`, or `{ callId, all: true }` when `userId` is omitted | Implemented, not tested |
| `deny(callId: string, userId: string): Promise<any>` | Ack `call:deny` | Implemented, not tested |
| `setCohost(callId: string, userId: string, cohost = true): Promise<any>` | Ack `call:set-cohost` | Implemented, not tested |
| `startRecording(callId: string): Promise<any>` | Ack `call:record-start` | Implemented, not tested |
| `stopRecording(callId: string): Promise<any>` | Ack `call:record-stop` | Implemented, not tested |
| `mediaState(callId: string, audio: boolean, video: boolean)` | Fire-and-forget `call:media-state` (UI indicators for others only; does not mute media) | Implemented, not tested |

All Ack controls resolve to the raw ack and reject with `REJECTED` when the server refuses (e.g. not host).

#### `calls.join` and `CallMedia`

Browser only. Creates a `CallMedia` on the client's socket and runs `media.join(callId, callType)`:

1. Throws `Error('Calls need a browser with WebRTC')` if `RTCPeerConnection` or `navigator.mediaDevices` is missing (tested in Node).
2. Lazy-imports `mediasoup-client`, `mediasoup:getRouterRtpCapabilities`, loads the device.
3. `mediasoup:joinCall` `{ callId, callType }`. If the reply has `lobby`, calls `onLobby()` and waits for `call:admitted` for this call, then retries. There is no timeout and `call:denied` is not handled here (see Known issues).
4. Only after admission: `mediasoup:createSendTransport`, `mediasoup:createRecvTransport` (`mediasoup:connectTransport` on connect).
5. `getUserMedia({ audio: true, video: callType === 'video' })`, produces each track (`mediasoup:produce`, `appData.source` `mic` / `camera`).
6. Consumes the existing producers from the join reply and later `mediasoup:newProducer` events (`mediasoup:consume`, `mediasoup:resumeConsumer`), skipping your own.

Errors from signaling are plain `Error`s with the server's `error` as message and `code` copied from the ack. `getUserMedia` errors (permission denied, no device) propagate as-is.

```ts
interface CallMediaOptions {
  onRemoteStream?: (userId: string, stream: MediaStream) => void; // tracks of a remote user added / removed
  onRemoteLeft?: (userId: string) => void;                        // on call:participant-left for this call
  onLobby?: () => void;                                           // waiting for a host to admit you
}

class CallMedia {
  callId: string;
  localStream: MediaStream | null;                 // set after getUserMedia
  readonly remoteStreams: Map<string, MediaStream>; // userId → stream (one stream per user, audio + video tracks)
  join(callId: string, callType: 'audio' | 'video'): Promise<void>; // called by calls.join
  setMicEnabled(enabled: boolean): void;    // pause / resume the audio producer
  setCameraEnabled(enabled: boolean): void; // pause / resume the video producer
  close(): void;  // stops local tracks, closes producers, consumers, transports; removes listeners
}
```

`close()` only releases media locally; call `client.calls.leave(callId)` to leave on the server. Prototype scope: mic and camera only; no screen share, simulcast layers, ICE restart or device switching.

```ts
const call = await client.calls.start(conversationId, 'video');
const media = await client.calls.join(call.callId, 'video', {
  onRemoteStream: (userId, stream) => { videoFor(userId).srcObject = stream; },
  onRemoteLeft: (userId) => removeTile(userId),
  onLobby: () => showWaiting(),
});
localVideo.srcObject = media.localStream;
media.setMicEnabled(false);
client.calls.controls.mediaState(call.callId, false, true);
// later
media.close();
client.calls.leave(call.callId);
```

---

### 6.8 `recordings`

| Method | Server call | Resolves to | Status |
|---|---|---|---|
| `list(conversationId: string): Promise<any[]>` | `GET /conversations/{id}/recordings` | `data` | Tested (array check only) |
| `get(recordingId: string): Promise<any>` | `GET /recordings/{id}` | `data` | Implemented, not tested |
| `transcript(recordingId: string): Promise<any>` | `GET /recordings/{id}/transcript` | `data` | Implemented, not tested |

Payload shapes are the server's; see the session API reference.

---

### 6.9 `organizations`

| Method | Server call | Resolves to | Status |
|---|---|---|---|
| `mine(): Promise<any>` | `GET /v1/organizations/mine` | `data` | Tested (truthy check only) |
| `members(): Promise<any>` | `GET /v1/workspace/organization/members` | `data` (members of the active workspace's organization) | Implemented, not tested |

Switching workspace is done with Clerk in the host app, not by the SDK.

---

### 6.10 `events`

```ts
events.on<K extends SpreeWeEventName>(event: K, handler: (payload: SpreeWeEvents[K]) => void): () => void
```

Registers a handler; returns an unsubscribe function. Handlers are called synchronously; exceptions thrown by a handler are swallowed. Handlers survive `disconnect()`. Handlers run outside any framework zone (in Angular, re-enter with `NgZone.run`). Status: **Tested** (for the events marked below).

Server event → SDK event mapping (cross-reference [Real-time events](./realtime-events.md)):

| SDK event | Payload type | Server event | Tested |
|---|---|---|---|
| `message` | `ChatMessage` (decrypted) | `receiveMessage` (deduplicated by id) | yes |
| `message.updated` | `ChatMessage` (re-decrypted, partial: see below) | `message:updated` | yes |
| `message.deleted` | `{ conversationId: string; messageId: string }` | `message:deleted` | yes |
| `message.rejected` | `{ conversationId?: string; reason: string; message?: string }` | `message:rejected` (also emits `error`) | no |
| `reaction.updated` | `{ conversationId: string; messageId: string; reactions: Reaction[] }` (passed through; `userId` may be an object) | `messageReactionUpdated` | yes |
| `pins.updated` | `{ conversationId: string; pins: unknown[] }` | `message:pins` | yes |
| `typing` | `{ conversationId: string; userId: string; isTyping: boolean }` | `userTyping` | yes |
| `presence` | `{ userId: string; status?: string; [k: string]: unknown }` | `user:presence` | yes |
| `receipts.updated` | `{ conversationId: string; [k: string]: unknown }` | `receipts:updated` | no |
| `messages.read` | `{ conversationId: string; userId?: string; [k: string]: unknown }` | `messagesMarkedRead` | yes |
| `notification` | `Notification` | `notification:new` | no |
| `conversation.added` | `unknown` | `group:added` | no |
| `conversation.removed` | `unknown` | `group:removed` | no |
| `conversation.updated` | `unknown` | `group:updated` | no |
| `call.incoming` | `CallInfo` | `call:incoming` | yes |
| `call.started` | `CallInfo` | `call:meeting-active` (**not** `call:started`) | no |
| `call.participant-joined` | `{ callId: string; userId: string }` | `call:participant-joined` | yes |
| `call.participant-left` | `{ callId: string; userId: string }` | `call:participant-left` | no |
| `call.participant-rejected` | `{ callId: string; userId: string }` | `call:participant-rejected` | no |
| `call.ended` | `{ callId: string; [k: string]: unknown }` | `call:ended` | yes |
| `call.lobby` | `unknown` | `call:lobby` | no |
| `call.admitted` | `unknown` | `call:admitted` | no |
| `call.denied` | `unknown` | `call:denied` | no |
| `call.removed` | `unknown` | `call:removed` | no |
| `call.force-muted` | `unknown` | `call:force-muted` | no |
| `call.media-updated` | `unknown` | `call:media-updated` | no |
| `call.error` | `{ message: string }` | `call:error` | no |
| `recording.updated` | `unknown` | `recording:updated` | no |
| `keys` | `void` (handler gets `undefined`) | E2EE sync received new to-device events | no (indirectly) |
| `error` | `SpreeWeError` | `message:rejected` (`REJECTED`), `connect_error` (`NOT_CONNECTED`) | no |

Pass-through events (everything except `message`, `message.updated`, `message.deleted`, `message.rejected`, `call.incoming`, `call.started`, `keys`, `error`) deliver the server payload unchanged; the TypeScript types describe the expected fields but are not validated.

`message.updated` is built from `{ messageId, conversationId, userId, e2ee, editedAt }`: `type` is `'text'`, `reactions` is `[]`, `createdAt` is `''`, `deleted` is `false`. Merge only `text`, `state`, `warning` and `edited` into your copy.

```ts
const off = client.events.on('message', (m) => {
  if (m.state === 'ok') render(m);
});
client.events.on('keys', () => reloadHistory()); // retry 'pending' messages
off();
```

---

## 7. Types

### ChatUser
```ts
interface ChatUser { _id: string; name?: string; username?: string; email?: string; avatar?: string; status?: string; }
```
As returned by the server; additional server fields may be present at runtime.

### PresenceStatus
```ts
type PresenceStatus = 'Available' | 'Busy' | 'Do not disturb' | 'Away' | 'Appear offline';
```
Same values as the server. `presence` events may carry other status strings (e.g. offline); treat `status` as `string`.

### Conversation
```ts
interface Conversation { id: string; isGroup: boolean; name: string; members: ChatUser[]; raw: any; }
```

### ChatMessage
```ts
interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  type: string;          // text | image | video | audio | pdf | file | system / call notices
  text: string;
  state: 'ok' | 'pending' | 'failed' | 'plain';
  warning?: string;
  attachment?: Attachment;
  replyToId?: string;
  reactions: Reaction[];
  edited: boolean;
  deleted: boolean;
  createdAt: string;     // as sent by the server, '' if absent
}
```

`state`:

| Value | Meaning | `text` |
|---|---|---|
| `ok` | Decrypted on this device and the sending device belongs to `senderId`. | decrypted text (caption for attachments, may be `''`) |
| `pending` | The room key has not arrived yet (Megolm missing key / unknown message index). Retry after the `keys` event (e.g. call `history` again). The SDK does not re-emit the message. | `''` |
| `failed` | Cannot be decrypted, or the sender check failed (`warning` = `"This message's sender couldn't be confirmed, so it isn't shown."`). | `''` |
| `plain` | Not encrypted: system / call notices from the server. | server `content` |

`warning` on an `ok` message: set when the library's shield is red (e.g. `"Sent from an unverified device"`).

### Attachment
```ts
interface Attachment { name: string; mimeType: string; size: number; download: () => Promise<Blob>; }
```
Present only when `state === 'ok'` and the decrypted content has a file. `name`, `mimeType` and `size` come from inside the ciphertext.

### Reaction
```ts
interface Reaction { emoji: string; userId: string; }
```

### Notification
```ts
interface Notification { _id: string; type: string; read: boolean; createdAt: string; [k: string]: unknown; }
```

### CallInfo
```ts
interface CallInfo { callId: string; conversationId: string; callType: 'audio' | 'video'; mode?: 'ring' | 'meetNow'; initiatedBy?: string; }
```
Normalized from the server payload: `callId` from `callId` or `_id`; `conversationId` from `groupId` or `conversationId`; `callType` is `'video'` only if the server said so, otherwise `'audio'`.

### EncryptedPayload, Decrypted, DecryptState
```ts
interface EncryptedPayload { algorithm: 'm.megolm.v1.aes-sha2'; ciphertext: string; session_id: string; sender_key: string; device_id: string; }
type DecryptState = 'ok' | 'pending' | 'failed';
interface Decrypted { state: DecryptState; content?: SecureContent; warning?: string; }
```
Exported for reference; you do not normally handle them. (`SecureContent` itself is not exported.)

### SpreeWeEvents, SpreeWeEventName, SpreeWeErrorCode
See [events](#610-events) and [error model](#5-error-model).

---

## 8. End-to-end encryption behaviour

- **One device per browser profile and user.** On first `connect()` the SDK creates an E2EE device (random 10-character id) and stores it in IndexedDB database **`spreewe-sdk-e2ee-vault`** (store `devices`, keyed by user id). Private keys live in the crypto library's own IndexedDB store `spreewe-sdk-e2ee-<userId>`, encrypted with a random passphrase that is itself wrapped by a non-extractable AES-GCM key. This protects keys at rest; it does not protect against malicious script in the page.
- The SDK's device is separate from the SpreeWe web app's device, even on the same origin.
- **`wasmUrl` is required**: the crypto library is WebAssembly and is loaded from that URL at `connect()`.
- **Pending messages.** A message encrypted before this device received the room key is returned with `state: 'pending'`. When the SDK's sync receives new to-device events (on `e2ee:to-device` / `e2ee:devices-changed` socket events, on every reconnect, and every 60 s) it emits **`keys`**; reload history then.
- **Sender check.** After decryption the SDK verifies that the Curve25519 key of the sending device belongs to the user the server names as sender (refreshing that user's device list once if needed). If not, the message is `failed`.
- **No key backup / no history on new devices.** Keys exist only on the device. Clearing site data, a new browser or a revoked device loses the ability to decrypt older messages; those show as `pending` or `failed` on the new device.
- **Server membership decides recipients.** Before each send the SDK fetches the room's members from the server. When a member was removed since the last send, the outbound session is rotated.
- A device revoked on the server (`403` on registration) is wiped locally and replaced by a new one at the next `connect()`.
- **Conversations without messages are not listed** by `conversations.list()`.

## 9. Real-time behaviour notes

- **Dedupe by id.** `receiveMessage` may arrive both via the room and via the user channel; the SDK emits `message` once per id. Ids returned by `history()` are also marked as seen, so a live copy of a message already loaded through history is not emitted.
- **Automatic room joins** on `conversations.list`, `openDirect`, `createGroup` and on receiving a message from a conversation you had not joined.
- **Reconnection.** Socket.IO reconnects automatically with a fresh token from `getToken`. On every `connect` the SDK re-joins all rooms joined so far (the server re-checks membership) and runs an E2EE sync.
- `connect_error` is emitted as an `error` event (`NOT_CONNECTED`) on every failed attempt.

## 10. Node usage

The test suite runs the SDK in Node with `fake-indexeddb`, global `fetch`, and the WASM loaded by the Node build of the crypto library (`wasmUrl` is not used there). This is a test setup, not a supported runtime; `calls.join` and file encryption paths using `Blob`/`FormData` are browser-oriented.

## 11. Quick start

```ts
const client = new SpreeWeClient({ apiUrl, getToken, wasmUrl });
client.events.on('error', (e) => console.warn(e.code, e.message));
client.events.on('message', (m) => console.log(m.conversationId, m.state, m.text));
await client.connect();

const conversations = await client.conversations.list();
const history = await client.messages.history(conversations[0].id);
await client.messages.send(conversations[0].id, 'Hello');
```

## 12. Status summary

| Area | Status |
|---|---|
| `connect`, `disconnect`, `me`, `deviceId`, `auth.devices` | Tested |
| `auth.revokeDevice` | Implemented, not tested |
| `users.get`, `users.setPresence` | Tested |
| `users.me`, `users.directory`, `users.updateProfile`, `users.setIdle` | Implemented, not tested |
| `conversations.list`, `openDirect`, `createGroup`, `removeMember`, `join` | Tested |
| `conversations.info`, `addMembers`, `delete` | Implemented, not tested |
| `messages.send`, `history`, `edit`, `delete`, `react`, `pin`, `markRead` | Tested |
| `messages.markDelivered` | Implemented, not tested |
| `chat.typing`, `chat.notifications.list`, `unreadCount` | Tested |
| `chat.notifications.markRead` | Implemented, not tested |
| `files.sendAttachment`, `Attachment.download` | Implemented, not tested in a real browser (needs WebRTC / S3) |
| `files.shared` | Implemented, not tested |
| `calls.start`, `accept`, `end`, `state`, `active` | Tested |
| `calls.reject`, `leave`, `history`, all `calls.controls` | Implemented, not tested |
| `calls.join` / `CallMedia` | Implemented, not tested in a real browser (needs WebRTC / S3) (only the "no WebRTC" error is tested) |
| `recordings.list` | Tested |
| `recordings.get`, `transcript` | Implemented, not tested |
| `organizations.mine` | Tested |
| `organizations.members` | Implemented, not tested |
| `events.on` | Tested |

## 13. Known issues and limitations

Observed in the source; not fixed in this prototype.

- **Multiple tabs share one device.** The vault is keyed by user id, so two tabs of the same origin open the same crypto store concurrently. The source itself notes that two machines on one store corrupt it. Avoid multiple connected clients per user per origin.
- `messages.send` / `files.sendAttachment` resolve before the server accepts the message; listen to `message.rejected`.
- Calling `connect()` twice without `disconnect()` opens a second socket; the first is not closed.
- If the initial connection times out (15 s) while Socket.IO is still retrying, `connect()` rejects but the socket keeps reconnecting in the background. Call `disconnect()` after a failed `connect()`.
- `CallMedia.join` waits indefinitely in the lobby; `call:denied` does not end the wait. No timeout.
- `calls.start` rejects on any `call:error` that arrives while it waits, even one unrelated to this conversation; two concurrent `start` calls for the same conversation both resolve with the first `call:started`.
- `auth.devices`, `auth.revokeDevice` and `CallMedia` throw plain `Error`s, not `SpreeWeError`. `UNSUPPORTED` is never thrown.
- `auth.revokeDevice(ownDeviceId)` stops E2EE but leaves the socket connected.
- `Attachment.download` depends on `fileUrl`/`downloadUrl` being present on the server message object and valid when downloaded. Whether live `receiveMessage` payloads include it, and how long the URL is valid, is not verified.
- The dedupe set and decrypt cache grow for the lifetime of the client; `disconnect()` does not clear the dedupe set.
- Fire-and-forget methods silently do nothing when the socket is not connected.
