# End-to-end encryption (E2EE) for messages and attachments

Status: **implemented in development and tested. Not production-ready** until the open items below are closed and an independent cryptographic and security review has been done. Nothing here has been deployed.

## 1. What is protected, and what is not

**Protected:** the text of every new chat message (personal, organization, group and Teams-channel conversations, edits included) and every new attachment (images, video, audio, documents). The server stores and relays only ciphertext. The server never has message keys or device private keys.

**Not protected (metadata the server still sees):**
- who is in each conversation, and who sent each message to which conversation, and when;
- the message type, ciphertext size, attachment size and kind;
- reactions, read and delivery receipts, pins, saved-message bookmarks, mentions (user ids, needed for mention notifications), reply links (message ids);
- call notices (`type: 'call'`: a fixed client string such as "Video call started." plus the join link) and system messages;
- device lists, public identity keys and the fact that devices exchange keys;
- calls, meetings, recordings and transcripts. These are a separate media path and are **not** E2EE (recordings and transcripts are made on the server).

**E2EE does not protect against:** a compromised device or browser, malicious or injected JavaScript served to the client (including a compromised SpreeWe frontend deployment), browser extensions, screenshots, or a legitimate recipient copying a message. Trust in the web client is trust in whoever serves it.

## 2. Protocol and library

- **Protocol:** Olm (pairwise, Double Ratchet) to exchange keys between devices, and Megolm (`m.megolm.v1.aes-sha2`) for conversation messages. These are the Matrix protocols, as deployed in Element and others.
- **Library:** `@matrix-org/matrix-sdk-crypto-wasm` **18.9.0**, pinned exactly in `webrtc-FE/package.json`. It is the Rust `matrix-sdk-crypto` crate (built on vodozemac) compiled to WebAssembly. vodozemac was audited by Least Authority in 2022. That audit covers vodozemac, not this wrapper or SpreeWe's integration. No cryptographic code was written for SpreeWe: the app only calls the library's `OlmMachine` API.
- **Attachments:** WebCrypto AES-256-GCM, with a fresh random key and IV for each file. The key, IV and a SHA-256 of the ciphertext travel inside the encrypted message. Decryption checks the hash, then the GCM tag. (`webrtc-FE/src/app/core/crypto/attachment-crypto.ts`)
- **Maintenance:** check for new library releases and Matrix security advisories before each release. Upgrading means bumping the pinned version and re-running `e2ee.service.spec.ts` and `e2ee-feasibility.spec.ts`.
- **Install note:** the frontend needs `npm install --legacy-peer-deps` because of an existing `ngx-socket-io` peer-dependency conflict that has nothing to do with E2EE.

## 3. Architecture

```
Browser (Angular)                                     Server (Node, MongoDB, S3)
E2eeService ── OlmMachine (WASM) ── IndexedDB store    /v1/e2ee/* key directory + to-device relay
     │  encrypt(conversation) → {ciphertext, session_id, sender_key, device_id}
     └─ socket sendMessage {type, e2ee} ─────────────► message.gateway: validates shape, stores e2ee, content ""
attachment-crypto (AES-GCM) ── upload encrypted=1 ──► S3: application/octet-stream ".bin", original name hidden
```

- **Identifiers:** user `@<userId>:spreewe.local`; room `!<conversationId>:spreewe.local`. These are internal names for the library only: there is no Matrix federation.
- **Server endpoints** (`webrtc-BE/src/api/v1/e2ee.routes.ts`, first-party sessions only; the device comes from the `x-spreewe-device` header):
  - devices: register, list, revoke;
  - keys: upload, query, claim;
  - `sendToDevice` and `sync` (to-device inbox);
  - room members.
- **Server checks** (`webrtc-BE/src/e2ee/e2ee.service.ts`):
  - A device can upload keys only for its own user and device id.
  - A device's identity key is immutable.
  - Queries and claims are limited to people who share a conversation with the caller.
  - One-time keys are claimed atomically.
  - To-device event types are allow-listed, size-capped (64 KB) and expire after 30 days.
  - Membership is always read from the server, never from the client.
- **Message checks:** `webrtc-BE/src/e2ee/payload.ts` accepts only the five ciphertext fields, up to 128 KB. A text or media message without them is rejected with `message:rejected` (`reason: "unencrypted"`), and nothing is stored.
- **Group key rotation:** before encrypting, the client fetches the member list from the server. If anyone has left since the last session was shared, it calls `invalidateGroupSession` so former members don't get keys for new messages. New members receive only the current session, so they can't read earlier history.

## 4. Keys and devices

- **Storage:** each browser profile is a device with its own Olm account in IndexedDB (`spreewe-e2ee-<userId>`). That store is encrypted by the library with a random passphrase. The passphrase is itself wrapped with a **non-extractable** AES-GCM key kept in IndexedDB `spreewe-e2ee-vault` (`key-vault.ts`).
- **Where private keys never go:** the server, MongoDB, localStorage, logs or any backup.
- **Limit of the storage protection:** it protects against copying the files off the disk. It does **not** protect against code running in the page.
- **Registration:** on sign-in, the shell starts E2EE for the user. The device registers, uploads identity and one-time keys, then syncs.
- **Revocation:** the server endpoint `POST /v1/e2ee/devices/:deviceId/revoke` exists. Revoking a device:
  - deletes its one-time keys and to-device inbox on the server;
  - tells contacts’ clients so they stop sharing keys with it.

  **There is no UI for revocation**: the devices page was removed at the product owner’s request (2026-10-28). Revoking a device does not sign it out.
- **Verification and identity warnings: removed from the UI** (2026-10-28, product decision). There is no header indicator, no fingerprint comparison and no "not verified" line on messages. Consequence: users can’t detect a substituted device or identity key (for example, a malicious server adding a device to a contact’s account), so the guarantee rests on trusting the server’s device directory. The library still records trust state, so this can be re-enabled.
- **Still shown on messages:** "waiting for the key" and "can’t be decrypted on this device", so a failure is never blank and never replaced by plaintext.
- **Sender binding:** a message whose session key doesn't belong to the claimed sender's devices is rejected (sender binding).

## 5. Recovery limits (important for users and support)

- There is **no key backup and no cross-signing yet**. A new browser, a cleared site-data store or a revoked device **cannot read messages sent before it was set up**. Those messages show "can't be decrypted on this device".
- Losing every device means losing readable history. Support cannot recover it: the server never had the keys.
- Possible next step: Matrix-style server-side key backup, encrypted with a user-held recovery key, plus cross-signing. Both are supported by the same library but are not implemented here. Each needs its own design and review.

## 6. Features changed to keep the server blind

| Feature | Before | Now |
|---|---|---|
| In-conversation search | Server full-text search | Client-side: the browser fetches and decrypts history page by page and matches in memory, scanning up to 2,000 messages per "load more". Nothing decrypted is stored. Slower on very long histories. |
| Global/server message search | Server searched message text | Can't match message text. The server can still search conversation and people metadata. |
| Notifications (push, activity, previews) | Message text | Generic "New message" from the server. In-app notifications decrypt on the device and fall back to "New message". |
| Forwarding | Server copied the message | The client decrypts, then re-encrypts for the target conversation. The server refuses `forwardOf`. |
| Edits | Plaintext | Re-encrypted. The server stores only the new ciphertext. |
| Developer apps / webhooks / app sockets | Received text and could send | Receive `{encrypted: true, content: null}` and no ciphertext. **Apps cannot send messages** (the `messages:write` scope is effectively unused). |
| Attachment previews and thumbnails | Server-generated | None from the server. The client decrypts and shows the file. Files are decrypted eagerly in memory, which costs memory for large files. |
| Mobile (Flutter) client | Worked | **Cannot read or send messages** until it integrates the same library (`matrix-sdk-crypto` has native bindings). This is a release blocker if mobile users exist. |

## 7. Existing (plaintext) history: migration strategy

New messages are always encrypted. Messages already stored in plaintext before this change are still plaintext on the server; encrypting them now would not remove the server's past access.

Recommended steps, **each needing explicit authorization from the product owner and the DBA/ops lead, because they are destructive**:
1. Announce a cut-over date, and offer users an export of their history before it.
2. After the cut-over, purge the `content` of messages that have no `e2ee` field, and delete the plaintext S3 objects of legacy attachments. Back up first, under the retention policy.
3. Optional and more complex: let a client that is online re-encrypt legacy history it can read. This is not implemented.

Until step 2 runs, legacy messages remain readable by the server, and the UI shows them without the encrypted state.

## 8. Deployment checklist (not done; requires authorization)

1. Backend: deploy, then run migrations (`2026-10-28-e2ee`: indexes only, non-destructive).
2. Frontend: `npm ci --legacy-peer-deps`, then a production build. Confirm `assets/crypto/matrix_sdk_crypto_wasm_bg.wasm` (about 7.8 MB) is served with `Content-Type: application/wasm`.
3. CSP: allow `'wasm-unsafe-eval'` in `script-src` if a CSP is enforced.
4. Service worker: check that the WASM isn't added to the prefetch group, which would download 7.8 MB on install.
5. Decide the Flutter, legacy-history and developer-app questions in section 6 and section 7 **before** release.
6. Independent security review of the integration.

## 9. Tests

- Backend, `webrtc-BE/test/e2ee.test.ts` (9 tests):
  - key upload only for your own account and device; a silent identity change is refused;
  - keys are served only for people who share a conversation;
  - a one-time key is handed out exactly once, including under concurrent claims, then the fallback key;
  - to-device messages are delivered once (ack); strangers, plaintext and unknown types are refused;
  - a revoked device stops receiving keys and can't publish; contacts are told;
  - room members come from the server, for members only, in the conversation's context;
  - plaintext messages are refused; encrypted ones are relayed without plaintext;
  - server-side forwarding is refused, and edits must be encrypted;
  - plaintext attachment uploads are refused; encrypted ones are stored opaquely without their name.

  App and webhook redaction is covered in the `webhooks` and `developer-platform` tests. All other suites now send encrypted payloads.
- Frontend, `e2ee.service.spec.ts` (real library, fake server; 8 tests):
  - round trip without the server seeing plaintext;
  - a removed member can't read later messages (key rotation);
  - rotation still holds after the sender reloads the page;
  - tampered ciphertext and a forged sender are refused;
  - a message whose key arrives late is "pending", then becomes readable (late or offline key delivery);
  - encryption is refused, rather than sending plaintext, when a member's devices can't be reached;
  - fingerprint verification, stored locally;
  - attachment round trip; a changed byte or a swapped file is refused.

  `e2ee-feasibility.spec.ts` checks the WASM loads.
- Integration, `webrtc-BE/test/e2ee-real-crypto.test.ts` (7 tests). It runs the **real** library in Node as several devices against the real HTTP routes, Socket.IO gateway and test database, following the same steps as the browser service. Each message carries a unique marker. The marker must appear only in an authorized device's decryption output: never in a Socket.IO frame (sent or received), an HTTP response, a stored document (messages, to-device queue, devices) or a log line. Covers:
  - 1:1 messages, including the sender reading its own;
  - the REST history path;
  - replies (the quoted message), edits, pins, saved messages and conversation-list previews;
  - a group, where a removed member can't read later messages and the session id changes;
  - outsiders, who get no history, no relay and no keys;
  - an offline recipient, history pagination and reconnection;
  - tampered ciphertext, replay into another conversation, an unknown session, and a device added later;
  - plaintext text and plaintext attachments refused.
- Not covered on the client: Megolm message replay. The library tracks message indexes, but SpreeWe has no test for it. Revoked devices are tested only on the server side.
- Last run (2026-10-28): backend 248/248 (28 files), frontend 94/94, production build OK. Neither project has a linter configured; both type checks (`tsc`, `ngc`) are clean.

### Fixed on 2026-10-28 (messages not displayed)

The REST history endpoint (`MessageService.history`) built each message field by field and left out `e2ee`. The client therefore treated encrypted messages as legacy ones and showed their empty `content`. The same omission affected:
- the quoted message in replies, on both the history and the live relay paths;
- the conversation-list last-message projection;
- pins;
- saved messages;
- shared media;
- the `/v1` history.

All of these now return the ciphertext, and the client decrypts each one (`reveal`, `revealRef`). Separately, the sender now refreshes members' device lists (`queryKeysForUsers`) before each key share. Without this, a recipient's device added since the last device-change sync, or while the sender's page was closed, did not get the key. The integration test fails without either fix.

Not covered by automated tests: a real multi-browser run against a staging server, large attachments, and long-history search performance.

## 10. Open items

- Independent cryptographic and security review.
- Key backup and cross-signing (section 5).
- Flutter client support.
- Legacy history purge (section 7).
- The lookup rate limit is per instance; use a shared store for multiple instances.
- Confirm the library's IndexedDB store names that `forgetDevice` deletes, so no stale key material is left behind.
- Recordings, transcripts and call media are out of scope for this change.
