# Integration tutorial

Nine steps that take an existing web application to encrypted chat, attachments, calls and a ready-made UI. Each step shows working code and says what is tested.

Before you start, finish the prerequisites in [Getting started](./getting-started.md#1-prerequisites): backend URL, your origin allow-listed, Clerk sign-in.

> Status reminder: steps 1–6 are covered by automated end-to-end tests (real backend, database and encryption; sign-in simulated). Steps 7–9 are **implemented but not tested in a real browser**. Plan your own browser testing.

---

## Step 1: Register an application (only if you need server-to-server)

What to register depends on what you build:

| You build | Register |
|---|---|
| A web app where **your users chat and call** in the browser | **Nothing extra.** Your origin is allow-listed by the SpreeWe operator, and users sign in with the SpreeWe Clerk instance. Go to step 2. |
| A **server** that reads conversations, reacts to events or manages users on their behalf | A **developer application** (`/v1/apps`). Then get user consent, exchange it for scoped user tokens, and subscribe to webhooks. See [Authentication: developer applications](./authentication.md) and [REST v1](./rest-api/v1-api.md). |

Developer-app tokens **cannot send or decrypt messages**. Messaging always happens in the user's browser through the SDK.

## Step 2: Configure authentication

Load Clerk with the SpreeWe publishable key, which the backend publishes at `GET /config`:

```ts
import { Clerk } from '@clerk/clerk-js';

const config = await (await fetch(`${SPREEWE_API}/config`)).json();
const clerk = new Clerk(config.data.clerkPublishableKey);
await clerk.load(/* your Clerk UI options */);
if (!clerk.user) clerk.mountSignIn(document.getElementById('sign-in')!);
```

`examples/angular-app/src/app.component.ts` shows the complete version: the Clerk UI loader, the sign-in mount and a workspace switcher.

The token provider for the SDK:

```ts
const getToken = () => clerk.session?.getToken({ skipCache: true }) ?? Promise.resolve(null);
```

The token is the **user's** short-lived session token, about 60 s. Never give the SDK an app credential.

## Step 3: Initialize the SDK

```ts
import { SpreeWeClient } from '@spreewe/chat-sdk';

const client = new SpreeWeClient({
  apiUrl: `${location.origin}/api`,     // via your proxy, or the backend URL directly (then CORS_ORIGINS must list you)
  socketUrl: location.origin,
  getToken,
  wasmUrl: new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI),
  deviceLabel: 'Acme Support',
});
```

## Step 4: Connect a user

```ts
const me = await client.connect();
console.log(me._id, client.deviceId);
```

`connect()` does four things:
1. Loads the SpreeWe user (`GET /web/user/me`).
2. Opens this browser's encryption device. On first use it creates one and registers its public keys. The keys stay in IndexedDB, so the same device is reused after a refresh.
3. Connects Socket.IO.
4. Syncs keys.

It rejects with a `SpreeWeError` (`NOT_SIGNED_IN`, `E2EE`, `NOT_CONNECTED`, `TIMEOUT`) if any of these fail.

**Switching workspace:** after `clerk.setActive({ organization })`, call `client.disconnect()` and `client.connect()` again. *Tested: connect, device creation.*

## Step 5: Load conversations

```ts
const conversations = await client.conversations.list();   // direct chats + groups of the active workspace
const people = await client.users.directory();              // who you may start a conversation with

const directId = await client.conversations.openDirect(people[0]._id);
const group = await client.conversations.createGroup({ name: 'Project', memberIds: [people[0]._id, people[1]._id] });
```

A direct conversation shows up in `list()` once it has at least one message.

`list()` returns direct chats (with participants and the other person's name) and the groups you are a member of.

*Tested: direct listing, direct and group creation, group messaging.*

## Step 6: Send and receive encrypted messages

```ts
client.events.on('message', (m) => {
  if (m.state === 'ok') render(m);                       // decrypted on this device
  if (m.state === 'pending') waitingForKey(m);           // the key is on its way
});
client.events.on('keys', async () => rerender(await client.messages.history(directId)));

await client.messages.send(directId, 'Hello!');
const history = await client.messages.history(directId, { limit: 30 });   // oldest first
await client.messages.send(directId, 'Re: hello', { replyTo: history[0].id });
await client.messages.edit(directId, history[0].id, 'Hello (edited)');
client.messages.react(directId, history[0].id, '👍');
```

More in the [Chat guide](./chat.md). *Tested: send, live receive, decrypt, history, reply, edit, react, pin, delete, typing, read receipts, groups.*

## Step 7: Upload and display attachments

```ts
// Send: the file is encrypted in the browser, only ciphertext is uploaded
await client.files.sendAttachment(directId, fileInput.files![0], 'optional caption');

// Receive: download and decrypt on this device
client.events.on('message', async (m) => {
  if (m.state === 'ok' && m.attachment) {
    const blob = await m.attachment.download();
    img.src = URL.createObjectURL(blob);     // call URL.revokeObjectURL later
  }
});
```

The backend needs S3 configured. See [Files and attachments](./files.md). *Implemented, not tested in a real browser (needs S3).*

## Step 8: Start and receive audio/video calls

```ts
// Caller
const call = await client.calls.start(directId, 'video');            // rings the other members
const media = await client.calls.join(call.callId, 'video', {
  onRemoteStream: (userId, stream) => attach(userId, stream),
});
localVideo.srcObject = media.localStream;

// Callee
client.events.on('call.incoming', async (c) => {
  if (!confirm(`Incoming ${c.callType} call`)) return client.calls.reject(c.callId);
  await client.calls.accept(c.callId);
  const media = await client.calls.join(c.callId, c.callType, { onRemoteStream: attach });
});

// Either side
media.setMicEnabled(false);
media.close(); client.calls.leave(call.callId);     // leave
await client.calls.end(call.callId);                // end for everyone (host)
```

The browser asks for camera and microphone permission and needs HTTPS. Restrictive networks need TURN on the backend. See [Audio and video calling](./calling.md).

*Signaling tested (start, incoming, accept, joined, state, end). Media implemented, not tested in a real browser.*

## Step 9: Integrate the ready-made Angular chat UI

```ts
import { Component } from '@angular/core';
import { SpwChatAppComponent } from '@spreewe/chat-angular';

@Component({
  selector: 'app-support',
  standalone: true,
  imports: [SpwChatAppComponent],
  template: `<spw-chat-app [client]="client" style="height: 600px"></spw-chat-app>`,
})
export class SupportComponent {
  client = client;   // connected SpreeWeClient from step 4
}
```

`<spw-chat-app>` includes the conversation sidebar, chat window, composer, attachments, presence and the call panel.

**Theming:** each component declares its own `--spw-*` defaults, so a variable set only on `spw-chat-app` doesn't reach the nested components. Set the variables from global CSS on every component, with a selector specific enough to win, for example:

```css
:root :is(spw-chat-app, spw-conversation-list, spw-chat-window, spw-composer, spw-call) { --spw-brand: #3949ab; }
```

This hasn't been verified in a browser. See [Angular UI library](./angular-ui.md).

Setup details (`preserveSymlinks`, the WASM asset) are in the [Angular UI library](./angular-ui.md) guide. The complete runnable app is [`examples/angular-app`](../../examples/angular-app) (`npm install --legacy-peer-deps && npm start`). Its origin `https://localhost:4300` must be in the backend's `CLERK_AUTHORIZED_PARTIES`.

*Build passes; not tested in a real browser.*

---

## Verify your integration
Use two browser profiles, signed in as two users:

1. **Chat:** messages from A appear decrypted for B. The `sendMessage` frame carries only `e2ee.ciphertext`.
2. **Refresh:** after a refresh, the device id (`client.deviceId`) is unchanged and history still decrypts.
3. **Groups:** after you remove a member, they no longer receive new messages.
4. **Workspaces:** an organization conversation is absent from the same user's personal context.
5. **Attachments and calls:** test them in your environment. They haven't been verified in a real browser yet.

If something fails, see [Troubleshooting](./troubleshooting.md).
