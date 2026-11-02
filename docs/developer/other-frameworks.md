# Other frameworks (React, Vue, plain TypeScript)

The ready-made UI components ([Angular UI library](./angular-ui.md)) exist **for Angular only**. For any other framework, use the headless `@spreewe/chat-sdk` and build your own UI. The SDK has no framework dependency: it's plain TypeScript with `fetch`, Socket.IO, WebCrypto/IndexedDB and WebAssembly.

| Framework | Ready-made UI | Headless SDK |
|---|---|---|
| Angular 16 | Yes (`@spreewe/chat-angular`). Build passes; not tested in a real browser. | Yes, built and bundled with Angular CLI 16 |
| React | **No** | Yes, with a bundler that meets the [requirements](#bundler-requirements). The example below is a pattern and hasn't been run in a React app. |
| Vue | **No** | Same as React |
| Plain JavaScript/TypeScript | No | Yes, **through a bundler**. A bare `<script type="module">` won't work, because the SDK imports packages by name (`socket.io-client`, …) and loads a WebAssembly module. |
| Node.js (server) | Not applicable | **Not supported.** The SDK needs browser storage for encryption keys and browser WebRTC for calls. For server-side integrations use developer applications and `/v1` ([Authentication](./authentication.md)). |

## Bundler requirements

The SDK is shipped as ES modules with fully specified relative imports (`from './client.js'`). We checked how bundlers handle it:

| Bundler | Result |
|---|---|
| Angular CLI 16 (webpack) | Works (the SpreeWe app and `examples/angular-app` build) |
| esbuild 0.21 (also what Vite uses for dependencies) | Bundles without changes |
| webpack 5.94 with default settings (CRA, Vue CLI, custom) | Bundles without changes |

SDK builds from checkpoint `1dc6d13` or earlier used extension-less imports, which webpack 5 rejects (`Can't resolve './client' … Did you mean 'client.js'?`). Rebuild the SDK from current source. A test (`webrtc-BE/test/sdk-packaging.test.ts`) keeps the imports fully specified.

**For every bundler:**
- Serve `node_modules/@matrix-org/matrix-sdk-crypto-wasm/pkg/matrix_sdk_crypto_wasm_bg.wasm` as a static file and pass its URL as `wasmUrl`. In Vite you can copy it into `public/crypto/` and use `wasmUrl: '/crypto/matrix_sdk_crypto_wasm_bg.wasm'`.
- **Local path installs** (`npm install /path/to/packages/chat-sdk`) are symlinks. If your bundler resolves the SDK's own `node_modules` you can end up with two copies of `socket.io-client` or `mediasoup-client`. That's harmless but larger. Prefer installing a packed tarball (`npm pack` in `packages/chat-sdk`, then `npm install ./spreewe-chat-sdk-0.1.0-prototype.tgz`).

## A client per signed-in user

Create one `SpreeWeClient` per signed-in user and workspace, and disconnect it on sign-out or workspace switch. The SDK does **not** reconnect by itself when the Clerk active organization changes.

```ts
// spreewe.ts: framework-independent wrapper
import { SpreeWeClient } from '@spreewe/chat-sdk';

let client: SpreeWeClient | null = null;

export async function connectSpreeWe(getToken: () => Promise<string | null>): Promise<SpreeWeClient> {
  client?.disconnect();
  client = new SpreeWeClient({
    apiUrl: `${location.origin}/api`,
    socketUrl: location.origin,
    getToken,
    wasmUrl: '/crypto/matrix_sdk_crypto_wasm_bg.wasm',
    deviceLabel: 'My App',
  });
  await client.connect();
  return client;
}

export function disconnectSpreeWe(): void {
  client?.disconnect();
  client = null;
}
```

## React (pattern)

```tsx
import { useEffect, useState } from 'react';
import type { ChatMessage, SpreeWeClient } from '@spreewe/chat-sdk';

export function Conversation({ client, conversationId }: { client: SpreeWeClient; conversationId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    let alive = true;
    const load = () => client.messages.history(conversationId).then((h) => alive && setMessages(h));
    load();
    // Each `on` returns an unsubscribe function: return them from the effect for cleanup
    const offMessage = client.events.on('message', (m) => {
      if (m.conversationId === conversationId) setMessages((prev) => [...prev, m]);
    });
    const offKeys = client.events.on('keys', load);           // 'pending' messages become readable
    client.messages.markRead(conversationId);
    return () => { alive = false; offMessage(); offKeys(); };
  }, [client, conversationId]);

  return (
    <div>
      {messages.map((m) => (
        <p key={m.id}>{m.state === 'ok' || m.state === 'plain' ? m.text : m.state === 'pending' ? 'Waiting for key…' : "Can't decrypt"}</p>
      ))}
      <form onSubmit={(e) => { e.preventDefault(); client.messages.send(conversationId, draft).then(() => setDraft('')); }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button disabled={!draft.trim()}>Send</button>
      </form>
    </div>
  );
}
```

## Vue 3 (pattern)

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { ChatMessage, SpreeWeClient } from '@spreewe/chat-sdk';

const props = defineProps<{ client: SpreeWeClient; conversationId: string }>();
const messages = ref<ChatMessage[]>([]);
const draft = ref('');
const offs: (() => void)[] = [];

async function load() { messages.value = await props.client.messages.history(props.conversationId); }

onMounted(() => {
  load();
  offs.push(
    props.client.events.on('message', (m) => { if (m.conversationId === props.conversationId) messages.value.push(m); }),
    props.client.events.on('keys', load),
  );
});
onUnmounted(() => offs.forEach((off) => off()));

async function send() { await props.client.messages.send(props.conversationId, draft.value); draft.value = ''; }
</script>

<template>
  <p v-for="m in messages" :key="m.id">{{ m.state === 'ok' || m.state === 'plain' ? m.text : 'Encrypted message' }}</p>
  <form @submit.prevent="send"><input v-model="draft" /><button :disabled="!draft.trim()">Send</button></form>
</template>
```

## Calls without Angular

`client.calls.join()` returns a `CallMedia` handle with a local `MediaStream` and remote streams per user. Attach them to `<video>` elements yourself:

```ts
const call = await client.calls.start(conversationId, 'video');          // you ring the others
const media = await client.calls.join(call.callId, 'video', {
  onRemoteStream: (userId, stream) => { videoFor(userId).srcObject = stream; },
  onRemoteLeft: (userId) => removeVideo(userId),
  onLobby: () => showWaitingForHost(),
});
localVideo.srcObject = media.localStream;
media.setMicEnabled(false);                                               // mute
// leave: release media locally, then tell the server
media.close();
client.calls.leave(call.callId);
```

Call media is **implemented but not tested in a real browser**. See [Audio and video calling](./calling.md).

## What you build yourself
Without the Angular components, your UI handles:
- **Message states:** `ok`, `pending` (re-read history on the `keys` event), `failed` and `plain`.
- **Attachments:** call `attachment.download()` to get a decrypted `Blob`, then `URL.createObjectURL`. Revoke the URL when you're done.
- **Typing:** call `chat.typing(id, true/false)` from your input, and show the `typing` events you receive.
- **Calls:** the incoming-call UI, and `<video>` elements for the streams.

The Angular components' source (`packages/chat-angular/src/lib`) is a working reference for all of these.
