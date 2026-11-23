# @spreewe/notifications

The SpreeWe activity feed for your app: mentions, replies, reactions, missed calls, meeting invites
and reminders, and recording updates. It comes as a headless service and two Web Components (Lit 3).

## Install

```sh
npm install @spreewe/core @spreewe/ui @spreewe/notifications
```

```ts
import "@spreewe/notifications/define"; // registers <spreewe-notification-bell> and <spreewe-notification-list>
```

Importing `@spreewe/notifications` on its own exports the classes without registering any tags.

## Scopes

| Scope | Needed for |
| --- | --- |
| `notifications:read` | Feed, unread count, live `notification:new` / `notification:read` events (required) |
| `notifications:write` | Marking notifications read (optional; the UI hides "Mark all as read" without it) |
| `realtime:connect` | Live updates (optional; without it the feed works over REST and `live` is `"unavailable"`) |

The server checks scopes on every request. A missing scope returns 403, and the components show it
as a permission message.

## What the server sends

`GET /notifications` returns entries newest first, 30 per page, using a `before` cursor. Each entry has
this shape (`SpreeWeNotification`):

```ts
{ _id, type, actor: { _id, username, avatar } | null, conversationId, messageId, callId,
  meetingId, recordingId, text, read, createdAt }
```

`type` is one of `mention`, `reply`, `reaction`, `missed-call`, `meeting-invite`, `meeting-reminder`
or `recording`. `text` is a short preview written by the server: the emoji for a reaction, "Video call"
or "Audio call" for a missed call, or the meeting title. In end-to-end encrypted chats, mentions and
replies always carry the fixed text "New message", because the server can't read the message.
Entries are kept for 90 days. Opening a chat in a SpreeWe client marks its mentions, replies and
reactions read.

## Service

```ts
import { getNotifications } from "@spreewe/notifications";

const n = getNotifications(client); // one instance per client
await n.load();                     // first page of the "all" feed, plus the unread count
n.items.subscribe((s) => render(s.items));
n.unread.subscribe((count) => setBadge(count));
n.onNotification((entry) => toast(entry));
```

| Member | Description |
| --- | --- |
| `start()` | Wires the live events and connects the shared socket when the token has `realtime:connect`. It is idempotent, never rejects, and `load()` calls it for you. |
| `feed(view)` | Returns a `NotificationFeed` for `"all"`, `"unread"` or `"mentions"`, the server's `view` filter. There is one feed per view, and every feed gets live updates. |
| `items` | Store holding `feed("all").state`: `{ view, items, loading, loadingMore, loaded, hasMore, error }`. |
| `load({ refresh? })` / `loadMore()` | Loads the first page or the next page of the "all" feed. |
| `unread`, `unreadLoaded`, `unreadError` | Stores for the unread count (`GET /notifications/unread-count`). |
| `refreshUnread()` | Reloads the unread count. |
| `markRead(ids)` | Calls `POST /notifications/read { ids }` in batches of 200. The change shows immediately and is rolled back if the server refuses. Resolves with the number of entries updated. |
| `markAllRead()` | Calls `POST /notifications/read {}`, which marks everything read. |
| `canMarkRead()` | Resolves `true` when the token has `notifications:write`. |
| `live` | Store with the live-update state: `"off" \| "connecting" \| "live" \| "unavailable"`. |
| `onNotification(fn)`, `onUnreadChange(fn)` | Listeners. Each returns a function that unsubscribes. |
| `findItem(id)` | Finds a loaded entry by id. |

`NotificationFeed` has `state`, `load({ refresh? })` and `loadMore()`.

The service keeps itself in sync:

- A `notification:read` event sets the exact unread count. If entries were read on another device,
  one request to `view=unread` works out which loaded entries are now read.
- After every reconnect, the service reloads the unread count and the newest page of each loaded feed.
- Entries you mark read stay in the "unread" feed, shown as read, until that feed is reloaded.

## `<spreewe-notification-bell>`

An icon button with an unread badge that opens the feed in a popover panel. The panel is fixed to
the viewport, sits under the button and stays inside the screen, so it works down to 320px wide.

| | |
| --- | --- |
| Attributes | `open` (reflected), `align="end"\|"start"`, `view` (the list's starting view), `no-panel` (button and badge only), `keep-open` (keep the panel open after a selection) |
| Methods | `toggle(force?)` |
| Events | `spreewe-notification-panel-toggle { open }`, `spreewe-notification-bell-click { unread }` (with `no-panel`). The list's events bubble through. |
| Slots | `icon` (replaces the bell), `header` and `empty` (passed on to the list) |
| CSS parts | `button`, `badge`, `panel`, `list` |
| CSS properties | `--sw-notification-panel-width` (380px), `--sw-notification-panel-height` (520px) |

Escape and clicks outside the panel close it, and focus goes back to the button.

## `<spreewe-notification-list>`

| | |
| --- | --- |
| Attributes | `view="all"\|"unread"\|"mentions"`, `no-tabs`, `no-header`, `no-auto-read` |
| Methods | `refresh()` |
| Events | `spreewe-notification-select { notification, conversationId, messageId }` (cancelable), `spreewe-notification-view-change { view }`, `spreewe-error { error, action }` |
| Slots | `header` (above the toolbar), `empty` |
| CSS parts | `toolbar`, `title`, `mark-all`, `tabs`, `tab`, `tab-selected`, `list`, `item`, `item-unread`, `avatar`, `type-icon`, `headline`, `actor`, `preview`, `time`, `dot`, `load-more`, `error` |

Selecting an entry marks it read when the token has `notifications:write`. To keep it unread, call
`preventDefault()` on the select event or set `no-auto-read`. Arrow keys move between entries, and
Left and Right switch tabs. Every string has a `notifications.*` key that you can override with
`setStrings()` from `@spreewe/ui`.

## Example

```html
<spreewe-provider id="sw">
  <spreewe-notification-bell align="end"></spreewe-notification-bell>
</spreewe-provider>
<script type="module">
  import "@spreewe/notifications/define";
  document.getElementById("sw").client = client; // your SpreeWeClient (createClient from @spreewe/core)
  document.addEventListener("spreewe-notification-select", (e) => {
    const { conversationId, messageId } = e.detail;
    if (conversationId) router.go(`/chat/${conversationId}?message=${messageId ?? ""}`);
  });
</script>
```
