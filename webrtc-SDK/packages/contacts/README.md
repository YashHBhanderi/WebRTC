# @spreewe/contacts

People features for your app: a directory with live presence, profiles, lookup by e-mail, blocking, and the signed-in user's own status and profile. It includes a headless service and five Web Components (Lit 3).

This module doesn't open chats. It fires `spreewe-contact-message` with `{ userId }` and `spreewe-conversation-start` with `{ conversationId, external }`. Hand these ids to `@spreewe/chat`, or to your own UI.

## Install

```sh
npm install @spreewe/core @spreewe/ui @spreewe/contacts
```

```ts
import "@spreewe/contacts/define"; // registers the elements (the main entry doesn't)
```

The components use the client from the `client` property, the nearest `<spreewe-provider>`, or `setDefaultClient()`.

## Scopes

| Scope | Needed for |
|---|---|
| `directory:read` | Directory, lookup by e-mail (required) |
| `profile:read` | Profiles, my profile (required) |
| `realtime:connect` | Live presence, and the socket used by block and status (required for those) |
| `contacts:write` | Starting a chat by e-mail, block and unblock (optional) |
| `profile:write` | Setting my status, editing my profile (optional) |
| `conversations:read` | Reading whether I blocked someone (`blockedInConversation`, optional) |

REST routes answer a missing scope with `403 "The token lacks the <scope> scope"`. The server never acks socket events outside the token's scopes, so the service checks scopes before sending and throws `SpreeWeError` with code `MISSING_SCOPE`.

## Who appears

- **Organization context:** the organization's active members.
- **Personal (global) context:** only people the user already shares a conversation with. Profiles follow the same rule; anyone else gets a 404. Other people are found by exact e-mail with `lookup()`, if they haven't turned off `globalDiscoverable`.
- Presence (`user:presence`) only reaches people who share a conversation with the user. App connections never mark a user online, so a status set from an app shows `isOnline: false` unless the user is also connected through SpreeWe itself.

## Service

```ts
import { getContacts } from "@spreewe/contacts";
const contacts = getContacts(client);
```

| Method | Backend | Notes |
|---|---|---|
| `search({ q?, limit?, cursor? })` | `GET /v1/directory` | One cursor page `{ items, nextCursor }`. Seeds `client.people.presence` |
| `browse({ q?, pageSize? })` | same | `{ state, loadMore(), refresh() }`. `state` is a store of `{ items, loading, loaded, error, nextCursor, done }` |
| `profile(userId, { refresh? })` | `GET /web/user/:userId` | Reuses `client.people.profile` (cached) |
| `presence` | socket `user:presence` | Same store as `client.people.presence` |
| `startPresence()` | | Connects the socket if the token allows it. Resolves `true`/`false` and never rejects |
| `lookup(email, { scope? })` | `POST /v1/contacts/lookup` | `{ found, message?, user?, external?, conversationId? }`. Unregistered, blocked and opted-out people all get `found: false`. `scope` (`"member"` by default, or `"external"`) only applies inside an organization; the personal context rejects `"external"` with 400. Rate-limited per user (30 per 10 min by default) |
| `startConversation(email, { scope? })` | `POST /v1/contacts/start` | `{ conversationId, external }`. Opens a new direct chat or reuses the existing one. Returns 404 if the person isn't eligible |
| `block(userId)` / `unblock(userId)` | socket `chat:block` / `chat:unblock` (ack) | `{ userId, blocked }`. Server refusals become `SOCKET_REFUSED` with the server's message |
| `blocked` | | Store of block states known this session (the server has no endpoint that lists blocked users) |
| `blockedInConversation(conversationId)` | `GET /conversations/:id/state` | `{ peerId, blockedByMe }` |
| `loadMyProfile()` / `me` | `GET /web/user/me` | My account with my real chosen status |
| `setPresence({ status?, statusMessage? })` | socket `presence:set` (ack) | `status` is one of `PRESENCE_STATUSES`. The message can be up to 140 characters. Returns `{ status, statusMessage, isOnline, ownStatus, … }` |
| `setIdle(idle)` | socket `presence:idle` | Shows Away while my status is Available |
| `updateProfile({ username?, bio?, image?, globalDiscoverable? })` | `PATCH /web/user/profile` (multipart fields `username`, `bio`, `image`, `globalDiscoverable`) | Name: 3–30 characters (letters, numbers, spaces, `. _ ' -`). Bio: up to 160 characters. Image: JPG, PNG, GIF or WebP, up to 5 MB. These rules are checked locally before sending |

Helpers: `validateUsername`, `validateAvatar`, `presenceText`, and the limits `USERNAME_MIN/MAX`, `BIO_MAX`, `STATUS_MESSAGE_MAX`, `AVATAR_MAX_BYTES`, `AVATAR_TYPES`.

## Components

### `<spreewe-contact-list>`

Searchable directory with presence dots. It loads more as you scroll and also has a "Load more" button.

| | |
|---|---|
| Attributes | `query`, `page-size` (default 30), `selected` (user id), `actions` (`"message"` adds a Message button per person), `no-search` |
| Methods | `refresh()`, `loadMore()` |
| Events | `spreewe-contact-select` `{ userId, user }`, `spreewe-contact-message` `{ userId, user }` |
| Slots | `header`, `empty`, `footer` |
| CSS parts | `search`, `list`, `item`, `item-selected`, `avatar`, `name`, `status`, `message`, `load-more`, `error` |

Keyboard: ↓ from the search box moves into the list. ↑/↓/Home/End move between people. Reaching the last person loads the next page.

### `<spreewe-profile-card user-id="…">`

Picture, name, live status, status message, bio and last seen. Shows Message and Block/Unblock buttons; Block/Unblock appears only with `contacts:write` + `realtime:connect`.

| | |
|---|---|
| Attributes | `user-id`, `conversation-id` (optional; reads whether you blocked them), `no-actions` |
| Properties | `blocked` (set it if your app already knows) |
| Methods | `load()` |
| Events | `spreewe-contact-message` `{ userId, user }`, `spreewe-contact-block` `{ userId, blocked }` |
| Slots | `actions` |
| CSS parts | `card`, `avatar`, `name`, `status`, `status-message`, `bio`, `actions`, `message`, `block`, `error` |

### `<spreewe-contact-lookup>`

E-mail → lookup → Start chat (or Open chat when one already exists).

| | |
|---|---|
| Attributes | `email`, `allow-external` (inside an organization, adds "someone outside my organization") |
| Methods | `lookUp()` |
| Events | `spreewe-conversation-start` `{ conversationId, external, user, started }` |
| Slots | `header` |
| CSS parts | `form`, `input`, `find`, `scope`, `result`, `avatar`, `name`, `start`, `error` |

### `<spreewe-presence-picker>`

My status (Available, Busy, Do not disturb, Away, Appear offline) and status message.

| | |
|---|---|
| Attributes | `no-message` |
| Events | `spreewe-presence-change` `{ status, statusMessage, presence }` |
| Slots | `header` |
| CSS parts | `statuses`, `status`, `status-selected`, `message`, `save`, `clear`, `error` |

### `<spreewe-profile-editor>`

My name, bio and picture. In the personal context it also offers "let people find me by e-mail".

| | |
|---|---|
| Attributes | `no-picture`, `no-discoverable` |
| Methods | `load()` |
| Events | `spreewe-profile-saved` `{ user }`, `spreewe-cancel` |
| Slots | `header`, `actions` |
| CSS parts | `form`, `heading`, `avatar`, `picture`, `input`, `bio`, `discoverable`, `save`, `cancel`, `error` |

All colours and spacing come from the `--sw-*` tokens of `@spreewe/ui`. Strings use `contacts.*` keys; override them with `setStrings()`.

## Example

```html
<spreewe-contact-list actions="message"></spreewe-contact-list>
<spreewe-profile-card></spreewe-profile-card>
<spreewe-contact-lookup></spreewe-contact-lookup>

<script type="module">
  const card = document.querySelector("spreewe-profile-card");
  document.addEventListener("spreewe-contact-select", (e) => card.setAttribute("user-id", e.detail.userId));
  document.addEventListener("spreewe-conversation-start", (e) => openChat(e.detail.conversationId)); // your chat UI
  document.addEventListener("spreewe-contact-message", (e) => openDirectChat(e.detail.userId));     // e.g. getChat(client).openDirect(userId)
</script>
```

## Known backend behaviour

- `GET /v1/directory` and `GET /web/user/:userId` return a contact's real `"Appear offline"` status (they read with `.lean()`, which skips the model's mask). Their `isOnline` is still false, and the components show the person as offline.
- The server has no endpoint that lists blocked users. The profile card only knows the state after you block/unblock in this session, when `conversation-id` is given, or when you set `blocked`.
- `user:updated` (name or picture changes) isn't delivered to app sockets. Profiles refresh when they are loaded again.
