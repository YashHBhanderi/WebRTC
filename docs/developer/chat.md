# Chat: conversations, messages, receipts and presence

This guide covers direct and group chat with the SpreeWe browser SDK (`@spreewe/chat-sdk`, source in `packages/chat-sdk/src/client.ts`). Every message body is end-to-end encrypted on the sending device. The server stores only ciphertext and does not accept plaintext text or media messages.

Related: [SDK reference](./sdk-reference.md) · [Real-time events](./realtime-events.md) · [Session REST API](./rest-api/session-api.md) · [Authentication](./authentication.md) · [Files and attachments](./files.md)

## Test status

| Area | Status |
|---|---|
| Direct chat: send, receive, decrypt, history, ciphertext-only storage | Tested via SDK |
| Reply, edit (re-encrypted), react, pin, delete, typing, read receipts | Tested via SDK |
| Groups: create, encrypted delivery to members, remove member (removed member stops receiving) | Tested via SDK |
| Presence (own sockets), notifications list / unread count | Tested via SDK |
| Workspace isolation (an organization chat is not visible from the same user's personal context) | Tested via SDK |
| Any UI, any real browser | **Not tested.** |

"Tested via SDK" means `webrtc-BE/test/sdk-e2e.test.ts`: real backend, real REST routes and Socket.IO gateways, real database, real Olm/Megolm crypto, running in Node. Only Clerk sign-in is simulated. **No part of this guide has been tested in a real browser.**

## Setup

```ts
import { SpreeWeClient } from '@spreewe/chat-sdk';

const client = new SpreeWeClient({
  apiUrl: 'https://api.example.com',
  getToken: () => clerk.session!.getToken(), // fresh Clerk session token, see ./authentication.md
  wasmUrl: '/assets/matrix_sdk_crypto_wasm_bg.wasm',
  deviceLabel: 'My app (Chrome)',
});

const me = await client.connect(); // loads the user, starts this device's E2EE identity, opens the socket
```

The workspace (personal or organization) is the active organization of the Clerk session. The SDK never sends an organization id; the server resolves it.

## Conversations

### Listing

```ts
const conversations = await client.conversations.list(); // Conversation[]
```

Behaviour, from the server (`ConversationService.getUserConversations`):

- **A conversation appears only once it has at least one message.** A direct chat created with `openDirect()` and never written to is not listed. (Exception: a chat the user cleared stays listed, empty.)
- Archived chats are excluded.
- **Direct chats and groups are both returned.** The SDK merges `GET /conversations` (direct chats only) and `GET /groupConversations` (groups), and orders them by latest activity. Groups have `isGroup: true` and the group name.
- For direct chats the server returns `sender` (you) and `receiver` (the other person) instead of `members`. The SDK builds `members` from them and names the chat after the other person.
- `list()` also joins the real-time room of each listed conversation.

### Opening a direct chat

```ts
const conversationId = await client.conversations.openDirect(otherUserId);
```

Returns the existing 1:1 conversation or creates one. The server decides who you may contact (`ConversationService.createOrGetConversation`):

| Rule | Error |
|---|---|
| You cannot open a chat with yourself | 400 |
| In an organization workspace, the other user must be an active member of that workspace (`assertCanInclude`) | 403 "Only members of this workspace can be added here" |
| Workspace guests may only include people they already share a conversation with | 403 |
| A **new** chat requires that neither side has blocked the other (`block.service.isBlockedEitherWay`). An existing chat stays reachable, but sending is refused while blocked. | 403 "You can't start a chat with this person." |
| In the personal context, a **new** chat needs a target that is globally discoverable, not deleted and not banned | 404 "No eligible account found." |

Conversations with people outside a workspace ("external" conversations) are additionally gated by the workspace policies for chat, calls and files (`assertExternalAllowed`, policies changed with `PATCH /tenant/current/policies` or the `/v1` workspace route). The SDK has no method for creating external conversations.

`client.users.directory()` returns the people the server lets you contact in the active workspace.

### Groups

```ts
const group = await client.conversations.createGroup({
  name: 'Project X',
  memberIds: [aliceId, bobId],   // you are added automatically
  description: 'optional',
});

await client.conversations.addMembers(group.id, [carolId]);
await client.conversations.removeMember(group.id, carolId);
const details = await client.conversations.info(group.id);
await client.conversations.delete(group.id);
```

Server rules (`conversationService.ts`, `group.service.ts`):

- A group needs a name (max 100 characters) and at least 3 members including the creator. Description max 500 characters, max 256 members in the create call.
- The creator is the first admin (`groupAdmin` / `groupAdmins`).
- **Add / remove members: group admins only.** You cannot remove yourself with `removeMember` ("Use Leave group"); the SDK has no leave method.
- In a workspace, added members must be members of that workspace.
- Team channels look like groups but are managed by their team; add / remove are refused.
- **Delete: group admins only.** It deletes all messages and stored attachments for everyone. Direct chats cannot be deleted (400 "Use Clear chat or Archive"); the SDK does not expose clear / archive.
- Creating a group does not notify the other members in real time. They see it when the first message arrives (the SDK joins the room on receipt) or via `conversation.added` when they are added later with `addMembers`.

A removed member stops receiving messages and gets an error from `messages.history()` for that group (tested).

### Real-time rooms

Some events (typing, reactions, `messages.read`) are sent to the conversation's room only. The SDK joins rooms automatically for conversations returned by `list()`, `openDirect()`, `createGroup()`, and on receipt of any message. For a group someone else created, call:

```ts
client.conversations.join(groupId);
```

The server checks membership before joining. Rooms are re-joined after a reconnect.

## Messages

### Sending

```ts
await client.messages.send(conversationId, 'Hello');
await client.messages.send(conversationId, 'Agreed', { replyTo: messageId, mentions: [userId] });
```

- Text is encrypted on this device (Megolm) before sending. If encryption fails, nothing is sent and the promise rejects with `SpreeWeError` code `E2EE`.
- `send()` resolves once the message is **handed to the socket**, not when the server stored it. There is no acknowledgement. Server-side refusals arrive as the `message.rejected` event (and an `error` event):

| `reason` | Cause |
|---|---|
| `policy` | External conversation and the workspace policy forbids chat (or files) |
| `blocked` | 1:1 and one side blocked the other |
| `attachment` | Invalid `storageKey` (see [files.md](./files.md)) |
| `unencrypted` | Missing or invalid E2EE payload |

Some refusals are **silent** (no event): sender is not a member, conversation does not exist, unknown message type. Treat a message as sent only when it comes back on the `message` event.

- Replies may only reference a non-deleted message of the same conversation; otherwise `replyTo` is dropped silently.
- Mentions are filtered to members of the conversation (max 50). Mentioned users and the author of a replied-to message get a notification whose text is "New message" (the server cannot read the content).
- Message text limit: 4000 characters (`MAX_MESSAGE_LENGTH`) applies to plaintext; encrypted payloads are validated separately.

### Receiving

```ts
client.events.on('message', (m) => {
  if (m.state === 'ok') render(m.text);
  else if (m.state === 'pending') showPlaceholder(m);   // room key has not arrived yet
  else if (m.state === 'failed') showUndecryptable(m, m.warning);
  else if (m.state === 'plain') renderNotice(m.text);   // system / call notices, not encrypted
});
```

`ChatMessage` fields: `id`, `conversationId`, `senderId`, `type` (`text | image | video | audio | pdf | file | system | call | recording`), `text`, `state`, `warning?`, `attachment?`, `replyToId?`, `reactions`, `edited`, `deleted`, `createdAt`.

`pending` messages are not re-emitted when the key arrives. Listen for the `keys` event and re-load the conversation's history to re-decrypt.

Each message is emitted once even though the server delivers it to both the room and the user.

### History and pagination

```ts
const page1 = await client.messages.history(conversationId);                  // newest 30, oldest first
const page2 = await client.messages.history(conversationId, { page: 2 });     // the 30 before those
const big   = await client.messages.history(conversationId, { limit: 100 });
```

- Page 1 is the newest `limit` messages (SDK default 30, server cap 2000), returned oldest-first. Page 2 is the next-older block, and so on. An empty array means no more history.
- Offset paging: if new messages arrive between calls, page boundaries shift and you can see duplicates. De-duplicate by `id`.
- Deleted messages and messages before the user's "clear chat" time are excluded by the server.
- The server also returns a delivery `status` (`sent | delivered | seen`) per message, but `ChatMessage` does not expose it. Use `receipts.updated` events, or the session REST API directly, if you need ticks.

### Editing

```ts
await client.messages.edit(conversationId, messageId, 'corrected text');
client.events.on('message.updated', (m) => replace(m)); // re-decrypted ChatMessage
```

- **Only your own messages, and only `text` messages** (`message-actions.service.ts`: "You can only edit your own messages", "Only text messages can be edited"). Errors reject with `SpreeWeError` code `REJECTED`.
- The new text is re-encrypted on this device; the server never sees it (tested).
- Newly added mentions in an edit trigger notifications.

### Deleting

```ts
await client.messages.delete(messageId);
client.events.on('message.deleted', ({ conversationId, messageId }) => remove(messageId));
```

- **Only your own messages** (403 otherwise), and you must still be a member of the conversation.
- Delete is for everyone: the message is soft-deleted (`isDeleted`), unpinned, and its stored attachment is removed unless a forwarded copy still uses it. All members get `message.deleted` and an updated `pins.updated`.
- Group admins cannot delete other members' messages through this endpoint.

### Reactions

```ts
client.messages.react(conversationId, messageId, '👍');
client.events.on('reaction.updated', ({ messageId, reactions }) => update(messageId, reactions));
```

One reaction per user per message (`ConversationService.addReaction`):

- no reaction yet → added;
- same emoji again → removed (toggle);
- different emoji → replaces your previous one.

`react()` is fire-and-forget (no acknowledgement); invalid requests (not a member, deleted message, emoji longer than 16 characters) are ignored silently. `reaction.updated` goes to the conversation room, so the reader must have joined it. Adding a reaction to someone else's message notifies them.

### Pins

```ts
const ack = await client.messages.pin(messageId, true);   // ack.pins = current pin list
await client.messages.pin(messageId, false);              // unpin
client.events.on('pins.updated', ({ conversationId, pins }) => showPins(pins));
```

Any member may pin or unpin. System messages cannot be pinned. A conversation keeps up to 25 pins. The SDK has no method to read the pin list on load; it arrives in the pin acknowledgement and `pins.updated` events.

## Typing indicators

```ts
client.chat.typing(conversationId, true);   // started typing
client.chat.typing(conversationId, false);  // stopped
client.events.on('typing', ({ conversationId, userId, isTyping }) => ...);
```

Sent only to rooms the socket joined, never back to the sender. The server does not time out typing state; send `false` yourself (for example after a few seconds without input).

## Read and delivery receipts

```ts
client.messages.markRead(conversationId);         // everything up to now is read by me
client.messages.markDelivered([conversationId]);  // messages up to now reached this device (max 50 ids)

client.events.on('messages.read', ({ conversationId, userId }) => ...);      // room event
client.events.on('receipts.updated', (r) => ...); // { conversationId, userId, readAt?, deliveredAt? }
```

- `markRead` also marks delivery and marks the conversation's notifications read.
- When a user's socket connects, the server marks all their conversations delivered.
- Receipts are per user per conversation (a timestamp), not per message. A message is `seen` when every other member's `readAt` is at or after it, `delivered` likewise with `deliveredAt`.

## Presence

```ts
await client.users.setPresence('Busy', 'In a workshop'); // 'Available' | 'Busy' | 'Do not disturb' | 'Away' | 'Appear offline'
client.users.setIdle(true);                               // automatic Away while chosen status is Available
client.events.on('presence', (p) => ...);                 // { userId, status, statusMessage, isOnline, autoAway, inCall, ... }
```

- `Appear offline` is never revealed: others see `isOnline: false`.
- Status message is whitespace-normalized.
- Who receives your presence: your own sockets always; other users only if, in their current workspace context, they share a conversation with you or you are in that context's directory (workspace member / discoverable). Guests see only people they share a conversation with.

**Known limitation:** the server caches presence visibility and contact lists for 60 seconds (`CONTACTS_TTL_MS` in `presence.service.ts`). A user who just became a contact (new chat, added to a group) may not see your presence changes for up to a minute. The SDK test only asserts delivery to your own sockets for this reason.

## Notifications (activity)

```ts
const { items, nextCursor } = await client.chat.notifications.list({ limit: 20 });
const older = await client.chat.notifications.list({ before: nextCursor! });
const unread = await client.chat.notifications.unreadCount();
await client.chat.notifications.markRead([items[0]._id]);   // or markRead() for all
client.events.on('notification', (n) => ...);
```

Notifications are created for mentions, replies, reactions to your messages and recording milestones. Encrypted content is never included; the text is a generic "New message".

## Message search

**Not supported for encrypted messages.** `GET /messages/:conversationId/search` matches the server-stored `content` field, which is empty for every encrypted text message. It can only find plaintext legacy messages. The SDK has no search method. If you need search, build it client-side over decrypted history.

## Errors

All SDK methods throw `SpreeWeError` with `code`: `NOT_SIGNED_IN`, `HTTP` (REST failure; `detail` holds the status), `REJECTED` (socket acknowledgement with an error), `E2EE`, `NOT_CONNECTED`, `TIMEOUT` (socket acknowledgements time out after 10 s). Methods implemented as plain socket emits (`react`, `markRead`, `markDelivered`, `typing`, `setIdle`) return nothing and do nothing if the socket is not connected.

## Not available in the SDK

Server features with no SDK method: leave group, group rename / avatar update, archive / clear chat, block / unblock, saved messages, forward (must be done client-side by decrypting and re-sending), message search, reading the pin list.
