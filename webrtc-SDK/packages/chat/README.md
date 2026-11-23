# @spreewe/chat

Direct and group chat: conversation list, chat window, message list and composer, with
attachments, reactions, replies, edits, deletes, typing, read receipts and live updates. Messages
are end-to-end encrypted; with [`@spreewe/e2ee`](../e2ee/README.md) enabled the components decrypt
and send, without it they show that messages exist but not their content.

```bash
npm install @spreewe/core @spreewe/ui @spreewe/chat @spreewe/e2ee @matrix-org/matrix-sdk-crypto-wasm@18.9.0
```

```html
<spreewe-provider id="sw">
  <spreewe-chat></spreewe-chat>
</spreewe-provider>
<script type="module">
  import "@spreewe/chat/define";
  import { enableE2ee } from "@spreewe/e2ee";
  enableE2ee(client);                       // optional: read and send content
  document.getElementById("sw").client = client;
</script>
```

## Scopes

Required: `realtime:connect`, `profile:read`, `conversations:read`, `groups:read`, `messages:read`.
Sending: `e2ee:device` + `messages:write`. Optional: `messages:edit`, `messages:react`,
`messages:delete`, `files:write` (attachments), `conversations:write` (start chats, archive,
favourite), `contacts:write` (start by e-mail, block). `scopesFor(["chat"], { includeOptional: true })`
returns them all.

## Components

### `<spreewe-chat>`
List and window side by side; below 720 px of its own width it shows one at a time with a back button.
- Attributes: `conversation-id`, `filter`.
- Slots: `list-header`, `header-actions`, `empty`. Parts: `list`, `window`.
- Tokens: `--sw-chat-list-width` (340px), `--sw-chat-radius`.

### `<spreewe-conversation-list>`
- Attributes: `selected`, `filter` (`all` | `direct` | `groups`), `archived`, `no-search`, `actions` (property, default true: favourite/archive menu).
- Events: `spreewe-conversation-select` `{ conversationId, conversation }`, `spreewe-error`.
- Slots: `header`, `empty`, `footer`.
- Parts: `search`, `list`, `item`, `item-selected`, `avatar`, `title`, `time`, `preview`, `badge`, `menu`.
- Method: `refresh()`.

### `<spreewe-chat-window>`
- Attributes: `conversation-id`, `show-back`, `no-header`, `readonly`.
- Events: `spreewe-back`, plus the list's and composer's events.
- Slots: `header` (replace), `header-actions` (e.g. `<spreewe-call-button>`), `empty`, `composer-before`, `composer-after`.
- Parts: `header`, `title`, `subtitle`, `back`, `messages`, `composer`.
- Drag and drop files onto it to send them.

### `<spreewe-message-list>`
- Attributes: `conversation-id`, `readonly`, `show-avatars` (`auto` | `always` | `never`).
- Events: `spreewe-reply` `{ message }`, `spreewe-edit` `{ message }`, `spreewe-delete-request` `{ message }` (cancelable: show your own confirmation and call `list.conversation.delete(id)`), `spreewe-error`.
- Parts: `scroller`, `day`, `message`, `message-mine`, `bubble`, `bubble-mine`, `author`, `meta`, `reactions`, `attachment`, `actions`, `system`, `jump`.
- Property `conversation` (the `ConversationSession`); method `scrollToLatest()`.
- Loads older history when scrolled to the top; keeps your position; decrypts images automatically.

### `<spreewe-message-composer>`
- Attributes: `conversation-id`, `placeholder`, `no-attachments`, `no-emoji`, `disabled`.
- Methods: `replyTo(message)`, `editMessage(message)`, `addFiles(files)`, `focus()`.
- Events: `spreewe-message-sent` `{ conversationId }`, `spreewe-error`.
- Slots: `before-input`, `after-input`. Parts: `bar`, `input`, `send`, `attach`, `emoji`, `notice`, `context`.
- Enter sends, Shift+Enter adds a line, ↑ edits your last message, Esc cancels reply/edit, pasting files attaches them.

## Service

```ts
import { getChat } from "@spreewe/chat";
const chat = getChat(client);
await chat.loadConversations();
chat.conversations.subscribe(({ items }) => …);      // ConversationSummary[]
const s = chat.open(conversationId);                // ConversationSession (call s.release())
s.messages.subscribe(({ items, hasOlder }) => …);   // ChatMessage[], oldest first
await s.send("Hello", { replyTo, mentions });
await s.sendFile(file, { caption, onProgress });
```

`ChatService`: `start()`, `conversations`, `unreadTotal`, `loadConversations({ archived, refresh })`,
`findConversation(id)`, `open(id)`, `openDirect(userId)`, `openByEmail(email, scope?)`,
`setArchived`, `setFavorite`, `clear`, `setBlocked(userId, blocked)`, `sendBlocker()`, `e2ee`.

`ConversationSession`: `messages`, `typing`, `removed`, `setVisible(bool)` (visible sessions mark
messages read), `loadOlder()`, `send`, `sendFile`, `edit`, `delete`, `react`, `pin`, `save`,
`discard(localId)`, `loadAttachment(messageId)`, `markRead()`, `typingStarted()`, `stopTyping()`,
`members`, `release()`.

`ChatMessage` adds to the server's message: `text`, `bodyState` (`ok` | `pending` (key not here yet,
retried automatically) | `failed` | `locked` (no encryption device) | `withheld` (app lacks
`e2ee:device`)), `warning`, `attachment` (`{ name, size, mimeType, kind, url, state }`), `quote`,
`local` (`sending` | `failed`).

Helpers: `validateUpload(file)`, `UPLOAD_ACCEPT`, `mediaKind(mime)` (mirror the server's upload rules:
images 10 MB, video 100 MB, audio/PDF 25 MB, documents 50 MB).

## Behaviour

- Sent messages appear immediately as "Sending…" and are confirmed when the server echoes the same
  ciphertext; refusals (`message:rejected`) and a 20 s timeout mark them failed with a reason.
- After a reconnect the list and open conversations re-fetch, and rooms are re-joined.
- Known backend issue: typing indicators **from** E2EE-enabled apps are dropped by the server (see
  [production.md](../../docs/production.md#known-backend-issues-found-while-building-the-sdk)).
- Not included: @mention autocomplete (send `mentions` yourself), message search UI, pinned messages
  panel, forwarding (the server refuses forwards).
