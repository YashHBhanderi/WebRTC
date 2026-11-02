# Organizations and workspaces

Related: [Integration guide](./integration-guide.md) · [Authentication](./authentication.md) · [Realtime events](./realtime-events.md) · [/v1 REST API](./rest-api/v1-api.md)

## 1. Context model

A SpreeWe **workspace** is the same thing as a **Clerk organization**. Every request and every socket runs in exactly one context:

| Context | When | What is visible |
|---|---|---|
| Workspace | The Clerk session has an active organization | Only that workspace's conversations, messages, calls, files and members |
| Global (personal) | No active organization | Global data, plus external conversations in which the user is a guest |

- The server reads the context from the token. No request carries an organization id.
- **Developer-app tokens** run in the app's context: a workspace-bound app's tokens act only in its workspace (and only while the user is an active member); a global app's tokens act in the user's personal context.
- Context resolution fails closed. An invalid organization id returns 401. A suspended or deleted workspace returns 403, and so does a user who is not, or is no longer, an active member. The server never falls back to another context.

Status: **Implemented and tested** (`tenant-isolation.test.ts`, `fail-closed.test.ts`, `global.test.ts`, `organizations.test.ts`).

## 2. Switching workspace

1. In a SpreeWe-session client, call Clerk's `setActive({ organization })`, or `setActive({ organization: null })` for the personal context.
2. REST calls pick up the new context straight away if your client fetches a fresh token for every call.
3. **A socket keeps the context it had when it connected.** After a switch, disconnect the socket and connect again with a fresh token so realtime events match the new workspace.

Developer-app tokens cannot switch workspace: the context is fixed by the app's binding. To act in another workspace, the workspace needs its own app (registered there by an owner or admin) and the user's consent to it.

Status: **Implemented, not tested in a real browser.**

## 3. Membership and roles

Roles are `owner`, `admin`, `member` and `guest`.

| Action | owner | admin | member | guest |
|---|---|---|---|---|
| Read the organization | yes | yes | yes | yes |
| Read members and the directory | yes | yes | yes | no |
| Update the organization, view the audit log, decide join requests, manage the join code, remove members, change roles | yes | yes | no | no |
| Delete the organization | yes | no | no | no |
| Invite | yes (admin, member, guest\*) | yes (member, guest\*) | `member` only, if the workspace setting `membersCanInvite` is on | no |
| Create teams | yes | yes | if `membersCanCreateTeams` is on | no |
| Change workspace policies | yes | yes | no | no |

\*Admins can invite `guest` only when the workspace setting `guestAccess` is on.

### Guests

- A guest inside the workspace cannot see members or the directory. A guest can only add people they already share a conversation with.
- A person outside the workspace can be a guest in an **external** conversation. That person sees the conversation only from their personal (global) context, never from inside one of their own workspaces.

## 4. Workspace policies

These are the only policies the server implements. All of them are **off by default**.

| Policy | Effect |
|---|---|
| `allowExternalChat` | Allows 1:1 external conversations between workspace members and people outside the workspace |
| `allowExternalCalls` | Allows calls in external conversations. Also requires `allowExternalChat` |
| `allowExternalFiles` | Allows file sharing in external conversations. Also requires `allowExternalChat` |
| `membersCanStartExternal` | Lets members, not only owners and admins, start external conversations |

Only owners and admins can change policies. The change applies on every server instance, and open clients receive `org:updated`. If a policy is turned off later, existing external conversations are blocked for that action ("External chat is turned off for this workspace").

## 5. Isolation guarantees

- A resource that belongs to another workspace, such as a conversation, message, call or recording, returns **404**, not 403. The response does not reveal that the resource exists.
- Socket events are delivered only to sockets in the matching context.
- App tokens are bound to the context of their app and grant.

Status: **Implemented and tested** (`tenant-isolation.test.ts`, `socket-isolation.test.ts`, `p0-isolation.test.ts`).

## 6. Organization endpoints and scopes

All endpoints are in the [/v1 REST API](./rest-api/v1-api.md). They accept a SpreeWe session token, and developer-app user tokens with the scope listed below. With an app token, the user's own role still applies: `organizations:manage` lets the app do only what the user, as owner or admin, could do themselves.

| Scope | Endpoints |
|---|---|
| `organizations:read` | `GET /v1/organizations/mine`, `GET /v1/organizations/discover`, `GET /v1/me/join-requests`, `GET /v1/me/organization-invitations`, `POST /v1/organization-invitations/preview`, `GET /v1/workspace`, `GET /v1/workspaces`, `GET /v1/workspace/organization`, `GET /v1/workspace/organization/members`, `GET /v1/workspace/members`, `GET /v1/teams`, `GET /v1/teams/{teamId}`, `GET /v1/teams/{teamId}/members`, `GET /v1/teams/{teamId}/channels` |
| `organizations:write` | `POST /v1/organizations`, `POST /v1/organizations/{organizationId}/join`, `POST /v1/organizations/{organizationId}/join-requests`, `POST /v1/me/join-requests/{requestId}/cancel`, `POST /v1/organization-invitations/accept`, `POST /v1/workspace/leave`, `POST /v1/teams`, `POST /v1/teams/{teamId}/join`, `POST /v1/teams/{teamId}/members`, `POST /v1/teams/{teamId}/channels`, `POST /v1/teams/{teamId}/channels/{channelId}/members` |
| `organizations:manage` | `PATCH /v1/workspace/organization`, `PATCH /v1/workspace/policies`, `PATCH /v1/workspace/organization/members/{userId}` (role), `POST /v1/workspace/organization/members/{userId}/remove`, `GET\|POST /v1/workspace/invitations`, `POST /v1/workspace/invitations/{invitationId}/resend` and `/revoke`, `GET /v1/workspace/join-requests`, `POST /v1/workspace/join-code`, `GET /v1/workspace/audit`, `PATCH /v1/teams/{teamId}`, `POST /v1/teams/{teamId}/archive`, `PATCH /v1/teams/{teamId}/members/{userId}`, `POST /v1/teams/{teamId}/members/{userId}/remove`, `POST /v1/teams/{teamId}/channels/{channelId}/members/{userId}/remove`, `POST /v1/teams/{teamId}/channels/{channelId}/delete` |

**SpreeWe session only** (app tokens get `403 This endpoint needs a signed-in SpreeWe session`):

- `POST /v1/workspace/organization/delete` and `POST /v1/workspace/organization/transfer` (delete the organization, transfer ownership);
- `POST /v1/workspace/join-requests/{requestId}/approve` and `/reject`;
- `GET /v1/workspace/apps` and `POST /v1/workspace/apps/{appId}/revoke-grants` (admins reviewing and cutting off apps in their workspace).

Endpoints marked "workspace" in the reference need an active workspace context: a global app's tokens get `400 This endpoint needs an active workspace` there.

Check [the /v1 reference](./rest-api/v1-api.md) for methods, bodies and required roles.
