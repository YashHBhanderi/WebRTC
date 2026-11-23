# @spreewe/meetings

Scheduled SpreeWe meetings (one-off and recurring) for your app: a headless service and three Web Components (Lit 3).

This module does **not** join calls. Every meeting has a `conversationId` (its own group chat, where its calls run). The components fire `spreewe-meeting-join` with `{ meetingId, conversationId, code }`; pass these ids to the calls module.

## Install

```sh
npm install @spreewe/core @spreewe/ui @spreewe/meetings
```

```ts
import { createClient, backendTokenProvider } from "@spreewe/core";
import { setDefaultClient } from "@spreewe/ui";
import "@spreewe/meetings/define"; // registers the elements (the main entry doesn't)

const client = createClient({ baseUrl: "https://api.example.com", auth: backendTokenProvider({ fetchToken }) });
setDefaultClient(client); // or wrap the components in <spreewe-provider>
```

## Scopes

| Scope | Needed for |
|---|---|
| `profile:read`, `meetings:read` | List, get and preview meetings (required) |
| `meetings:write` | Create, update, cancel, join by code |
| `realtime:connect` | Live `meeting:updated` events (optional; without it, lists refresh after your own changes only) |
| `directory:read` | The scheduler's people search (optional) |

App tokens without a scope get `403 "The token lacks the <scope> scope"`. The components show this as a permission message.

## Service

```ts
import { getMeetings } from "@spreewe/meetings";
const meetings = getMeetings(client); // one instance per client
```

| Method | Backend | Notes |
|---|---|---|
| `list({ from, to })` | `GET /meetings?from=&to=` | Occurrences overlapping `[from, to)`, sorted. The server caps a range at 62 days, so longer ranges are fetched in parts and merged. Cancelled meetings and cancelled occurrences are not included |
| `watchRange(from, to)` | same + `meeting:updated` | `{ state, refresh(), release() }`. `state` is a store of `{ items, loading, loaded, error }`. It reloads on `meeting:updated`, after reconnects and after changes made through this service |
| `get(id)` | `GET /meetings/:id` | Organiser or invitee only (404 otherwise) |
| `create(input)` | `POST /meetings` | `{ title, startAt, endAt, description?, invitees?: userId[], recurrence?, lobby?, password?, timeZone? }`. `timeZone` defaults to the browser's. Max 24 h, title max 120, description max 2000, invitees max 250 |
| `update(id, patch)` | `PATCH /meetings/:id` | Organiser only. Only the given fields are sent. `recurrence: null` removes the repeat rule. `password: ""` removes the password |
| `cancel(id, { occurrence? })` | `DELETE /meetings/:id?occurrence=` | Whole series, or one occurrence (pass its `occurrenceStart`). Organiser only |
| `preview(codeOrLink)` | `GET /meetings/code/:code` | Works for people who weren't invited. They get `meetingId: null` and `conversationId: null` |
| `join(codeOrLink, { password? })` | `POST /meetings/code/:code/join` | Returns `{ meetingId, conversationId, lobby, code }`. Non-invitees give the password (if one is set) and are added to the meeting chat. Returns 410 if the meeting was cancelled |
| `onUpdated(listener)` | socket `meeting:updated` | `{ meetingId }`. Starts live updates |
| `startLive()` | | Connects the socket if the token allows it. Resolves `true`/`false` and never rejects |

Helpers: `parseMeetingCode(input)` (accepts a code, a `…/meet/<code>` link or `?code=`), `localTimeZone()`, `MAX_RANGE_DAYS`.

Recurrence: `{ freq: "daily" | "weekdays" | "weekly" | "monthly", interval?: 1–30, byWeekday?: 0–6 (0 = Sunday, weekly only), until?: date, count?: 1–500 }`. Without `until` or `count`, the server ends the series after two years. Occurrences keep their local wall-clock time in the meeting's time zone. Monthly repeats on the same day of the month.

Errors are `SpreeWeError`s. Validation failures have `status: 400`, `code: "VALIDATION_ERROR"`, and the server's message, e.g. "The meeting must end after it starts".

## Components

### `<spreewe-meeting-list>`

Upcoming meetings grouped by day, with Join buttons and live updates.

| | |
|---|---|
| Attributes | `from` (date or date-time, default start of today), `days` (default 7), `to` (overrides `days`), `selected` (meeting id), `hide-ended` |
| Methods | `refresh()` |
| Events | `spreewe-meeting-select` `{ meetingId, occurrenceStart, meeting }`, `spreewe-meeting-join` `{ meetingId, conversationId, code, occurrenceStart, activeCallId }` |
| Slots | `header`, `empty`, `footer` |
| CSS parts | `list`, `day`, `day-label`, `item`, `item-selected`, `time`, `title`, `meta`, `badge`, `join`, `error` |

Keyboard: ↑/↓/Home/End move between meetings, Enter opens one.

### `<spreewe-meeting-scheduler>`

Form to create a meeting, or to edit one (`meeting-id`). Fields: title, date, start and end (an end before the start means the next day), invitees (people search via `client.people.directory`), description, repeat, lobby and password. Server validation messages are shown as the server sends them. People who aren't the organiser see the meeting read-only. When editing, the organiser can cancel the meeting.

| | |
|---|---|
| Attributes | `meeting-id`, `start` (default start for a new meeting, ISO), `duration` (minutes, default 30), `no-recurrence`, `no-password` |
| Methods | `resetForm()` |
| Events | `spreewe-meeting-saved` `{ meeting, created }`, `spreewe-meeting-cancelled` `{ meetingId }`, `spreewe-cancel` |
| Slots | `header` (replaces the heading), `actions` |
| CSS parts | `form`, `heading`, `field`, `input`, `invitees`, `chip`, `suggestions`, `suggestion`, `error`, `save`, `cancel`, `cancel-meeting` |

The date and time inputs use the browser's time zone. New meetings are created in that zone. Edits keep the meeting's zone.

### `<spreewe-meeting-join>`

Enter a meeting ID or link, preview it, enter the password if asked, then join.

| | |
|---|---|
| Attributes | `code` (code or link; it is previewed straight away) |
| Methods | `lookUp(input?)` |
| Events | `spreewe-meeting-preview` `{ preview }`, `spreewe-meeting-join` `{ meetingId, conversationId, code, lobby }` |
| Slots | `header` |
| CSS parts | `form`, `input`, `continue`, `preview`, `title`, `meta`, `password`, `join`, `error` |

All colours, sizes and spacing come from the `--sw-*` tokens of `@spreewe/ui`. UI strings use `meetings.*` keys; override them with `setStrings()`.

## Example

```html
<spreewe-meeting-list days="14"></spreewe-meeting-list>
<spreewe-meeting-scheduler hidden></spreewe-meeting-scheduler>
<spreewe-meeting-join></spreewe-meeting-join>

<script type="module">
  document.addEventListener("spreewe-meeting-join", (e) => {
    const { conversationId, meetingId } = e.detail;
    // Hand over to the calls module, e.g. start / join the call in `conversationId`
  });
  document.addEventListener("spreewe-meeting-select", (e) => {
    const scheduler = document.querySelector("spreewe-meeting-scheduler");
    scheduler.setAttribute("meeting-id", e.detail.meetingId);
    scheduler.hidden = false;
  });
</script>
```

## Known backend behaviour

- `PATCH /meetings/:id` doesn't enforce the 24-hour maximum that `POST` does (webrtc-BE `meeting.service.ts` update). The scheduler checks it on the client.
- Invitees removed in an update don't receive `meeting:updated`, so their lists keep the meeting until they reload.
- `preview().recurrence` is a text summary, while `Meeting.recurrence` is the rule object (`recurrenceText` holds the summary).
