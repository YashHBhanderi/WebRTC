import { io, Socket } from 'socket.io-client';
import { E2ee, EncryptedPayload, HttpError } from './e2ee';

/**
 * SpreeWe chat client (prototype), user-session mode.
 *
 * Runs in the end user's browser with the user's own SpreeWe (Clerk) session token, supplied by the
 * host app through `getToken`. The SDK registers its OWN encryption device for that user; private keys
 * stay on this device. No developer-app secret is used or accepted here.
 *
 * Workspace (personal vs organization) is the active organization of the Clerk session: the server
 * resolves and enforces it, the SDK never sends an organization id.
 */
export interface SpreeWeClientOptions {
  /** Backend base URL, e.g. https://api.example.com (REST + /v1/e2ee) */
  apiUrl: string;
  /** Socket.IO URL; defaults to apiUrl */
  socketUrl?: string;
  socketPath?: string;
  /** Fresh Clerk session token for the signed-in user (called before every request / reconnect) */
  getToken: () => Promise<string | null>;
  /** Where the host app serves matrix_sdk_crypto_wasm_bg.wasm */
  wasmUrl: string | URL;
  /** Shown in the user's device list */
  deviceLabel?: string;
}

export interface ChatUser {
  _id: string;
  name?: string;
  username?: string;
  email?: string;
}

export interface Conversation {
  id: string;
  isGroup: boolean;
  name: string;
  members: ChatUser[];
  raw: any;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  /** Decrypted text (only when state is 'ok') */
  text: string;
  /** ok | pending (key not arrived yet) | failed | plain (system / call notice, not encrypted) */
  state: 'ok' | 'pending' | 'failed' | 'plain';
  warning?: string;
  createdAt: string;
}

export type SpreeWeErrorCode = 'NOT_SIGNED_IN' | 'HTTP' | 'REJECTED' | 'E2EE' | 'NOT_CONNECTED';

export class SpreeWeError extends Error {
  constructor(public code: SpreeWeErrorCode, message: string, public detail?: unknown) {
    super(message);
  }
}

type Listener<T> = (value: T) => void;

export class SpreeWeClient {
  me: ChatUser | null = null;
  private socket: Socket | null = null;
  private readonly e2ee: E2ee;
  private joined = new Set<string>();
  private seen = new Set<string>();
  private messageListeners = new Set<Listener<ChatMessage>>();
  private errorListeners = new Set<Listener<SpreeWeError>>();
  private keyListeners = new Set<Listener<void>>();

  constructor(private opts: SpreeWeClientOptions) {
    this.e2ee = new E2ee({
      apiUrl: opts.apiUrl,
      getToken: opts.getToken,
      wasmUrl: opts.wasmUrl,
      deviceLabel: opts.deviceLabel,
      onKeysChanged: () => this.keyListeners.forEach((l) => l()),
    });
  }

  get deviceId(): string {
    return this.e2ee.myDeviceId;
  }

  /** Load the signed-in user, open (or create) this device's encryption identity, connect real-time. */
  async connect(): Promise<ChatUser> {
    const me = await this.rest<ChatUser>('GET', '/web/user/me');
    if (!me?._id) throw new SpreeWeError('NOT_SIGNED_IN', 'No signed-in SpreeWe user');
    this.me = me;
    try {
      await this.e2ee.start(String(me._id));
    } catch (e) {
      throw new SpreeWeError('E2EE', e instanceof Error ? e.message : 'Encryption could not start', e);
    }
    this.openSocket();
    return me;
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.e2ee.stop();
    this.joined.clear();
  }

  onMessage(listener: Listener<ChatMessage>): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: Listener<SpreeWeError>): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  /** New room keys arrived: re-run history() to resolve 'pending' messages. */
  onKeysChanged(listener: Listener<void>): () => void {
    this.keyListeners.add(listener);
    return () => this.keyListeners.delete(listener);
  }

  /** Conversations of the signed-in user in the session's active workspace. */
  async listConversations(): Promise<Conversation[]> {
    const list = await this.rest<any[]>('GET', '/conversations');
    const conversations = (list || []).map((c) => this.toConversation(c));
    conversations.forEach((c) => this.join(c.id));
    return conversations;
  }

  /** Open (or create) a direct conversation with another user (server checks who you may contact). */
  async openDirect(userId: string): Promise<string> {
    const res = await this.rest<any>('POST', '/conversations', { receiverId: userId }, true);
    const id = String(res?.conversationId ?? res?.data?._id ?? res?._id);
    this.join(id);
    return id;
  }

  /** People you can start a conversation with in the active workspace. */
  async directory(): Promise<ChatUser[]> {
    return (await this.rest<ChatUser[]>('GET', '/web/users')) || [];
  }

  /** Recent messages, oldest first, decrypted on this device. */
  async history(conversationId: string, limit = 30): Promise<ChatMessage[]> {
    const list = await this.rest<any[]>('GET', `/messages/${encodeURIComponent(conversationId)}?limit=${limit}`);
    const out: ChatMessage[] = [];
    for (const m of list || []) {
      this.seen.add(String(m._id));
      out.push(await this.toMessage(m, conversationId));
    }
    return out;
  }

  /** Encrypt on this device and send. Resolves once handed to the server; rejections arrive via onError. */
  async send(conversationId: string, text: string): Promise<void> {
    if (!this.socket?.connected || !this.me) throw new SpreeWeError('NOT_CONNECTED', 'Not connected');
    let e2ee: EncryptedPayload;
    try {
      e2ee = await this.e2ee.encrypt(conversationId, { text });
    } catch (e) {
      throw new SpreeWeError('E2EE', 'Message could not be encrypted, so it was not sent', e);
    }
    this.socket.emit('sendMessage', { user: { _id: this.me._id }, conversationId, content: '', type: 'text', e2ee });
  }

  // ------------------------------------------------------------------ internals

  private openSocket(): void {
    const socket = io(this.opts.socketUrl ?? this.opts.apiUrl, {
      path: this.opts.socketPath,
      transports: ['websocket', 'polling'],
      // Fresh token on every connect / reconnect (Clerk tokens live about a minute)
      auth: (cb) => void this.opts.getToken().then((token) => cb({ token: token || '', deviceId: `sdk-${this.e2ee.myDeviceId}` })),
    });
    socket.on('connect', () => {
      // Rejoin conversation rooms after a reconnect (the server re-checks membership per room)
      const rooms = [...this.joined];
      this.joined.clear();
      rooms.forEach((id) => this.join(id));
      void this.e2ee.sync();
    });
    // Room keys / device changes are waiting (same triggers as the SpreeWe web app's shell)
    for (const event of ['e2ee:to-device', 'e2ee:devices-changed']) socket.on(event, () => void this.e2ee.sync());
    socket.on('receiveMessage', async (m: any) => {
      const id = String(m?._id || '');
      // Delivered to the room and to the user: once per message
      if (!id || this.seen.has(id)) return;
      this.seen.add(id);
      const message = await this.toMessage(m, String(m.conversationId));
      this.messageListeners.forEach((l) => l(message));
    });
    socket.on('message:rejected', (r: any) => this.emitError(new SpreeWeError('REJECTED', r?.message || `Message rejected (${r?.reason || 'unknown'})`, r)));
    socket.on('connect_error', (e: Error) => this.emitError(new SpreeWeError('NOT_CONNECTED', e.message)));
    this.socket = socket;
  }

  private join(conversationId: string): void {
    if (this.joined.has(conversationId)) return;
    this.joined.add(conversationId);
    this.socket?.emit('joinConversation', conversationId);
  }

  private emitError(error: SpreeWeError): void {
    this.errorListeners.forEach((l) => l(error));
  }

  private async toMessage(m: any, conversationId: string): Promise<ChatMessage> {
    const senderId = String(m.user?._id || m.userId?._id || m.userId || '');
    const base = { id: String(m._id), conversationId: String(m.conversationId || conversationId), senderId, createdAt: String(m.createdAt || '') };
    if (!m.e2ee) return { ...base, text: String(m.content || ''), state: 'plain' };
    const d = await this.e2ee.decrypt({ _id: base.id, conversationId: base.conversationId, e2ee: m.e2ee, userId: senderId, createdAt: m.createdAt });
    return { ...base, text: d.state === 'ok' ? d.content?.text || '' : '', state: d.state, warning: d.warning };
  }

  private toConversation(c: any): Conversation {
    const members: ChatUser[] = (c.members || []).map((u: any) => (typeof u === 'object' ? u : { _id: String(u) }));
    const others = members.filter((u) => String(u._id) !== String(this.me?._id));
    const name = c.isGroup ? c.groupName || c.name || 'Group' : others.map((u) => u.name || u.username || u.email || 'User').join(', ') || 'Conversation';
    return { id: String(c._id), isGroup: !!c.isGroup, name, members, raw: c };
  }

  private async rest<T>(method: 'GET' | 'POST', path: string, body?: unknown, rawBody = false): Promise<T> {
    const token = await this.opts.getToken();
    if (!token) throw new SpreeWeError('NOT_SIGNED_IN', 'No session token');
    const res = await fetch(`${this.opts.apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new SpreeWeError('HTTP', `${method} ${path} failed (${res.status})`, new HttpError(res.status, res.statusText));
    const json = await res.json();
    return (rawBody ? json : json?.data) as T;
  }
}
