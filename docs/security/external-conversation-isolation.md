# External conversation isolation

An external conversation belongs to one workspace (the **host**). Each guest is invited as a person, not as a member of their own organization.

## Rule (Phase 4B)

| Who | Sees the external conversation and its records… | …not from |
| --- | --- | --- |
| Host workspace member | while in the host workspace | their personal (global) context, or any other workspace |
| Invited guest | from their personal (global) context | any workspace, including their own organization's |
| Anyone else | never | — |

"Records" means messages, calls, meetings, recordings, notifications and saved messages.

**Why guests use only their personal context:** it keeps another organization's conversation from ever appearing inside a workspace view. That matters most when the guest belongs to several organizations.

**Trade-off:** a guest who works mainly inside their own workspace must switch to their personal context to see external chats. Allowing it in the guest's home workspace would need an explicit cross-organization policy, which this phase does not include.

## How it is enforced

- **Conversations** (`conversationFilter`):
  - workspace context: `{ tenantId: <workspace> }`;
  - global context: `{ tenantId: null }` or `{ scope: "external", externalParticipants: <me> }`.
- **Records** (`derivedFilter`): the same rule. External records carry `guestUserIds`, copied from the conversation on insert. Before this phase, any external record was visible from any context, filtered only by user.
- **Socket delivery** (`visibleIn`): external → the host workspace's sockets, or the guest's personal-context socket.
- **Notifications without a conversation id** are delivered only to listed guests outside the workspace.
- **Consistency:** `checkScopeConsistency()` now also checks guest lists. Migration `2026-10-22-external-guest-lists` copies guest lists onto existing external records and repairs any drift.

## What guests can never reach

- The host's internal conversations, messages and files.
- The workspace directory and workspace endpoints (`/tenant/*`, `/v1/workspace*`).
- Meeting history of other conversations.
- Recordings of other conversations.
- Call participation outside the external conversation (calls also need the host policy `allowExternalCalls`).

## Tests (`test/p0-isolation.test.ts`, `test/tenant-isolation.test.ts`)

- Guest: personal context OK; own-organization workspace refused; internal chats refused.
- Host member: workspace OK; personal context refused.
- Search, notifications and call history follow the rule.
- Socket: an external message reaches the guest's personal socket, not their workspace socket.
- Legacy-file links are only issued through the scoped message endpoints.

**Negative checks:**
- Letting guests see external chats from any context fails the guest test.
- Letting external records be visible to anyone in the global context fails the records test.

## Not covered

- Files uploaded to S3 in external chats are reachable only through the scoped message endpoints. The S3 signing itself is **not exercised** in tests (storage isn't configured there).
- Group external conversations (several guests or several organizations) are not supported; external conversations are 1:1.
