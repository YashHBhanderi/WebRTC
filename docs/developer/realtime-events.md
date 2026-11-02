# Real-time events (Socket.IO)

This page lists every Socket.IO event the SpreeWe backend handles or emits: payloads, acknowledgements, authorization checks, delivery rules, and the scope a developer app needs for each event. It was checked against the server source (`webrtc-BE/src/realtime/**`, `webrtc-BE/src/developer/scopes.ts`, `webrtc-BE/src/services/**`, `webrtc-BE/src/organizations/events.ts`).

Related pages:

- [Authentication](./authentication.md): Clerk session tokens, developer-app user tokens and scopes.
- [Session API](./rest-api/session-api.md) and [v1 API](./rest-api/v1-api.md): the REST endpoints you use alongside the socket (history, uploads, E2EE device sync).

**Columns used in the tables:**

- **App scope**: the scope a developer-app token must hold to send (client → server) or receive (server → client) the event, exactly as listed in `SOCKET_EVENT_SCOPES` and `DELIVERED_EVENT_SCOPES` (`webrtc-BE/src/developer/scopes.ts`). **SpreeWe clients only** means the event is not in those maps: app sockets cannot send it, or (for server → client) do not receive it through the scope-filtered paths. The server still applies the user's own permissions (membership, host role, policies) on top of the scope.
- **Tests**: the test files in `webrtc-BE/test/` that emit or assert the event, or **Not covered by tests**.

> Call media (produce / consume / resume) has server tests for admission only. No automated test runs a full audio/video session with real WebRTC.

---

## 1. Connecting

| Item | Value |
|---|---|
| URL | The backend's base URL (same host as the REST API). |
| Path | Socket.IO default `/socket.io`. |
| Transports | Socket.IO defaults (WebSocket and HTTP long-polling). |
| Handshake auth | `{ token: string, deviceId?: string }` in `auth` (not a query string or header). |
| Max message size | `SOCKET_MAX_BUFFER_BYTES` (default 5 MiB). Larger frames are dropped by Socket.IO. |
| CORS | Origins in `CORS_ORIGINS`, plus origins registered by active developer apps. No credentials (cookies are not used). Requests with no `Origin` (native apps, servers) are accepted. |

### Handshake auth

```ts
auth: {
  token: string;      // Clerk session JWT, or a developer-app user token
  deviceId?: string;  // SpreeWe clients only; must match /^[\w-]{8,64}$/
}
```

- **Missing or empty `token`**: `connect_error` with message `"Authentication error"`. You also get this for a Clerk token when the server has no Clerk configuration.
- **Clerk token rejected** (expired, wrong `azp`, clock skew): `"Invalid token"`. The `azp` check applies only when the client sends an `Origin` header.
- **Developer-app user token** (recognised by its format): verified against the live app, grant and tenant, and against the app's registered origins when an `Origin` is sent. Invalid: `"Invalid token"`. Without the `realtime:connect` scope: `"The token lacks the realtime:connect scope"`. See [Authentication](./authentication.md).
- **Workspace**: fixed at handshake time from the verified token. To switch workspace, disconnect and reconnect with a token for the other workspace.

### Token freshness

The token is checked **at connect time**. Clerk session tokens live about 60 seconds, so pass a **function** for `auth`; Socket.IO calls it on every connect and reconnect (see the example in [section 7](#7-example-raw-socketio-client)).

Sockets can be closed after they connect:

- **SpreeWe client sockets** are re-checked every `SOCKET_REVALIDATE_MS` (default 30 s) and disconnected when the workspace becomes inactive or the membership is removed. Some Clerk membership or organization changes disconnect them immediately.
- **Developer-app sockets** are disconnected when the app token expires (a timer set to the token's `exp`), and when the periodic re-check finds the token, app or grant no longer valid. Get a new token from your backend and reconnect.

### `deviceId`

- Identifies one tab or device, so a reconnect of the same tab keeps its call session. Store it per tab (for example in `sessionStorage`) and send the same value on every reconnect.
- Must match `^[\w-]{8,64}$`. Otherwise the server uses `socket.id`, which changes on every reconnect.
- **Developer-app sockets always get `deviceId = socket.id`**; the value you send is ignored. A reconnecting app socket is therefore a new device for call purposes (see [Calls from an app](#calls-from-an-app)).

### Reconnection: what the client must redo

Socket.IO reconnects automatically. On every `connect` event (not just the first):

1. **Re-join conversation rooms**: emit `joinConversation` for each open conversation. Room membership does not survive a reconnect.
2. **Re-sync E2EE**: run your to-device / key sync over REST; `e2ee:to-device` and `e2ee:devices-changed` are not replayed.
3. **Ringing calls**: the server sends `call:pending-rings` on every connect. Treat the list as authoritative and drop any ring you are showing that is not in it.
4. **Calls in progress**: a SpreeWe client has **12 seconds** to reconnect with the **same `deviceId`**. After that the server releases the socket's media and screen share, removes it from the call and broadcasts `call:participant-left`. Developer-app sockets get the same cleanup after the same 12 s, but cannot resume (their `deviceId` changes).

### Rate limits and connection caps

- Token bucket, default `SOCKET_RATE_PER_SEC` = 30 events/s refill, `SOCKET_RATE_BURST` = 120. Keyed **per user** for SpreeWe clients (shared by all of the user's sockets), and **per app and user** for developer-app sockets.
- The limit is **per server instance**, not shared across a cluster.
- When the bucket is empty the event is dropped and its ack is never called. The server emits `rate-limited` `{ event, reason? }` (SpreeWe clients: at most once a second).
- Developer-app connection caps, per instance: `quotas.maxConnections` per app, and 5 sockets per app user. Over the cap the server emits `rate-limited` `{ event: "connect", reason: "connection limit" }` and disconnects.

---

## 2. Rooms and delivery model

| Mechanism | Reaches | Used for |
|---|---|---|
| **Per-user** (`emitToUser`) | The user's **single most recent SpreeWe client socket**, plus **all** of their developer-app sockets. Conversation events are filtered by each socket's workspace; app sockets also by scope. | New messages (also sent to the room), edits, deletes, pins, receipts, notifications, call invites, group changes |
| **Conversation room** | Sockets that called `joinConversation` (or joined via `call:start` / `call:accept`) | `receiveMessage`, `userTyping`, `messageReactionUpdated`, `messagesMarkedRead` |
| **Call room** and **call peers** | Sockets in the call's room (joined by `call:accept`, `screen:join`, `mediasoup:joinCall`), or sockets registered as media peers | In-call events |
| **User room** (`notifyUserEverywhere`) | All of the user's sockets, every workspace | `e2ee:*`, `org:joined` / `org:removed` / …, `conversation:removed` |
| **Workspace** (`emitToWorkspace`) | Matching SpreeWe client sockets in that workspace. Never developer-app sockets. | `org:*`, `team:*`, `channel:*` |

Consequences:

- **Typing is room-only.** `typing` / `stopTyping` are ignored unless the sending socket is in the room, and `userTyping` goes only to the room.
- **`messageReactionUpdated` and `messagesMarkedRead` are room-only.**
- **`receiveMessage` is sent twice** (room and per user). De-duplicate by `_id`.
- **Removal applies to every connection.** When a user is removed from a group or leaves it, **every** socket of that user (all tabs, devices and developer-app connections, on every instance) leaves the conversation room, and `group:removed` reaches every connection. Deleting a group empties its room.

### How developer-app sockets receive room events

An app socket does not join rooms directly. When it joins a room (through `joinConversation`, `call:accept`, `mediasoup:joinCall`, …, with the same membership checks as SpreeWe clients), it is placed in one scope-specific copy of that room per scope the app holds. In practice:

- An app socket receives a room broadcast **only if the event is in `DELIVERED_EVENT_SCOPES` and the app holds that event's scope**. For example, `userTyping` in a joined conversation needs `messages:read`; `call:participant-joined` needs `calls:read`.
- Encrypted message content in room broadcasts follows the same rule as direct delivery (see [section 5](#5-developer-app-sockets)).
- Leaving a room, removal from a group and revocation remove the app socket from all its copies of the room, on every instance.
- App sockets are also placed in the user's own room, so `e2ee:to-device` and `e2ee:devices-changed` reach apps that hold `e2ee:device`. Workspace events (`org:*`, `team:*`, `channel:*`, `conversation:removed`) are not in the scope maps and never reach app sockets.

---

## 3. Client → server events

### Ack convention

- `onAck` handlers (`chat:*`, `group:*`, `message:edit`, `message:pin`) and most call controls reply `{ success: true, ...result }` or `{ error: string }`.
- Some events reply with **raw objects** without `success` (`call:getState`, `call:getActive`, `call:session`, `screen:getState`, `ice:getServers`, most `mediasoup:*`). Detect failure by checking `error`.
- **none**: the server never calls the ack.
- Events refused before reaching a handler (rate limit, missing app scope) never get an ack. Always use a timeout.

### Chat and messages

| Event | Payload | Ack | Authorization / notes | App scope | Tests |
|---|---|---|---|---|---|
| `joinConversation` | `conversationId: string` (bare string) | none | Joins the room only if you are a member; ignored silently otherwise. | `messages:read` | developer-api-access.test.ts, developer-api-e2ee.test.ts, group-revocation.test.ts, multi-instance.test.ts, socket-isolation.test.ts, teams-channels.test.ts, organizations-realtime.test.ts |
| `typing` | `conversationId: string` | none | Only if this socket is in the room. Broadcasts `userTyping` to the others in the room. | `messages:read` | developer-api-access.test.ts, group-revocation.test.ts, multi-instance.test.ts, socket-isolation.test.ts, teams-channels.test.ts |
| `stopTyping` | `conversationId: string` | none | Same as `typing`. | `messages:read` | Not covered by tests |
| `sendMessage` | see below | none (outcome: `receiveMessage` or `message:rejected`) | `user._id` must equal the socket's user; member; external-access policy and blocking apply. App sockets: see [Sending from an app](#sending-messages-from-an-app). | `messages:write` | developer-api-access.test.ts, developer-api-e2ee.test.ts, e2ee-real-crypto.test.ts, e2ee.test.ts, group-revocation.test.ts, multi-instance.test.ts, socket-isolation.test.ts, p0-isolation.test.ts, and others |
| `message:edit` | `{ messageId: string; e2ee: EncryptedPayload; mentions?: string[] }` | `{ success: true }` / `{ error }` | Author only. Emits `message:updated` per user. App sockets: same device check as `sendMessage` (no quota). | `messages:edit` | e2ee-real-crypto.test.ts, e2ee.test.ts |
| `message:pin` | `{ messageId: string; pinned?: boolean }` (default true) | `{ success: true, pins }` / `{ error }` | Member. Emits `message:pins` per user. | `messages:react` | e2ee-real-crypto.test.ts |
| `reactToMessage` | `{ conversationId; messageId; emoji }` (emoji ≤ 16 chars) | none | Member; message in that conversation and not deleted. Toggles. Emits `messageReactionUpdated` to the room. | `messages:react` | developer-api-access.test.ts, group-revocation.test.ts |
| `markMessagesRead` | `conversationId: string` (bare string) | none | Member. Emits `messagesMarkedRead` (room) and `receipts:updated` (per user). | `messages:read` | multi-instance.test.ts |
| `message:delivered` | `{ conversationIds: string[] }` (max 50) | none | Member conversations only. Emits `receipts:updated` to the other members. | `messages:read` | Not covered by tests |
| `chat:archive` / `chat:unarchive` | `{ conversationId }` | `{ success, conversationId, state }` / `{ error }` | Member; your own state only. | `conversations:write` | Not covered by tests |
| `chat:favorite` / `chat:unfavorite` | `{ conversationId }` | same | same | `conversations:write` | favorites.test.ts |
| `chat:clear` | `{ conversationId }` | same | same | `conversations:write` | Not covered by tests |
| `chat:block` / `chat:unblock` | `{ userId }` | `{ success, userId, blocked }` / `{ error }` | Your own block list. | `contacts:write` | Not covered by tests |

#### `sendMessage` payload

```ts
interface SendMessagePayload {
  user: { _id: string };          // must equal the authenticated user
  conversationId: string;
  type: 'text' | 'image' | 'video' | 'audio' | 'pdf' | 'file' | 'call';
  content: string;                // send '' for text/media: encrypted types are stored with ''
  e2ee: EncryptedPayload;         // required for text and media types
  storageKey?: string;            // media types: key returned by the upload endpoint
  replyTo?: string | null;        // message id in the same conversation
  mentions?: string[];            // member user ids
  fileUrl?: string;               // 'call' type only (link, max 2048 chars)
  forwardOf?: string;             // always rejected (reason "forward")
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

- **Sender mismatch, unknown type, conversation not found, not a member**: dropped silently (server log only).
- **Other refusals**: `message:rejected` `{ conversationId?, reason, message? }` to the sending socket:

| `reason` | Meaning |
|---|---|
| `policy` | Blocked by the workspace's external-access policy. |
| `blocked` | One side of the direct chat has blocked the other. |
| `attachment` | `storageKey` is invalid or not usable. |
| `forward` | `forwardOf` was sent; forwarding is not supported. |
| `unencrypted` | Missing or invalid `e2ee` payload. |
| `e2ee` | App socket only: `e2ee.device_id` is not an active encryption device this app registered for the user. |
| `quota` | App socket only (`sendMessage`): the app's daily message quota (`messagesPerDay`) is used up. |
| `error` | App socket only: the device / quota check failed unexpectedly. |

#### Sending messages from an app

`sendMessage` and `message:edit` from an app socket are accepted only when `e2ee.device_id` is one of the app's **active** encryption devices for this user (registered with the `e2ee:device` scope; see [Authentication](./authentication.md) and the device endpoints in the [v1 API](./rest-api/v1-api.md)). Each accepted `sendMessage` counts against the app's daily message quota. After these checks the normal handler runs with the same membership, policy and encryption checks as SpreeWe clients.

### Presence

| Event | Payload | Ack | Authorization / notes | App scope | Tests |
|---|---|---|---|---|---|
| `presence:set` | `{ status: 'Available' \| 'Busy' \| 'Do not disturb' \| 'Away' \| 'Appear offline'; statusMessage?: string }` | `{ success: true, presence }` / `{ error }` | Any other status is rejected. Others see "Appear offline" as offline. | `profile:write` | developer-api-access.test.ts |
| `presence:idle` | `{ idle: boolean }` | none | Sets the auto-away flag. | `profile:write` | Not covered by tests |

An app connection never marks the user online or becomes their primary socket; it only gets these two handlers.

### Groups

All group events use the `onAck` format. Admin rights are enforced in the group service.

| Event | Payload | Ack (success) | Authorization / notes | App scope | Tests |
|---|---|---|---|---|---|
| `group:update` | `{ groupId, groupName?, groupDescription?, groupAvatarKey? }` | `{ success, group }` | Emits `group:updated`. | `groups:write` | developer-api-access.test.ts |
| `group:add-member` | `{ groupId, userIds: string[] }` | `{ success, group, added }` | Emits `group:updated`, `group:added` (each added user), system `receiveMessage`. | `groups:manage` | Not covered by tests |
| `group:remove-member` | `{ groupId, userId }` | `{ success, group }` | Removes every connection of the user from the room. Emits `group:removed` (removed user), `group:updated`, system message. | `groups:manage` | e2ee-real-crypto.test.ts |
| `group:promote-admin` | `{ groupId, userId }` | `{ success, group }` | Emits `group:updated`. | `groups:manage` | Not covered by tests |
| `group:remove-admin` | `{ groupId, userId }` | `{ success, group }` | Emits `group:updated`. | `groups:manage` | Not covered by tests |
| `group:leave` | `{ groupId }` | `{ success, groupId }` | Removes every connection of the user from the room. Emits `group:removed` `{ reason: "left" }`, `group:updated`, system message. | `groups:manage` | group-revocation.test.ts |

### Calls

Errors from `call:start`, `call:accept`, `call:reject`, `call:leave` and `call:end` may also arrive as a `call:error` event `{ message }` on the calling socket.

| Event | Payload | Ack | Authorization / notes | App scope | Tests |
|---|---|---|---|---|---|
| `call:start` | `{ groupId; callType: 'audio' \| 'video'; mode?: 'ring' \| 'meetNow' }` | none; reply is `call:started` `{ callId, groupId, callType, mode, initiatedBy, resumed? }` or `call:error` | Member; not blocked; external-call policy. Default mode: video `meetNow`, audio `ring`. An active call is returned with `resumed: true`. `ring` sends `call:incoming` to the others; `meetNow` sends `call:meeting-active` to all members. | `calls:write` | call-reconnect.test.ts, developer-api-calls.test.ts, multi-instance.test.ts, socket-isolation.test.ts |
| `call:accept` | `{ callId }` | `{ success, callId }` / `{ error }` | Participant. Joins the conversation and call rooms. Emits `call:participant-joined` unless you are held in the lobby. | `calls:write` | developer-api-calls.test.ts, multi-instance.test.ts |
| `call:reject` | `{ callId }` | none | Emits `call:participant-rejected`; the ring ends when everyone has declined. | `calls:write` | Not covered by tests |
| `call:leave` | `{ callId }` | none | Leaves media, lobby and screen share. Emits `call:participant-left`. Ends the call when the last person leaves. | `calls:write` | call-reconnect.test.ts, multi-instance.test.ts |
| `call:end` | `{ callId }` | `{ success }` / `{ error }` | Member. Group calls: host only. 1:1: either side. Emits `call:ended`. | `calls:write` | developer-api-calls.test.ts |
| `call:getState` | `{ callId }` | State object (no `success`) or `{ error }`: `callId, myRole, settings, cohostIds, lobby, recording, recordingAvailable, groupId, callType, mode, callStatus, startedAt, elapsedMs, isGroup, groupName, hostIds, participants, screenSharerUserId, ...` | Non-removed participant. `lobby` filled for moderators only. | `calls:read` | developer-api-calls.test.ts |
| `call:getActive` | `{ groupId }` | `{ call: { callId, groupId, callType, mode, callStatus, initiatedBy } \| null }` | Member; non-members get `{ call: null }`. | `calls:read` | Not covered by tests |
| `call:session` | any | `{ elsewhere: boolean; callId? }` | Whether this user is live in a call on another device. | `calls:read` | Not covered by tests |
| `call:takeover` | `{ callId? }` | `{ success }` / `{ error }` | Moves the call session to this device; the other device gets `call:force-leave`. | `calls:write` | Not covered by tests |
| `call:upgrade` | `{ callId; callType?: 'video' }` | `{ success, callId, groupId, callType }` / `{ error }` | Active participant. Emits `call:media-updated` to the call room. | `calls:write` | Not covered by tests |
| `call:media-state` | `{ callId; audio: boolean; video: boolean }` | none | Media peer in that call only. Emits `call:media-state` to the other peers. | `calls:write` | Not covered by tests |
| `call:hand` | `{ callId; raised: boolean }` | none | Media peer only. | `calls:write` | Not covered by tests |
| `call:reaction` | `{ callId; emoji }` | none | Media peer; emoji from a fixed set; rate-limited per user. | `calls:write` | Not covered by tests |
| `call:mute-participant` | `{ callId; userId }` | `{ success }` / `{ error }` | Host or co-host of a group call. Target gets `call:force-muted` and is expected to mute itself (not enforced by the server). | `calls:manage` | developer-api-calls.test.ts |
| `call:mute-all` | `{ callId }` | `{ success, ... }` / `{ error }` | Moderator. | `calls:manage` | Not covered by tests |
| `call:remove-participant` | `{ callId; userId }` | `{ success }` / `{ error }` | Host or co-host; co-hosts remove attendees only. The removed user cannot rejoin this call. | `calls:manage` | Not covered by tests |
| `call:admit` | `{ callId; userId } \| { callId; all: true }` | `{ success, admitted }` / `{ error }` | Moderator. | `calls:manage` | Not covered by tests |
| `call:deny` | `{ callId; userId }` | `{ success }` / `{ error }` | Moderator. | `calls:manage` | Not covered by tests |
| `call:set-cohost` | `{ callId; userId; cohost?: boolean }` | `{ success, ... }` / `{ error }` | Host. | `calls:manage` | Not covered by tests |
| `call:settings` | `{ callId; lobby?: boolean; allowUnmute?: boolean; allowShare?: boolean }` | `{ success, settings }` / `{ error }` | Moderator. Emits `call:settings`. | `calls:manage` | Not covered by tests |
| `call:record-start` | `{ callId }` | `{ success, ... }` / `{ error }` | Host or co-host; recording must be enabled on the server. | `recordings:write` | developer-api-calls.test.ts |
| `call:record-stop` | `{ callId }` | same | same | `recordings:write` | Not covered by tests |

### Screen share lock

| Event | Payload | Ack | Authorization / notes | App scope | Tests |
|---|---|---|---|---|---|
| `screen:join` | `{ callId }` | `{ success }` / `{ error }` | Active participant. Joins the call room. | `calls:write` | socket-isolation.test.ts |
| `screen:start` | `{ callId }` | `{ success }` / `{ error, sharerUserId? }` | One sharer at a time; `allowShare` applies. Emits `screen:started`. | `calls:write` | Not covered by tests |
| `screen:stop` | `{ callId }` | `{ success }` / `{ error }` | Releases your own lock. Emits `screen:stopped`. | `calls:write` | Not covered by tests |
| `screen:getState` | `{ callId }` | `{ sharerUserId: string \| null; error? }` | Active participant. | `calls:write` | socket-isolation.test.ts |

A socket's screen-share lock is released when it disconnects.

### Media (mediasoup) and ICE

**Admission rule:** `mediasoup:createSendTransport`, `mediasoup:createRecvTransport`, `mediasoup:connectTransport` and `mediasoup:restartIce` require that this socket has completed a **successful, non-lobby** `mediasoup:joinCall` for a call in which the user is still an active participant. Otherwise:

```ts
{ error: 'Join the call before using media', code: 'NOT_JOINED' }
```

| Event | Payload | Ack (success) | Errors / notes | App scope | Tests |
|---|---|---|---|---|---|
| `mediasoup:joinCall` | `{ callId; callType: 'audio' \| 'video' }` | `{ success: true, producers: ProducerInfo[] }` or `{ lobby: true }` | `callId is required`, `Invalid callType`, `Not a participant of this call`, `{ error, code: 'IN_CALL_ELSEWHERE' }`. Joins the call room. | `calls:write` | developer-api-calls.test.ts, media-admission.test.ts, socket-isolation.test.ts |
| `mediasoup:getRouterRtpCapabilities` | none | `{ rtpCapabilities }` | `{ error }` | `calls:write` | developer-api-calls.test.ts |
| `mediasoup:createSendTransport` | none | `{ id, iceParameters, iceCandidates, dtlsParameters, ...iceConfig, reused? }` | `NOT_JOINED`. Reuses a not-yet-connected transport. | `calls:write` | developer-api-calls.test.ts, media-admission.test.ts |
| `mediasoup:createRecvTransport` | none | same | `NOT_JOINED` | `calls:write` | media-admission.test.ts |
| `mediasoup:connectTransport` | `{ transportId; dtlsParameters }` | `{ connected: true }` | `NOT_JOINED`, `Transport not found` | `calls:write` | media-admission.test.ts |
| `mediasoup:restartIce` | `{ transportId }` | `{ iceParameters, ...iceConfig }` | `NOT_JOINED`, `Transport not found` | `calls:write` | media-admission.test.ts |
| `mediasoup:produce` | `{ transportId; kind: 'audio' \| 'video'; rtpParameters; appData?: { source?: 'screen' } }` | `{ id }` | `Peer not found`, `Send transport not found`, `Invalid transport`, `Peer is not associated with a call`, `Invalid kind`, screen share not allowed. Emits `mediasoup:newProducer`. | `calls:write` | Not covered by tests |
| `mediasoup:closeProducer` | `{ producerId }` | `{ success: true }` | Succeeds even if already gone. | `calls:write` | Not covered by tests |
| `mediasoup:consume` | `{ producerId; rtpCapabilities }` | `{ id, producerId, kind, rtpParameters, type, source }` | `Peer not found`, `Receive transport not found`, `Cannot consume this producer`, `Producer not found in this call` | `calls:write` | socket-isolation.test.ts |
| `mediasoup:resumeConsumer` | `{ consumerId }` | `{ success: true }` | `Peer not found`, `Consumer not found` | `calls:write` | Not covered by tests |
| `mediasoup:setPreferredLayers` | `{ consumerId; spatialLayer; temporalLayer }` | `{ success: true, ignored? }` | `Consumer not found`, `Invalid layers` | `calls:write` | Not covered by tests |
| `mediasoup:syncProducers` | `{ callId }` | `{ producers: ProducerInfo[] }` | No `callId`: `{ producers: [] }`. Requires admission to **that** call and active participation, re-checked on every request; otherwise `{ producers: [], error, code: 'NOT_JOINED' }`. | `calls:write` | developer-api-calls.test.ts, media-admission.test.ts |
| `ice:getServers` | none | ICE config (STUN/TURN, per-user credentials) | none | `calls:write` | developer-platform.test.ts, socket-isolation.test.ts |

`ProducerInfo = { producerId: string; userId: string; kind: 'audio' | 'video'; source: 'camera' | 'screen' }`.

#### Calls from an app

An app socket uses the same call and media handlers as SpreeWe clients and joins as another device of the user. The server allows one media session per user: if the user is already in a call on another device, `mediasoup:joinCall` returns `IN_CALL_ELSEWHERE` (use `call:session` / `call:takeover` to move it). When an app socket disconnects, its screen share is released immediately and its call session is cleaned up after the 12-second grace period.

---

## 4. Server → client events

**Receives** column: **user** = per-user delivery (section 2); **room** = conversation room; **call room** / **call peers**; **socket** = only the socket that acted; **everywhere** = user room; **workspace** = matching SpreeWe client sockets in that workspace.

### Chat, messages, presence

| Event | Payload | Receives | App scope | Tests |
|---|---|---|---|---|
| `receiveMessage` | `{ _id, userId, conversationId, type, content: '', e2ee, replyTo, mentions, reactions, createdAt, user, status: 'sent', ...media }`. System and call messages have plaintext `content`. | room **and** user (de-duplicate by `_id`) | `messages:read` | developer-api-access.test.ts, developer-api-e2ee.test.ts, e2ee-real-crypto.test.ts, group-revocation.test.ts, multi-instance.test.ts, socket-isolation.test.ts, and others |
| `message:rejected` | `{ conversationId?, reason, message? }` | socket | `messages:read` (emitted directly to the sending socket) | developer-api-e2ee.test.ts, developer-platform.test.ts, e2ee-real-crypto.test.ts, e2ee.test.ts |
| `message:updated` | `{ conversationId, messageId, userId, e2ee, editedAt, mentions }` | user (all members) | `messages:read` | e2ee-real-crypto.test.ts |
| `message:deleted` | `{ conversationId, messageId }` | user (all members) | `messages:read` | Not covered by tests |
| `message:pins` | `{ conversationId, pins }` | user (all members) | `messages:read` | Not covered by tests |
| `messageReactionUpdated` | `{ conversationId, messageId, reactions }` | room | `messages:read` | developer-api-access.test.ts, group-revocation.test.ts |
| `messagesMarkedRead` | `{ conversationId, userId }` | room | `messages:read` | multi-instance.test.ts |
| `receipts:updated` | read: `{ conversationId, userId, readAt, deliveredAt }`; delivered: `{ conversationId, userId, deliveredAt }` | user (members; the delivered variant skips the user who marked it) | `messages:read` | Not covered by tests |
| `userTyping` | `{ conversationId, userId, isTyping }` | room (not the sender) | `messages:read` | developer-api-access.test.ts, group-revocation.test.ts, multi-instance.test.ts, socket-isolation.test.ts, teams-channels.test.ts |
| `user:presence` | `{ userId, isOnline, status, statusMessage, autoAway, inCall, ... }`; your own sockets also get `ownStatus` | contacts allowed to see you (judged per socket, app sockets included), plus yourself | `realtime:connect` | multi-instance.test.ts, p0-isolation.test.ts |
| `user:updated` | `{ _id, username, avatar, bio, status }` | user (everyone sharing a conversation with you) | SpreeWe clients only | Not covered by tests |
| `notification:new` | `{ _id, type, actor, conversationId, messageId, callId, meetingId, recordingId, text, read, createdAt }` | user | `notifications:read` | developer-platform.test.ts |
| `notification:read` | `{ unread: number }` | user | `notifications:read` | Not covered by tests |
| `rate-limited` | `{ event: string; reason?: string }` | socket | `realtime:connect` | socket-isolation.test.ts |

### Conversations, groups, meetings, recordings

| Event | Payload | Receives | App scope | Tests |
|---|---|---|---|---|
| `group:added` | `{ groupId, group }` from group changes; `{ groupId }` only from meeting invites | user | `groups:read` | Not covered by tests |
| `group:removed` | `{ groupId, reason: 'removed' \| 'left' \| 'deleted', by? }` | every connection of the user | `groups:read` | group-revocation.test.ts |
| `group:updated` | `{ groupId, group }` | user (members) | `groups:read` | developer-api-access.test.ts |
| `conversation:removed` | `{ conversationId }` | everywhere | SpreeWe clients only | Not covered by tests |
| `meeting:updated` | `{ meetingId }` | user | `meetings:read` | Not covered by tests |
| `recording:updated` | `{ recordingId, conversationId, status, transcriptStatus, startedBy, title }` | user (members) | `recordings:read` | Not covered by tests |

### Calls

| Event | Payload | Receives | App scope | Tests |
|---|---|---|---|---|
| `call:started` | `{ callId, groupId, callType, mode, initiatedBy, resumed? }` | socket (caller) | `calls:read` | call-reconnect.test.ts, developer-api-calls.test.ts, developer-platform.test.ts |
| `call:error` | `{ message }` | socket | `calls:read` | developer-api-calls.test.ts, socket-isolation.test.ts |
| `call:incoming` | `{ callId, groupId, callType, mode, initiatedBy }` | user (members except caller), `ring` mode | `calls:read` | developer-api-calls.test.ts, multi-instance.test.ts |
| `call:meeting-active` | same | user (all members), `meetNow` mode | `calls:read` | Not covered by tests |
| `call:pending-rings` | `{ calls: Array<{ callId, groupId, callType, mode, initiatedBy, resent: true }> }` | socket, on every connect | `calls:read` | call-reconnect.test.ts |
| `call:force-leave` | `{ callId, reason: 'other-device' }` | the other device's socket | SpreeWe clients only (not in the scope maps; sent directly to the socket) | Not covered by tests |
| `call:participant-joined` | `{ callId, userId }` | call room | `calls:read` | developer-api-calls.test.ts, multi-instance.test.ts |
| `call:participant-left` | `{ callId, userId, removed? }` | call room | `calls:read` | multi-instance.test.ts |
| `call:participant-rejected` | `{ callId, userId }` | call room | `calls:read` | Not covered by tests |
| `call:ended` | `{ callId, groupId, callStatus, endedBy?, reason? }` | call room **and** user (all members) | `calls:read` | developer-api-calls.test.ts, multi-instance.test.ts |
| `call:media-updated` | `{ callId, groupId, callType }` | call room | `calls:write` | Not covered by tests |
| `call:media-state` | `{ callId, userId, audio, video }` | call peers (not the sender) | SpreeWe clients only (not in the scope maps; see [Known limitations](#6-known-limitations)) | Not covered by tests |
| `call:hand` | `{ callId, userId, raised }` | call peers (not the sender) | `calls:write` | Not covered by tests |
| `call:reaction` | `{ callId, userId, emoji }` | call peers (not the sender) | `calls:write` | Not covered by tests |
| `call:audio-levels` | `{ callId, levels }` | call peers | `calls:write` | Not covered by tests |
| `call:force-muted` | `{ callId, by?, all?, locked? }` | target peer socket(s) | `calls:write` | developer-api-calls.test.ts |
| `call:removed` | `{ callId, by }` | removed user's peer socket | `calls:write` | Not covered by tests |
| `call:lobby` | `{ callId, waiting }` | moderators' peer sockets | `calls:write` | Not covered by tests |
| `call:admitted` | `{ callId }` | user | `calls:write` | Not covered by tests |
| `call:denied` | `{ callId }` | user | `calls:write` | Not covered by tests |
| `call:settings` | `{ callId, settings, cohostIds }` | call room | `calls:write` | Not covered by tests |
| `call:share-stopped` | `{ callId, reason: 'not-allowed' }` | user (the sharer) | `calls:write` | Not covered by tests |
| `call:recording` | `{ callId, active: true, startedAt, by, byName }` or `{ callId, active: false, reason }` | call peers | `recordings:read` | Not covered by tests |
| `screen:started` | `{ callId, userId }` | call room | `calls:write` | Not covered by tests |
| `screen:stopped` | `{ callId, userId }` | call room | `calls:write` | Not covered by tests |
| `mediasoup:newProducer` | `{ producerId, userId, kind, source }` | call room and each peer (de-duplicate by `producerId`) | `calls:write` | Not covered by tests |
| `mediasoup:producerClosed` | `{ producerId, userId, source, consumerId? }` | call room, or the consuming socket | `calls:write` | Not covered by tests |

### E2EE

| Event | Payload | Receives | App scope | Tests |
|---|---|---|---|---|
| `e2ee:to-device` | `{}` | everywhere (recipients of to-device messages) | `e2ee:device` | Not covered by tests |
| `e2ee:devices-changed` | `{ users: string[] }` (Matrix-style user ids) | everywhere (peers of a user whose device list changed) | `e2ee:device` | Not covered by tests |

What to do:

- **`e2ee:to-device`**: to-device messages (usually room keys) are waiting for one of the user's devices. Run your sync, then retry decrypting messages that failed with a missing key.
- **`e2ee:devices-changed`**: refresh those users' device keys before encrypting the next message, so new devices get the room key and revoked ones do not.
- Run a sync after every reconnect; these events are not replayed.

### Organizations, teams, channels

These go only to SpreeWe client sockets; none is in the scope maps (**App scope: SpreeWe clients only** for every row). Payloads carry ids only; re-fetch details over REST.

| Event | Payload | Receives | Tests |
|---|---|---|---|
| `org:updated` | `{ organizationId }` | workspace (everyone) | organizations-realtime.test.ts |
| `org:members-changed` | `{ organizationId }` | workspace, non-guest roles | organizations-realtime.test.ts |
| `org:invitations-changed` | `{ organizationId }` | workspace, non-guests or admins (depends on invite policy) | Not covered by tests |
| `org:join-request-created` | `{ organizationId, requestId }` | workspace admins | organizations-realtime.test.ts |
| `org:join-requests-changed` | `{ organizationId }` | workspace admins | Not covered by tests |
| `org:role-changed` | `{ organizationId, role }` | the affected user in the workspace | organizations-realtime.test.ts |
| `org:joined` | `{ organizationId, clerkOrgId, name, role }` | everywhere | Not covered by tests |
| `org:removed` | `{ organizationId, reason }` | everywhere | organizations-realtime.test.ts |
| `org:deleted` | `{ organizationId }` | everywhere | Not covered by tests |
| `org:invitation` | `{ organizationId, invitationId, name }` | everywhere | organizations-realtime.test.ts |
| `org:invitation-revoked` | `{ organizationId, invitationId }` | everywhere | Not covered by tests |
| `org:join-request` | `{ organizationId, name, status }` | everywhere | Not covered by tests |
| `team:changed` | `{ teamId, change }` | workspace (team viewers) | Not covered by tests |
| `team:members-changed` | `{ teamId }` | workspace (team viewers) | Not covered by tests |
| `team:channels-changed` | `{ teamId }` | workspace (team viewers) | Not covered by tests |
| `team:joined` | `{ teamId, name }` | listed users | organizations-realtime.test.ts |
| `team:removed` | `{ teamId }` | the removed user | organizations-realtime.test.ts |
| `channel:created` | `{ teamId, channelId, name }` | channel members | organizations-realtime.test.ts |
| `channel:joined` | `{ teamId, channelId }` | listed users | Not covered by tests |
| `channel:members-changed` | `{ teamId, channelId }` | channel members | Not covered by tests |
| `channel:removed` | `{ teamId, channelId }` | removed users | Not covered by tests |

---

## 5. Developer-app sockets

A socket that connects with a developer-app user token (`realtime:connect` required):

- **Inbound events:** only events in `SOCKET_EVENT_SCOPES` whose scope the app holds. Anything else is refused with the error `"Not available to this app"` and no ack.
- **Outbound events:** events delivered per user or through rooms reach the app socket only if they are in `DELIVERED_EVENT_SCOPES` and the app holds that scope. Events emitted directly to the acting socket (acks, `call:started`, `call:error`, `call:pending-rings`, `message:rejected`, `rate-limited`) and to media peers are not scope-filtered, but you can only trigger them with events your scopes allow.
- **Rooms:** `joinConversation` and the call events put the socket in rooms, with the room rules in [section 2](#how-developer-app-sockets-receive-room-events).
- **Message content:** apps **without** `e2ee:device` receive encrypted messages as `{ ...payload, e2ee: undefined, content: null, encrypted: true }`. Apps **with** `e2ee:device` receive the ciphertext (`e2ee`) and decrypt it with their own device, like SpreeWe clients. System and call messages keep plaintext `content` in both cases.
- **Sending:** see [Sending messages from an app](#sending-messages-from-an-app).
- **Calls:** see [Calls from an app](#calls-from-an-app).
- **Presence:** the app connection does not mark the user online. It receives `user:presence` for people visible in its context.
- **Workspace visibility:** conversation events are delivered only if the token's context can see the conversation.
- **Lifetime:** disconnected at token expiry; reconnect with a new token from your backend.

---

## 6. Known limitations

These are true of the current code.

1. **Per-user events reach only the latest SpreeWe client socket.** `emitToUser` delivers to the user's most recently connected first-party socket (plus all app sockets). With two tabs or devices, only the latest receives direct events such as `call:incoming`, `message:updated`, `receipts:updated`, `notification:new`. Room events reach every socket that joined the room. Workaround: `joinConversation` on each socket and re-fetch state over REST when a tab gains focus. (Removal from rooms and `group:removed` are not affected; they reach every connection.)
2. **Developer-app sockets cannot resume a call after reconnecting**, because their `deviceId` is always the new `socket.id`.
3. **`call:media-state` is not in `DELIVERED_EVENT_SCOPES`**, but it is sent directly to each media peer's socket, so an app socket that joined media (which needs `calls:write`) receives it anyway.
4. **`group:added` has two payload shapes**: `{ groupId, group }` (group changes) and `{ groupId }` (meeting invites).
5. **Ack formats are inconsistent** (see [Ack convention](#ack-convention)). `call:start`, `call:reject`, `call:leave`, `sendMessage`, `reactToMessage`, `markMessagesRead` and `typing` have no ack.
6. **Some `sendMessage` failures are silent** (sender mismatch, unknown type, not a member): no `message:rejected`.
7. **`receipts:updated`**: the "read" variant includes the reader; the "delivered" variant skips the user who marked it.
8. **Rate limits and app connection caps are per server instance**, not cluster-wide.

---

## 7. Example (raw socket.io-client)

```ts
import { io, Socket } from 'socket.io-client';

// SpreeWe clients: a stable per-tab id. Developer apps: deviceId is ignored by the server.
const deviceId = sessionStorage.getItem('deviceId') ?? crypto.randomUUID();
sessionStorage.setItem('deviceId', deviceId);

const socket: Socket = io(API_URL, {
  transports: ['websocket', 'polling'],
  // Called on every connect and reconnect, so each attempt gets a fresh token
  // (a Clerk session token, or an app user token from your backend).
  auth: (cb) => { getToken().then((token) => cb({ token: token ?? '', deviceId })); },
});

const joined = new Set<string>();
const join = (conversationId: string) => {
  joined.add(conversationId);
  socket.emit('joinConversation', conversationId);
};

const onConnect = () => {
  joined.forEach((id) => socket.emit('joinConversation', id)); // rooms do not survive a reconnect
  void syncE2ee();                                             // key events are not replayed
};
const seen = new Set<string>();
const onMessage = (m: { _id: string }) => {
  if (seen.has(m._id)) return; // delivered to the room and to the user
  seen.add(m._id);
  handleMessage(m);
};
const onTyping = (p: { conversationId: string; userId: string; isTyping: boolean }) => showTyping(p);
const onPendingRings = (p: { calls: unknown[] }) => replaceRings(p.calls);
const onRateLimited = (p: { event: string; reason?: string }) => backOff(p.event);
const onConnectError = (err: Error) => console.warn('connect failed:', err.message);

socket.on('connect', onConnect);
socket.on('connect_error', onConnectError);
socket.on('receiveMessage', onMessage);
socket.on('userTyping', onTyping);
socket.on('call:pending-rings', onPendingRings);
socket.on('e2ee:to-device', syncE2ee);
socket.on('e2ee:devices-changed', syncE2ee);
socket.on('rate-limited', onRateLimited);

join(conversationId);

// Request/response: always use a timeout (refused or rate-limited events never get an ack)
const res = await socket.timeout(10_000).emitWithAck('message:pin', { messageId, pinned: true });
if (res.error) throw new Error(res.error);

// Cleanup (e.g. component unmount)
socket.off('connect', onConnect);
socket.off('connect_error', onConnectError);
socket.off('receiveMessage', onMessage);
socket.off('userTyping', onTyping);
socket.off('call:pending-rings', onPendingRings);
socket.off('e2ee:to-device', syncE2ee);
socket.off('e2ee:devices-changed', syncE2ee);
socket.off('rate-limited', onRateLimited);
socket.disconnect();
```

`emitWithAck` with `timeout` needs socket.io-client 4.6 or later. `getToken`, `syncE2ee`, `handleMessage` and the other helpers are your own code.
