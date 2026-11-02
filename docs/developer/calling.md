# Audio and video calls

Calls run in two layers: **signaling** over the SpreeWe Socket.IO connection (start, ring, accept, leave, host controls) and **media** over a mediasoup SFU (WebRTC). The SDK covers both: `client.calls.*` for signaling and `client.calls.join()` → `CallMedia` (`packages/chat-sdk/src/calls-media.ts`) for media.

Related: [Recordings](./recordings.md) · [SDK reference](./sdk-reference.md) · [Real-time events](./realtime-events.md) · [Session REST API](./rest-api/session-api.md) · [Authentication](./authentication.md)

## Status

| Area | Status |
|---|---|
| Signaling: start (ring) → incoming → accept → participant joined → state / active → end | **Tested via SDK** (`webrtc-BE/test/sdk-e2e.test.ts`, real backend, Node) |
| Media (`calls.join`, `CallMedia`: mic, camera, remote streams, lobby wait) | **Implemented, not tested in a real browser.** WebRTC cannot run in the Node test; the test only checks that `join()` fails with a clear error there. |
| Host controls (`calls.controls.*`), lobby, Meet Now | Implemented, not tested via the SDK |
| Screen sharing | **Not implemented in the SDK.** The server supports it (`screen:join`, `screen:start`, `screen:stop`, `screen:getState`, and producers with `appData.source = 'screen'`), and the SpreeWe web app uses it. |

**No calling media has been tested in a real browser through the SDK.** Test on your target browsers and networks before production use.

## Call model

- A call always belongs to a **conversation** (direct or group). Only members of that conversation can start, see or join it. One active call per conversation: starting while one is running returns the running call (`resumed: true` from the server).
- **Modes:**
  - `ring` (SDK default): members get `call.incoming` and a ring timer runs (`CALL_RING_TIMEOUT_MS`, default 45 s). In a 1:1 call, a decline (or every invitee declining a group ring) ends the call.
  - `meetNow`: no ring; members get `call.started` (server event `call:meeting-active`) and can join when they want.
- **Roles** (`meeting-controls.service.ts`, `call-session.service.ts`):
  - 1:1 calls: both people are hosts.
  - Group calls: **host** = whoever started the call (`initiatedBy`) or any admin of the group (`isCallHost`); **co-host** = appointed by a host for this call; everyone else is an **attendee**.
- **Lobby:** in group calls with the lobby setting on, attendees who have not been admitted wait in the lobby and get no media transports until a host or co-host admits them. Hosts and co-hosts never wait. The lobby is turned on by a scheduled meeting's default or by the `call:settings` socket event; **the SDK has no method to change meeting settings.**
- Blocked contacts cannot call each other. External conversations need the workspace's call policy.

## Lifecycle with the SDK

### Caller

```ts
const call = await client.calls.start(conversationId, 'video');            // ring
// or: await client.calls.start(conversationId, 'video', 'meetNow');
// call: { callId, conversationId, callType, mode, initiatedBy }

client.events.on('call.participant-joined', ({ callId, userId }) => ...);
client.events.on('call.participant-rejected', ({ callId, userId }) => ...);
client.events.on('call.ended', ({ callId }) => media?.close());

const media = await client.calls.join(call.callId, call.callType, {
  onRemoteStream: (userId, stream) => attachVideo(userId, stream),
  onRemoteLeft: (userId) => removeVideo(userId),
  onLobby: () => showWaiting(),
});
localVideo.srcObject = media.localStream;
```

`calls.start()` resolves on the server's `call:started` and rejects with `REJECTED` on `call:error`, or `TIMEOUT` after 10 s. Note: it listens to *any* `call:error` on the socket while waiting, so an unrelated call error in that window rejects it.

### Callee

```ts
client.events.on('call.incoming', async (c) => {
  if (!(await askUser(c))) { client.calls.reject(c.callId); return; }
  await client.calls.accept(c.callId);
  const media = await client.calls.join(c.callId, c.callType, { onRemoteStream });
});
```

### During and after

```ts
media.setMicEnabled(false);       // pauses the local producer (others stop receiving audio)
media.setCameraEnabled(false);
client.calls.controls.mediaState(callId, /*audio*/ false, /*video*/ true); // tell others, for UI icons

media.close();                    // release camera / mic and transports locally
client.calls.leave(callId);       // leave on the server (the call stays up until the last person leaves)
await client.calls.end(callId);   // end for everyone

const state  = await client.calls.state(callId);
const active = await client.calls.active(conversationId);  // running call or null
const history = await client.calls.history();              // call history of the active workspace
```

- `end`: 1:1 calls — either person; group calls — **host only** ("Only the host can end the meeting for everyone"). Attendees use `leave`.
- `media.close()` does not leave the call on the server; always call `calls.leave()` too.
- `setMicEnabled` / `setCameraEnabled` only pause client-side producers. Use `controls.mediaState` so other clients can show the state.

### Media join order (`CallMedia.join`)

1. Check WebRTC is available (`RTCPeerConnection`, `navigator.mediaDevices`), else throw "Calls need a browser with WebRTC".
2. Load the mediasoup `Device` with `mediasoup:getRouterRtpCapabilities`.
3. `mediasoup:joinCall` (admission). If the reply is `{ lobby: true }`, call `onLobby` and wait for `call:admitted`, then retry.
4. Create send and receive transports — **only after admission**. The server refuses transports to a socket that has not joined, or was removed, with `{ error, code: 'NOT_JOINED' }` (SEC-005).
5. `getUserMedia({ audio: true, video: callType === 'video' })`.
6. Produce each local track.
7. Consume every existing producer from other participants, then new ones as `mediasoup:newProducer` arrives; closed producers are dropped.

Errors from media signaling are thrown as plain `Error` with an optional `code` property (not `SpreeWeError`).

**Known SDK issue:** if a host **denies** a lobby request, `join()` never resolves or rejects (it only listens for `call:admitted`). Listen for `call.denied` / `call.removed` yourself, call `media.close()` and drop the pending promise.

### One active call per user

A user can be in media for one call on one device at a time. If the user is already in a call on another live device, `mediasoup:joinCall` fails with `code: 'IN_CALL_ELSEWHERE'` ("You're already in a call on another device"). A dead session elsewhere is taken over automatically. The server also supports an explicit move (`call:session`, `call:takeover`), which the SDK does not expose.

## Media permissions and browser requirements

- `getUserMedia` requires a **secure context**: HTTPS, or `http://localhost` during development. On plain HTTP, `navigator.mediaDevices` is undefined and `join()` throws.
- The browser asks the user for microphone (and camera for video calls) permission. If denied, `getUserMedia` throws (`NotAllowedError`) after transports have already been created; call `media.close()` and `calls.leave()`.
- The SDK requests default devices only. No device selection, switching, simulcast layer control or ICE-restart handling (the SpreeWe web app has these).
- `mediasoup-client` is loaded with a dynamic `import()`; your bundler must include it.

## Participant management (host / co-host)

```ts
await client.calls.controls.admit(callId, userId);      // or admit(callId) to admit everyone waiting
await client.calls.controls.deny(callId, userId);
await client.calls.controls.setCohost(callId, userId, true);
await client.calls.controls.muteParticipant(callId, userId);
await client.calls.controls.removeParticipant(callId, userId);
```

| Action | Who may | Notes |
|---|---|---|
| admit / deny | host or co-host (group calls) | waiting list arrives as `call.lobby`; admitted user gets `call.admitted`, denied `call.denied` |
| setCohost | host only | target must be in the meeting; hosts cannot be made co-host |
| muteParticipant | host or co-host, group calls only; **caller must be in the call's media** | the server only sends `call:force-muted` to the target; the target client must mute itself (`media.setMicEnabled(false)`) |
| removeParticipant | host or co-host, group calls only; caller must be in media | co-hosts remove attendees only; hosts remove attendees and co-hosts; nobody removes a host or themselves. Removed users get `call.removed`, their media is closed, and they cannot rejoin this call. |
| startRecording / stopRecording | see [recordings.md](./recordings.md) | |

Not in the SDK: change meeting settings (lobby, allow unmute, allow share), mute all, hand raise, in-call reactions, upgrade audio→video.

Attendee media policy is enforced on the server: if attendees may not unmute, their audio producer is paused server-side until allowed.

## Running your own SpreeWe backend: media configuration

All values are read from environment variables in `webrtc-BE/src/utils/network.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `MEDIASOUP_ANNOUNCED_ADDRESS` | **required in production**; dev: first LAN IPv4, else `127.0.0.1` | Public IP or DNS name that browsers connect to. A private IP in production logs a warning (external clients cannot reach it). |
| `MEDIASOUP_LISTEN_IP` | `0.0.0.0` | Local interface mediasoup binds to |
| `MEDIASOUP_RTC_PORT` | `40000` | The single RTC port for all transports (UDP and ICE-TCP) |
| `MEDIASOUP_ENABLE_UDP` | `true` | At least one of UDP / TCP must be on |
| `MEDIASOUP_ENABLE_TCP` | `true` | ICE-TCP fallback when UDP is blocked |
| `MEDIASOUP_INITIAL_OUTGOING_BITRATE` | `1000000` | bps |
| `MEDIASOUP_MAX_INCOMING_BITRATE` | `5000000` | bps per transport |
| `MEDIASOUP_MAX_OUTGOING_BITRATE` | `0` | bps; 0 = no limit |
| `MEDIASOUP_KEYFRAME_REQUEST_DELAY_MS` | `500` | coalesces keyframe requests for video producers |
| `MEDIASOUP_LOG_LEVEL` | `warn` | `debug`, `warn`, `error`, `none` |
| `MEDIA_DEBUG_STATS` | `false` | extra media statistics logging |
| `STUN_URLS` | — | comma-separated, e.g. `stun:stun.example.com:3478` |
| `TURN_URLS` | — | comma-separated, e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349` |
| `TURN_SECRET` | — | shared secret for coturn `use-auth-secret` (recommended) |
| `TURN_USERNAME` / `TURN_CREDENTIAL` | — | static TURN credentials (used only without `TURN_SECRET`) |
| `TURN_CREDENTIAL_TTL` | `86400` | lifetime in seconds of generated TURN credentials |
| `ICE_TRANSPORT_POLICY` | `all` | `relay` forces TURN only (requires `TURN_URLS`) |
| `MEDIA_TEST_TCP_TUNNEL_HOST` / `_PORT` | — | **test only**, refused in production: extra TCP candidate for a tunnel such as `ngrok tcp 40000` |
| `CALL_RING_TIMEOUT_MS` | `45000` | ring timeout (`call-session.service.ts`) |

Startup fails if `TURN_URLS` is set without `TURN_SECRET` or a username/credential pair, if `ICE_TRANSPORT_POLICY=relay` without `TURN_URLS`, or if both UDP and TCP are disabled.

### TURN credentials

ICE servers are returned to each client with every transport (`getClientIceConfig(userId)`). With `TURN_SECRET`, credentials are short-lived and per user (TURN REST API scheme, as used by coturn `use-auth-secret`):

```
username   = "<unix expiry = now + TURN_CREDENTIAL_TTL>:<userId>"
credential = base64( HMAC-SHA1( TURN_SECRET, username ) )
```

The secret never leaves the server. With static `TURN_USERNAME` / `TURN_CREDENTIAL`, the same credentials are handed to every client; prefer `TURN_SECRET`.

### Ports and network

- Open `MEDIASOUP_RTC_PORT` (default 40000) for **UDP and TCP** inbound to the media server. All transports share this one port (mediasoup `WebRtcServer`); no port range is needed.
- Only the announced address is advertised as an ICE candidate; internal IPs are not exposed.
- The HTTPS / WebSocket port of the API (behind your reverse proxy) must allow WebSocket upgrades for Socket.IO.
- TURN (your own coturn or a provider) typically needs 3478 UDP/TCP and 5349 TLS plus its relay port range; configure it according to your TURN server.
- Recording uses local loopback UDP ports `RECORDING_PORT_MIN`–`MAX` (51000–51999); no firewall change is needed ([recordings.md](./recordings.md)).
- Clients behind restrictive firewalls need either ICE-TCP to port 40000 or TURN over TLS (443/5349).

### Known limitation: single mediasoup worker (SEC-007, open)

The server runs **one mediasoup worker and one router** for all calls (`mediasoup.service.ts`). Consequences:

- media capacity is limited to one CPU core per server process;
- if the worker dies, the process exits after 2 s (`process.exit(1)`), dropping every call and socket on that instance.

A worker pool is planned (see `docs/audit/phase-0b-audit-report.md`), not implemented. Size and supervise instances (restart on exit) accordingly.

## Events

| SDK event | When |
|---|---|
| `call.incoming` | ring call started in one of your conversations (not sent to the caller) |
| `call.started` | Meet Now opened (server `call:meeting-active`). **Not** emitted for ring calls. |
| `call.participant-joined` / `-left` / `-rejected` | participant changes (`-left` carries `removed: true` when removed by a host) |
| `call.ended` | call over, for everyone |
| `call.lobby` / `call.admitted` / `call.denied` / `call.removed` | lobby and moderation |
| `call.force-muted` | a host asked you to mute |
| `call.media-updated` | someone's mic / camera indicator changed |
| `call.error` | server error for a call operation |

Server events such as `call:recording` and `call:settings` are not mapped by the SDK. See [realtime-events.md](./realtime-events.md).
