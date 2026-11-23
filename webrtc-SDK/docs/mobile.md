# Mobile (Flutter) package

How to build a Flutter package that another company's app (the **host app**) can add, so its users get
SpreeWe chat and calls **after signing in to the host app only**. They never see a SpreeWe login or
consent screen.

> **Status.** There is no Flutter package yet. The current SDK (`@spreewe/*`) is browser-only (Web
> Components, IndexedDB, WASM encryption) and cannot be reused in Flutter. This page is the plan and
> the backend contract the package must follow. Everything marked **Verified** was checked against the
> SpreeWe backend docs or source on 2026-11-17. Everything marked **Unverified** must be proven with a
> spike before anyone commits to dates.

---

## 1. How sign-in works without a SpreeWe login

SpreeWe already supports this through **app users**, so no backend changes are needed (Verified,
[app-users.md](../../docs/developer/app-users.md)).

```
 user ──(host app login)──▶ HOST BACKEND ──(client ID + secret, Basic auth)──▶ SpreeWe
                               │  1. POST /api/v1/app-users    register the user (once)
                               │  2. POST /api/v1/app-tokens   short-lived token for that user
 Flutter app ◀── token ────────┘
     └──(Bearer token)──▶ SpreeWe REST + Socket.IO   (only inside the host app's tenant)
```

- The host app is registered **from a personal account** in the Developer Portal. This gives it a
  dedicated tenant (`dedicatedTenant: true`). Workspace apps (`tenantBound`) can't use app users.
- Tokens issued for app users need **no consent screen** ("these accounts are yours").
- Tokens last 60–900 s (default 600). There is **no refresh token**: the mobile app asks the host
  backend for a new one before `expiresAt`.
- The app's users can only see and talk to other users of the same app. They can't reach SpreeWe
  accounts or other apps' users. The server enforces this.

### Mobile-specific facts (Verified)

- **No `Origin` header is fine.** Native apps don't send one. The backend checks allowed origins only
  when an `Origin` is present (REST: `webrtc-BE/src/developer/app.service.ts`, socket:
  [realtime-events.md §1](../../docs/developer/realtime-events.md#1-connecting)). You don't need to
  register an origin for the mobile app.
- **The client secret must never be in the mobile app.** An APK or IPA can be unpacked. Only the host
  backend holds `swk_…` / `sws_…`.

---

## 2. What each side builds

| Part | Owner (role) | Work |
|---|---|---|
| SpreeWe developer app + credential | SpreeWe product owner | Register the app (personal context), pick the scopes, create a credential, store the secret in the host's secret manager |
| Token endpoint on the host backend | Host backend developer | Register users and exchange tokens (section 3) |
| `spreewe_flutter` package | Flutter developer (SpreeWe side) | REST client, socket, chat, calls, optional UI (section 4) |
| Push notifications for calls/messages | Host backend + mobile developer | Webhook → FCM/APNs (section 6) |
| Host app integration | Host mobile developer | Add the package, pass a token callback (section 5) |

---

## 3. Host backend: the token endpoint

The host backend exposes one endpoint to its own mobile app, for example `POST /spreewe/token`,
protected by **the host's own session** (JWT, cookie, etc.).

```
1. Check the host session → host user id, e.g. "host-user-42"
2. First time only: POST /api/v1/app-users
     { "externalUserId": "host-user-42", "name": "Asha Rao", "email": "...", "avatarUrl": "https://..." }
     201 → created; 409 → already exists (treat as success)
3. POST /api/v1/app-tokens
     { "externalUserRef": "host-user-42", "scopes": [ ...narrowest set... ], "ttlSeconds": 600 }
4. Return { accessToken, expiresAt } to the app (Cache-Control: no-store)
```

Both calls use `Authorization: Basic base64(clientId:clientSecret)`. See
[`examples/token-server/server.mjs`](../examples/token-server/server.mjs) for a minimal version (it's
deliberately unauthenticated, so add step 1 before using it for real).

Rules (Verified, app-users.md):

- `externalUserId` must be a **stable, opaque** id (database key or UUID), never an email. It can't be
  changed later.
- On host sign-out: `POST /api/v1/app-tokens/revoke { "token": "…" }`.
- When a user leaves the host product: `DELETE /api/v1/app-users/{externalUserId}` (deactivate). This
  stops their tokens immediately.
- Limits: 1,000 users for development apps, 100,000 for production apps. Credential requests are limited
  to 120/min by default. Every token fetch counts, so cache the token on the device until shortly
  before it expires.

### Scopes

Ask for the narrowest set per feature ([authentication.md §3](authentication.md#3-scopes-by-module)):

| Feature | Required | Commonly added |
|---|---|---|
| Chat (read list/metadata) | realtime:connect, profile:read, conversations:read, groups:read, messages:read | conversations:write, contacts:write, directory:read, files:write |
| Chat (read content + send) | above + **e2ee:device, messages:write** | messages:edit, messages:react, messages:delete |
| Calls | realtime:connect, profile:read, calls:read, calls:write | calls:manage |
| Contacts | realtime:connect, directory:read, profile:read | contacts:write, profile:write |

---

## 4. The Flutter package

### Suggested public API

```dart
final spreewe = SpreeWeClient(
  baseUrl: 'https://api.spreewe.example',
  // The host app supplies this; it calls the host backend, never SpreeWe directly.
  fetchToken: () async {
    final r = await hostApi.post('/spreewe/token');
    return SpreeWeToken(r['accessToken'], DateTime.parse(r['expiresAt']));
  },
);

await spreewe.connect();
spreewe.chat.conversations.listen((list) { ... });
await spreewe.calls.start(groupId: id, type: CallType.video);
await spreewe.signOut(); // revoke via host backend, clear cache, close socket
```

This mirrors `backendTokenProvider()` in `@spreewe/core`, so web and mobile behave the same way.

### Modules, in build order

| # | Module | Built on | Notes |
|---|---|---|---|
| 1 | Core: token cache, REST, errors | `http` or `dio` | Refresh the token 60 s before `expiresAt`, with one fetch in flight at a time. On 401: refresh once and retry. On 429 with `Retry-After` ≤ 10 s: wait and retry once (same rules as [authentication.md §5](authentication.md#5-connection-management-and-errors)) |
| 2 | Realtime | `socket_io_client` (Dart) | Handshake `auth: { token }`, Socket.IO v4 protocol. The server **disconnects at token expiry**: reconnect with a fresh token and back off exponentially. After every reconnect, re-join rooms and re-sync over REST ([realtime-events.md](../../docs/developer/realtime-events.md#reconnection-what-the-client-must-redo)) |
| 3 | Contacts / directory | REST + socket | Simplest feature module; good first end-to-end test |
| 4 | Chat (metadata) | REST + socket | Without `e2ee:device`, messages arrive as `content: null, encrypted: true` |
| 5 | Calls | `flutter_webrtc` + a mediasoup client | Signalling over `call:*` and `mediasoup:*` events ([realtime-events.md](../../docs/developer/realtime-events.md#calls)) |
| 6 | E2EE (send/read messages) | Olm/Megolm library | Hardest part, see below |
| 7 | UI widgets (optional) | Flutter widgets | Conversation list, chat window, call screen; themable |

Library names above are from general Flutter knowledge and are **Unverified for this project**: check
each one's current version, maintenance status and licence on pub.dev before choosing.

### Known hard parts and risks

1. **End-to-end encryption.** Sending text messages and reading their content requires `e2ee:device`.
   The app must run its **own Olm/Megolm device per user**, compatible with SpreeWe clients, which use
   `@matrix-org/matrix-sdk-crypto-wasm` 18.9.0. That library is browser/Node only. A Flutter version
   needs a native Olm/Megolm implementation (for example vodozemac bindings) that interoperates with it.
   **Unverified:** nobody has tested interop, and the backend docs say app E2EE is "not tested in a
   browser or mobile app built by a third party". Spike this **first**. If it fails, chat on mobile is
   read-only metadata.
   - Keys must be stored in the platform keystore (`flutter_secure_storage` or similar). Losing them
     means losing access to history on that device.
   - Device lifecycle: [authentication.md §9](../../docs/developer/authentication.md).
2. **Calls (mediasoup).** The server uses mediasoup 3.x. The Flutter side needs a mediasoup-compatible
   client on top of `flutter_webrtc`. Community Dart ports exist, but their maintenance status is
   **Unverified**. The alternative is writing the transport/producer/consumer handling yourself. The
   backend docs also say: *"No automated test runs a full audio/video session with real WebRTC."*
   Test on real iOS and Android devices early.
3. **App sockets can't resume a call after reconnecting** (Verified, known limitation #2): their
   `deviceId` is always the new `socket.id`. On mobile, network switches (Wi-Fi ↔ cellular) are common,
   so a drop means re-joining the call, not resuming it. Design the call UI for this.
4. **The app connection doesn't mark the user online** (Verified). Presence for mobile users won't
   show from the app socket alone.
5. **Rate limits.** Development apps are capped at 120 requests/min **for the whole app** (all users
   together). Many test devices hitting it at once will get 429s. Request production quotas before a
   pilot.
6. **Background behaviour.** iOS and Android suspend sockets in the background. Incoming calls and
   messages while the app is closed need push (section 6). Without push, users only receive calls with
   the app open.

---

## 5. Host app integration (what the host developer does)

1. Add the package (path, git or private registry; see section 7).
2. Implement `fetchToken` against **their own** backend endpoint (section 3).
3. Create one `SpreeWeClient` after the host login, and call `signOut()` on host logout.
4. Platform setup:
   - **Android:** `INTERNET`, `CAMERA`, `RECORD_AUDIO`, `BLUETOOTH_CONNECT` (headsets) permissions;
     foreground service for an ongoing call.
   - **iOS:** `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`; background mode `voip` and
     `audio` if using CallKit.
5. Use the widgets, or build their own UI on the package's streams.

---

## 6. Push notifications (incoming calls and messages)

SpreeWe has no mobile push of its own. Use **outbound webhooks** to the host backend (Verified events:
`call.started`, `call.ended`, `message.created`, `conversation.members_added`,
`conversation.members_removed`, `recording.available`;
[outbound-webhooks.md](../../docs/integrations/outbound-webhooks.md)):

```
SpreeWe ──webhook (signed)──▶ host backend ──FCM / APNs (VoIP)──▶ device
                                                   └▶ app wakes → fetchToken → connect → call:accept
```

- iOS incoming calls need **PushKit + CallKit**. Apple requires a VoIP push to show a call UI promptly,
  or the app can be throttled. Android: FCM high-priority + a full-screen notification.
- Verify webhook signatures on the host backend before sending pushes.
- Message pushes can't contain message text (it's end-to-end encrypted). Send "New message from X"
  and decrypt in the app.

---

## 7. Building and distributing the package

```bash
flutter create --template=package spreewe_flutter   # Dart-only; use --template=plugin if native code is needed
cd spreewe_flutter
flutter analyze && flutter test
dart pub publish --dry-run                           # checks pubspec and contents without uploading
```

Ways to give it to a host app **without publishing to pub.dev**, matching what we do for npm tarballs:

| Option | In host `pubspec.yaml` | Use for |
|---|---|---|
| Local path | `spreewe_flutter: { path: ../spreewe_flutter }` | Your own testing |
| Private git | `spreewe_flutter: { git: { url: git@…/spreewe_flutter.git, ref: v0.1.0 } }` | Pilot customers |
| Private pub repository | `hosted: https://pub.example.com` | Production customers |

Before any external distribution, settle the same two decisions as the web SDK
([development.md](development.md#publishing)): **licence** (currently `UNLICENSED`) and **where it is
hosted**. Publishing to pub.dev makes the source public.

---

## 8. Suggested delivery order

| Phase | Deliverable | Exit check |
|---|---|---|
| 0. Spikes | E2EE interop (Flutter device ↔ web client) and a mediasoup call on real iOS + Android | Decrypted message both ways; 2-party video call for 10 min on cellular |
| 1. Core | Token cache, REST, socket, reconnect | Socket survives token expiry and network switch |
| 2. Contacts + chat metadata | Lists, groups, receipts | Matches the web SDK on the same account |
| 3. Calls | 1:1 and group, mute, camera switch | Phase 0 call test passes in the package |
| 4. E2EE chat | Send and read text, attachments | Phase 0 interop passes in the package |
| 5. Push | Webhook → FCM/APNs, CallKit | Incoming call rings with the app killed |
| 6. UI widgets | Optional ready-made screens | Host app integrates in under a day |

The phase 0 results decide whether phases 3 and 4 are feasible as planned. Don't promise them to a
customer before then.
