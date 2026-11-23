# @spreewe/calls

Audio and video calls through SpreeWe's SFU (mediasoup): incoming-call prompt, call button, call
stage with screen sharing, controls, participants and host controls. `mediasoup-client` is loaded on
the first call, so pages that never call don't download it.

```bash
npm install @spreewe/core @spreewe/ui @spreewe/calls mediasoup-client
```

```html
<spreewe-provider id="sw">
  <spreewe-call-button conversation-id="…" call-type="video" label></spreewe-call-button>
  <spreewe-call-view></spreewe-call-view>          <!-- renders only during a call -->
  <spreewe-incoming-call></spreewe-incoming-call>  <!-- ringing calls, anywhere on the page -->
</spreewe-provider>
<script type="module">import "@spreewe/calls/define";</script>
```

## Scopes

`realtime:connect`, `profile:read`, `calls:read` (invites, state), `calls:write` (start, join, media,
screen sharing). Optional: `calls:manage` (host controls), `recordings:read`, `recordings:write`.
The server decides who is host (group admins / the starter) and who may record.

## Components

### `<spreewe-call-button>`
- Attributes `conversation-id`, `call-type` (`audio` | `video`), `mode` (`ring` | `meetNow`), `label`.
- Starts a call, or joins the one running in that conversation.
- Events `spreewe-call-started`, `spreewe-error`. Part `button`.

### `<spreewe-incoming-call>`
- Attributes `show-active` (also offer group calls in progress), `ringtone` (URL; no sound by default), `position` (`top-right` | `bottom-right` | `inline`).
- Events `spreewe-incoming-call` `{ invite }` (cancelable: handle it with your own UI), `spreewe-call-accepted`, `spreewe-call-declined`.
- Parts `card`, `title`, `accept`, `decline`. Token `--sw-incoming-z`.

### `<spreewe-call-view>`
- The current call: grid (presenter layout while someone shares), remote audio, header with duration,
  recording and connection state; joining / lobby / reconnecting / other-device / ended states.
- Attributes `heading`, `hide-header`, `hide-controls`.
- Events `spreewe-call-closed`, `spreewe-error`.
- Slots `header-actions`, `controls-start`, `controls-end`, `ended`, `empty`.
- Parts `stage`, `header`, `grid`, `tile`, `presenter`, `controls`, `panel`. Token `--sw-call-radius`, plus the `--sw-call-*` colours.

### `<spreewe-call-controls>`
- Mic, camera, screen, hand, reactions, participants, leave (and "end for everyone" for hosts).
- Attributes `no-screen`, `no-hand`, `no-reactions`, `no-participants`. Slots `start`, `end`. Parts `bar`, `button`, `leave`.

### `<spreewe-participant-tile>`
- Properties `stream`, `name`, `avatar`, `muted`, `mirror`, `speaking` (0–1), `hand`, `reaction`, `screen`.
- Parts `video`, `avatar`, `label`, `badge`. Token `--sw-call-speaking`.

## Service

```ts
import { getCalls } from "@spreewe/calls";
const calls = getCalls(client, { videoConstraints: { width: { ideal: 640 } } }); // options on first call only
await calls.start();                         // listen for invites
calls.invites.subscribe((list) => …);        // ringing / joinable calls
calls.state.subscribe((s) => …);             // phase, participants (MediaStreams), local media, roles
await calls.startCall(conversationId, "video");
await calls.accept(invite);
await calls.setMicrophone(false);
await calls.leave();
```

Methods: `startCall(conversationId, type, { mode })`, `accept(invite | callId, { callType })`,
`reject`, `dismiss`, `leave`, `end`, `takeOver`, `reset`, `activeCall(conversationId)`, `session()`,
`setMicrophone`, `setCamera` (upgrades an audio call), `startScreenShare`, `stopScreenShare`,
`raiseHand`, `react`, `refreshState`, host: `muteParticipant`, `muteAll`, `removeParticipant`,
`admit(userId | "all")`, `deny`, `setCohost`, `updateSettings({ lobby, allowUnmute, allowShare })`,
`startRecording`, `stopRecording`, `isModerator`.

Phases: `idle → starting → joining → (lobby) → connected ⇄ reconnecting → ended`, plus `elsewhere`
(the user is in this call on another device; `takeOver()` moves it here).

Options: `createDevice`, `getUserMedia`, `getDisplayMedia`, `audioConstraints`, `videoConstraints`,
`cameraEncodings` (default 3 simulcast layers), `syncIntervalMs`.

## Behaviour

- One media session per user (server rule). An app socket that reconnects is a new device: the
  service re-accepts, takes over and rejoins automatically.
- ICE restarts on `failed`, and on `disconnected` after 2.5 s; producers are re-listed every 10 s to
  catch missed events.
- If the camera is unavailable the call continues with the microphone, or listen-only.
- A call ends when its last participant leaves.
- **Not verified with real media** (see [production.md](../../docs/production.md)): the integration
  tests run real signaling against the real SFU with a simulated WebRTC handler.
