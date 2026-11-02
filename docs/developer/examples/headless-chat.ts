/**
 * Headless SpreeWe integration (no UI framework). Type-checked against @spreewe/chat-sdk by
 * `npx tsc -p docs/developer/examples` (see tsconfig.json next to this file).
 *
 * Runs in a browser bundle (Vite / esbuild / Angular CLI / webpack with fullySpecified: false).
 * `getToken` must return the signed-in user's SpreeWe (Clerk) session token: never an app secret.
 */
import { SpreeWeClient, SpreeWeError, ChatMessage, CallInfo } from '@spreewe/chat-sdk';

export async function startSpreeWe(getToken: () => Promise<string | null>, log: (line: string) => void) {
  const client = new SpreeWeClient({
    apiUrl: 'https://spreewe.example.com/api',   // SpreeWe REST (direct, or your same-origin proxy)
    socketUrl: 'https://spreewe.example.com',    // Socket.IO
    getToken,
    wasmUrl: new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI),
    deviceLabel: 'My App',
  });

  // 1. Connect: loads the user, opens (or creates) this browser's encryption device, connects realtime
  const me = await client.connect();
  log(`signed in as ${me.name || me.username || me._id}, device ${client.deviceId}`);

  // 2. Listen before acting. Every `on` returns an unsubscribe function.
  const offs = [
    client.events.on('message', (m: ChatMessage) => {
      if (m.state === 'ok') log(`[${m.conversationId}] ${m.senderId}: ${m.text}`);
      else if (m.state === 'pending') log('a message is waiting for its key; re-read history on the "keys" event');
    }),
    client.events.on('keys', () => log('new room keys arrived')),
    client.events.on('typing', (t) => log(`${t.userId} ${t.isTyping ? 'is typing' : 'stopped typing'}`)),
    client.events.on('call.incoming', (c: CallInfo) => log(`incoming ${c.callType} call ${c.callId}`)),
    client.events.on('message.rejected', (r) => log(`rejected: ${r.reason} ${r.message || ''}`)),
    client.events.on('error', (e: SpreeWeError) => log(`error ${e.code}: ${e.message}`)),
  ];

  // 3. Direct conversations of the active workspace (one appears once it has a message).
  //    Known defect: group conversations are not returned by list(); keep createGroup()'s result.
  const conversations = await client.conversations.list();
  log(`${conversations.length} conversations`);

  // 4. Open a direct conversation with someone from the directory and send an encrypted message
  const people = await client.users.directory();
  const other = people.find((u) => u._id !== me._id);
  if (other) {
    const conversationId = await client.conversations.openDirect(other._id);
    await client.messages.send(conversationId, 'Hello from the headless SDK');

    // 5. History, decrypted on this device (oldest first)
    const history = await client.messages.history(conversationId, { limit: 20 });
    history.filter((m) => m.state === 'ok').forEach((m) => log(`history: ${m.text}`));

    // 6. Reactions, typing, read receipt
    const last = history[history.length - 1];
    if (last) client.messages.react(conversationId, last.id, '👍');
    client.chat.typing(conversationId, true);
    client.chat.typing(conversationId, false);
    client.messages.markRead(conversationId);
  }

  return {
    client,
    stop: () => {
      offs.forEach((off) => off());
      client.disconnect();
    },
  };
}
