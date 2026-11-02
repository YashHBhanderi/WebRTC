# Session REST API (user-session endpoints)

These are the REST endpoints a signed-in end user's browser or app calls with its own Clerk session token. They are the older, unversioned surface. For the versioned, uniformly enveloped API, see [./v1-api.md](./v1-api.md).

Messages are **not** sent over REST. Sending, editing, reacting, pinning and read receipts go over Socket.IO (`sendMessage`, `message:edit`, `reactToMessage`, `message:pin`, `markMessagesRead`, ...). See [../realtime-events.md](../realtime-events.md).

## Contents

- [Conventions](#conventions)
- [Status labels](#status-labels)
- [Users](#users)
- [Conversations](#conversations)
- [Groups](#groups)
- [Messages](#messages)
- [Search and files](#search-and-files)
- [Uploads](#uploads)
- [Calls](#calls)
- [Meetings](#meetings)
- [Recordings](#recordings)
- [Notifications](#notifications)
- [Workspace (tenant)](#workspace-tenant)
- [Public configuration](#public-configuration)

## Conventions

### Base URL

Every route in this document is served twice: at the root and under `/api`. `GET $SPREEWE_API/conversations` and `GET $SPREEWE_API/api/conversations` hit the same handler. Pick whichever your reverse proxy forwards. The examples use `$SPREEWE_API` with no prefix.

### Authentication

```
Authorization: Bearer $SPREEWE_SESSION_TOKEN
```

- The token is a **Clerk session token** for the end user. Every route except `GET /config` requires it.
- **Developer-app tokens are not accepted here.** The `verifyToken` middleware only reads the Clerk session (`getAuth`). Developer-app user tokens belong to the `/v1` surface, documented in [./v1-api.md](./v1-api.md).
- Browser requests (those with an `Origin` header) are checked against `CLERK_AUTHORIZED_PARTIES` (Clerk `azp`). Requests with no `Origin` header and a Bearer token (native apps) skip the `azp` check.
- On the first authenticated request, the server links the Clerk user to an app account and creates the account if it does not exist yet.

### Workspace context

The workspace is the **active Clerk organization in the session token** (`org_id`). No endpoint takes a tenant or workspace id. To change workspace, switch the organization in Clerk and use the new session token.

- **No active org:** personal context. You only see people you already share a conversation with. There is no public directory.
- **Active org:** the workspace must exist and be `active`, otherwise you get `403 This workspace is suspended` or `403 This workspace no longer exists`. A malformed org id returns `401 Invalid organization in session`. A member removed from the workspace gets `403 You are no longer a member of this workspace`. For organizations managed in SpreeWe, a caller who is not an active member gets `403 You are not a member of this organization`.
- Conversations, messages, search results and the directory are all filtered to the active context.

### Response envelopes

These routes do **not** share one envelope. Each route lists the exact shape it returns. The shapes in use:

| Shape | Used by |
|---|---|
| `{ "status": true, "data": ..., "message": "..." }` | Most user, group, meeting, recording, notification, search, workspace and config routes |
| `{ "success": true, "data": ... }` (sometimes with `message`) | `GET /conversations`, `GET /messages/:conversationId`, message search and position, `GET /conversations/:id/state`, `GET /groupConversations` |
| `{ "conversationId": "..." }` (no envelope) | `POST /conversations` |
| `{ "storageKey", "type", "size", "encrypted" }` (no envelope) | `POST /upload`, `purpose=message` |
| `{ "status": <bool>, "data": null, "message": "Message deleted" }` | `DELETE /messages/:messageId` (`status` mirrors the service result) |
| File download | `GET /recordings/:id/transcript/export` |

The SDK's internal `rest()` helper returns `json.data` by default. It reads the raw body only for `POST /conversations` and `POST /upload`.

### Errors

Most handlers report failures through `sendError`:

```json
{
  "status": false,
  "success": false,
  "data": null,
  "message": "Type at least 2 characters to search",
  "error": { "code": "VALIDATION_ERROR", "message": "Type at least 2 characters to search", "actionable": true }
}
```

| HTTP | `error.code` |
|---|---|
| 400, 413, 415, 422 | `VALIDATION_ERROR` |
| 401 | `AUTHENTICATION_ERROR` |
| 403 | `PERMISSION_ERROR` |
| 404 | `NOT_FOUND_ERROR` |
| 409 | `CONFLICT_ERROR` |
| 429 | `RATE_LIMIT_ERROR` |
| 5xx | `SERVER_ERROR`. The `message` is a generic fallback and internal details are never returned. |

Some failures use a different shape:

- **Authentication failures** from `verifyToken` return `{ "success": false, "message": "..." }`:
  - `401 Please sign in to continue.`
  - `503 Sign-in is not configured on the server`
  - a workspace-resolution error with its own status (see [Workspace context](#workspace-context))
- **Upload errors** (`POST /upload`, and multer errors on any multipart route) return `{ "status": false, "data": null, "message": "..." }` with no `error` object.
- **Rate-limit responses** return `429` with `{ "success": false, "message": "Too many requests. Please slow down and try again." }`.
- **`DELETE /web/deleteUser/:id` with someone else's id** returns `403 { "status": false, "data": null, "message": "You can only delete your own account" }`.

Invalid ObjectIds are generally rejected as `400`. Resources outside your membership or workspace generally return `404`, so the response does not reveal whether the resource exists.

### Rate limits

Limits are per client IP, per window. Configure them in `webrtc-BE/src/config/security.ts`:

| Variable | Default | Applies to |
|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window length for both limits |
| `RATE_LIMIT_MAX` | `600` | Every request |
| `RATE_LIMIT_SENSITIVE_MAX` | `60` | Additionally: `POST /upload`, `GET /search`, `POST /conversations/group`, `POST /meetings`, `POST /meetings/code/:code/join`, `POST /tenant/external-conversations`, `PATCH /tenant/current/policies` (with and without `/api`) |

Responses carry `RateLimit` / `RateLimit-Policy` headers (draft-7). JSON and URL-encoded bodies are capped at `JSON_BODY_LIMIT` (default `2mb`). Files go through multipart.

### End-to-end encryption

Message text and media are end-to-end encrypted on the sender's device. When a client sends a message (Socket.IO `sendMessage`), the server validates the ciphertext and stores it in the message's `e2ee` field. It refuses plaintext text or media messages with `message:rejected` (`reason: "unencrypted"`, "Messages must be end-to-end encrypted"). REST responses therefore return `e2ee` for clients to decrypt. For encrypted messages, `content` is empty or a placeholder. Chat attachments are uploaded as ciphertext too (see [Uploads](#uploads)).

## Status labels

Each endpoint is labelled with one of:

- **Tested via SDK**: exercised by the SDK end-to-end test (`webrtc-BE/test/sdk-e2e.test.ts`, through `packages/chat-sdk`).
- **Implemented (server tests)**: covered by another test in `webrtc-BE/test/*.test.ts`.
- **Implemented, not covered by tests**: no automated test calls it.
- **Implemented, not tested end to end (needs S3)**: upload paths.

---

## Users

### GET /web/user/me

Returns the signed-in user's account. On first use, the server links the Clerk user to an app account or creates one.
Status: **Tested via SDK** (`auth.connect`).

**Response 200** `{ status, data, message }`. `data` is the full user document, including your own unmasked `status`.

```json
{ "status": true, "data": { "_id": "66f0c1...", "username": "alice", "email": "alice@example.com", "avatar": "", "bio": "", "status": "online" }, "message": "" }
```

**Errors:** `404 Account not found`. `500 Could not load your account`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/web/user/me"
```

### GET /web/users

### GET /web/users/except-current

Both routes return the same thing: the directory of people you may start a conversation with in the active context. The current user is always excluded.

- In a workspace: the workspace's active members. Guests see only people they already share a conversation with.
- In personal context: people you already share a conversation with.

Accounts that are deleted or banned in Clerk are never listed. Results are sorted by username, up to 500.
Status: **Implemented (server tests)**.

**Response 200**:

- `GET /web/users`: `{ status: true, data: User[], message: "All Users" }`
- `GET /web/users/except-current`: `{ status: true, data: User[], message: "User get Successfully" }`

Each user has the public fields only: `_id, username, avatar, isOnline, lastSeen, bio, status, statusMessage, autoAway`. Emails are not included.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/web/users"
```

For a filterable version, see [`GET /directory`](#get-directory).

### GET /web/user/:userId

Returns one person's profile if they are visible to you. A user is visible if they are you, share a conversation with you in the active context, or (outside guest role) are an active member of the active workspace. Other users get `404`.
Status: **Tested via SDK** (`users.get`).

| Param | Type | Notes |
|---|---|---|
| `userId` | ObjectId (path) | Invalid id → `404 User not found` |

**Response 200** `{ status: true, data: User, message: "User get Successfully" }`. Another user's profile contains the public fields listed under `GET /web/users`. Your own profile contains every field except `password`.

**Errors:** `404 User not found`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/web/user/66f0c1aa0000000000000002"
```

### PATCH /web/user/profile

Updates the signed-in user's profile. Send `multipart/form-data`, or JSON if there is no image. After the update, the server pushes `user:updated` to everyone who shares a conversation with you.
Status: **Implemented, not covered by tests**. Image upload: **Implemented, not tested end to end (needs S3)**.

| Field | Type | Notes |
|---|---|---|
| `username` | string | Validated by `validateUsername` |
| `bio` | string | Control characters are stripped. Max length `BIO_MAX` (see `userServices.ts`) |
| `status` | string | Must be one of `USER_STATUSES` |
| `globalDiscoverable` | boolean or `"true"`/`"false"` | |
| `image` | file | Optional avatar: JPEG, PNG, GIF or WebP, max 5 MB |

Email cannot be changed here.

**Response 200** `{ status: true, data: User, message: "Profile updated successfully" }`.

**Errors:** `400` validation messages such as `Bio must be text`, `Invalid status`, `globalDiscoverable must be true or false`. `413` if the file is too large. `500 Could not update the profile`.

```bash
curl -X PATCH -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" \
  -F "bio=Working on the API" -F "image=@avatar.png" "$SPREEWE_API/web/user/profile"
```

### DELETE /web/deleteUser/:id — internal, not for integrators

Deletes the caller's own app user record (MongoDB) and releases their avatar file. Any other `:id` returns `403 You can only delete your own account`. There is no admin override.
Status: **Implemented, not covered by tests**.

This does **not** delete the Clerk user. The next authenticated request with a valid session links or creates the app account again (see `verifyToken`). Conversations and messages are not removed either. Do not use this for account deletion. Delete the user in Clerk, which the server syncs through its Clerk webhook.

**Response 200** `{ status: true, data: null, message: "User Deleted Successfully" }`.

```bash
curl -X DELETE -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/web/deleteUser/66f0c1aa0000000000000001"
```

---

## Conversations

### GET /conversations

Lists your **direct (1:1)** conversations in the active context, newest first. Only chats that have a message, or that you cleared, are included. Group conversations are **not** included; use [`GET /groupConversations`](#get-groupconversations) for those.
Status: **Tested via SDK** (`conversations.list`).

| Query | Type | Default | Notes |
|---|---|---|---|
| `archived` | `true` / `1` | false | Returns the archived list instead |

**Response 200** `{ success: true, data: Conversation[] }`. Each item has:

- `_id`, `unreadCount`, `timestamp`
- `scope` (`global` / `workspace` / `external`), `externalParticipants`
- `isArchived`, `isFavorite`
- `sender` (you), `receiver` (the other person)
- `lastMessage` (may carry `e2ee` rather than readable text)

```json
{ "success": true, "data": [ { "_id": "6710...", "unreadCount": 2, "scope": "global", "externalParticipants": [], "isArchived": false, "isFavorite": false, "receiver": { "_id": "66f0...", "username": "bob" }, "lastMessage": { "type": "text" }, "timestamp": "2026-11-01T09:12:00.000Z" } ] }
```

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/conversations?archived=false"
```

### POST /conversations

Opens a direct conversation with `receiverId`. If one already exists, returns it.

Rules for a **new** conversation:

- Neither side may have blocked the other.
- In a workspace, the receiver must be a workspace member. To chat with outsiders, use [`POST /tenant/external-conversations`](#post-tenantexternal-conversations).
- In personal context, the receiver must be discoverable and not deleted or banned.

Status: **Tested via SDK** (`conversations.openDirect`).

| Body field | Type | Notes |
|---|---|---|
| `receiverId` | ObjectId | Required |

**Response 200**, with no envelope:

```json
{ "conversationId": "6710aa000000000000000001" }
```

**Errors:**

- `400 Receiver ID is required`, `400 You can't start a chat with yourself`, `400` for an invalid id
- `403 You can't start a chat with this person.`, or a workspace-membership `403`
- `404 No eligible account found.`

```bash
curl -X POST -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{"receiverId":"66f0c1aa0000000000000002"}' "$SPREEWE_API/conversations"
```

### GET /conversations/:conversationId/state

Returns your per-chat state. You must be a member of the conversation.
Status: **Implemented, not covered by tests**.

**Response 200** `{ success: true, data }`. `data` includes:

- Your chat-state fields: archive, clear and favorite flags, from `chat-state.service`
- `isGroup`
- `peerId`: `null` for groups
- `blockedByMe`: only your own block is revealed
- `receipts`: per-member delivered and read markers
- `pins`

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/conversations/6710aa000000000000000001/state"
```

### DELETE /conversations/:conversationId

Deletes a **group**. Only group admins may do this. Members are notified with `group:removed` (`reason: "deleted"`). Direct chats cannot be deleted: use Clear chat or Archive instead.
Status: **Implemented (server tests)**.

**Response 200** `{ status: true, data: null, message: "Group deleted" }`.

**Errors:**

- `400 Use Clear chat or Archive to remove this chat for you` (direct chat)
- `403 You are not a member of this conversation`
- `403 Only group admins can delete the group`
- `404 Conversation not found`

```bash
curl -X DELETE -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/conversations/6710aa000000000000000009"
```

### GET /conversations/:conversationId/media

Returns up to 300 media messages in the chat, newest first: images, videos, audio, PDFs and files. You must be a member. Messages before your "clear chat" point are excluded.
Status: **Implemented, not covered by tests**. Media: **needs S3**.

**Response 200** `{ status: true, data: Media[], message: "Shared media retrieved successfully" }`. Each item has `_id, conversationId, userId, e2ee, type, createdAt` plus media fields with pre-signed URLs. Encrypted files are decrypted on the client using the key inside the message's `e2ee` payload.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/conversations/6710aa000000000000000001/media"
```

---

## Groups

### POST /conversations/group

Creates a group. The caller becomes the group admin and is added to the members if missing. Send `multipart/form-data` (needed for the optional photo) or JSON.
Status: **Tested via SDK** (`conversations.createGroup`). Photo: **Implemented, not tested end to end (needs S3)**. Rate limit: **sensitive**.

| Field | Type | Notes |
|---|---|---|
| `groupMembers` | string | **JSON-encoded array** of user ObjectIds, e.g. `'["id1","id2"]'`. Max 256. Including yourself, there must be at least 3 members (you plus at least 2 others). In a workspace, every member must belong to it. |
| `groupName` | string | Required, max 100 |
| `groupDescription` | string | Optional, max 500 |
| `image` | file | Optional group photo, max 5 MB |

**Response 201** `{ status: true, data: Conversation, message: "Group Conversation created Successfully" }`.

**Errors:**

- `400 Members are required Or Group Admin required!`
- `400 Members are invalid`
- `400 A group must have a name and at least 2 members`
- `403` if a member is outside the workspace

```bash
curl -X POST -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" \
  -F 'groupMembers=["66f0c1aa0000000000000002","66f0c1aa0000000000000003"]' \
  -F "groupName=Release team" "$SPREEWE_API/conversations/group"
```

### PUT /conversations/group/:id/add-member

Adds members to a group. The same rules apply as for the `group:add-member` socket event.
Status: **Implemented (server tests)**.

| Body | Type |
|---|---|
| `userIds` | ObjectId[] |

**Response 200** `{ status: true, data: GroupSummary, message: "Member Added Successfully" }`.

**Errors:**

- `400 Those people are already members of this group`
- `400 This is a team channel: manage it from the team`
- `404 Group not found`
- `404 Users not found`
- `403` for permission or workspace failures

```bash
curl -X PUT -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{"userIds":["66f0c1aa0000000000000004"]}' "$SPREEWE_API/conversations/group/6710aa000000000000000009/add-member"
```

### PUT /conversations/group/:id/remove-member

Removes one member from a group.
Status: **Tested via SDK** (`conversations.removeMember`).

| Body | Type |
|---|---|
| `userId` | ObjectId |

**Response 200** `{ status: true, data: GroupSummary, message: "Member removed successfully" }`.

**Errors:**

- `400 Use Leave group to remove yourself`
- `400 User is not a member of this group`
- `404 Group not found`
- `403` for permission failures

```bash
curl -X PUT -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"66f0c1aa0000000000000004"}' "$SPREEWE_API/conversations/group/6710aa000000000000000009/remove-member"
```

### GET /groupConversations

Lists your groups with the last message and unread count, newest first. Team channels are excluded.
Status: **Implemented (server tests)**.

| Query | Type | Default |
|---|---|---|
| `archived` | `true` / `1` | false |

**Response 200** `{ success: true, data: Group[], message: "Grop chats get Successfully" }`. The typo is in the server message.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/groupConversations"
```

### GET /conversations/:id/group

Returns group details for a member.
Status: **Implemented (server tests)**.

**Response 200** `{ status: true, data: Group, message: "Data get Successfully" }`.

**Errors:** `404 Group conversation not found`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/conversations/6710aa000000000000000009/group"
```

---

## Messages

There is no REST endpoint for sending messages. Use the Socket.IO `sendMessage` event (see [../realtime-events.md](../realtime-events.md)).

### GET /messages/:conversationId

Returns a page of message history, oldest first within the page. You must be a member. Messages before your "clear chat" point are excluded.
Status: **Tested via SDK** (`messages.history`).

| Query | Type | Default | Limits |
|---|---|---|---|
| `page` | int | 1 | ≥ 1. Page 1 holds the newest messages |
| `limit` | int | 20 (the SDK sends 30) | Clamped to 1–2000 |

**Response 200** `{ success: true, message: "Messages retrieved successfully", data: Message[] }`. Each message has:

- `_id, conversationId, type, createdAt, userId`
- `content`: empty for encrypted messages
- `e2ee`: the ciphertext, decrypted on the device
- media fields
- `isDeleted, isRead, status` (`seen`/`delivered`/...), `editedAt, mentions, saved, call, recording, reactions`
- `user`: `{ _id, username, email, avatar, isOnline, lastSeen }`
- `replyTo`: `{ _id, content, e2ee, type, userId }`

```json
{ "success": true, "message": "Messages retrieved successfully", "data": [ { "_id": "6711...", "conversationId": "6710...", "content": "", "e2ee": { "...": "ciphertext" }, "type": "text", "status": "seen", "isRead": true, "saved": false, "mentions": [], "createdAt": "2026-11-01T09:12:00.000Z", "user": { "_id": "66f0...", "username": "alice" }, "replyTo": null } ] }
```

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/messages/6710aa000000000000000001?page=1&limit=30"
```

### GET /messages/:conversationId/search

Server-side search inside one chat. It runs a case-insensitive substring match on the stored `content` field of text messages and captioned media.
Status: **Implemented, not covered by tests**.

**Limitation:** encrypted messages store their text only in `e2ee`, so `content` is empty. This search **cannot match end-to-end-encrypted text**. It only finds legacy plaintext messages. Search decrypted history on the client instead.

| Query | Type | Default | Notes |
|---|---|---|---|
| `q` | string | — | 2–100 characters |
| `before` | ISO date | — | Cursor |
| `beforeId` | ObjectId | — | Cursor tie-breaker |
| `limit` | int | 30 | Clamped to 1–50 |

**Response 200** `{ success: true, data: { results: [{ _id, content, type, createdAt, user }], nextCursor: { before, beforeId } | null } }`.

**Errors:** `400 Type at least 2 characters to search`, `400 Search text is too long`, `400 Invalid cursor`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/messages/6710aa000000000000000001/search?q=invoice"
```

### GET /messages/:conversationId/position/:messageId

Returns how many visible messages are newer than the given one. Use it to load enough history pages to reach that message.
Status: **Implemented, not covered by tests**.

**Response 200** `{ success: true, data: { messageId, newerCount } }`.

**Errors:** `404 Message not found`, `400` for an invalid id.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/messages/6710aa000000000000000001/position/6711aa000000000000000005"
```

### DELETE /messages/:messageId

Deletes your own message for everyone and unpins it. Members receive `message:deleted` and `message:pins`.
Status: **Tested via SDK** (`messages.delete`).

**Response 200** `{ status: <bool>, data: null, message: "Message deleted" }`.

**Errors:** `403 You can only delete your own messages`, `404 Message not found`.

```bash
curl -X DELETE -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/messages/6711aa000000000000000005"
```

### PUT /messages/:messageId/save

Saves or unsaves a message for yourself (bookmark). You must be a member of the message's conversation.
Status: **Implemented (server tests)**.

| Body | Type | Default |
|---|---|---|
| `saved` | boolean | `true`. Anything other than `false` saves |

**Response 200** `{ status: true, data: { messageId, saved }, message: "" }`.

```bash
curl -X PUT -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{"saved":true}' "$SPREEWE_API/messages/6711aa000000000000000005/save"
```

### GET /saved-messages

Returns your saved messages, newest saved first. Only messages from chats you are still in, and that are not deleted, are included.
Status: **Implemented (server tests)**.

| Query | Type | Default | Notes |
|---|---|---|---|
| `before` | ISO date | — | Cursor |
| `limit` | int | 30 | Clamped to 1–50 |

**Response 200** `{ status: true, data: { items, ... }, message: "" }`.

**Errors:** `400 Invalid cursor`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/saved-messages?limit=30"
```

---

## Search and files

### GET /search

Global search across what you can see in the active context.
Status: **Implemented (server tests)**. Rate limit: **sensitive**.

The `messages` category matches `content` with a case-insensitive regex. Like the per-chat search, it **cannot match end-to-end-encrypted text**. The `files` category matches `file.originalName`. Encrypted attachments are stored with the name `"encrypted"`, so their real file names are not searchable. User, chat (by name) and meeting results work normally.

| Query | Type | Default | Notes |
|---|---|---|---|
| `q` | string | — | 2–100 characters |
| `types` | comma list | all | `users,chats,messages,files,meetings`. Unknown values are ignored |
| `from` / `to` | date | — | Filter messages and files by creation time |
| `sender` | ObjectId | — | Filter messages and files by author |
| `limit` | int | 8 | Per category, clamped to 1–30 |

**Response 200** `{ status: true, data: { users, chats, messages, files, meetings }, message: "" }`. Message and file items have `_id, conversationId, conversationTitle, isGroup, content, type, createdAt, user`, plus media fields for files.

**Errors:** `400 Type at least 2 characters to search`, `400 Search text is too long`, `400 Invalid from date` / `400 Invalid to date`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/search?q=bob&types=users,chats"
```

### GET /files

Lists files shared in your chats, newest first.
Status: **Implemented, not covered by tests**. Media URLs: **needs S3**.

| Query | Type | Default | Notes |
|---|---|---|---|
| `type` | `image` / `video` / `audio` / `pdf` / `file` | all | Unknown values are treated as "all" |
| `before` | ISO date | — | Cursor |
| `limit` | int | 30 | Clamped to 1–50 |

**Response 200** `{ status: true, data: { items: [{ _id, conversationId, conversationTitle, type, createdAt, user, ...media }], nextCursor }, message: "" }`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/files?type=image"
```

---

## Uploads

### POST /upload

Uploads one file to S3 storage as `multipart/form-data`. Status: **Implemented, not tested end to end (needs S3)**. Rate limit: **sensitive**.

The flow for chat attachments:

1. Encrypt the file on the device.
2. Upload it here.
3. Send the returned `storageKey` inside a `sendMessage` socket event.

The server never sees the plaintext file.

| Field | Type | Notes |
|---|---|---|
| `file` | file | Required. Exactly one file |
| `purpose` | `message` (default) / `group-avatar` | |
| `conversationId` | ObjectId | Required for `message`. You must be a member |
| `encrypted` | `"1"` | **Required** for `message`. Without it the server returns `400 Attachments must be end-to-end encrypted` |
| `kind` | `image` / `video` / `audio` / `pdf` / `file` | Required for `message`. Sets the size limit |
| `groupId` | ObjectId | Required for `group-avatar`. You must be a group admin |

**Size limits** per kind:

| Kind | Max size |
|---|---|
| `image` | 10 MB |
| `video` | 100 MB |
| `audio` | 25 MB |
| `pdf` | 25 MB |
| `file` | 50 MB |
| group or profile photo | 5 MB |

The outer multer cap is the largest of these, 100 MB. Multer also allows at most 20 form fields.

**Type checks:**

- Unencrypted uploads (group photos) are checked by declared MIME type, file extension and content signature sniffing. Images must be JPEG, PNG, GIF or WebP.
- Encrypted attachments cannot be sniffed. Only `kind` and size are checked.

**Response 200, `purpose=message`**, with no envelope:

```json
{ "storageKey": "production/conversations/6710.../images/2026/11/3f1c...-....bin", "type": "image", "size": 182934, "encrypted": true }
```

**Response 200, `purpose=group-avatar`**, with no envelope: `{ storageKey, fileUrl, thumbnailUrl, type, mimeType, originalName, size }`. `fileUrl` and `thumbnailUrl` equal the storage key. Prefix them with `s3BaseUrl` from `GET /config`.

**Errors**, shape `{ status: false, data: null, message }`:

- `400 No file uploaded`
- `400 Unknown attachment kind`
- `400 Unknown upload purpose`
- `400 Attachments must be end-to-end encrypted`
- `400 Upload rejected: ...`
- `403 You can't send files in this chat` (blocked)
- `403 File sharing with external people is turned off for this workspace`
- `413 File is too large (max 100 MB)`, or `413 This file is too large. The limit is N MB for this type.`
- `500 Upload failed`

```bash
curl -X POST -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" \
  -F "purpose=message" -F "conversationId=6710aa000000000000000001" -F "encrypted=1" -F "kind=image" \
  -F "file=@photo.jpg.enc" "$SPREEWE_API/upload"
```

Older on-disk files at `GET /uploads/:name` are served only through short-lived signed links that the server issues inside message payloads. You should not build these URLs yourself.

---

## Calls

Calls are started and controlled over Socket.IO. REST only exposes history.

### GET /calls

Returns your call history (1:1 and group), newest first.
Status: **Implemented (server tests)**. Note: the SDK's `calls.history()` calls this route, but the SDK e2e test does not exercise it.

| Query | Type | Default | Notes |
|---|---|---|---|
| `filter` | `missed` | — | Missed calls only |
| `before` | ISO date | — | Cursor |
| `limit` | int | 30 | Clamped to 1–50 |

**Response 200** `{ status: true, data: { items, nextCursor }, message: "" }`. Each item has:

- `_id, conversationId, isGroup, isMeeting, title, avatar, peerId, callerName, participants, callType`
- `direction`: `incoming` / `outgoing`
- `outcome`: `answered`, `missed`, `declined`, `cancelled`, `failed`, `no-answer` or `ongoing`
- `duration` (seconds), `createdAt`

**Errors:** `400 Invalid cursor`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/calls?filter=missed"
```

---

## Meetings

These routes are not wrapped by the browser SDK. All of them return `{ status: true, data, message: "" }`.

| Method & path | Purpose | Status |
|---|---|---|
| `GET /meetings?from=&to=` | Occurrences in a date range (max 62 days) | Implemented (server tests) |
| `POST /meetings` | Create a meeting. **Sensitive** rate limit | Implemented (server tests) |
| `GET /meetings/:id` | Meeting details | Implemented (server tests) |
| `PATCH /meetings/:id` | Update (organizer only) | Implemented, not covered by tests |
| `DELETE /meetings/:id?occurrence=` | Cancel the whole series, or one occurrence. `data: null` | Implemented, not covered by tests |
| `GET /meetings/code/:code` | Preview what a join link shows | Implemented, not covered by tests |
| `POST /meetings/code/:code/join` | Join by code. **Sensitive** rate limit | Implemented (server tests) |

**Body for `POST /meetings` and `PATCH /meetings/:id`.** For PATCH, all fields are optional.

| Field | Type | Notes |
|---|---|---|
| `title` | string | Required on create, max 120 |
| `description` | string | Max 2000 |
| `startAt`, `endAt` | date | The end must be after the start. Max length 24 hours |
| `timeZone` | IANA zone | Invalid values fall back to `UTC` on create and are ignored on update |
| `invitees` | ObjectId[] | Max 250 |
| `recurrence` | object | Frequency is `daily`, `weekdays`, `weekly` or `monthly`. The end date must be after the first meeting |
| `password` | string | 4–64 characters |
| `lobby` | boolean | |

**`POST /meetings/code/:code/join`** takes the body `{ "password"?: string }` and returns `{ meetingId, conversationId, lobby }`. A non-invitee is added to the meeting chat and, if a call is running, to the call's participant list.

**Errors:**

- `400` validation messages, for example `The meeting must end after it starts` or `Choose a range of up to 62 days`
- `403 Only the organizer can change this meeting`
- `403 The meeting password is incorrect`
- `404 Meeting not found`
- `410 This meeting was cancelled`

```bash
curl -X POST -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{"title":"Weekly sync","startAt":"2026-11-03T10:00:00Z","endAt":"2026-11-03T10:30:00Z","timeZone":"Europe/London"}' \
  "$SPREEWE_API/meetings"
```

---

## Recordings

Recording files are stored privately in S3. Responses carry short-lived signed links.

### GET /conversations/:conversationId/recordings

Returns up to 50 recordings of a conversation, newest first. You must be a member.
Status: **Tested via SDK** (`recordings.list`).

**Response 200** `{ status: true, data: [{ _id, title, startedAt, duration, status, transcriptStatus, size, expired, ... }], message: "" }`.

**Errors:** `404 Conversation not found`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/conversations/6710aa000000000000000001/recordings"
```

### GET /recordings/:id

Returns recording details. When the file is available, the response includes a `playbackUrl` and a `downloadUrl` (pre-signed, short-lived); otherwise both are `null`. It also includes `transcriptAvailable` and `startedByName`.
Status: **Implemented (server tests)**.

**Response 200** `{ status: true, data, message: "" }`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/recordings/6720aa000000000000000001"
```

### GET /recordings/:id/transcript

Returns the transcript.
Status: **Implemented, not covered by tests**. Note: the SDK's `recordings.transcript()` calls this route, but the SDK e2e test does not exercise it.

**Response 200** `{ status: true, data: { status, error, segments }, message: "" }`. Each segment has `startTime`, `endTime`, `speaker` and `text`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/recordings/6720aa000000000000000001/transcript"
```

### GET /recordings/:id/transcript/export

Downloads the transcript as a file, not JSON. The response sets `Content-Disposition: attachment`.
Status: **Implemented, not covered by tests**.

| Query | Values | Default |
|---|---|---|
| `format` | `txt`, `srt`, `vtt` | `txt` (any unknown value) |

**Errors**, JSON envelope: `400 The transcript isn't ready yet`.

```bash
curl -OJ -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/recordings/6720aa000000000000000001/transcript/export?format=srt"
```

### POST /recordings/:id/transcript/retry

Starts transcription again.
Status: **Implemented, not covered by tests**.

**Response 200** `{ status: true, data: { transcriptStatus }, message: "Transcription started" }`.

**Errors:**

- `400 This recording can't be transcribed`
- `400 The transcript is already available`
- `400` when no transcription engine is configured

```bash
curl -X POST -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/recordings/6720aa000000000000000001/transcript/retry"
```

---

## Notifications

### GET /notifications

Returns your activity feed, newest first.
Status: **Tested via SDK** (`notifications.list`).

| Query | Type | Default | Notes |
|---|---|---|---|
| `before` | ISO date | — | Cursor |
| `limit` | int | 30 | Clamped to 1–50 |
| `view` | `unread` / `mentions` | all | |

**Response 200** `{ status: true, data: { items, nextCursor }, message: "" }`. Each item has `_id, type, actor, conversationId, messageId, callId, meetingId, recordingId, text, ...`. For encrypted messages, `text` is a generic preview such as "New message". The server cannot read message text.

**Errors:** `400 Invalid cursor`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/notifications?view=unread"
```

### GET /notifications/unread-count

Status: **Tested via SDK** (`notifications.unreadCount`).

**Response 200** `{ "status": true, "data": { "unread": 3 }, "message": "" }`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/notifications/unread-count"
```

### POST /notifications/read

Marks notifications as read. It only ever touches your own notifications.
Status: **Implemented, not covered by tests**.

| Body | Type | Notes |
|---|---|---|
| `ids` | ObjectId[] | Optional, max 200. Omit it to mark all as read |

**Response 200** `{ status: true, data: { updated: <count> }, message: "" }`. If anything changed, the server also emits `notification:read`.

**Errors:** `400 Too many notifications in one request`.

```bash
curl -X POST -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" -H "Content-Type: application/json" -d '{}' "$SPREEWE_API/notifications/read"
```

---

## Workspace (tenant)

The workspace is always the active organization in your session token. All of these routes return `{ status: true, data, message: "" }` and report errors through `sendError`.

### GET /tenant/current

Returns a summary of the active workspace.
Status: **Implemented (server tests)**.

**Response 200**, `data`:

```json
{ "_id": "6700...", "name": "Acme", "slug": "acme", "status": "active", "role": "admin",
  "policies": { "allowExternalChat": false, "allowExternalCalls": false, "allowExternalFiles": false, "membersCanStartExternal": false },
  "permissions": { "updatePolicies": true, "startExternal": false } }
```

The policy values above are an illustration. Actual defaults come from `DEFAULT_TENANT_POLICIES`.

**Errors:** `400 Switch to a workspace first` (no active org), `404 Workspace not found`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/tenant/current"
```

### PATCH /tenant/current/policies

Changes workspace policies. Only workspace owners and admins may do this. Rate limit: **sensitive**.
Status: **Implemented (server tests)**.

**Body:** any subset of `allowExternalChat`, `allowExternalCalls`, `allowExternalFiles` and `membersCanStartExternal`. Each value must be a boolean.

**Response 200:** the updated summary, in the same shape as `GET /tenant/current`.

**Errors:**

- `400 Policies are required`
- `400 Unknown policy: <key>`
- `400 <key> must be true or false`
- `400 Nothing to update`
- `400 Switch to a workspace first`
- `403 Only workspace owners and admins can change policies`

```bash
curl -X PATCH -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{"allowExternalChat":true}' "$SPREEWE_API/tenant/current/policies"
```

### GET /tenant/workspaces

Lists workspaces in which you have an active membership. To switch workspace, change the active organization in Clerk.
Status: **Implemented, not covered by tests**.

**Response 200** `data: [{ tenantId, clerkOrgId, name, slug, status, role, active }]`.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/tenant/workspaces"
```

### GET /directory

Returns the people you can start a conversation with, under the same rules as [`GET /web/users`](#get-webusers), with optional filtering.
Status: **Implemented (server tests)**.

| Query | Type | Notes |
|---|---|---|
| `q` | string | Case-insensitive username match. Trimmed and capped at 100 characters |

**Response 200** `data: User[]`, with public fields only, up to 500.

```bash
curl -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" "$SPREEWE_API/directory?q=bo"
```

### POST /tenant/external-conversations

Starts, or reopens, a 1:1 chat between you and someone **outside** the active workspace. The workspace owns the conversation, and the guest sees only that conversation.

It requires `allowExternalChat`. Admins may always start one; other members need `membersCanStartExternal`; guests never can. Rate limit: **sensitive**.
Status: **Implemented (server tests)**.

| Body | Type |
|---|---|
| `userId` | ObjectId of the outside person |

**Response 200**:

```json
{ "status": true, "data": { "conversationId": "6710aa00000000000000000c", "scope": "external" }, "message": "" }
```

**Errors:**

- `400 Switch to a workspace first`
- `400 You can't start an external chat with yourself`
- `400 This person is a member of the workspace; start a normal chat instead`
- `403 External chat is turned off for this workspace`
- `403 Only workspace admins can start external conversations`
- `404 User not found`

```bash
curl -X POST -H "Authorization: Bearer $SPREEWE_SESSION_TOKEN" -H "Content-Type: application/json" \
  -d '{"userId":"66f0c1aa00000000000000ff"}' "$SPREEWE_API/tenant/external-conversations"
```

---

## Public configuration

### GET /config

Returns public client settings. No authentication is needed and the response contains no secrets.
Status: **Implemented (server tests)**.

**Response 200**:

```json
{ "status": true, "data": { "s3BaseUrl": "https://bucket.s3.eu-west-2.amazonaws.com", "clerkPublishableKey": "pk_live_..." }, "message": "" }
```

```bash
curl "$SPREEWE_API/config"
```

The unauthenticated load-balancer probes `GET /health/live` and `GET /health/ready` are also mounted. They are operational endpoints, not part of the integration surface.
