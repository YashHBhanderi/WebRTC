# Organizations and workspaces

Related: [Authentication](./authentication.md) · [SDK reference](./sdk-reference.md) · [Realtime events](./realtime-events.md) · [/v1 REST API](./rest-api/v1-api.md) · [Getting started](./getting-started.md)

## 1. Context model

A SpreeWe **workspace** is the same thing as a **Clerk organization**. Every request and every socket runs in exactly one context:

| Context | When | What is visible |
|---|---|---|
| Workspace | The Clerk session has an active organization | Only that workspace's conversations, messages, calls, files and members |
| Global (personal) | No active organization | Global data, plus external conversations in which the user is a guest |

- The server reads the context from the session token. The SDK never sends an organization id.
- Context resolution fails closed. An invalid organization id returns 401. A suspended or deleted workspace returns 403, and so does a user who is not, or is no longer, an active member. The server never falls back to another context.

Status: **Implemented and tested** (`tenant-isolation.test.ts`, `fail-closed.test.ts`, `global.test.ts`, `organizations.test.ts`).

## 2. Switching workspace

1. In the host app, call Clerk's `setActive({ organization })`, or `setActive({ organization: null })` for the personal context.
2. REST calls pick up the new context straight away, because the SDK requests a fresh token for every call.
3. **The socket keeps the context it had when it connected.** The SDK does not reconnect on its own when the organization changes (based on `packages/chat-sdk/src/client.ts`). After a switch, call `client.disconnect()` and then `client.connect()` so realtime events match the new workspace.

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

## 6. What the SDK exposes

| SDK call | REST endpoint |
|---|---|
| `client.organizations.mine()` | `GET /v1/organizations/mine`: the organizations the user belongs to |
| `client.organizations.members()` | `GET /v1/workspace/organization/members`: members of the active workspace (not available to guests) |

Everything else is available only through the [/v1 REST API](./rest-api/v1-api.md), using the user's session token. That includes:

- **Creating and finding organizations:** `POST /v1/organizations`, `GET /v1/organizations/discover`, `POST /v1/organizations/{organizationId}/join`, `/join-requests`
- **Invitations:** `GET|POST /v1/workspace/invitations`, `.../resend`, `.../revoke`, `GET /v1/me/organization-invitations`, `POST /v1/organization-invitations/preview` and `/accept`
- **Join requests and codes:** `/v1/workspace/join-requests`, `/v1/workspace/join-code`, `/v1/me/join-requests`
- **Members:** `/v1/workspace/organization/members/{userId}` (role change), `.../remove`, `/v1/workspace/leave`, `/v1/workspace/organization/transfer`
- **Organization settings and deletion:** `/v1/workspace/organization`, `/v1/workspace/organization/delete`, `/v1/workspace/audit`
- **Workspace apps:** `GET /v1/workspace/apps`, `POST /v1/workspace/apps/{appId}/revoke-grants`

Check [the /v1 reference](./rest-api/v1-api.md) for methods, bodies and required roles.
