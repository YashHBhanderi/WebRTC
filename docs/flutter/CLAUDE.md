# Flutter client — Claude implementation guide

Use this file as the source of truth when implementing the **Flutter** app for this product. The Angular web client (`webrtc-FE`) and Node backend (`webrtc-BE`) already exist. Flutter must **reuse the same backend** and ship **the same features**, not a subset and not a redesign of the protocol.

Do not invent new REST paths, socket event names, payloads, or message types. Copy the contracts below. When a web file and this guide disagree, **read the live TypeScript** — it is the protocol.

---

## How to work

1. Implement **one module at a time**, in the order in §3. Do not start calls before chat send/receive works.
2. After each module: feature checklist in that section must be true, including empty / error / offline states.
3. Keep UI behaviour aligned with the web app (Teams-like messenger: nav rail, chat list + conversation, call overlay that survives navigation). Visuals may be Material 3 / Cupertino-native, but **information architecture, actions, and states must match**.
4. Brand: slate `#2c3a47` (light brand) → `#c7d2d8`; accent `#82b4dc`; Inter (or a close metric-compatible font). Icons: Tabler-equivalent (`flutter_tabler_icons` or similar). No Font Awesome.
5. Do not add Teams/Channels. Do not add a second chat protocol. Do not store secrets in the repo.

Reference trees:

- Web UI: `webrtc-FE/src/app/pages/`
- Services: `webrtc-FE/src/app/core/services/`
- Models: `webrtc-FE/src/app/core/interfaces/chat.ts`
- REST: `webrtc-BE/src/routes/routes.ts` and `webrtc-BE/src/app.ts`
- Sockets: `webrtc-BE/src/realtime/`

---

## 1. Product

A signed-in user gets a shell with:

| Route (web) | Flutter destination | Purpose |
|---|---|---|
| `/auth/login`, `/auth/register` | Auth stack | Clerk sign-in / sign-up |
| `/activity` | Activity tab | Mentions, replies, reactions, missed calls, meeting invites, recordings |
| `/chat` | Chat tab | Conversations + thread |
| `/calls` | Calls tab | Start a call + history |
| `/calendar` | Calendar tab | Meetings |
| `/files` | Files tab | Shared attachments across chats |
| `/profile` | Profile (account menu) | Name, photo, bio, presence, ringtone |
| `/settings` | Settings | Theme, chat list, notifications |
| `/meet`, `/meet/:code` | Join meeting | Code (+ optional password) |
| `/recordings/:id` | Recording player | Playback + transcript |

Calls are **not** a separate route in the web app. They open as an overlay owned by the shell so chat / calendar stay mounted. Flutter must do the same (overlay / `Navigator` overlay / PiP), not push a page that destroys the chat.

---

## 2. Architecture (Flutter)

Suggested layout (adapt names, keep layers):

```
lib/
  app.dart                 # MaterialApp, theme, router
  main.dart
  core/
    api/                   # Dio: Bearer Clerk token, /api prefix
    realtime/              # socket_io_client, ack helpers
    auth/                  # Clerk + GET /web/user/me cache
    models/                # Dart copies of chat.ts + call snapshots
    theme/                 # tokens matching webrtc-FE/src/styles.scss
  features/
    auth/
    shell/                 # nav rail / bottom bar, incoming-call, call overlay
    activity/
    chat/
    calls/
    calendar/
    files/
    profile/
    settings/
    meeting_join/
    recording/
    call/                  # mediasoup + stage UI + prejoin + lobby
```

**Suggested packages (do not add extras without need):**

| Concern | Package |
|---|---|
| HTTP | `dio` |
| Sockets | `socket_io_client` |
| Auth | `clerk_flutter` (or Clerk SDK current for Flutter) |
| State | `riverpod` or `bloc` — pick one and stay with it |
| WebRTC / SFU | `flutter_webrtc` + mediasoup signaling from this backend (`mediasoup:*` events). Prefer a maintained mediasoup Flutter client if it speaks the same produce/consume flow. |
| Local prefs | `shared_preferences` |
| Secure token cache | Clerk SDK (do not roll your own JWT store) |
| Images | `cached_network_image` |
| Files / picker | `file_picker`, `image_picker` |
| Notifications | `flutter_local_notifications` + FCM later if/when the backend adds push. Today the web uses **browser Notification API** + in-app Activity. Match in-app first. |
| Video in chat | `video_player` |
| Audio in chat | `just_audio` or `video_player` |
| Deep links | `/meet/:code` |
| PiP | `pip_view` / platform PiP APIs — web has `call-pip.service.ts` |

**Environment**

- Base URL: same API the web uses (`environment.apiUrl`). REST is mounted at both `/api` and `/` (`webrtc-BE/src/app.ts`). Prefer `/api`.
- `GET /api/config` (no auth) returns `{ s3BaseUrl, clerkPublishableKey }`.
- Socket.IO: same origin as API, **websocket + polling**, auth handshake:

```ts
handshake.auth = { token: clerkSessionJwt, deviceId: stablePerInstallId }
```

`deviceId`: 8–64 chars `[\w-]`. Persist per install (not per user). Reconnects of the same device keep the call; another device can `call:takeover`.

Every REST call: `Authorization: Bearer <Clerk session JWT>`. Refresh the JWT before it expires; sockets reconnect with a fresh token (tokens are checked only on connect).

---

## 3. Implementation order

| Phase | Module | Depends on |
|---|---|---|
| 0 | Project, theme, Dio, Clerk, `GET /web/user/me` | — |
| 1 | Socket + presence | 0 |
| 2 | Shell + nav + settings/theme | 0 |
| 3 | Chat list + open conversation + text messages | 1 |
| 4 | Composer: reply, edit, mentions, emoji, attachments | 3 |
| 5 | Message actions: react, pin, save, forward, delete, search | 4 |
| 6 | Groups, block, archive, clear, profile of peer | 3 |
| 7 | Media bubbles (photo, video, audio, PDF, file) + lightbox | 4 |
| 8 | Call log rows + missed-call pills in chat | 3 |
| 9 | Incoming ring UI + 1:1 / group calls (mediasoup) | 1, 3 |
| 10 | Meeting controls (lobby, record, share, hands, co-host) | 9 |
| 11 | Recording cards in chat + recording page + transcript | 7, 10 |
| 12 | Calls tab (history + start) | 9 |
| 13 | Calendar + meet join | 9 |
| 14 | Activity + Files + Saved + global search | 5, 11, 13 |
| 15 | Profile, ringtones, chat-list compact toggle, PiP | 2, 9 |

---

## 4. Shared models

Mirror `webrtc-FE/src/app/core/interfaces/chat.ts` and `socket.service.ts`.

### 4.1 User

```
_id, username, email?, avatar?, isOnline, lastSeen, bio, status,
statusMessage?, autoAway?, inCall? (live only, from user:presence)
```

`status` enum the user **chooses**: `Available | Busy | Do not disturb | Away | Appear offline`.

Derived presence key (see `presence.util.ts`): `available | busy | incall | dnd | away | offline`.

- Offline if not connected or status is `Appear offline`.
- `Do not disturb` → `dnd`.
- `inCall` (live) overrides Available/Busy/Away → `In a call`.
- `autoAway` while Available → `away`.

### 4.2 Message

```
_id, user, userId?, content?, type, isDeleted, createdAt,
replyTo?, reactions[{userId, emoji}],
fileUrl?, thumbnailUrl?, downloadUrl?, fileName?, fileSize?, mimeType?,
status?: sent | delivered | seen,
editedAt?, mentions?: string[], saved?,
recording?: { recordingId },
call?: { callId, callType: audio|video, mode: ring|meetNow, duration, outcome?: missed },
forwardedFrom?: string
```

**`type` values**

| type | Who creates it | UI |
|---|---|---|
| `text` | client | Bubble |
| `image` `video` `audio` `pdf` `file` | client after `POST /upload` | Media / file card |
| `call` | server (ended or missed) | Call log / missed pill — **not** a bubble |
| `system` | server | Centered notice |
| `recording` | server | Recording card |

Clients may send only: `text | image | video | audio | pdf | file | call`. Never send `system` or `recording`.

Caption rule (`messageHasText`): show text if `content` is set **and** type is not `call`/`system`/`recording` **and** `content !== type`. Otherwise the type label is the preview (`Photo`, `Video`, …).

### 4.3 Conversation / chat state (`GET /conversations/:id/state`)

```
isArchived, archivedAt, clearedAt, isFavorite, isGroup, peerId,
blockedByMe, receipts[], pins[]
```

### 4.4 Call snapshot (`call:getState`)

See `CallStateSnapshot` in `socket.service.ts`: `callId, groupId, callType, mode, callStatus, startedAt, elapsedMs, isGroup, hostIds, participants, screenSharerUserId, media, hands, myRole, settings { lobby, allowUnmute, allowShare }, cohostIds, lobby[], recording, recordingAvailable`.

---

## 5. Auth module

**Web:** Clerk (`clerk.service.ts`) + `GET /web/user/me` (`auth.service.ts`).

**Must have**

- Sign in, sign up, sign out (Clerk).
- After Clerk session exists, call `GET /web/user/me`. Backend **links or creates** the Mongo user (`identity.service.ts`). Cache `{ _id, username, email, avatar, … }` locally.
- Guard: no shell without Clerk session **and** app user.
- Logout: clear cache + Clerk `signOut` → auth stack.
- HTTP 401: clear session, go to login.

**Do not** send username/password to this API. Clerk owns credentials.

---

## 6. Realtime module

Connect Socket.IO **once** at shell login; disconnect on logout.

Handshake auth: `{ token, deviceId }` as above.

**Rooms:** emit `joinConversation` with the open conversation id whenever the thread opens (and again after reconnect). Membership is verified server-side.

Ack pattern: many call/group/chat mutations use `socket.emit(event, payload, callback)` with `{ success?, error?, ... }`. Implement a `request(event, data, timeoutMs)` helper like the web `SocketService.request`.

### 6.1 Events to emit

| Event | Payload | Notes |
|---|---|---|
| `joinConversation` | `conversationId` | Also used for groups |
| `sendMessage` | see §7.4 | No ack; errors via `message:rejected` |
| `reactToMessage` | `{ messageId, emoji, conversationId }` | Toggle |
| `typing` / `stopTyping` | `(conversationId, userId)` | Throttle typing |
| `markMessagesRead` | `(conversationId, userId)` | Open thread + visible |
| `message:delivered` | `{ conversationIds }` | On connect / list load |
| `message:edit` | `{ messageId, content, mentions }` | Ack |
| `message:pin` | `{ messageId, pinned }` | Ack |
| `presence:set` | `{ status, statusMessage }` | Ack |
| `presence:idle` | `{ idle: boolean }` | App background / idle timer |
| `chat:archive` / `chat:unarchive` | `{ conversationId }` | Ack |
| `chat:favorite` / `chat:unfavorite` | `{ conversationId }` | Ack; per user, any chat / group / channel I belong to. Lists (`/conversations`, `/groupConversations`, team channels) carry `isFavorite` |
| `chat:clear` | `{ conversationId }` | Ack |
| `chat:block` / `chat:unblock` | `{ userId }` | Ack |
| `group:update` | `{ groupId, groupName?, groupDescription?, groupAvatarKey? }` | Ack |
| `group:add-member` | `{ groupId, userIds }` | Ack |
| `group:remove-member` | `{ groupId, userId }` | Ack |
| `group:promote-admin` / `group:remove-admin` | `{ groupId, userId }` | Ack |
| `group:leave` | `{ groupId }` | Ack |
| `call:*` / `screen:*` / `mediasoup:*` | §11 | |

### 6.2 Events to listen

| Event | Use |
|---|---|
| `receiveMessage` | Insert / bump list |
| `message:updated` | Edit |
| `message:deleted` | Tombstone |
| `message:rejected` | `{ conversationId, reason, message? }` toast |
| `messageReactionUpdated` | Update reactions |
| `message:pins` | Pin strip |
| `messagesMarkedRead` | Ticks / unread |
| `receipts:updated` | Group seen |
| `userTyping` | `{ userId, isTyping, conversationId }` |
| `user:presence` | Online / inCall / status |
| `user:created` | New account appears in contacts **without reload** |
| `user:updated` | Name / avatar |
| `group:updated` `group:added` `group:removed` | Group membership |
| `notification:new` `notification:read` | Activity |
| `meeting:updated` | Calendar |
| `recording:updated` | Recording card / page |
| `call:*` `screen:*` | §11 |
| `connect` / `disconnect` | Rejoin conversation; `message:delivered` |

Presence idle: when the app is backgrounded long enough, emit `presence:idle { idle: true }`; on resume `false`. Matches web `presence.service.ts`.

---

## 7. Chat module

Reference: `chat.component.ts/html`, `message-item`, `message-composer`, `conversation-info-panel`, `message-search-panel`, `sidebar-profile`.

### 7.1 Chat list (left pane / first screen on phone)

**REST**

- `GET /conversations` — 1:1
- `GET /groupConversations` — groups
- `GET /web/users/except-current` — contacts without a thread yet
- `POST /conversations` `{ userId }` — open or create 1:1
- `POST /conversations/group` multipart `image` + fields — create group (web also uses this; live updates go over `group:*`)

**List row fields (precompute like web `SidebarItem`):** kind `direct | group | contact`, title, avatar, presence, preview, previewIsMine, previewRead, time, unread, hasActiveCall.

Filters: All / Unread / Groups / Contacts, plus Archived mode.

Search: client-filter the loaded lists (web `onSidebarSearch`).

**Setting `chat.ui.showLastMessage`** (local, default **on**). Off: hide last-message preview and time; avatar **28px** instead of **40px**; keep unread + live-call badge. Web: `ChatUiService` + Settings → Chat.

Live call badge: from `CallManager` / `call:meeting-active` / `call:getActive`.

On `receiveMessage`: move that conversation to top; bump unread if it is not the open thread.

### 7.2 Conversation header

- Avatar, name, presence / member count (groups).
- Actions: audio call, video call, search panel, menu (archive, clear, block **1:1**, leave **group**, info panel).
- Voice **before** video (web order).
- Pinned strip under header: current pin + “View all (N)”; jump to message.

### 7.3 Thread

- Paginate oldest: `GET /messages/:conversationId?page=&pageSize=` (`historyPageSize` = 20).
- Jump: `GET /messages/:conversationId/position/:messageId` then load around it (search / activity / pin).
- Day pills.
- Incoming: name + time on first of a run; avatar only on first.
- Outgoing: dark slate bubble `#2c3a47`, light text, ticks (1:1: sent / delivered / seen).
- System / start-of-history pills.
- Typing row.
- Unread divider (`firstUnreadId`).
- Swipe-to-reply, long-press actions on touch.
- Hover strip on desktop (optional on phone — use long-press sheet): 4 quick reactions `😀 ❤️ 😂 😮`, more, reply, menu.

**Do not render `type === 'call'` as a bubble.** See §7.7.

Blocked: hide composer; show “You blocked {name}” + Unblock.

### 7.4 Send (`sendMessage`)

```
{
  user: { _id, username, email, avatar, isOnline, lastSeen },  // must match socket user
  conversationId,
  content,                 // trimmed; for media may be caption or type name
  type,                    // text | image | video | audio | pdf | file
  createdAt,               // ISO, client
  replyTo: messageId | null,
  mentions?: string[],     // member ids still @named in the text
  storageKey?: string,     // from POST /upload (media only)
  forwardOf?: string       // copy server-side; do not send content/file
}
```

`user._id` **must** be the authenticated user or the server drops the event.

Multi-file: **one message per file**; caption / reply / mentions only on the first (`MessageSenderService`).

Max text length: server `MAX_MESSAGE_LENGTH` (see `message-actions.service.ts`) — treat as 4000 on the composer (`maxlength="4000"`).

Enter sends; Shift+Enter newline. Esc cancels reply/edit.

### 7.5 Composer (parity)

- Full-width input, **no divider line** above it.
- Attachments **inside** the input box, not a bar above.
- Reply / edit preview **inside** the box.
- Attach, emoji, textarea, send.
- Paste / pick files; validate client-side (`upload.service.ts` rules) then `POST /api/upload`.
- Reply: **focus the input** (prevent reply-button from stealing focus).
- Edit: own **text** messages only; Enter saves (`message:edit`); Esc cancels. No attachments while editing.
- Mentions: `@` in groups → member picker; store ids; strip unused.
- ↑ in empty box: edit last own text message.

**Uploads**

`POST /api/upload` multipart field `file`, plus purpose (`message` + `conversationId`, or `group-avatar` + `groupId`). Response `UploadResult`: `storageKey, fileUrl, thumbnailUrl, type, mimeType, originalName, size`.

Limits (reject before upload):

| Kind | Max | Types |
|---|---|---|
| image | 10 MB | jpeg, png, gif, webp |
| video | 100 MB | mp4, webm, quicktime |
| audio | 25 MB | audio/* |
| pdf | 25 MB | pdf |
| file | 50 MB | zip, doc(x), xls(x), ppt(x), txt, log, csv, md |

Max **10** files per send. Concurrency 2. Progress + retry + cancel like web `UploadService` (failed jobs stay in the thread).

### 7.6 Message UI (must match web)

**Photo:** padded bubble, rounded image, hover overlay (name, zoom, download), footer `1.8 MB · PNG image` + time/ticks. Tap image → lightbox.

**Video:** **same layout as photo** (shrink-wrap, no empty strip on the right). Center play = **inline** `video_player` in the bubble (controls while playing). Overlay play (hover bar) = **lightbox / preview**. Pause inline before opening preview. Footer `42 MB · MP4 video`.

**Audio:** native / app controls + download.

**PDF / file card:** icon tile (PDF tinted danger), name, `size · PDF document` / `DOCX file`, divider, Quick preview (PDF only) + Download.

**Forwarded:** top of bubble `↪ Forwarded from **Name**` + divider. Name is a **snapshot** stored as `forwardedFrom` (group name or original author). Older messages may lack it — hide the header.

**Recording card:** §12.

**Quote/reply:** left brand bar, author, preview; tap jumps to original.

**Reactions:** chips under bubble; tap toggles yours.

### 7.7 Call rows in the thread

When `msg.type === 'call' && msg.call`:

- `outcome === 'missed'`: red pill. Callee: `Missed voice/video call · {day} at {time}` + **Callback**. Caller: `Unanswered …`.
- Else: green icon tile, `{Outgoing\|Incoming} {voice\|video} call · {duration}` (or **Meeting** if `mode === 'meetNow'`), time, **Call again ›**.
- Callback / Call again: **1:1 only**, hidden if blocked or already in a call here. Starts `call:start` with that `callType`.
- Unanswered 1:1 rings: server posts the missed message (`call-session.service.ts`). Declined/cancelled stay in Call History only.

Legacy live-join “call” messages without `msg.call` still exist as centered events in web (`call-event`). Keep that branch: if `type === 'call' && !call && content` is not missed/declined, show the join pill if the meeting is live.

### 7.8 Message actions

| Action | How |
|---|---|
| Reply | Local composer state |
| React | `reactToMessage` |
| Copy text / copy link | Clipboard (`/chat?c={id}&m={id}`) |
| Download | `downloadUrl` or `fileUrl` |
| Forward | Pick conversations; `sendMessage` with `forwardOf` |
| Pin / unpin | `message:pin` |
| Save / unsave | `PUT /messages/:id/save { saved }` |
| Edit | own text; `message:edit` |
| Delete | `DELETE /messages/:id` (own) |

Search panel: `GET /messages/:conversationId/search?q=` paginated (`searchPageSize` 30). Highlight + jump.

Info panel: members (groups), shared media `GET /conversations/:id/media`, recordings `GET /conversations/:id/recordings`.

### 7.9 Groups

Create: name, optional description + photo, member picker.

Admins: add/remove members, promote/remove admin, update name/description/avatar (`group:*`).

Leave: `group:leave`. Non-admins cannot kick.

System messages when membership changes.

---

## 8. Shell module

Reference: `shell.component.ts/html`.

- Persistent frame: **nav rail** (wide) / **bottom tabs** (phone).
- Tabs: Activity, Chat, Calls, Calendar, Files. Profile + Settings from account menu.
- Header: menu, global search (`Ctrl+E` on web → use a search icon / Android search), avatar + name + presence.
- Incoming call overlay (`incoming-call`) on **every** page, not only Chat.
- Call surface (`group-call`) hosted here so it **survives** tab changes.
- Minimize call → PiP (`call-pip.service.ts`) while browsing other tabs.
- Collapsed rail tooltip / labels.
- Status picker: Available, Busy, DND, Away, Appear offline + optional status message (`presence:set`).
- Unread badges on Activity / Chat from notification center + conversation unread.

Keyboard shortcuts (web Alt+1…7) are optional on mobile; keep on desktop/web-renderer if you ship Flutter web.

---

## 9. Settings module

Reference: `section-pages.component.ts` (`SettingsPageComponent`).

**Appearance:** Light / Dark / System (`ThemeService`, `data-theme`). Persist `app.theme`.

**Chat:** toggle **Show last message** (persist `chat.ui.showLastMessage`, default on). See §7.1.

**Notifications (this device):**

- Browser/OS permission CTA.
- Prefs (persist like `notification-center.service.ts`): desktop, sound, messages, mentions, replies, reactions, missedCalls, meetings.
- Skip alerts for the **open** conversation and while DND.
- Mute sound during an active call.
- Ringtone choice lives on **Profile**, not Settings.

**Shortcuts** section: list only if the platform has them.

---

## 10. Profile module

Reference: `sidebar-profile`.

- Avatar (upload via `PATCH /web/user/profile` multipart `image`), username, bio.
- Presence + status message.
- Ringtone preview / pick (`ringtone.service.ts`).
- Sign out.

`GET /web/user/:userId` for other people’s profile sheet from avatar tap.

---

## 11. Calls / meetings module (WebRTC)

This is the hardest module. Read `mediasoup.service.ts`, `call-manager.service.ts`, `group-call.component.ts`, `call.gateway.ts`, `media.gateway.ts` before coding.

### 11.1 Call kinds

| | 1:1 | Group |
|---|---|---|
| `mode: ring` | Phone-like: incoming overlay, accept/reject | Ring members |
| `mode: meetNow` | Instant meeting (often video) | Meet now from header |

Web: 1:1 audio uses `ring`; 1:1 video from chat header uses `ring`; group video “Meet now” uses `meetNow`. `startGroupCall(groupId, callType, mode)`.

### 11.2 Signaling (`call:*`)

**Emit**

| Event | Role |
|---|---|
| `call:start` | `{ groupId, callType, mode }` |
| `call:getActive` | `{ groupId }` → `{ call }` |
| `call:accept` / `call:reject` | `{ callId }` |
| `call:leave` / `call:end` | `{ callId }` — end = everyone (host, or either side in 1:1) |
| `call:upgrade` | audio → video |
| `call:getState` | snapshot |
| `call:session` | `{ elsewhere, callId? }` |
| `call:takeover` | move call to this device |
| `call:media-state` | `{ callId, audio, video }` |
| `call:reaction` | `{ callId, emoji }` — `👍❤️😂👏😮😢` |
| `call:hand` | `{ callId, raised }` groups |
| `call:mute-participant` | host |
| `call:remove-participant` | host |
| `call:settings` | `{ callId, lobby?, allowUnmute?, allowShare? }` |
| `call:mute-all` | host |
| `call:admit` | `{ callId, userId }` or `{ callId, all: true }` |
| `call:deny` | `{ callId, userId }` |
| `call:set-cohost` | `{ callId, userId, cohost }` |
| `call:record-start` / `call:record-stop` | host, if `recordingAvailable` |
| `screen:join` `screen:start` `screen:stop` `screen:getState` | screen share |
| `ice:getServers` | TURN/STUN from server |

**Listen:** `call:started`, `call:incoming`, `call:meeting-active`, `call:ended`, `call:participant-joined/left/rejected`, `call:media-state`, `call:media-updated`, `call:reaction`, `call:hand`, `call:audio-levels`, `call:force-muted`, `call:removed`, `call:force-leave` (other device takeover), `call:error`, `call:lobby`, `call:settings`, `call:admitted`, `call:denied`, `call:recording`, `call:share-stopped`, `screen:started`, `screen:stopped`.

Cannot call a contact you blocked / who blocked you (`call:error`).

### 11.3 MediaSoup (`mediasoup:*`)

Flow after accept / start (and after lobby admit):

1. `ice:getServers`
2. `mediasoup:getRouterRtpCapabilities`
3. Load Device
4. `mediasoup:createSendTransport` + `createRecvTransport`
5. `mediasoup:connectTransport` `{ transportId, dtlsParameters }`
6. `mediasoup:joinCall` `{ callId, callType }` → `{ lobby?, producers[] }`
7. If `lobby: true`, **do not produce**; wait `call:admitted` then join again / produce.
8. Produce mic (and camera if video). `appData.source` distinguishes `mic | camera | screen`.
9. For each remote producer: `mediasoup:consume` then `mediasoup:resumeConsumer`
10. `mediasoup:syncProducers` on reconnect
11. `mediasoup:closeProducer` when muting/stopping tracks
12. `mediasoup:restartIce` on disconnected
13. Simulcast: web uses VP8 L1T3; **mobile uses 2 layers**. Match `cameraEncodings()` in `mediasoup.service.ts`.
14. `mediasoup:setPreferredLayers` for downlink adaptation.

Local media: `getUserMedia` via `flutter_webrtc`. Prefs: selected mic/cam, noise suppression (`media-devices.util.ts`), video effects (`video-effects.service.ts`: none / blur / virtual background) — implement effects if the platform supports them; otherwise hide the tiles (web already gates on `effectsSupported`).

Screen share: one presenter at a time; attendees may be locked (`allowShare`). Stopping emits `screen:stop`. Flutter mobile: use platform screen-capture APIs; if unavailable, hide Share on that device rather than crashing.

### 11.4 Call UI (parity)

- **Pre-join** (meetings / meet-now): cam/mic preview, device pick, Join / Cancel (`call-prejoin`).
- Incoming: avatar, name, voice vs video, Accept / Decline, ringtone.
- Live: stage tiles (self, remotes, screen), speaking highlight (`call:audio-levels`), mute/cam icons, hand, host crown.
- Toolbar: mic, cam (+ effects menu), share, reactions, hand (groups), more (roster, meeting options, record), leave / end.
- Roster: mute participant, remove, set co-host (host).
- Lobby list for moderators: Admit / Deny / Admit all; waiting overlay for attendees.
- Meeting options: lobby, allow unmute, allow share.
- REC badge + duration when recording.
- Reconnecting / network quality banner (`networkQuality$` good/fair/poor).
- Meeting chat panel: **same conversation** as the group, compact composer (`meeting-chat.component.ts`).
- Copy invite / meet code (`call-link`).
- Takeover: if `call:session.elsewhere`, prompt to move the call here.
- Minimize → PiP; expanding restores the overlay.

1:1 vs group: 1:1 either side can end; groups only host/co-host end-for-all, others leave.

---

## 12. Recordings module

Server-side FFmpeg compose + whisper.cpp. Client never records the mix itself.

**In call:** Start/Stop if `recordingAvailable` and role allows. Listen `call:recording` and `recording:updated`.

**In chat:** message `type: recording` with `recording.recordingId`. Card (`recording-card.component.ts`):

- Mic tile, title, badge (Completed / Recording / Processing / Failed / Expired / Unavailable).
- Meta: `MMM d · duration · size · Meeting recording`.
- Menu: Open recording, Download.
- Inline **audio** player: play/pause, seek, speed 1 / 1.5 / 2. `playbackUrl` is **short-lived** — on error, re-GET `/recordings/:id` and resume.
- Footer: Transcribed / Transcribing… / No transcript; Transcript button; Download.
- Header pill: `● Recorded by You|{name}`.
- Dark variant inside outgoing bubble (token overrides).
- **Do not** claim Encrypted / page counts / verified signature.

**Page** `/recordings/:id`:

- `GET /recordings/:id` — playbackUrl, downloadUrl, duration, size, status, transcriptStatus, transcriptAvailable, expired, startedByName, title, startedAt
- `GET /recordings/:id/transcript` — segments `{ speaker, startTime, text }`
- `GET /recordings/:id/transcript/export`
- `POST /recordings/:id/transcript/retry`
- `GET /conversations/:id/recordings` — list in info panel

Expired after ~30 days (`recordingConfig`). 404 → “no longer available”.

---

## 13. Calls tab

Reference: `calls-page.component.ts`.

- Left: people search + multi-select, start audio (and video if you expose it).
- Main: history `GET /calls` with filters All / Missed / Incoming / Outgoing, cursor pagination.
- Row: title, type, direction, outcome (`answered | missed | declined | cancelled | no-answer | failed | ongoing`), duration, time, Call back.
- Deep link from Activity: `?call=<id>` highlight.

Outcomes and labels: `OUTCOME_LABEL` in that file.

---

## 14. Calendar / meetings module

Reference: `calendar-page`, `meeting-editor`, `meeting-details`, `meet-join`, `calendar-settings`, `meeting.service.ts`.

**REST**

- `GET /meetings?from=&to=` range
- `POST /meetings` create
- `GET /meetings/:id` `PATCH` `DELETE` (cancel)
- `GET /meetings/code/:code` preview (auth)
- `POST /meetings/code/:code/join` `{ password? }`

**Fields:** title (120), description (2000), invitees, startAt, endAt, timeZone (IANA), recurrence `{ freq: daily|weekdays|weekly|monthly, interval, byWeekday?, until?, count? }`, cancelledOccurrences, code, hasPassword, lobby, status `scheduled|cancelled`. Occurrences are **computed**, not stored.

**UI**

- Month / week / day / work-week (calendar settings: time scale, work hours, location).
- Create / edit / cancel meeting; optional password; lobby flag.
- Join via `/meet/:code` (password if required) → prejoin → call on the meeting conversation.
- Listen `meeting:updated`.
- Calendar settings persist locally (`calendar.settings.v1`).

---

## 15. Activity module

Reference: `activity-page`, `notification-center.service.ts`.

- `GET /notifications` paginated, `GET /notifications/unread-count`, `POST /notifications/read`.
- Live: `notification:new`, `notification:read`.
- Filters: All / Unread / @Mentions.
- Types: `mention | reply | reaction | missed-call | meeting-invite | meeting-reminder | recording`.
- Open: jump to chat message (highlight), call history, meeting, or recording page.
- Mark one / mark all read.
- Respect prefs (§9) for OS/sound alerts. Never toast for the open conversation.

---

## 16. Files module

`GET /files?type=&cursor=` types `image | video | audio | pdf | file`. Columns: name, shared in, shared by, date, open/download. Preview images via `thumbnailUrl`. Tapping a row can jump to the chat message when `conversationId` + id are present.

---

## 17. Saved messages

`GET /saved-messages?before=` cursor. Each item is a message; open jumps to conversation + highlight. Toggle save from the message menu (`PUT /messages/:id/save`).

---

## 18. Global search

`GET /search?q=` (`search.service.ts` / `search.controller.ts`). People, chats, messages. Selecting a person opens/creates 1:1; selecting a message jumps with `position` API.

Header search field; on phone a search page is fine.

---

## 19. REST catalog (complete)

Prefix `/api`. All except `GET /config` require Clerk Bearer.

| Method | Path |
|---|---|
| GET | `/config` |
| GET | `/web/user/me` |
| GET | `/web/users` |
| GET | `/web/users/except-current` |
| GET | `/web/user/:userId` |
| PATCH | `/web/user/profile` (multipart `image`) |
| DELETE | `/web/deleteUser/:id` |
| GET/POST | `/conversations` |
| GET | `/conversations/:conversationId/state` |
| GET | `/conversations/:id/group` |
| GET | `/conversations/:conversationId/media` |
| GET | `/conversations/:conversationId/recordings` |
| DELETE | `/conversations/:conversationId` |
| POST | `/conversations/group` |
| PUT | `/conversations/group/:id/add-member` |
| PUT | `/conversations/group/:id/remove-member` |
| GET | `/groupConversations` |
| GET | `/messages/:conversationId` |
| GET | `/messages/:conversationId/search` |
| GET | `/messages/:conversationId/position/:messageId` |
| DELETE | `/messages/:messageId` |
| PUT | `/messages/:messageId/save` |
| GET | `/saved-messages` |
| GET | `/search` |
| GET | `/files` |
| GET | `/calls` |
| GET | `/meetings` |
| POST | `/meetings` |
| GET | `/meetings/code/:code` |
| POST | `/meetings/code/:code/join` |
| GET/PATCH/DELETE | `/meetings/:id` |
| GET | `/recordings/:id` |
| GET | `/recordings/:id/transcript` |
| GET | `/recordings/:id/transcript/export` |
| POST | `/recordings/:id/transcript/retry` |
| GET | `/notifications` |
| GET | `/notifications/unread-count` |
| POST | `/notifications/read` |
| POST | `/upload` |

Response shape is typically `{ status, data, message }`. Use `data`.

---

## 20. Design / UX constraints

- **Tabler icons only** (or Flutter Tabler set). No Font Awesome.
- Inter everywhere.
- Tokens: copy `--slate-*`, `--app-brand`, `--app-accent`, bubble in/out, success `#107c41`, danger `#ba1a1a` (dark theme variants in `styles.scss`).
- Outgoing bubbles override tokens locally (white text, dark fill) so nested cards (recording, buttons) invert automatically — replicate with a `BubbleScope` theme in Flutter.
- Phone: list **or** thread (web `isMobileView` / `showChatPane`); back returns to list. Call overlay still global.
- Empty / loading / error for every list.
- Don’t show fake labels (Encrypted, Verified Signature, page counts).

---

## 21. Testing expectations (Flutter)

The web repo was often verified manually. For Flutter, for each module:

- Golden path of that module’s checklist.
- Airplane mode: sockets reconnect, no duplicate messages.
- Two devices, same user: presence, call takeover, `call:force-leave`.
- Two users: 1:1 message, ticks, missed call, callback.
- Group: mention, pin, recording card.
- Blocked user cannot message or ring.

Do not change the Node API to “make Flutter easier”. If a contract is ambiguous, read the gateway and match the web client.

---

## 22. Out of scope / already decided

- No Electron. Screen share is browser/OS capture, not a desktop helper.
- No Python on clients. Transcription is **server** whisper.cpp.
- No new product surfaces (channels, stories, payments).
- Secrets stay in Clerk / server `.env`. Flutter uses publishable key from `GET /config` or `--dart-define`.

When a module is finished, tick its section in this file (or a short `docs/flutter/PROGRESS.md`) so the next session does not re-litigate it.
