# Teams and channels

Teams group people inside an organization; channels are the conversations within a team. Both exist only inside SpreeWe-managed organizations and only in that organization's context. They are invisible in the personal context and in every other organization.

Code: `webrtc-BE/src/organizations/team.service.ts` · routes `webrtc-BE/src/api/v1/team.routes.ts` · UI `pages/organizations/organization-home.component.ts`, `team-page.component.ts`.

## Data
- **`teams`** (`Team`; tenant-scoped plugin kind `tenant`):
  - `name` (2–80 characters, **unique per organization among active teams, case-insensitive**), `description`, `avatar`, `visibility` (`public` | `private`), `status` (`active` | `archived`), `createdBy`;
  - `settings.membersCanCreateChannels` (default true), `settings.membersCanAddMembers` (default false).
- **`team_memberships`** (`TeamMembership`; plugin kind `tenant`):
  - `teamId`, `userId`, `role` (`owner` | `manager` | `member`), `status` (`active` | `removed`);
  - unique on `(teamId, userId)`.
- **Channels are `Conversation` documents** with `teamId`, `channelType` (`standard` | `private` | `shared`) and `channelArchivedAt`.
  - They reuse everything conversations already have: messages, files, calls, search, read state, sockets, and the existing membership checks.
  - They are left out of the chat sidebar's group list (`teamId: null` filter).
  - The ordinary group-management endpoints refuse them: *"This is a team channel: manage it from the team"*.

## Teams
- **Create:** `POST /v1/teams` (needs `teams:create`). The creator becomes team **owner**. Every team starts with a **General** standard channel, which can't be deleted.
- **Visibility.**
  - Public teams are listed to every non-guest member, who may join them.
  - Private teams are visible only to their members and to organization owners and admins. Others get 404, so existence isn't confirmed.
  - Guests see only teams they were added to.
- **Membership.**
  - Adding requires active organization members; outsiders are refused with 400.
  - Adding never changes the role of someone already on the team.
  - Team owners and managers add people. Members can too when `membersCanAddMembers` is on, and only as members.
  - Only team owners (or organization owners and admins) add owners or managers or change roles.
  - Nobody changes their own team role, except organization owners and admins.
- **Last team owner:** can't be demoted, removed or leave (409). This is safe under concurrency (`demoteTeamOwner`).
- **Archive:** `POST /v1/teams/:teamId/archive` (team owner or organization owner/admin). The team disappears, and its channels are archived with their member lists emptied. History is kept; nobody can read the channels any more.

## Channels

| Type | Members | Who can create | Visible to |
|---|---|---|---|
| `standard` | Every active team member, kept in sync when people join or leave the team | Team owners and managers; members if `membersCanCreateChannels` | Team members (non-members browsing a public team see standard channels only) |
| `private` | Explicit subset of team members (creator included) | Same | **Its members only**. Organization owners and admins who are not in it can't list, open, read or join it |
| `shared` | Team members chosen by the creator, plus external people | Team owners and managers, or organization owners and admins, **and** the organization allows external chat (`allowExternalChat`, plus `membersCanStartExternal` for non-admins) | Its members; external people see only this channel |

- **Create:** `POST /v1/teams/:teamId/channels` with `{ name, type, description?, memberIds?, externalUserIds? }`.
- **Add members** (private and shared only): `POST …/channels/:channelId/members`; only people on the team. Standard channels follow the team.
- **Remove members:** `POST …/channels/:channelId/members/:userId/remove`. Anyone may remove themselves; channel and team owners and managers may remove others.
- **Delete:** `POST …/channels/:channelId/delete`. The channel is archived (history kept, members emptied). General can't be deleted.
- **Favorites:** each channel in `GET /v1/teams/:teamId/channels` carries `isFavorite` for the caller. It is set with the `chat:favorite` / `chat:unfavorite` socket events (per user, members only), the same as for chats and groups.
- **Web client:** teams and channels appear in the chat list under **All → Teams & channels** (the separate Teams rail entry was removed; `/organization` remains reachable from that section's menu and with Alt+8).

### Shared channels and external people
A shared channel is an **external conversation**: `scope: "external"`, `tenantId` of the owning organization, and `externalParticipants`. These fields are set by the server, never taken from input.
- External people must **not** be members of the organization (400). Organization members are added as normal channel members.
- Existing external-conversation isolation applies ([../security/external-conversation-isolation.md](../security/external-conversation-isolation.md)):
  - external people see only that conversation, labelled *External*;
  - they never see the organization's teams, channels or directory;
  - calls and files follow `allowExternalCalls` and `allowExternalFiles`.
- **UI:** shared channels are created through the API only. The team page offers standard and private channels. A people picker for accounts outside the organization would enumerate accounts; that needs a product decision first (for example, inviting by email into a shared channel).

## Removal
- Removing someone from the organization:
  - marks all their team memberships `removed`;
  - pulls them from `members` and `groupAdmins` of every team channel in that organization;
  - disconnects their sockets for that organization.
- Removing someone from a team pulls them from all of that team's channels.

## Real-time events
All events are tenant-scoped: they are delivered only to the recipient's sockets **in that organization**.

| Event | To | Payload |
|---|---|---|
| `team:joined` | People added to a team | `{ teamId, name }` |
| `team:removed` | The person removed | `{ teamId }` |
| `channel:created` | The new channel's members | `{ teamId, channelId, name }` |
| `channel:joined` | People added to a private or shared channel | `{ teamId, channelId }` |

Message, typing, call and read events for channels are the ordinary conversation events. Joining a channel's socket room uses the existing conversation membership check, so a non-member can't join a private channel's room (tested).

## Opening a channel
The organization home and team page open a channel with `/chat?c=<channelId>`. The chat view loads it through the member-only group info endpoint, so a link to a channel you're not in shows nothing.
