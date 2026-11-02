# @spreewe/chat-angular reference

Package: `@spreewe/chat-angular` `0.1.0-prototype` (private, not published to npm). Source: `packages/chat-angular/src`.

Angular UI components for SpreeWe chat and calling, built on [`@spreewe/chat-sdk`](./sdk-reference.md). They are **new components written on top of the SDK** that follow the SpreeWe web app's look (colours, layout). They are **not** extracted from the SpreeWe web app and do not reuse its components, services or styles.

> **Status of every component: Build passes (strict templates); not yet tested in a real browser.**
> No unit or end-to-end tests exist for this package. The underlying SDK has also not been tested in a real browser (see [sdk-reference.md](./sdk-reference.md)).

Characteristics of all components:

- Standalone components (`standalone: true`); import them directly, no NgModule.
- `ChangeDetectionStrategy.OnPush`.
- SDK events arrive outside Angular's zone; the components re-enter with `NgZone.run(...)` and call `markForCheck()`.
- No global CSS. Styles are component-scoped and themed through `--spw-*` CSS custom properties.
- Every component needs a **connected** `SpreeWeClient` (`await client.connect()` before rendering).

---

## Requirements

Peer dependencies (`packages/chat-angular/package.json`):

| Package | Range |
|---|---|
| `@angular/common` | `>=16.2.0 <17` |
| `@angular/core` | `>=16.2.0 <17` |
| `@angular/forms` | `>=16.2.0 <17` |
| `@spreewe/chat-sdk` | `0.1.0-prototype` |

Dependency: `tslib ^2.3.0`. Built with Angular 16.2.12 / ng-packagr 16.2 in partial compilation mode (`strictTemplates: true`).

The host app also needs the SDK's peers: `@matrix-org/matrix-sdk-crypto-wasm 18.9.0`, `socket.io-client ^4.8.1`, `mediasoup-client ^3.23.1`.

---

## Installation

Neither package is on npm. Build them locally and install with `file:` dependencies.

### 1. Build order

```bash
# 1. SDK (tsc → packages/chat-sdk/dist)
cd packages/chat-sdk
npm install
npm run build

# 2. Angular library (ng-packagr → packages/chat-angular/dist)
cd ../chat-angular
npm install            # installs @spreewe/chat-sdk from file:../chat-sdk
npm run build          # ng-packagr -p ng-package.json -c tsconfig.lib.json
```

The SDK must be built first: chat-angular compiles against `@spreewe/chat-sdk`'s `dist` types. Rebuild chat-angular after SDK type changes.

### 2. Host app dependencies

As in `examples/angular-app/package.json`:

```json
{
  "dependencies": {
    "@spreewe/chat-sdk": "file:../../packages/chat-sdk",
    "@spreewe/chat-angular": "file:../../packages/chat-angular/dist",
    "@matrix-org/matrix-sdk-crypto-wasm": "18.9.0",
    "socket.io-client": "^4.8.1",
    "mediasoup-client": "^3.23.1"
  }
}
```

Note: `@spreewe/chat-angular` points at the built `dist` folder, `@spreewe/chat-sdk` at the package folder (its `main` is `dist/index.js`). Adjust the relative paths to your layout.

If `npm install` reports peer dependency conflicts (for example between the Angular versions of the host and the library's dev dependencies, or the prototype version string of `@spreewe/chat-sdk`), install with:

```bash
npm install --legacy-peer-deps
```

### 3. `angular.json`

```json
"build": {
  "options": {
    "preserveSymlinks": true,
    "assets": [
      { "glob": "matrix_sdk_crypto_wasm_bg.wasm",
        "input": "node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg",
        "output": "assets/crypto" }
    ]
  }
}
```

- **`preserveSymlinks: true`** — `file:` dependencies are installed as symlinks. Without this option the bundler resolves the symlink to the real path under `packages/…`, and `@angular/core` imported by the library resolves to `packages/chat-angular/node_modules/@angular/core` instead of the host's copy. Two copies of Angular in one bundle break dependency injection and change detection (typical errors: `NG0203` inject outside an injection context, or components that never update). With `preserveSymlinks` the library resolves its peers from the host's `node_modules`.
- **WASM asset** — copies the crypto library's WebAssembly file into the build so it can be passed as `wasmUrl`:

```ts
wasmUrl: new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI)
```

The example also lists `allowedCommonJsDependencies` for mediasoup-client's CommonJS dependencies (`debug`, `events`, `sdp-transform`, `h264-profile-level-id`, `awaitqueue`, `supports-color`) to silence build warnings.

### 4. Backend routing

The example serves the app and proxies `/api` → backend REST (prefix stripped) and `/socket.io` → backend Socket.IO (`examples/angular-app/proxy.conf.js`), then uses `apiUrl: `${origin}/api``, `socketUrl: origin`. The app is served over HTTPS (`ng serve --ssl true`) because camera, microphone and WebCrypto require a secure context.

---

## Minimal usage

```ts
import { Component, OnDestroy, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { SpreeWeClient } from '@spreewe/chat-sdk';
import { SpwChatAppComponent } from '@spreewe/chat-angular';

@Component({
  selector: 'app-chat',
  standalone: true,
  imports: [CommonModule, SpwChatAppComponent],
  template: `
    <p *ngIf="status">{{ status }}</p>
    <spw-chat-app *ngIf="ready" [client]="client"></spw-chat-app>
  `,
  styles: [`:host { display: flex; flex-direction: column; height: 100vh; } spw-chat-app { flex: 1; min-height: 0; }`],
})
export class ChatComponent implements OnInit, OnDestroy {
  client = new SpreeWeClient({
    apiUrl: `${location.origin}/api`,
    socketUrl: location.origin,
    getToken: () => clerk.session?.getToken({ skipCache: true }) ?? Promise.resolve(null),
    wasmUrl: new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI),
    deviceLabel: 'My app',
  });
  ready = false;
  status = 'Connecting…';

  async ngOnInit() {
    try { await this.client.connect(); this.ready = true; this.status = ''; }
    catch (e: any) { this.status = `Could not connect: ${e?.message || e}`; }
  }
  ngOnDestroy() { this.client.disconnect(); }
}
```

Render components only after `connect()` resolved; they subscribe to SDK events and call SDK methods on init. When the user or workspace changes, disconnect, create a new client, connect, and re-render (see `examples/angular-app/src/app.component.ts`; `webrtc-FE/src/app/sdk-demo/sdk-demo.component.ts` shows the same embedded in the SpreeWe app).

---

## Exports

```ts
export { SpwChatAppComponent, SpwConversationListComponent, SpwChatWindowComponent, SpwComposerComponent,
  SpwAttachmentComponent, SpwPresenceBadgeComponent, SpwCallComponent } from '@spreewe/chat-angular';
export type { SpwCallPhase } from '@spreewe/chat-angular';
```

---

## Components

### `<spw-chat-app>` — `SpwChatAppComponent`

Complete chat and calling UI: conversation sidebar, chat window, incoming/outgoing call panel, error toast.

| Input | Type | Default | Meaning |
|---|---|---|---|
| `client` | `SpreeWeClient` | — (required) | Connected client. |
| `allowCalls` | `boolean` | `true` | Passed to `spw-chat-window` (shows call buttons). |
| `allowRecording` | `boolean` | `true` | Passed to `spw-call` (record button, recordings/transcripts). |

Outputs: none.

SDK events: `call.incoming` (opens the call panel as incoming), `error` (shows the message in a toast; click to dismiss).

SDK calls: `calls.start(conversationId, type)` when the chat window emits `call`; `users.directory()` to build the `userId → name` map for the call panel.

Renders: a two-column grid (sidebar `minmax(220px, 300px)`, main `1fr`) with a border; "Select a conversation" when none is open; the call panel absolutely positioned bottom-right (`min(560px, 100% - 24px)` wide); the error toast bottom-left.

Behaviour:
- Fills its container: `:host { display: block; height: 100%; min-height: 420px }`. Give it a height (e.g. flex child with `min-height: 0`).
- **Mobile (≤ 640px):** single column. The list is shown until a conversation is opened; then only the chat window is shown, with a "← Chats" button to go back. (The back button element exists at all widths but is hidden above 640px.)
- Only one call at a time: an incoming ring while a call panel is open is ignored (not rejected; the caller keeps ringing).
- For outgoing calls, `initiatedBy` is set to the current user so the panel shows "End for all".

```html
<spw-chat-app [client]="client" [allowRecording]="false"></spw-chat-app>
```

---

### `<spw-conversation-list>` — `SpwConversationListComponent`

Sidebar of the active workspace's direct and group conversations, with unread markers and "new chat" / "new group".

| Input | Type | Default | Meaning |
|---|---|---|---|
| `client` | `SpreeWeClient` | — (required) | Connected client. |
| `title` | `string` | `'Chats'` | Header text. |
| `selectedId` | `string \| null` | `null` | Highlighted conversation; also suppresses the unread marker for it. |

| Output | Payload | When |
|---|---|---|
| `selected` | `Conversation` | A conversation was clicked, opened (new chat) or created (new group). |

SDK events: `message` (marks the conversation unread unless it is `selectedId`; refreshes the list if the conversation is not listed yet), `conversation.added`, `conversation.removed`, `conversation.updated` (refresh).

SDK calls: `conversations.list()` (direct chats and groups) and `users.directory()` on init and on each refresh; `conversations.openDirect(userId)`; `conversations.createGroup({ name, memberIds })`.

Renders: header with title and "＋" button; when open, a panel with "Chat" / "Group" tabs, a people search field (filters the directory by display name, excludes yourself), clickable names (direct) or checkboxes plus group name and "Create group" (group); the conversation list (groups prefixed with `# `, unread dot); "Loading…", "No conversations yet", errors.

Behaviour notes:
- Unread state is local to the component (in memory); it is not loaded from the server and resets on reload.
- A new direct conversation is not returned by the server until it has a message; the component selects a locally built `Conversation` (`raw: null`) in that case.
- Every refresh re-fetches both conversations and the directory.

```html
<spw-conversation-list [client]="client" [selectedId]="current?.id ?? null" (selected)="current = $event"></spw-conversation-list>
```

---

### `<spw-chat-window>` — `SpwChatWindowComponent`

One conversation: header, decrypted message list, reactions, reply / edit / delete, typing indicator, composer.

| Input | Type | Default | Meaning |
|---|---|---|---|
| `client` | `SpreeWeClient` | — (required) | Connected client. |
| `conversation` | `Conversation \| null` | `null` | Conversation to show. |
| `allowCalls` | `boolean` | `true` | Show the audio / video call buttons. |

| Output | Payload | When |
|---|---|---|
| `call` | `'audio' \| 'video'` | A call button was clicked. The component does not start the call itself; the host (or `spw-chat-app`) calls `client.calls.start`. |

SDK events (filtered to this conversation): `message` (appended; then `markRead`), `message.updated` (merges `text`, `state`, `edited: true`), `message.deleted` (marks deleted, clears text), `reaction.updated` (replaces reactions), `typing` (from others; auto-expires after 6 s), `presence` (direct conversations: the peer's status), `keys` (reloads history so `pending` messages can decrypt).

SDK calls: `messages.history(id, { limit: 50 })` and `messages.markRead(id)` on load; `messages.react`; `messages.delete`.

Renders:
- Header: conversation name; for direct conversations a `spw-presence-badge` with label; for groups the member count; call buttons if `allowCalls`.
- Messages (own messages right-aligned with `--spw-mine`; `plain` system notices centred; sender name above others' messages in groups; quoted reply text).
- By state: `pending` → "Waiting for this message's key…"; `failed` → `warning` or "Can't be decrypted on this device"; deleted → "Message deleted"; otherwise `spw-attachment` (if any), text, "(edited)".
- Grouped reaction counts.
- On hover / focus (only for `ok`, not deleted): quick reactions 👍 ❤️ 😂 🎉, Reply, and for own messages Edit and Delete.
- "<names> typing…".
- `spw-composer` bound to the reply/edit state.

Behaviour notes:
- Changing any input re-subscribes and reloads the history (only the latest 50 messages; no paging or infinite scroll).
- The list does not auto-scroll to the newest message.
- Initial peer presence is taken from the member's `status` field, then updated from `presence` events.

```html
<spw-chat-window [client]="client" [conversation]="current" (call)="startCall($event)"></spw-chat-window>
```

---

### `<spw-composer>` — `SpwComposerComponent`

Message input with attachment, reply and edit modes, and typing notifications. Content is encrypted by the SDK before it leaves the device.

| Input | Type | Default | Meaning |
|---|---|---|---|
| `client` | `SpreeWeClient` | — (required) | Connected client. |
| `conversationId` | `string` | `''` | Target conversation; with `''` nothing is sent. |
| `replyTo` | `ChatMessage \| null` | `null` | Shows "Replying to: …" and sends with `replyTo`. |
| `editing` | `ChatMessage \| null` | `null` | Edit mode: preloads the message text; Send becomes Save; attachments are hidden. |
| `placeholder` | `string` | `'Write an encrypted message'` | Input placeholder. |

| Output | Payload | When |
|---|---|---|
| `sent` | `void` | After a successful send / save / attachment upload. |
| `cancel` | `void` | The ✕ in the reply/edit bar was clicked. |

SDK calls: `messages.edit` (edit mode), `files.sendAttachment(conversationId, file, text)` (file chosen; text is the caption), otherwise `messages.send(conversationId, text, { replyTo })`; `chat.typing(id, true)` on first keystroke and `chat.typing(id, false)` 2.5 s after the last keystroke and after sending.

Renders: optional reply/edit bar; 📎 file picker (single file); text input; Send/Save button (disabled while busy or when there is neither text nor file); selected file name with Remove; error text.

Behaviour notes: an attachment is sent without `replyTo`. "Sent" means handed to the server (see SDK `messages.send`); server rejections are not shown here (they surface via the SDK `error` event, which `spw-chat-app` shows as a toast).

```html
<spw-composer [client]="client" [conversationId]="id" [replyTo]="replyTo" (sent)="replyTo = null" (cancel)="replyTo = null"></spw-composer>
```

---

### `<spw-attachment>` — `SpwAttachmentComponent`

Downloads and decrypts an attachment on this device and displays it.

| Input | Type | Default |
|---|---|---|
| `attachment` | `Attachment \| undefined` | `undefined` |

Outputs: none. SDK events: none. SDK calls: `attachment.download()`.

Renders, by `mimeType`: `image/*` → `<img>`, `video/*` → `<video controls>`, `audio/*` → `<audio controls>` (images/videos max 280×240 px), otherwise a download link "name (size)". While loading: "Decrypting <name>…"; on failure: "This attachment couldn't be downloaded or decrypted."

Behaviour: downloads immediately when the input is set (no click needed); creates an object URL and revokes it on change / destroy. Status of the underlying SDK download: not tested in a real browser (needs S3).

```html
<spw-attachment [attachment]="message.attachment"></spw-attachment>
```

---

### `<spw-presence-badge>` — `SpwPresenceBadgeComponent`

Presence dot with optional label.

| Input | Type | Default |
|---|---|---|
| `status` | `string \| null \| undefined` | `undefined` |
| `showLabel` | `boolean` | `false` |

Outputs: none. SDK events: none (pass the status in).

Colour mapping (case-insensitive): `Available` / `Online` → green; `Busy` / `Do not disturb` → red; `Away` → amber; anything else (including `Appear offline`, empty) → grey. The tooltip and label show `status`, or `Offline` if empty. The dot colours are fixed hex values, not CSS variables.

```html
<spw-presence-badge [status]="user.status" [showLabel]="true"></spw-presence-badge>
```

---

### `<spw-call>` — `SpwCallComponent`

Call panel: incoming (accept / decline), outgoing (cancel via Leave), active call with participant video grid, mic / camera toggles, leave / end for all, recording start / stop, recordings and transcripts after the call. Media runs through `client.calls.join` (mediasoup SFU, browser only).

| Input | Type | Default | Meaning |
|---|---|---|---|
| `client` | `SpreeWeClient` | — (required) | Connected client. |
| `call` | `CallInfo \| null` | `null` | The call; nothing renders when `null`. |
| `direction` | `'incoming' \| 'outgoing'` | `'incoming'` | `'incoming'` for a ring you received, `'outgoing'` for a call you started. |
| `allowRecording` | `boolean` | `true` | Show Record and "Recordings & transcripts". |
| `names` | `Record<string, string>` | `{}` | `userId → display name` for tiles (fallback `Participant`). |

| Output | Payload | When |
|---|---|---|
| `closed` | `void` | "Close" clicked in the ended state. The host should then clear `call`. |

Exported type:

```ts
type SpwCallPhase = 'incoming' | 'outgoing' | 'connecting' | 'lobby' | 'active' | 'ended';
```

Phases and labels:

| Phase | Label | Entered when |
|---|---|---|
| `incoming` | Incoming… | `direction = 'incoming'` initially. Shows Accept / Decline. |
| `outgoing` | Calling… | `direction = 'outgoing'`. **The caller joins media immediately** (on input change). |
| `connecting` | Connecting… | Callee clicked Accept: `calls.accept`, then **the callee joins media**. |
| `lobby` | Waiting for the host to let you in | `CallMedia` reported `onLobby`. |
| `active` | Connected | Callee after media joined; caller when `call.participant-joined` arrives or the first remote stream arrives. |
| `ended` | Ended | `call.ended` / `call.removed` for this call, or Decline / Leave / End for all. |

SDK events (filtered by `callId`): `call.ended`, `call.removed` (→ ended), `call.participant-joined` (outgoing → active), `recording.updated` (recording flag = `status === 'recording'` or `active === true`).

SDK calls: `calls.accept`, `calls.join` (with `onLobby`, `onRemoteStream`, `onRemoteLeft`), `calls.reject` (Decline), `calls.leave` (Leave), `calls.end` (End for all), `calls.controls.mediaState`, `calls.controls.startRecording` / `stopRecording`, `recordings.list(conversationId)`, `recordings.transcript(recordingId)`; `CallMedia.setMicEnabled` / `setCameraEnabled` / `close`.

Renders: title ("Video call" / "Audio call", phase label, "● REC" while recording); in outgoing / connecting / lobby / active: a tile grid (your tile with local video for video calls, muted; one tile per remote user) and buttons Mute/Unmute, Camera off/on (video calls), Record/Stop recording (enabled only in `active`), Leave, End for all (only if `call.initiatedBy` is the current user). In `ended`: "Call ended", "Recordings & transcripts" (if `allowRecording`), "Close". The recordings list shows date, transcript status and a Transcript button; the transcript is shown as text (a string response, `text`, or joined `segments[].text`, else "No transcript yet").

Behaviour notes:
- Recording toggle flips its local flag only after the server acknowledged; `recording.updated` events also set it.
- Leave / Decline / End close local media (`CallMedia.close()`).
- Any input change resets the panel (closes media and re-subscribes); see Known issues.
- Mic / camera toggles pause the producers and broadcast the state; they do not stop the device (camera light may stay on).

Standalone use (without `spw-chat-app`):

```ts
call: CallInfo | null = null;
direction: 'incoming' | 'outgoing' = 'incoming';

ngOnInit() {
  this.client.events.on('call.incoming', (c) => this.zone.run(() => { this.direction = 'incoming'; this.call = c; this.cdr.markForCheck(); }));
}
async startVideo(conversationId: string) {
  const c = await this.client.calls.start(conversationId, 'video');
  this.direction = 'outgoing';
  this.call = { ...c, initiatedBy: String(this.client.me?._id) };
}
```

```html
<spw-call *ngIf="call" [client]="client" [call]="call" [direction]="direction" [names]="names" (closed)="call = null"></spw-call>
```

Set `direction` before (or together with) `call`; the component reads `direction` when `call` changes.

---

## Theming

All components include the shared styles in `packages/chat-angular/src/lib/theme.ts`. Variables are declared on each component's `:host` (with emulated encapsulation this compiles to an attribute selector such as `[_nghost-abc]`, specificity 0,1,0). Two consequences, inferred from the CSS and not yet verified in a browser:

1. Each component redeclares the defaults on its own host, so a value set on an ancestor does not reach nested components. **Set overrides on every component element** you use.
2. A plain element selector in global CSS (`spw-chat-app { … }`, specificity 0,0,1) loses to the `:host` default. Put overrides in a host component's styles (Angular adds an attribute, giving 0,1,1, which is what the example app does) or raise specificity in global CSS (e.g. `:root spw-chat-app`, specificity 0,1,1).

The recommended form is therefore global CSS (`styles.css`) with `:root` prefixes, shown below.


| Variable | Light default | Dark default (`prefers-color-scheme: dark`) | Used for |
|---|---|---|---|
| `--spw-bg` | `#ffffff` | `#151b21` | Backgrounds, inputs, buttons |
| `--spw-surface` | `#f4f6f8` | `#1d252d` | Sidebar, others' message bubbles, transcript box |
| `--spw-border` | `#d9dee3` | `#2f3a44` | Borders |
| `--spw-text` | `#1f2a33` | `#e3e8ec` | Text |
| `--spw-muted` | `#66737f` | `#93a1ad` | Secondary text |
| `--spw-brand` | `#2c3a47` | `#c7d2d8` | Primary buttons |
| `--spw-accent` | `#82b4dc` | `#82b4dc` (unchanged) | Selected conversation bar, unread dot, reply quote bar |
| `--spw-mine` | `#dcebf7` | `#24384a` | Own message bubbles |
| `--spw-danger` | `#b3261e` | `#b3261e` (unchanged) | Danger buttons, errors, REC |
| `--spw-radius` | `8px` | `8px` (unchanged) | Corner radius |
| `--spw-font` | `inherit` | `inherit` (unchanged) | `font-family` |

Other fixed styles: primary button text is `#fff` (`#151b21` in dark mode); call tiles have a `#0f1418` background with white name labels; presence dot colours are fixed.

Dark mode follows the operating system (`prefers-color-scheme`); there is no input or class to force light or dark.

### Theming example

```css
/* styles.css (global) */
:root spw-chat-app,
:root spw-conversation-list,
:root spw-chat-window,
:root spw-composer,
:root spw-call,
:root spw-attachment,
:root spw-presence-badge {
  --spw-brand: #3949ab;
  --spw-accent: #7986cb;
  --spw-radius: 4px;
  --spw-font: 'Montserrat', sans-serif;
}
```

The example app instead sets `spw-chat-app { --spw-brand: #3949ab; --spw-accent: #7986cb; }` in its own component styles. That outranks the `:host` default only on the `spw-chat-app` element; the nested components (`spw-conversation-list`, `spw-chat-window`, `spw-call`, …) are not in that component's template and keep their own defaults, so most visible colours would not change. Verify theming in a browser.

## Known issues and limitations

Observed in the source; not fixed in this prototype.

- **`spw-call` resets on any input change.** `ngOnChanges` closes media and re-subscribes whenever any input changes. Passing a new `names` object (or toggling `allowRecording`) during a call ends the local media. `spw-chat-app` mutates `names` in place, which avoids this but also means `spw-call` (OnPush) may not show names loaded later.
- `spw-chat-window` reloads history whenever any input changes (e.g. `allowCalls`).
- `spw-chat-app` ignores a second incoming call without rejecting it.
- Lobby: if the host denies entry, `CallMedia.join` keeps waiting; the panel stays in `lobby` until the user clicks Leave.
- `spw-chat-window` marks the conversation read on every incoming message while it is mounted, even if the page is hidden.
- No pagination beyond the latest 50 messages, no auto-scroll, no message search, no group management UI (add/remove members), no pins UI, no device management UI.
- Unread markers are in-memory only.
- The composer's typing timer is not cleared on destroy.
- Theming: each component redeclares `--spw-*` defaults on its own `:host`, so overrides on an ancestor do not cascade into nested components (see Theming). Not verified in a browser.
- The `recording.updated` payload fields used (`callId`, `status`, `active`) are assumptions in the component; they are not verified against the server.
