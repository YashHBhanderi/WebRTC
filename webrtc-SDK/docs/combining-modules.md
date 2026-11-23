# Combining modules

Modules never import each other. They share one `SpreeWeClient` (one socket, one token source, one
profile and presence cache), and you connect them through DOM events. That keeps each bundle
small and lets you swap any part for your own UI.

Working example: [`examples/combined`](../examples/combined).

## One client, one provider

```ts
const client = createClient({ baseUrl, auth });
enableE2ee(client);                                   // if chat or files should read content
document.querySelector("spreewe-provider").client = client;
```

Request the union of the scopes you need: `scopesFor(["chat", "calls", "groups", "notifications"], { includeOptional: true })`.
Every module service is a per-client singleton (`getChat(client)`, `getCalls(client)`, …), so
components and your own code see the same state.

## Common wiring

| From | Event / API | To |
|---|---|---|
| Chat window header | put `<spreewe-call-button slot="header-actions" conversation-id=…>` | Calls |
| `spreewe-conversation-select` from the list | `detail.conversationId`; `getChat(client).findConversation(id)?.isGroup` | `<spreewe-group-details group-id>` |
| `<spreewe-notification-list>` / bell | `spreewe-notification-select` → `detail.conversationId` | `<spreewe-chat-window conversation-id>` |
| `<spreewe-contact-list actions="message">`, `<spreewe-profile-card>` | `spreewe-contact-message` → `detail.userId` → `await getChat(client).openDirect(userId)` | Chat |
| `<spreewe-contact-lookup>` | `spreewe-conversation-start` → `detail.conversationId` | Chat |
| `<spreewe-create-group>` | `spreewe-group-created` → `detail.groupId` (a conversation id) | Chat, group details |
| `<spreewe-meeting-list>`, `<spreewe-meeting-join>` | `spreewe-meeting-join` → `detail.conversationId` → `calls.activeCall(id)` then `accept()`, or `startCall(id, "video", { mode: "meetNow" })` | Calls |
| `<spreewe-group-details>` | `spreewe-group-left` / `spreewe-group-deleted` | Close the chat |
| Any component | `spreewe-error` → `detail.error` (`SpreeWeError`) | Your toast / logging |

```ts
document.addEventListener("spreewe-contact-message", async (e) => {
  chatWindow.conversationId = await getChat(client).openDirect(e.detail.userId);
});
document.addEventListener("spreewe-meeting-join", async (e) => {
  const calls = getCalls(client);
  const active = await calls.activeCall(e.detail.conversationId);
  if (active) await calls.accept(active.callId, { callType: "video" });
  else await calls.startCall(e.detail.conversationId, "video", { mode: "meetNow" });
});
```

## Calls next to chat

Place `<spreewe-incoming-call>` once at the root and `<spreewe-call-view>` where the call should
appear (an overlay, a side panel, a route). The call view renders nothing while there is no call and
sets `data-idle` on itself, so you can hide its container: `#layer:has(spreewe-call-view[data-idle]) { display: none }`.

## Signing out

`client.destroy()` disconnects the socket and disposes every module service; then sign out of the
token provider (`oauth.signOut()`) and create a new client for the next user. The encryption
device's keys stay in the browser for that user's next sign-in.
