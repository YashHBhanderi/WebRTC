# SpreeWe frontend integration packages

Embed SpreeWe chat, groups, calls, meetings, files, notifications and contacts in your own web app.
SpreeWe is the communication backend; your app keeps its own layout, branding and theme.

- **Framework-neutral.** Every UI component is a standard Web Component (built with Lit), so it
  works in React, Vue, Angular, Svelte or plain HTML. Every module also has a headless service
  for building your own UI.
- **Pick what you need.** Each feature is its own npm package. Importing chat downloads nothing
  from calls or meetings, and calls doesn't download chat or the encryption library. (Both were
  checked in the example builds; see [docs/production.md](docs/production.md#bundle-sizes).)
- **Same backend, same rules.** The packages use SpreeWe's existing REST API, Socket.IO events,
  OAuth and end-to-end encryption. They duplicate no business logic: the server enforces scopes,
  membership and roles.

## Packages

| Package | What it gives you | Depends on |
|---|---|---|
| [`@spreewe/core`](packages/core/README.md) | Client, authentication (OAuth 2.0 + PKCE, backend token exchange, session tokens), REST client, Socket.IO connection, shared types. No UI. | `socket.io-client` |
| [`@spreewe/ui`](packages/ui/README.md) | Theme tokens (light/dark), `<spreewe-provider>`, `<spreewe-avatar>`, base element, icons, strings | core, `lit` |
| [`@spreewe/e2ee`](packages/e2ee/README.md) | End-to-end encryption device (Olm/Megolm). Needed to read and send message content. | core, `@matrix-org/matrix-sdk-crypto-wasm` |
| [`@spreewe/chat`](packages/chat/README.md) | Conversation list, chat window, message list, composer, attachments, reactions, receipts | core, ui (e2ee optional) |
| [`@spreewe/groups`](packages/groups/README.md) | Group list, group details, member management, create group | core, ui |
| [`@spreewe/calls`](packages/calls/README.md) | Incoming call, call button, call view, controls, participants, host controls | core, ui, `mediasoup-client` |
| [`@spreewe/meetings`](packages/meetings/README.md) | Meeting list, scheduler, join by code | core, ui |
| [`@spreewe/files`](packages/files/README.md) | The user's files, a conversation's shared media | core, ui (e2ee optional) |
| [`@spreewe/notifications`](packages/notifications/README.md) | Notification bell and list | core, ui |
| [`@spreewe/contacts`](packages/contacts/README.md) | Directory, profile card, contact lookup, presence, profile editor | core, ui |

Feature modules don't import each other. You connect them through events, for example a
`<spreewe-call-button>` placed in the chat window's `header-actions` slot.

## Quick start (chat)

```bash
npm install @spreewe/core @spreewe/ui @spreewe/chat @spreewe/e2ee @matrix-org/matrix-sdk-crypto-wasm@18.9.0
```

```html
<spreewe-provider id="sw"><spreewe-chat></spreewe-chat></spreewe-provider>
```

```ts
import { createClient, createOAuthClient, scopesFor } from "@spreewe/core";
import { enableE2ee } from "@spreewe/e2ee";
import "@spreewe/chat/define";

const oauth = createOAuthClient({
  baseUrl: "https://api.spreewe.example",
  clientId: "<your app id>",
  redirectUri: `${location.origin}/`,
  scopes: scopesFor(["chat"], { includeOptional: true }),
});
if (oauth.isRedirectCallback()) await oauth.handleRedirectCallback();
if (!oauth.isSignedIn) await oauth.signIn();

const client = createClient({ baseUrl: "https://api.spreewe.example", auth: oauth });
enableE2ee(client);
document.querySelector("#sw").client = client;
```

## Documentation

| Guide | |
|---|---|
| [Installation](docs/installation.md) | Packages, peer dependencies, bundlers, WASM, CDN |
| [Authentication and configuration](docs/authentication.md) | Register an app, pick an auth mode, scopes, origins, token refresh |
| [Theming and customisation](docs/theming.md) | Tokens, light/dark, CSS parts, slots, strings and locale, own components |
| [Combining modules](docs/combining-modules.md) | Chat + calls + groups + notifications in one app, wiring events |
| [Frameworks](docs/frameworks.md) | React, Vue, Angular, Svelte |
| [Production checklist](docs/production.md) | Rate limits, security, browser support, bundle sizes, known backend issues |
| [Testing and releasing](docs/development.md) | Build, unit and integration tests, versioning, publishing |
| Module guides | Each package's README (links in the table above): scopes, service API, components (attributes, properties, events, slots, CSS parts) |

## Examples

| Example | Shows |
|---|---|
| [`examples/chat-only`](examples/chat-only) | Chat on its own, OAuth + PKCE in the browser, E2EE, your own brand colours |
| [`examples/calls-only`](examples/calls-only) | Calls on their own (no chat code bundled), incoming call prompt, host controls |
| [`examples/combined`](examples/combined) | Several modules in one app, backend token exchange ([`examples/token-server`](examples/token-server)) |

## Status

Version 0.1.0. See [docs/production.md](docs/production.md) for what has and hasn't been verified.
In short: every service is tested against the real backend (in-process, real Socket.IO, real Olm/Megolm,
the real mediasoup SFU with a simulated WebRTC handler). The components have unit tests in jsdom.
Nothing has been tested in a real browser yet, so audio/video media and the visual layout still
need a manual browser pass before production.
