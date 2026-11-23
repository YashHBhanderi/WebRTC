# @spreewe/groups

Group list, group details and member management, live. Group messaging itself is
[`@spreewe/chat`](../chat/README.md) (a group is a conversation); this module adds the group-specific UI.

```bash
npm install @spreewe/core @spreewe/ui @spreewe/groups
```

```html
<spreewe-group-details group-id="…"></spreewe-group-details>
<script type="module">import "@spreewe/groups/define";</script>
```

## Scopes

`groups:read` (list, details, live events), `groups:write` (create, rename, description, photo —
the photo also needs `files:write`), `groups:manage` (add / remove members, promote / demote admins,
leave), `conversations:delete` (delete a group), `directory:read` (member picker). The server also
checks that the user is a group admin.

## Components

### `<spreewe-group-list>`
- Attribute `selected`. Event `spreewe-group-select` `{ groupId, group }`.
- Slots `header`, `empty`. Parts `list`, `item`, `item-selected`, `name`, `meta`, `badge`.

### `<spreewe-group-details>`
- Attributes `group-id`, `readonly`.
- Shows name, description, photo, members with roles and presence; actions by role: edit, add
  members, make/remove admin, remove member, leave, delete.
- Events: `spreewe-member-select` `{ user }`, `spreewe-group-left` `{ groupId }`, `spreewe-group-deleted` `{ groupId }`,
  `spreewe-confirm-request` `{ message, action }` (cancelable: show your dialog, then call `confirmAction()`), `spreewe-error`.
- Slots `header-actions`, `footer`. Parts `header`, `name`, `description`, `members`, `member`, `role`, `actions`, `danger`.

### `<spreewe-create-group>`
- Form: name, description, photo, members (at least 2 others).
- Events `spreewe-group-created` `{ groupId }`, `spreewe-cancel`. Slot `title`. Parts `form`, `actions`, `submit`. Method `reset()`.

### `<spreewe-member-picker>`
- Directory search with multi-select. Properties `selected` (DirectoryEntry[]), `exclude` (user ids).
- Event `spreewe-change` `{ selected }`. Parts `search`, `results`, `chip`.

## Service

```ts
import { getGroups } from "@spreewe/groups";
const groups = getGroups(client);
const id = await groups.create({ name: "Launch", memberIds: [a, b], description, photo });
groups.group(id).subscribe(({ group, gone }) => …);   // live details; gone = removed | left | deleted
await groups.addMembers(id, [c]);
```

`loadGroups()`, `groups` (store), `group(id)`, `loadDetails(id)`, `create`, `update(id, { name, description })`,
`setPhoto(id, blob)`, `addMembers`, `removeMember`, `promote`, `demote`, `leave`, `delete`, `isAdmin(group, userId)`.

Member changes use the same Socket.IO events as the SpreeWe apps (`group:add-member`, …), so every
member sees them live; refusals reject with `SOCKET_REFUSED` and the server's message.
