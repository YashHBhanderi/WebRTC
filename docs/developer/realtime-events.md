# Real-time events (Socket.IO)

This page lists every Socket.IO event that the SpreeWe backend handles or emits. It covers the payloads, acknowledgements, authorization checks and delivery rules for each one. All of it was checked against the server source (`webrtc-BE/src/realtime/**`, `webrtc-BE/src/services/**`, `webrtc-BE/src/e2ee/**`, `webrtc-BE/src/organizations/events.ts`) and the SDK (`packages/chat-sdk/src/client.ts`).

Related pages:

- [SDK reference](./sdk-reference.md): the `SpreeWeClient` API, which wraps most of these events.
- [Authentication](./authentication.md): how to get Clerk session tokens and developer-app user tokens.
- [Calling](./calling.md): the call flow and mediasoup signalling, step by step.

**Test coverage labels** used in the tables:

- **Tested via SDK**: exercised end to end through the SDK in `webrtc-BE/test/sdk-e2e.test.ts`.
- **Server tests**: covered by another file in `webrtc-BE/test/` (raw socket tests).
- **Not covered by tests**: no automated test emits or asserts this event.

> **Call media has not been verified in a real browser through the SDK.** The `mediasoup:*` signalling events have server tests (admission checks only). Nobody has yet tested a full audio/video session (produce, consume, resume) in a browser using the SDK's `calls.join()`. In Node, the SDK test only confirms that `calls.join()` refuses to run without WebRTC.

---

## 1. Connecting

| Item | Value |
|---|---|
| URL | The backend's base URL (same host as the REST API). The SDK uses `socketUrl ?? apiUrl`. |
| Path | Socket.IO default `/socket.io` (the server sets no custom path; the SDK passes `socketPath` only if you set it). |
| Transports | Server: Socket.IO defaults (WebSocket and HTTP long-polling). The SDK requests `['websocket', 'polling']`. |
| Handshake auth | `{ token: string, deviceId?: string }` in `auth` (not a query string or header). |
| Max message size | `maxHttpBufferSize` = `SOCKET_MAX_BUFFER_BYTES` (default 5 MiB). Larger frames are dropped by Socket.IO. |
| CORS | Origins in `CORS_ORIGINS` (comma-separated, https required in production), plus origins registered by active developer apps. No credentials (cookies are not used). Requests with no `Origin` (native apps) are accepted. |

### Handshake auth

```ts
auth: {
  token: string;      // Clerk session JWT, or a developer-app user token
  deviceId?: string;  // first-party sockets only; must match /^[\w-]{8,64}$/
}
```

- **Missing or empty `token`**: the connection is refused with `connect_error` message `"Authentication error"`. You also get this when the server has no Clerk configuration.
- **Clerk token rejected** (expired, wrong `azp`, clock skew): `connect_error` `"Invalid token"`. The `azp` (authorized parties) check applies only when the browser sends an `Origin` header.
- **Developer-app token** (detected by format): checked against the live app, grant and tenant. If it is invalid you get `"Invalid token"`. If the app lacks `realtime:connect` you get `"The token lacks the realtime:connect scope"`.
- **Workspace**: the server fixes the socket's workspace at handshake time, from the active organization in the verified token. To switch workspace, disconnect and reconnect with a token for the other organization.

### Token freshness

The server checks the token **only at connect time**. Clerk session tokens live for about 60 seconds, so a token you captured once will fail on the next reconnect. Pass a **function** for `auth` so that every connect and reconnect fetches a fresh token:

```ts
import { io } from 'socket.io-client';

const socket = io(API_URL, {
  transports: ['websocket', 'polling'],
  auth: (cb) => {
    getClerkToken().then((token) => cb({ token: token ?? '', deviceId: myDeviceId }));
  },
});
```

The SDK does this for you: it calls `getToken()` on every (re)connect and sends `deviceId: "sdk-<e2ee device id>"`.

Sockets can still be closed after they connect:

- **First-party sockets** are re-checked every `SOCKET_REVALIDATE_MS` (default 30 s, minimum 5 s). The server disconnects them if the workspace becomes inactive or the user's membership is removed. Some membership or organization changes in Clerk disconnect them immediately.
- **Developer-app sockets** are disconnected when the app token expires (a timer set to the token's `exp`). They are also disconnected if the periodic re-check finds the token, app or grant no longer valid.

### `deviceId`

- It identifies one tab or device, so a reconnect of the same tab keeps its call session. Store it per tab (for example in `sessionStorage`) and send the same value on every reconnect.
- It must match `^[\w-]{8,64}$`. If it is missing or invalid, the server uses `socket.id`, which changes on every reconnect. In that case a dropped connection is treated as a different device during calls.
- Developer-app sockets always get `deviceId = socket.id`; the server ignores the value you send.

### Reconnection: what the client must redo

Socket.IO reconnects automatically. On every `connect` event (not just the first):

1. **Re-join conversation rooms**: emit `joinConversation` for each open conversation. Room membership does not survive a reconnect. Without it you get no typing indicators, and the other room broadcasts reach you only through per-user delivery (see section 2).
2. **Re-sync E2EE**: run your to-device / key sync, because `e2ee:to-device` or `e2ee:devices-changed` may have fired while you were offline. The SDK calls `e2ee.sync()` on every connect.
3. **Ringing calls**: the server sends `call:pending-rings` on every first-party connect, so a ring that went out during the reconnect is not lost. Treat the list as authoritative: drop any ring you are showing that is not in it.
4. **Calls in progress**: if you were in a call, you have **12 seconds** (`CALL_RECONNECT_GRACE_MS`) to reconnect with the **same `deviceId`**. If you do not, the server removes you from the call and broadcasts `call:participant-left`.

The SDK handles steps 1 and 2. It does **not** handle `call:pending-rings` (see [Discrepancies](#discrepancies-found-while-writing-this-page)).

### Connect errors

Every refusal reaches the client as `connect_error` with one of these messages: `"Authentication error"`, `"Invalid token"`, or `"The token lacks the realtime:connect scope"`. The SDK turns each `connect_error` into an `error` event (`SpreeWeError` code `NOT_CONNECTED`). If the first connect does not succeed within 15 s, `connect()` rejects with `TIMEOUT`.

### Rate limits

- Each limit is a token bucket keyed **per user** and shared by all of that user's sockets on one server instance. Opening more sockets does not give you more events. Developer-app sockets use a separate bucket per app and user.
- Defaults: `SOCKET_RATE_PER_SEC` = 30 events/s refill, `SOCKET_RATE_BURST` = 120.
- The limit is **per process**: it is not shared across instances in a cluster.
- When the bucket is empty, the server drops the event. Your ack callback is never called, so you will see a timeout. At most once per second the server emits:

  ```ts
  socket.on('rate-limited', (p: { event: string; reason?: string }) => { /* back off */ });
  ```

- Developer-app connection caps: `app.quotas.maxConnections` per app, and 5 sockets per app user (both per instance). When a cap is exceeded, the server emits `rate-limited` `{ event: "connect", reason: "connection limit" }` and then disconnects the socket.

---

## 2. Rooms and delivery model

The server delivers events in four ways:

| Mechanism | Reaches | Used for |
|---|---|---|
| **Per-user** (`emitToUser`, `emitToUsers`) | The user's **single most recent first-party socket**, plus all of their developer-app sockets. Conversation-related events are filtered by the socket's workspace. | New messages (together with room delivery), edits, pins, receipts, notifications, call invites, group changes |
| **Conversation room** (`io().to(conversationId)`) | Every socket that has called `joinConversation` (or joined during `call:start` / `call:accept`) for that conversation | `receiveMessage`, `userTyping`, `messageReactionUpdated`, `messagesMarkedRead` |
| **Call room** (`io().to(callId)`) and **call peers** (`emitToCall`) | Sockets in the call's room, or sockets registered as media peers in the call | In-call events |
| **User room / workspace** (`notifyUserEverywhere`, `emitToWorkspace`) | **All** of the user's first-party sockets, either in every workspace or filtered by workspace and role. Never developer-app sockets. | `e2ee:*`, `org:*`, `team:*`, `channel:*`, `conversation:removed` |

Important consequences:

- **Typing is room-only.** `typing` and `stopTyping` are ignored unless the sending socket has joined the room, and `userTyping` is sent only to the room. Call `joinConversation` first.
- **`messageReactionUpdated` and `messagesMarkedRead` are room-only.** A socket that has not joined the room never sees them.
- **`receiveMessage` is sent twice**: once to the conversation room and once per user. De-duplicate by `_id`, as the SDK does.
- **Known limitation (SEC-008, open):** per-user events go only to the user's **most recently connected first-party socket**. If the same user has two tabs or devices open, only the latest one receives direct events such as `call:incoming`, `message:updated`, `receipts:updated` and `notification:new`. Conversation-room events reach every socket that has joined the room. Until SEC-008 is fixed, call `joinConversation` on each socket and re-fetch state over REST when a tab gains focus.

---

## 3. Client → server events

### Ack convention

Events that take an acknowledgement callback (`socket.emit(event, payload, (res) => ...)`) do not all reply in the same format. Check the **Ack** column for each event.

- **`onAck` handlers** (`chat:*`, `group:*`) and most call controls reply `{ success: true, ...result }` on success or `{ error: string }` on failure.
- Some events reply with **raw objects** that have no `success` field, for example `call:getActive`, `call:session`, `screen:getState`, `ice:getServers` and most `mediasoup:*` events. Detect failure by checking for `error`.
- **"none"** means the server never calls the ack. These events fail silently: the server ignores the event or only logs the problem.

### Chat and messages

| Event | Payload | Ack | Authorization / notes | SDK method | Tests |
|---|---|---|---|---|---|
| `joinConversation` | `conversationId: string` (bare string) | none | Joins the room only if you are a member; otherwise it is ignored silently. | internal (called on every message receipt and on reconnect); `conversations.join(id)` | Tested via SDK |
| `typing` | `conversationId: string` | none | Only if this socket is in the room. The server broadcasts `userTyping` to others in the room. | `chat.typing(id, true)` | Tested via SDK |
| `stopTyping` | `conversationId: string` | none | Same as `typing` | `chat.typing(id, false)` | Server tests |
| `sendMessage` | see below | none (outcome arrives as `receiveMessage` or `message:rejected`) | `user._id` must equal the socket's user; must be a member; checks external-access policy and blocking. **Refused for developer-app sockets.** | `messages.send`, attachments | Tested via SDK |
| `message:edit` | `{ messageId: string; e2ee: EncryptedPayload; mentions?: string[] }` | `{ success: true }` / `{ error }` | Author only (enforced in the message-actions service). Emits `message:updated` per user. | `messages.edit` | Tested via SDK |
| `message:pin` | `{ messageId: string; pinned?: boolean }` (`pinned` defaults to true) | `{ success: true, pins }` / `{ error }` | Enforced in the message-actions service. Emits `message:pins` per user. | `messages.pin` | Tested via SDK |
| `reactToMessage` | `{ conversationId: string; messageId: string; emoji: string }` (emoji ≤ 16 chars) | none | Must be a member; the message must belong to the conversation and not be deleted. Toggles the reaction. Emits `messageReactionUpdated` to the room. | `messages.react` | Tested via SDK |
| `markMessagesRead` | `conversationId: string` (bare string) | none | Must be a member. Emits `messagesMarkedRead` (room) and `receipts:updated` (per user). | `messages.markRead` | Tested via SDK |
| `message:delivered` | `{ conversationIds: string[] }` (max 50) | none | Only conversations you are a member of. Emits `receipts:updated` to the other members. | `messages.markDelivered` | Not covered by tests |
| `chat:archive` / `chat:unarchive` | `{ conversationId }` | `{ success, conversationId, state }` / `{ error }` | Member only; changes only your own state | not in SDK | Not covered by tests |
| `chat:favorite` / `chat:unfavorite` | `{ conversationId }` | same | same | not in SDK | Server tests |
| `chat:clear` | `{ conversationId }` | same | same | not in SDK | Not covered by tests |
| `chat:block` / `chat:unblock` | `{ userId }` | `{ success, userId, blocked }` / `{ error }` | Your own block list only | not in SDK | Not covered by tests |

#### `sendMessage` payload

```ts
interface SendMessagePayload {
  user: { _id: string };          // must equal the authenticated user
  conversationId: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'file' | 'call';
  content: string;                // send '' for text/media: the server stores '' for encrypted types
  e2ee: EncryptedPayload;         // REQUIRED for text and media types
  storageKey?: string;            // media types: key returned by POST /upload
  replyTo?: string | null;        // message id in the same conversation
  mentions?: string[];            // member user ids
  fileUrl?: string;               // 'call' type only (link, max 2048 chars)
  forwardOf?: string;             // currently always rejected (reason "forward")
}

interface EncryptedPayload {      // webrtc-BE/src/e2ee/payload.ts
  algorithm: 'm.megolm.v1.aes-sha2';
  ciphertext: string;   // base64/base64url, 1..131072 chars
  session_id: string;   // base64/base64url, ≤ 128 chars
  sender_key: string;   // base64/base64url, ≤ 128 chars
  device_id: string;    // /^[A-Za-z0-9_-]{4,64}$/
}
```

Failures:

- **Sender mismatch, unknown type, conversation not found, or not a member**: dropped silently. There is no event or ack, only a server log line.
- **Other refusals**: the server emits `message:rejected` with `reason` set to one of these:

| `reason` | Meaning |
|---|---|
| `policy` | Blocked by the workspace's external-access policy. |
| `blocked` | One side of the direct chat has blocked the other. |
| `attachment` | `storageKey` is invalid or not usable. |
| `forward` | `forwardOf` was sent; forwarding is not supported. |
| `unencrypted` | Missing or invalid `e2ee` payload. |
| `e2ee` | Developer-app socket (apps cannot send messages). |

### Presence

| Event | Payload | Ack | Notes | SDK method | Tests |
|---|---|---|---|---|---|
| `presence:set` | `{ status: 'Available' \| 'Busy' \| 'Do not disturb' \| 'Away' \| 'Appear offline'; statusMessage?: string }` | `{ success: true, presence }` / `{ error }` | Any other status is rejected. Others see "Appear offline" as offline. | `users.setPresence` | Tested via SDK |
| `presence:idle` | `{ idle: boolean }` | none | Sets the auto-away flag. | `users.setIdle` | Not covered by tests |

### Groups

All group events use the `onAck` format. Admin rights are enforced in `group.service`.

| Event | Payload | Ack (success) | Server emits | Tests |
|---|---|---|---|---|
| `group:update` | `{ groupId, groupName?, groupDescription?, groupAvatarKey? }` | `{ success, group }` | `group:updated` | Not covered by tests |
| `group:add-member` | `{ groupId, userIds: string[] }` | `{ success, group, added }` | `group:updated`, `group:added` (to each added user), system `receiveMessage` | Not covered by tests |
| `group:remove-member` | `{ groupId, userId }` | `{ success, group }` | `group:removed` (to the removed user), `group:updated`, system message | Server tests |
| `group:promote-admin` | `{ groupId, userId }` | `{ success, group }` | `group:updated` | Not covered by tests |
| `group:remove-admin` | `{ groupId, userId }` | `{ success, group }` | `group:updated` | Not covered by tests |
| `group:leave` | `{ groupId }` | `{ success, groupId }` | `group:removed` `{ reason: "left" }`, `group:updated`, system message | Not covered by tests |

The SDK changes group membership over REST (`conversations.addMembers` / `removeMember`), not through these events.

### Calls

Errors from `call:start`, `call:reject` and `call:leave` (and also from `call:accept` and `call:end`) arrive as a `call:error` event `{ message }` sent to the calling socket.

| Event | Payload | Ack | Authorization / notes | SDK method | Tests |
|---|---|---|---|---|---|
| `call:start` | `{ groupId: string; callType: 'audio' \| 'video'; mode?: 'ring' \| 'meetNow' }` | none. Reply is the `call:started` event `{ callId, groupId, callType, mode, initiatedBy, resumed? }` or `call:error`. | Member; not blocked; external-call policy. If `mode` is omitted, video defaults to `meetNow` and audio to `ring`. If a call is already active, the server returns it with `resumed: true`. `ring` sends `call:incoming` to the others; `meetNow` sends `call:meeting-active` to all members. | `calls.start` (waits up to 10 s) | Tested via SDK |
| `call:accept` | `{ callId }` | `{ success, callId }` / `{ error }` | Participant. Joins the conversation and call rooms. Emits `call:participant-joined` to the call room unless you are held in the lobby. | `calls.accept` | Tested via SDK |
| `call:reject` | `{ callId }` | none | Emits `call:participant-rejected`. Ends the ring when everyone has declined. | `calls.reject` | Not covered by tests |
| `call:leave` | `{ callId }` | none | Leaves media, lobby and screen share. Emits `call:participant-left`. The call ends when the last person leaves. | `calls.leave` | Server tests |
| `call:end` | `{ callId }` | `{ success }` / `{ error }` | Member. In group calls only a host may end the call; either side may end a 1:1 call. Emits `call:ended`. | `calls.end` | Tested via SDK |
| `call:getState` | `{ callId }` | State object (no `success`) or `{ error }`. Fields: `callId, myRole, settings, cohostIds, lobby, recording, recordingAvailable, groupId, callType, mode, callStatus, startedAt, elapsedMs, isGroup, groupName, hostIds, participants, screenSharerUserId, ...snapshot` | Non-removed participant. `lobby` is filled only for moderators. | `calls.state` | Tested via SDK |
| `call:getActive` | `{ groupId }` | `{ call: { callId, groupId, callType, mode, callStatus, initiatedBy } \| null }` | Member. Non-members get `{ call: null }`. | `calls.active` | Tested via SDK |
| `call:session` | any | `{ elsewhere: boolean; callId? }` | Tells you whether this user is live in a call on another device. | not in SDK | Not covered by tests |
| `call:takeover` | `{ callId? }` | `{ success }` / `{ error }` | Moves the call session to this device. | not in SDK | Not covered by tests |
| `call:upgrade` | `{ callId; callType?: 'video' }` | `{ success, callId, groupId, callType }` / `{ error }` | Active participant. Emits `call:media-updated` to the call room. | not in SDK | Not covered by tests |
| `call:media-state` | `{ callId; audio: boolean; video: boolean }` | none | Only when this socket is a media peer in the call. Emits `call:media-state` to the other peers. | `calls.controls.mediaState` | Not covered by tests |
| `call:hand` | `{ callId; raised: boolean }` | none | Media peer only | not in SDK | Not covered by tests |
| `call:reaction` | `{ callId; emoji }` | none | Media peer; emoji from a fixed set; rate-limited per user | not in SDK | Not covered by tests |
| `call:mute-participant` | `{ callId; userId }` | `{ success }` / `{ error }` | Host or co-host of a group call. The target client receives `call:force-muted` and is expected to mute itself; the server does not enforce it. | `calls.controls.muteParticipant` | Not covered by tests |
| `call:remove-participant` | `{ callId; userId }` | same | Host or co-host. Co-hosts can remove attendees only. The removed user cannot rejoin this call. | `calls.controls.removeParticipant` | Not covered by tests |
| `call:settings` | `{ callId; lobby?: boolean; allowUnmute?: boolean; allowShare?: boolean }` | `{ success, settings }` / `{ error }` | Moderator (enforced in meeting-controls). Emits `call:settings`. | not in SDK | Not covered by tests |
| `call:mute-all` | `{ callId }` | `{ success, ... }` / `{ error }` | Moderator | not in SDK | Not covered by tests |
| `call:admit` | `{ callId; userId } \| { callId; all: true }` | `{ success, admitted }` / `{ error }` | Moderator | `calls.controls.admit` | Not covered by tests |
| `call:deny` | `{ callId; userId }` | `{ success }` / `{ error }` | Moderator | `calls.controls.deny` | Not covered by tests |
| `call:set-cohost` | `{ callId; userId; cohost?: boolean }` | `{ success, ... }` / `{ error }` | Host | `calls.controls.setCohost` | Not covered by tests |
| `call:record-start` | `{ callId }` | `{ success, ... }` / `{ error }` | Host or co-host; recording must be enabled on the server | `calls.controls.startRecording` | Not covered by tests |
| `call:record-stop` | `{ callId }` | same | same | `calls.controls.stopRecording` | Not covered by tests |

### Screen share lock

| Event | Payload | Ack | Notes | Tests |
|---|---|---|---|---|
| `screen:join` | `{ callId }` | `{ success }` / `{ error }` | Active participant only. Joins the call room. | Server tests |
| `screen:start` | `{ callId }` | `{ success }` / `{ error, sharerUserId? }` | Only one sharer at a time; the organizer's `allowShare` setting applies. Emits `screen:started`. | Not covered by tests |
| `screen:stop` | `{ callId }` | `{ success }` / `{ error }` | Releases your own lock. Emits `screen:stopped`. | Not covered by tests |
| `screen:getState` | `{ callId }` | `{ sharerUserId: string \| null; error? }` | Active participant | Server tests |

None of the screen events is wrapped by the SDK.

### Media (mediasoup) and ICE

**Admission rule (SEC-005):** `mediasoup:createSendTransport`, `mediasoup:createRecvTransport`, `mediasoup:connectTransport` and `mediasoup:restartIce` require that this socket has already completed a **successful, non-lobby** `mediasoup:joinCall` for a call where the user is still an active participant. Otherwise they reply:

```ts
{ error: 'Join the call before using media', code: 'NOT_JOINED' }
```

Media flow has **not** been tested in a real browser through the SDK. The SDK's `calls.join()` drives these events (`packages/chat-sdk/src/calls-media.ts`). See [Calling](./calling.md).

| Event | Payload | Ack (success) | Errors / notes | Tests |
|---|---|---|---|---|
| `mediasoup:joinCall` | `{ callId; callType: 'audio' \| 'video' }` | `{ success: true, producers: ProducerInfo[] }` or `{ lobby: true }` (waiting for admission) | `callId is required`, `Invalid callType`, `Not a participant of this call`, `{ error, code: 'IN_CALL_ELSEWHERE' }`. Joins the call room. | Server tests |
| `mediasoup:getRouterRtpCapabilities` | none | `{ rtpCapabilities }` | `{ error }` | Not covered by tests |
| `mediasoup:createSendTransport` | none | `{ id, iceParameters, iceCandidates, dtlsParameters, ...iceConfig, reused? }` | `NOT_JOINED`. Reuses the transport if it has not been connected yet. | Server tests |
| `mediasoup:createRecvTransport` | none | same | `NOT_JOINED` | Server tests |
| `mediasoup:connectTransport` | `{ transportId; dtlsParameters }` | `{ connected: true }` | `NOT_JOINED`, `Transport not found` | Server tests |
| `mediasoup:restartIce` | `{ transportId }` | `{ iceParameters, ...iceConfig }` | `NOT_JOINED`, `Transport not found` | Server tests |
| `mediasoup:produce` | `{ transportId; kind: 'audio' \| 'video'; rtpParameters; appData?: { source?: 'screen' } }` | `{ id }` | `Peer not found`, `Send transport not found`, `Invalid transport`, `Peer is not associated with a call`, `Invalid kind`, screen-share not allowed. Emits `mediasoup:newProducer`. | Not covered by tests |
| `mediasoup:closeProducer` | `{ producerId }` | `{ success: true }` | Succeeds even if the producer is already gone. | Not covered by tests |
| `mediasoup:consume` | `{ producerId; rtpCapabilities }` | `{ id, producerId, kind, rtpParameters, type, source }` | `Peer not found`, `Receive transport not found`, `Cannot consume this producer`, `Producer not found in this call` | Server tests |
| `mediasoup:resumeConsumer` | `{ consumerId }` | `{ success: true }` | `Peer not found`, `Consumer not found` | Not covered by tests |
| `mediasoup:setPreferredLayers` | `{ consumerId; spatialLayer; temporalLayer }` | `{ success: true, ignored? }` | `Consumer not found`, `Invalid layers` | Not covered by tests |
| `mediasoup:syncProducers` | `{ callId }` | `{ producers: ProducerInfo[] }` | Returns `{ producers: [] }` with no `callId`. Requires that this socket was admitted to **that** call (`mediasoup:joinCall`) and is still an active participant, re-checked on every request; otherwise `{ producers: [], error, code: "NOT_JOINED" }`. | Server tests (`media-admission.test.ts`) |
| `ice:getServers` | none | ICE config (STUN/TURN, per-user credentials) | none | Server tests |

`ProducerInfo = { producerId: string; userId: string; kind: 'audio' | 'video'; source: 'camera' | 'screen' }`.

---

## 4. Server → client events

The **Receives** column uses these terms:

- **user**: per-user delivery (one first-party socket, plus app sockets).
- **room**: conversation room.
- **call room** and **call peers**: see section 2.
- **everywhere**: all of the user's first-party sockets.
- **workspace**: matching first-party sockets in that workspace.

### Chat, messages, presence

| Event | Payload | Receives | SDK event | Tests |
|---|---|---|---|---|
| `receiveMessage` | Full message: `{ _id, userId, conversationId, type, content: '', e2ee, replyTo, mentions, reactions, createdAt, user, status: 'sent', ...media }`. System and call messages have plaintext `content`. | room **and** user (de-duplicate by `_id`) | `message` (decrypted `ChatMessage`) | Tested via SDK |
| `message:rejected` | `{ conversationId?, reason, message? }` | sending socket | `message.rejected` (and `error`) | Server tests |
| `message:updated` | `{ conversationId, messageId, userId, e2ee, editedAt, mentions }` | user (all members) | `message.updated` (re-decrypted) | Tested via SDK |
| `message:deleted` | `{ conversationId, messageId }` | user (all members) | `message.deleted` | Tested via SDK |
| `message:pins` | `{ conversationId, pins }` | user (all members) | `pins.updated` | Tested via SDK |
| `messageReactionUpdated` | `{ conversationId, messageId, reactions }` | room | `reaction.updated` | Tested via SDK |
| `messagesMarkedRead` | `{ conversationId, userId }` | room | `messages.read` | Tested via SDK |
| `receipts:updated` | read: `{ conversationId, userId, readAt, deliveredAt }`; delivered: `{ conversationId, userId, deliveredAt }` | user (members; the delivered variant skips the user who marked it) | `receipts.updated` | Not covered by tests |
| `userTyping` | `{ conversationId, userId, isTyping }` | room (excludes the sender) | `typing` | Tested via SDK |
| `user:presence` | `{ userId, isOnline, status, statusMessage, autoAway, inCall, ... }`. On your own sockets it also includes `ownStatus`. | contacts allowed to see you (judged per socket), plus yourself | `presence` | Tested via SDK |
| `user:updated` | `{ _id, username, avatar, bio, status }` | user (everyone who shares a conversation with you) | none | Not covered by tests |
| `notification:new` | `{ _id, type, actor, conversationId, messageId, callId, meetingId, recordingId, text, read, createdAt }` | user | `notification` | Server tests |
| `notification:read` | `{ unread: number }` | user | none | Not covered by tests |
| `rate-limited` | `{ event: string; reason?: string }` | sending socket | none | Server tests |

### Conversations, groups, meetings, recordings

| Event | Payload | Receives | SDK event | Tests |
|---|---|---|---|---|
| `group:added` | `{ groupId, group }` from group changes; `{ groupId }` only from meeting invites | user | `conversation.added` | Not covered by tests |
| `group:removed` | `{ groupId, reason: 'removed' \| 'left' \| 'deleted', by? }` | user | `conversation.removed` | Not covered by tests |
| `group:updated` | `{ groupId, group }` | user (members) | `conversation.updated` | Not covered by tests |
| `conversation:removed` | `{ conversationId }` | everywhere | none | Not covered by tests |
| `meeting:updated` | `{ meetingId }` | user | none | Not covered by tests |
| `recording:updated` | `{ recordingId, conversationId, status, transcriptStatus, startedBy, title }` | user (members) | `recording.updated` | Not covered by tests |

### Calls

| Event | Payload | Receives | SDK event | Tests |
|---|---|---|---|---|
| `call:started` | `{ callId, groupId, callType, mode, initiatedBy, resumed? }` | caller socket | resolves `calls.start()` | Tested via SDK |
| `call:error` | `{ message }` | acting socket | `call.error` (also rejects `calls.start()`) | Server tests |
| `call:incoming` | `{ callId, groupId, callType, mode, initiatedBy }` | user (members except caller), `ring` mode | `call.incoming` | Tested via SDK |
| `call:meeting-active` | same | user (all members), `meetNow` mode | `call.started` | Not covered by tests |
| `call:pending-rings` | `{ calls: Array<{ callId, groupId, callType, mode, initiatedBy, resent: true }> }` | this socket, on every first-party connect | none | Server tests |
| `call:force-leave` | `{ callId, reason: 'other-device' }` | the other device's socket | none | Not covered by tests |
| `call:participant-joined` | `{ callId, userId }` | call room | `call.participant-joined` | Tested via SDK |
| `call:participant-left` | `{ callId, userId, removed? }` | call room | `call.participant-left` | Server tests |
| `call:participant-rejected` | `{ callId, userId }` | call room | `call.participant-rejected` | Not covered by tests |
| `call:ended` | `{ callId, groupId, callStatus, endedBy?, reason? }` | call room **and** user (all members) | `call.ended` | Tested via SDK |
| `call:media-updated` | `{ callId, groupId, callType }` | call room | `call.media-updated` | Not covered by tests |
| `call:media-state` | `{ callId, userId, audio, video }` | call peers (excludes the sender) | none | Not covered by tests |
| `call:hand` | `{ callId, userId, raised }` | call peers (excludes the sender) | none | Not covered by tests |
| `call:reaction` | `{ callId, userId, emoji }` | call peers (excludes the sender) | none | Not covered by tests |
| `call:audio-levels` | `{ callId, levels }` | call peers | none | Not covered by tests |
| `call:force-muted` | `{ callId, by? , all?, locked? }` | target peer socket(s) | `call.force-muted` | Not covered by tests |
| `call:removed` | `{ callId, by }` | removed user's socket | `call.removed` | Not covered by tests |
| `call:lobby` | `{ callId, waiting }` | moderators' peer sockets | `call.lobby` | Not covered by tests |
| `call:admitted` | `{ callId }` | user | `call.admitted` | Not covered by tests |
| `call:denied` | `{ callId }` | user | `call.denied` | Not covered by tests |
| `call:settings` | `{ callId, settings, cohostIds }` | call room | none | Not covered by tests |
| `call:share-stopped` | `{ callId, reason: 'not-allowed' }` | user (the sharer) | none | Not covered by tests |
| `call:recording` | `{ callId, active: true, startedAt, by, byName }` or `{ callId, active: false, reason }` | call peers | none | Not covered by tests |
| `screen:started` | `{ callId, userId }` | call room | none | Not covered by tests |
| `screen:stopped` | `{ callId, userId }` | call room | none | Not covered by tests |
| `mediasoup:newProducer` | `{ producerId, userId, kind, source }` | call room and each peer (de-duplicate by `producerId`) | internal to `calls.join()` | Not covered by tests |
| `mediasoup:producerClosed` | `{ producerId, userId, source, consumerId? }` | call room, or the consuming socket | internal to `calls.join()` | Not covered by tests |

### E2EE

| Event | Payload | Receives | SDK | Tests |
|---|---|---|---|---|
| `e2ee:to-device` | `{}` | everywhere (recipients of to-device messages) | triggers `e2ee.sync()` internally; `keys` is emitted when keys change | Not covered by tests |
| `e2ee:devices-changed` | `{ users: string[] }` (Matrix-style user ids) | everywhere (peers of a user whose device list changed) | triggers `e2ee.sync()` internally | Not covered by tests |

### Organizations, teams, channels

These events go only to first-party sockets, never to developer-app sockets. All payloads contain ids only: re-fetch the details over REST.

| Event | Payload | Receives | Tests |
|---|---|---|---|
| `org:updated` | `{ organizationId }` | workspace (everyone) | Server tests |
| `org:members-changed` | `{ organizationId }` | workspace, non-guest roles | Server tests |
| `org:invitations-changed` | `{ organizationId }` | workspace, non-guests or admins (depends on the invite policy) | Not covered by tests |
| `org:join-request-created` | `{ organizationId, requestId }` | workspace admins | Server tests |
| `org:join-requests-changed` | `{ organizationId }` | workspace admins | Not covered by tests |
| `org:role-changed` | `{ organizationId, role }` | the affected user in the workspace | Server tests |
| `org:joined` | `{ organizationId, clerkOrgId, name, role }` | everywhere | Not covered by tests |
| `org:removed` | `{ organizationId, reason }` | everywhere | Server tests |
| `org:deleted` | `{ organizationId }` | everywhere | Not covered by tests |
| `org:invitation` | `{ organizationId, invitationId, name }` | everywhere | Server tests |
| `org:invitation-revoked` | `{ organizationId, invitationId }` | everywhere | Not covered by tests |
| `org:join-request` | `{ organizationId, name, status }` | everywhere | Not covered by tests |
| `team:changed` | `{ teamId, change }` | workspace (team viewers) | Not covered by tests |
| `team:members-changed` | `{ teamId }` | workspace (team viewers) | Not covered by tests |
| `team:channels-changed` | `{ teamId }` | workspace (team viewers) | Not covered by tests |
| `team:joined` | `{ teamId, name }` | listed users | Server tests |
| `team:removed` | `{ teamId }` | the removed user | Server tests |
| `channel:created` | `{ teamId, channelId, name }` | channel members | Server tests |
| `channel:joined` | `{ teamId, channelId }` | listed users | Not covered by tests |
| `channel:members-changed` | `{ teamId, channelId }` | channel members | Not covered by tests |
| `channel:removed` | `{ teamId, channelId }` | removed users | Not covered by tests |

None of the `org:*`, `team:*` or `channel:*` events is mapped by the SDK. Listen on the raw socket if you need them.

---

## 5. E2EE events: what a client must do

Message content is end-to-end encrypted (Megolm). The server stores and relays only ciphertext. Two events tell you that key material is waiting:

- **`e2ee:to-device`**: one or more to-device messages (usually room keys) are queued for one of your devices. The payload is empty `{}`. Call your sync endpoint to fetch and process them. After processing, retry decrypting any messages that failed with "missing key".
- **`e2ee:devices-changed`**: `{ users }`, the people whose device lists changed (a device was added or revoked). Refresh their device keys before you encrypt the next message, so that new devices receive the room key and revoked devices do not.

Both events go to **all** of your first-party sockets (user room), not just the latest one. Neither event is sent to developer-app sockets. Also run a sync after every reconnect, because the server does not replay these events.

When you use the SDK, all of this is automatic: it syncs on `connect` and on both events, and emits `keys` when key state changes. See [SDK reference](./sdk-reference.md).

---

## 6. Developer-app sockets

A socket that connects with a developer-app user token (scope `realtime:connect` required) is restricted:

- **Rooms:** it never joins any room, so it receives no room broadcasts (typing, reactions, read markers, call room events).
- **Calls and presence:** it has no presence registration of its own, cannot place or join calls, and gets no media.
- **Inbound events:** only events in `SOCKET_EVENT_SCOPES` are allowed. Today that list contains just `sendMessage` (`messages:write`), and `sendMessage` is always refused with `message:rejected` `{ reason: 'e2ee' }`. In practice, **an app socket cannot successfully send any event**. Every other event is refused with the error `"Not available to this app"`, and the ack is not called.
- **Outbound events:** the socket receives only events in `DELIVERED_EVENT_SCOPES`, and only if the app has the matching scope:

| Event | Required scope |
|---|---|
| `receiveMessage`, `message:updated`, `message:deleted` | `messages:read` |
| `user:presence`, `rate-limited` | `realtime:connect` |

- **Message content is stripped.** Any payload that carries `e2ee` is delivered as `{ ...payload, e2ee: undefined, content: null, encrypted: true }`, because the app holds no device keys. System and call messages (which are not encrypted) keep their `content`.
- **Workspace visibility:** conversation events are delivered only if the token's context can see the conversation.
- **Connection caps and rate limits:** see [Rate limits](#rate-limits). The socket is disconnected when the token expires; get a new token from your backend and reconnect. See [Authentication](./authentication.md).

`message:rejected` is emitted directly to the sending socket, so an app receives it even though it is not in the delivered-events list.

---

## 7. Subscribing and cleaning up

### SDK

`client.events.on(name, handler)` returns an unsubscribe function. Handler exceptions are caught, so they never break the SDK.

```ts
const client = new SpreeWeClient({ apiUrl, getToken: () => clerk.session!.getToken() });
await client.connect();

const offs = [
  client.events.on('message', (m) => render(m)),
  client.events.on('typing', ({ conversationId, userId, isTyping }) => showTyping(conversationId, userId, isTyping)),
  client.events.on('call.incoming', (call) => ring(call)),
  client.events.on('error', (e) => console.warn(e.code, e.message)),
];

client.conversations.join(conversationId); // needed for typing indicators

// cleanup (e.g. component destroy)
offs.forEach((off) => off());
client.disconnect();
```

The SDK re-joins rooms and re-syncs E2EE on reconnect. For events the SDK does not map (see the tables above), use the raw socket.

### Raw socket.io-client

```ts
import { io, Socket } from 'socket.io-client';

const deviceId = sessionStorage.getItem('deviceId') ?? crypto.randomUUID();
sessionStorage.setItem('deviceId', deviceId);

const socket: Socket = io(API_URL, {
  transports: ['websocket', 'polling'],
  auth: (cb) => { getToken().then((token) => cb({ token: token ?? '', deviceId })); },
});

const joined = new Set<string>();
const join = (id: string) => { joined.add(id); socket.emit('joinConversation', id); };

const onConnect = () => {
  joined.forEach((id) => socket.emit('joinConversation', id)); // rooms do not survive reconnect
  void syncE2ee();
};
const seen = new Set<string>();
const onMessage = (m: any) => {
  if (seen.has(m._id)) return; // delivered to room and to user
  seen.add(m._id);
  handleMessage(m);
};
const onRateLimited = (p: { event: string }) => backOff(p.event);

socket.on('connect', onConnect);
socket.on('receiveMessage', onMessage);
socket.on('e2ee:to-device', syncE2ee);
socket.on('e2ee:devices-changed', syncE2ee);
socket.on('rate-limited', onRateLimited);
socket.on('connect_error', (err) => console.warn('connect failed:', err.message));

// Request/response with timeout
const res = await socket.timeout(10_000).emitWithAck('message:pin', { messageId, pinned: true });
if (res.error) throw new Error(res.error);

// cleanup
socket.off('connect', onConnect);
socket.off('receiveMessage', onMessage);
socket.off('rate-limited', onRateLimited);
socket.disconnect();
```

`emitWithAck` with `timeout` needs socket.io-client 4.6 or later. Always use a timeout: dropped events (rate limit, app-scope refusal) never get an ack.

---

## Discrepancies found while writing this page

These are recorded for the backend and SDK maintainers. They have not been fixed.

1. `developer/scopes.ts` describes `messages:write` as "Send text messages over Socket.IO", but `realtime/index.ts` always refuses `sendMessage` from app sockets. The scope has no effect today.
2. *(Fixed in `3214f33`.)* `removeUserFromRoom` now removes **every** first-party socket of the user from the conversation room (via the per-user room, cluster-wide), and `group:removed` reaches every connection. Deleting a group empties its room. Covered by `group-revocation.test.ts` with two simultaneous connections.
3. The SDK does not handle `call:pending-rings`, so SDK users can miss rings that arrive during a reconnect. The SDK also does not map `call:force-leave`, `call:settings`, `call:recording`, `call:media-state`, `call:hand`, `call:reaction`, `call:audio-levels`, `call:share-stopped`, `screen:*`, `user:updated`, `notification:read`, `meeting:updated`, `conversation:removed`, `rate-limited`, `org:*`, `team:*` or `channel:*`.
4. `group:added` has two payload shapes: `{ groupId, group }` from `group.events.ts` and `{ groupId }` from `meeting.service.ts`.
5. Ack formats are inconsistent. Some events use `{ success, ... }` / `{ error }`, while `call:getActive`, `call:session`, `screen:getState`, `call:getState` and most `mediasoup:*` events reply with raw objects. `call:start`, `call:reject`, `call:leave`, `sendMessage`, `reactToMessage` and `markMessagesRead` have no ack at all.
6. *(Fixed in `3214f33`.)* `mediasoup:syncProducers` now requires admission to that call and active participation (see the table above).
7. The `receipts:updated` "read" variant includes the reader (it is not skipped), while the "delivered" variant skips the user who marked it.
8. Some `sendMessage` failures (sender mismatch, unknown type, not a member) are dropped silently, with no `message:rejected`.
