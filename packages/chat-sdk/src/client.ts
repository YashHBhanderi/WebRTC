import { io, Socket } from 'socket.io-client';
import { E2ee, EncryptedPayload, HttpError, SecureContent } from './e2ee.js';
import { decryptFile, encryptFile } from './attachment-crypto.js';
import { CallMedia, CallMediaOptions } from './calls-media.js';

/**
 * SpreeWe client SDK (prototype), user-session mode.
 *
 * Runs in the end user's browser with the user's own SpreeWe (Clerk) session token from `getToken`.
 * The SDK is its own E2EE device; private keys stay on this device and no plaintext message content is
 * ever sent to the server. No developer-app secret is used or accepted here (server-to-server app
 * integrations use /api/v1 with app credentials, on the developer's server).
 *
 * Workspace (personal vs organization) is the Clerk session's active organization; the server resolves
 * and enforces it. The SDK never sends an organization id.
 */
export interface SpreeWeClientOptions {
  /** Backend base URL for REST and /v1 (e.g. https://api.example.com, or `${origin}/api` behind a proxy) */
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

// ------------------------------------------------------------------ public types

export interface ChatUser {
  _id: string;
  name?: string;
  username?: string;
  email?: string;
  avatar?: string;
  status?: string;
}

/** Same values as the server (presence.service USER_STATUSES) */
export type PresenceStatus = 'Available' | 'Busy' | 'Do not disturb' | 'Away' | 'Appear offline';

export interface Conversation {
  id: string;
  isGroup: boolean;
  name: string;
  members: ChatUser[];
  raw: any;
}

export interface Attachment {
  name: string;
  mimeType: string;
  size: number;
  /** Download + decrypt on this device */
  download: () => Promise<Blob>;
}

export interface Reaction {
  emoji: string;
  userId: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  /** text | image | video | audio | pdf | file | system / call notices */
  type: string;
  /** Decrypted text (when state is 'ok'), or the notice text (state 'plain') */
  text: string;
  /** ok | pending (key not arrived yet) | failed | plain (system / call notice, not encrypted) */
  state: 'ok' | 'pending' | 'failed' | 'plain';
  warning?: string;
  attachment?: Attachment;
  replyToId?: string;
  reactions: Reaction[];
  edited: boolean;
  deleted: boolean;
  createdAt: string;
}

export interface Notification {
  _id: string;
  type: string;
  read: boolean;
  createdAt: string;
  [k: string]: unknown;
}

export interface CallInfo {
  callId: string;
  conversationId: string;
  callType: 'audio' | 'video';
  mode?: 'ring' | 'meetNow';
  initiatedBy?: string;
}

/** Events, by SDK name. Handlers get decrypted / normalized payloads. */
export interface SpreeWeEvents {
  message: ChatMessage;
  'message.updated': ChatMessage;
  'message.deleted': { conversationId: string; messageId: string };
  'message.rejected': { conversationId?: string; reason: string; message?: string };
  'reaction.updated': { conversationId: string; messageId: string; reactions: Reaction[] };
  'pins.updated': { conversationId: string; pins: unknown[] };
  typing: { conversationId: string; userId: string; isTyping: boolean };
  presence: { userId: string; status?: string; [k: string]: unknown };
  'receipts.updated': { conversationId: string; [k: string]: unknown };
  'messages.read': { conversationId: string; userId?: string; [k: string]: unknown };
  notification: Notification;
  'conversation.added': unknown;
  'conversation.removed': unknown;
  'conversation.updated': unknown;
  'call.incoming': CallInfo;
  'call.started': CallInfo;
  'call.participant-joined': { callId: string; userId: string };
  'call.participant-left': { callId: string; userId: string };
  'call.participant-rejected': { callId: string; userId: string };
  'call.ended': { callId: string; [k: string]: unknown };
  'call.lobby': unknown;
  'call.admitted': unknown;
  'call.denied': unknown;
  'call.removed': unknown;
  'call.force-muted': unknown;
  'call.media-updated': unknown;
  'call.error': { message: string };
  'recording.updated': unknown;
  keys: void;
  error: SpreeWeError;
}
export type SpreeWeEventName = keyof SpreeWeEvents;

export type SpreeWeErrorCode = 'NOT_SIGNED_IN' | 'HTTP' | 'REJECTED' | 'E2EE' | 'NOT_CONNECTED' | 'TIMEOUT' | 'UNSUPPORTED';

export class SpreeWeError extends Error {
  constructor(public code: SpreeWeErrorCode, message: string, public detail?: unknown) {
    super(message);
  }
}

/** Server event → SDK event, for events passed through as-is (messages are decrypted separately). */
const PASS_THROUGH: Record<string, SpreeWeEventName> = {
  'message:pins': 'pins.updated',
  messageReactionUpdated: 'reaction.updated',
  userTyping: 'typing',
  'user:presence': 'presence',
  'receipts:updated': 'receipts.updated',
  messagesMarkedRead: 'messages.read',
  'notification:new': 'notification',
  'group:added': 'conversation.added',
  'group:removed': 'conversation.removed',
  'group:updated': 'conversation.updated',
  'call:participant-joined': 'call.participant-joined',
  'call:participant-left': 'call.participant-left',
  'call:participant-rejected': 'call.participant-rejected',
  'call:ended': 'call.ended',
  'call:lobby': 'call.lobby',
  'call:admitted': 'call.admitted',
  'call:denied': 'call.denied',
  'call:removed': 'call.removed',
  'call:force-muted': 'call.force-muted',
  'call:media-updated': 'call.media-updated',
  'call:error': 'call.error',
  'recording:updated': 'recording.updated',
};

const mediaKind = (mime: string): 'image' | 'video' | 'audio' | 'pdf' | 'file' =>
  /^image\/(jpeg|png|gif|webp)$/.test(mime) ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime === 'application/pdf' ? 'pdf' : 'file';

/** Last activity of a conversation row (for ordering a merged list) */
const activity = (raw: any): number =>
  new Date(raw?.timestamp || raw?.lastMessage?.createdAt || raw?.updatedAt || raw?.createdAt || 0).getTime() || 0;

const callInfo = (p: any): CallInfo => ({
  callId: String(p?.callId ?? p?._id ?? ''),
  conversationId: String(p?.groupId ?? p?.conversationId ?? ''),
  callType: p?.callType === 'video' ? 'video' : 'audio',
  mode: p?.mode,
  initiatedBy: p?.initiatedBy ? String(p.initiatedBy) : undefined,
});

export class SpreeWeClient {
  private socket: Socket | null = null;
  private readonly e2ee: E2ee;
  private me_: ChatUser | null = null;
  private joined = new Set<string>();
  private seen = new Set<string>();
  private listeners = new Map<string, Set<(v: any) => void>>();

  constructor(private opts: SpreeWeClientOptions) {
    this.e2ee = new E2ee({
      apiUrl: opts.apiUrl,
      getToken: opts.getToken,
      wasmUrl: opts.wasmUrl,
      deviceLabel: opts.deviceLabel,
      onKeysChanged: () => this.emit('keys', undefined),
    });
  }

  // ================================================================== auth

  readonly auth = {
    /** Load the signed-in user, open (or create) this device's encryption identity, connect real-time. */
    connect: async (): Promise<ChatUser> => {
      const me = await this.rest<ChatUser>('GET', '/web/user/me');
      if (!me?._id) throw new SpreeWeError('NOT_SIGNED_IN', 'No signed-in SpreeWe user');
      this.me_ = me;
      try {
        await this.e2ee.start(String(me._id));
      } catch (e) {
        throw new SpreeWeError('E2EE', e instanceof Error ? e.message : 'Encryption could not start', e);
      }
      await this.openSocket();
      return me;
    },
    disconnect: (): void => {
      this.socket?.disconnect();
      this.socket = null;
      this.e2ee.stop();
      this.joined.clear();
    },
    /** The user's encryption devices (fingerprints only) */
    devices: () => this.e2ee.devices(),
    revokeDevice: (deviceId: string) => this.e2ee.revokeDevice(deviceId),
  };

  get me(): ChatUser | null {
    return this.me_;
  }

  get deviceId(): string {
    return this.e2ee.myDeviceId;
  }

  /** Shorthands */
  connect(): Promise<ChatUser> { return this.auth.connect(); }
  disconnect(): void { this.auth.disconnect(); }

  // ================================================================== users

  readonly users = {
    me: () => this.rest<ChatUser>('GET', '/web/user/me'),
    /** People you can contact in the active workspace */
    directory: async () => (await this.rest<ChatUser[]>('GET', '/web/users')) || [],
    get: (userId: string) => this.rest<ChatUser>('GET', `/web/user/${encodeURIComponent(userId)}`),
    updateProfile: (update: { name?: string; username?: string; bio?: string; [k: string]: unknown }) => this.rest<ChatUser>('PATCH', '/web/user/profile', update),
    setPresence: (status: PresenceStatus, statusMessage?: string) => this.ack('presence:set', { status, statusMessage }),
    setIdle: (idle: boolean) => this.socket?.emit('presence:idle', { idle }),
  };

  // ================================================================== conversations

  readonly conversations = {
    /**
     * Conversations of the signed-in user in the active workspace: direct chats that have a message
     * (GET /conversations) and groups (GET /groupConversations), newest activity first.
     */
    list: async (): Promise<Conversation[]> => {
      const [direct, groups] = await Promise.all([
        this.rest<any[]>('GET', '/conversations'),
        this.rest<any[]>('GET', '/groupConversations'),
      ]);
      const out = [
        ...(direct || []).map((c) => this.toConversation(c, false)),
        ...(groups || []).map((c) => this.toConversation(c, true)),
      ];
      const seen = new Set<string>();
      const unique = out.filter((c) => !seen.has(c.id) && !!seen.add(c.id));
      unique.sort((a, b) => activity(b.raw) - activity(a.raw));
      unique.forEach((c) => this.join(c.id));
      return unique;
    },
    /** Open (or create) a direct conversation; the server decides who you may contact */
    openDirect: async (userId: string): Promise<string> => {
      const res = await this.rest<any>('POST', '/conversations', { receiverId: userId }, true);
      const id = String(res?.conversationId ?? res?.data?._id ?? res?._id);
      this.join(id);
      return id;
    },
    createGroup: async (input: { name: string; memberIds: string[]; description?: string }): Promise<Conversation> => {
      const group = await this.rest<any>('POST', '/conversations/group', { groupName: input.name, groupDescription: input.description || '', groupMembers: JSON.stringify(input.memberIds) });
      const c = this.toConversation(group, true);
      this.join(c.id);
      return c;
    },
    info: async (conversationId: string) => this.toConversation(await this.rest<any>('GET', `/conversations/${encodeURIComponent(conversationId)}/group`), true),
    addMembers: (conversationId: string, userIds: string[]) => this.rest<any>('PUT', `/conversations/group/${encodeURIComponent(conversationId)}/add-member`, { userIds }),
    removeMember: (conversationId: string, userId: string) => this.rest<any>('PUT', `/conversations/group/${encodeURIComponent(conversationId)}/remove-member`, { userId }),
    delete: (conversationId: string) => this.rest<any>('DELETE', `/conversations/${encodeURIComponent(conversationId)}`),
    /** Join the real-time room (done automatically for listed / opened conversations) */
    join: (conversationId: string) => this.join(conversationId),
  };

  // ================================================================== messages

  readonly messages = {
    /** Encrypt on this device and send. Resolves once handed to the server; rejections arrive as 'message.rejected'. */
    send: async (conversationId: string, text: string, options: { replyTo?: string; mentions?: string[] } = {}): Promise<void> => {
      await this.sendSecure(conversationId, { text }, { type: 'text', replyTo: options.replyTo, mentions: options.mentions });
    },
    /** Messages, oldest first, decrypted on this device */
    history: async (conversationId: string, options: { limit?: number; page?: number } = {}): Promise<ChatMessage[]> => {
      const q = `?limit=${options.limit ?? 30}&page=${options.page ?? 1}`;
      const list = await this.rest<any[]>('GET', `/messages/${encodeURIComponent(conversationId)}${q}`);
      const out: ChatMessage[] = [];
      for (const m of list || []) {
        this.seen.add(String(m._id));
        out.push(await this.toMessage(m, conversationId));
      }
      return out;
    },
    /** Edit your own message (re-encrypted on this device) */
    edit: async (conversationId: string, messageId: string, text: string): Promise<void> => {
      const e2ee = await this.encrypt(conversationId, { text });
      await this.ack('message:edit', { messageId, e2ee });
    },
    delete: (messageId: string) => this.rest<any>('DELETE', `/messages/${encodeURIComponent(messageId)}`),
    /** Toggle a reaction */
    react: (conversationId: string, messageId: string, emoji: string) => this.socket?.emit('reactToMessage', { conversationId, messageId, emoji }),
    pin: (messageId: string, pinned = true) => this.ack('message:pin', { messageId, pinned }),
    markRead: (conversationId: string) => this.socket?.emit('markMessagesRead', conversationId),
    markDelivered: (conversationIds: string[]) => this.socket?.emit('message:delivered', { conversationIds }),
  };

  // ================================================================== chat (typing, notifications)

  readonly chat = {
    typing: (conversationId: string, isTyping: boolean) => this.socket?.emit(isTyping ? 'typing' : 'stopTyping', conversationId),
    notifications: {
      /** Newest first; pass `before` (nextCursor) for the next page */
      list: async (options: { before?: string; limit?: number } = {}): Promise<{ items: Notification[]; nextCursor: string | null }> => {
        const q = new URLSearchParams();
        if (options.before) q.set('before', options.before);
        if (options.limit) q.set('limit', String(options.limit));
        const d = await this.rest<any>('GET', `/notifications${q.toString() ? `?${q}` : ''}`);
        return { items: d?.items || [], nextCursor: d?.nextCursor ?? null };
      },
      unreadCount: async () => Number((await this.rest<any>('GET', '/notifications/unread-count'))?.unread ?? 0),
      markRead: (ids?: string[]) => this.rest<any>('POST', '/notifications/read', { ids }),
    },
  };

  // ================================================================== files

  readonly files = {
    /** Encrypt a file on this device, upload the ciphertext, send it as an encrypted message */
    sendAttachment: async (conversationId: string, file: Blob & { name?: string }, caption = ''): Promise<void> => {
      const kind = mediaKind(file.type || 'application/octet-stream');
      const { ciphertext, info } = await encryptFile(file);
      const form = new FormData();
      form.append('purpose', 'message');
      form.append('conversationId', conversationId);
      form.append('encrypted', '1');
      form.append('kind', kind);
      form.append('file', ciphertext, 'encrypted.bin');
      const uploaded = await this.rest<any>('POST', '/upload', form, true);
      if (!uploaded?.storageKey) throw new SpreeWeError('HTTP', 'Upload failed');
      await this.sendSecure(conversationId, { text: caption, file: { ...info, storageKey: uploaded.storageKey } }, { type: uploaded.type || kind, storageKey: uploaded.storageKey });
    },
    /** Shared media of a conversation (server metadata; contents stay encrypted) */
    shared: (conversationId: string) => this.rest<any>('GET', `/conversations/${encodeURIComponent(conversationId)}/media`),
  };

  // ================================================================== calls

  readonly calls = {
    /** Start (ring) or open a meeting in a conversation. Resolves with the call once the server created it. */
    start: (conversationId: string, callType: 'audio' | 'video', mode: 'ring' | 'meetNow' = 'ring'): Promise<CallInfo> =>
      new Promise((resolve, reject) => {
        const s = this.requireSocket();
        const done = (fn: () => void) => { clearTimeout(timer); s.off('call:started', ok); s.off('call:error', fail); fn(); };
        const ok = (p: any) => { if (String(p?.groupId) === conversationId) done(() => resolve(callInfo(p))); };
        const fail = (p: any) => done(() => reject(new SpreeWeError('REJECTED', p?.message || 'Call could not start', p)));
        const timer = setTimeout(() => done(() => reject(new SpreeWeError('TIMEOUT', 'Call start timed out'))), 10_000);
        s.on('call:started', ok);
        s.on('call:error', fail);
        s.emit('call:start', { groupId: conversationId, callType, mode });
      }),
    accept: (callId: string) => this.ack('call:accept', { callId }),
    reject: (callId: string) => this.socket?.emit('call:reject', { callId }),
    leave: (callId: string) => this.socket?.emit('call:leave', { callId }),
    end: (callId: string) => this.ack('call:end', { callId }),
    state: (callId: string) => this.ack('call:getState', { callId }),
    /** The running call of a conversation, if any */
    active: async (conversationId: string) => (await this.ack('call:getActive', { groupId: conversationId }))?.call ?? null,
    /** Call history of the active workspace */
    history: () => this.rest<any>('GET', '/calls'),
    controls: {
      muteParticipant: (callId: string, userId: string) => this.ack('call:mute-participant', { callId, userId }),
      removeParticipant: (callId: string, userId: string) => this.ack('call:remove-participant', { callId, userId }),
      admit: (callId: string, userId?: string) => this.ack('call:admit', userId ? { callId, userId } : { callId, all: true }),
      deny: (callId: string, userId: string) => this.ack('call:deny', { callId, userId }),
      setCohost: (callId: string, userId: string, cohost = true) => this.ack('call:set-cohost', { callId, userId, cohost }),
      startRecording: (callId: string) => this.ack('call:record-start', { callId }),
      stopRecording: (callId: string) => this.ack('call:record-stop', { callId }),
      /** Tell others your mic / camera state (UI indicators) */
      mediaState: (callId: string, audio: boolean, video: boolean) => this.socket?.emit('call:media-state', { callId, audio, video }),
    },
    /**
     * Browser only: join the call's media (mediasoup SFU) after accept / start. Returns a handle with the
     * local stream, remote streams and mute / camera controls. Requires WebRTC (not available in Node).
     */
    join: async (callId: string, callType: 'audio' | 'video', options: CallMediaOptions = {}): Promise<CallMedia> => {
      const media = new CallMedia(this.requireSocket(), String(this.me_?._id || ''), options);
      await media.join(callId, callType);
      return media;
    },
  };

  // ================================================================== recordings

  readonly recordings = {
    list: (conversationId: string) => this.rest<any[]>('GET', `/conversations/${encodeURIComponent(conversationId)}/recordings`),
    get: (recordingId: string) => this.rest<any>('GET', `/recordings/${encodeURIComponent(recordingId)}`),
    transcript: (recordingId: string) => this.rest<any>('GET', `/recordings/${encodeURIComponent(recordingId)}/transcript`),
  };

  // ================================================================== organizations

  readonly organizations = {
    /** Organizations the user belongs to (switching workspace is done with Clerk's setActive in the host app) */
    mine: () => this.v1<any>('GET', '/organizations/mine'),
    /** Members of the active workspace's organization */
    members: () => this.v1<any>('GET', '/workspace/organization/members'),
  };

  // ================================================================== events

  readonly events = {
    on: <K extends SpreeWeEventName>(event: K, handler: (payload: SpreeWeEvents[K]) => void): (() => void) => {
      const set = this.listeners.get(event) || new Set();
      set.add(handler);
      this.listeners.set(event, set);
      return () => set.delete(handler);
    },
  };

  // ------------------------------------------------------------------ internals

  private emit<K extends SpreeWeEventName>(event: K, payload: SpreeWeEvents[K]): void {
    this.listeners.get(event)?.forEach((l) => {
      try { l(payload); } catch { /* a listener's error must not break the SDK */ }
    });
  }

  private requireSocket(): Socket {
    if (!this.socket?.connected) throw new SpreeWeError('NOT_CONNECTED', 'Not connected; call connect() first');
    return this.socket;
  }

  private ack<T = any>(event: string, data: unknown, ms = 10_000): Promise<T> {
    const s = this.requireSocket();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SpreeWeError('TIMEOUT', `${event} timed out`)), ms);
      s.emit(event, data, (r: any) => {
        clearTimeout(timer);
        if (r?.error) reject(new SpreeWeError('REJECTED', String(r.error), r));
        else resolve(r);
      });
    });
  }

  private encrypt(conversationId: string, content: SecureContent): Promise<EncryptedPayload> {
    return this.e2ee.encrypt(conversationId, content).catch((e) => {
      throw new SpreeWeError('E2EE', 'Could not encrypt, so nothing was sent', e);
    });
  }

  private async sendSecure(conversationId: string, content: SecureContent, extra: { type: string; replyTo?: string; mentions?: string[]; storageKey?: string }): Promise<void> {
    const s = this.requireSocket();
    const e2ee = await this.encrypt(conversationId, content);
    s.emit('sendMessage', {
      user: { _id: this.me_!._id },
      conversationId,
      content: '',
      type: extra.type,
      replyTo: extra.replyTo || null,
      mentions: extra.mentions?.length ? extra.mentions : undefined,
      storageKey: extra.storageKey,
      e2ee,
    });
  }

  private openSocket(): Promise<void> {
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
      if (!id || this.seen.has(id)) return; // delivered to the room and to the user: once per message
      this.seen.add(id);
      // A conversation we weren't in the room of (e.g. someone else's first message): join for typing etc.
      this.join(String(m.conversationId || ''));
      this.emit('message', await this.toMessage(m, String(m.conversationId)));
    });
    // Edit: { conversationId, messageId, userId, e2ee, editedAt } → re-decrypted here
    socket.on('message:updated', async (p: any) => {
      if (!p?.messageId) return;
      const message = { _id: p.messageId, conversationId: p.conversationId, userId: p.userId, e2ee: p.e2ee, editedAt: p.editedAt };
      this.emit('message.updated', await this.toMessage(message, String(p.conversationId)));
    });
    socket.on('message:deleted', (p: any) => this.emit('message.deleted', { conversationId: String(p?.conversationId), messageId: String(p?.messageId) }));
    socket.on('message:rejected', (r: any) => {
      this.emit('message.rejected', { conversationId: r?.conversationId, reason: String(r?.reason || 'unknown'), message: r?.message });
      this.emit('error', new SpreeWeError('REJECTED', r?.message || `Message rejected (${r?.reason || 'unknown'})`, r));
    });
    socket.on('call:incoming', (p: any) => this.emit('call.incoming', callInfo(p)));
    socket.on('call:meeting-active', (p: any) => this.emit('call.started', callInfo(p)));
    for (const [server, name] of Object.entries(PASS_THROUGH)) socket.on(server, (p: any) => this.emit(name, p));
    this.socket = socket;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SpreeWeError('TIMEOUT', 'Real-time connection timed out')), 15_000);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.on('connect_error', (e: Error) => {
        this.emit('error', new SpreeWeError('NOT_CONNECTED', e.message));
        if (!socket.active) { clearTimeout(timer); reject(new SpreeWeError('NOT_CONNECTED', e.message)); }
      });
    });
  }

  private join(conversationId: string): void {
    if (!conversationId || this.joined.has(conversationId)) return;
    this.joined.add(conversationId);
    this.socket?.emit('joinConversation', conversationId);
  }

  private async toMessage(m: any, conversationId: string): Promise<ChatMessage> {
    const senderId = String(m.user?._id || m.userId?._id || m.userId || '');
    const reactions: Reaction[] = (m.reactions || []).map((r: any) => ({ emoji: String(r.emoji), userId: String(r.userId?._id || r.userId) }));
    const base = {
      id: String(m._id),
      conversationId: String(m.conversationId || conversationId),
      senderId,
      type: String(m.type || 'text'),
      replyToId: m.replyTo ? String(m.replyTo._id || m.replyTo) : undefined,
      reactions,
      edited: !!(m.editedAt || m.isEdited),
      deleted: !!m.isDeleted,
      createdAt: String(m.createdAt || ''),
    };
    if (!m.e2ee) return { ...base, text: String(m.content || ''), state: 'plain' };
    const d = await this.e2ee.decrypt({ _id: base.id, conversationId: base.conversationId, e2ee: m.e2ee, userId: senderId, createdAt: m.createdAt });
    const file = d.state === 'ok' ? d.content?.file : undefined;
    const fileUrl: string | undefined = m.fileUrl || m.downloadUrl;
    return {
      ...base,
      text: d.state === 'ok' ? d.content?.text || '' : '',
      state: d.state,
      warning: d.warning,
      attachment: file ? {
        name: file.name,
        mimeType: file.mimeType,
        size: file.size,
        download: async () => {
          if (!fileUrl) throw new SpreeWeError('HTTP', 'No download link for this attachment');
          const res = await fetch(fileUrl);
          if (!res.ok) throw new SpreeWeError('HTTP', `Download failed (${res.status})`);
          return decryptFile(await res.arrayBuffer(), file);
        },
      } : undefined,
    };
  }

  /**
   * Server rows differ by route: direct chats (GET /conversations) carry `sender` (me) and `receiver`
   * (the other person) instead of `members`; group rows carry `members` and `groupName` but not
   * always `isGroup`. `isGroup` is passed when the route already tells.
   */
  private toConversation(c: any, isGroup?: boolean): Conversation {
    const group = isGroup ?? !!c?.isGroup;
    const toUser = (u: any): ChatUser => (typeof u === 'object' && u ? { ...u, _id: String(u._id) } : { _id: String(u) });
    let members: ChatUser[] = (c?.members || []).map(toUser);
    if (!members.length && !group) members = [c?.sender, c?.receiver].filter(Boolean).map(toUser);
    const others = members.filter((u) => u._id !== String(this.me_?._id));
    const name = group
      ? c?.groupName || c?.name || 'Group'
      : others.map((u) => u.name || u.username || u.email || 'User').join(', ') || 'Conversation';
    return { id: String(c?._id), isGroup: group, name, members, raw: c };
  }

  private v1<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return this.rest<T>(method, `/v1${path}`, body);
  }

  private async rest<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, rawBody = false): Promise<T> {
    const token = await this.opts.getToken();
    if (!token) throw new SpreeWeError('NOT_SIGNED_IN', 'No session token');
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const res = await fetch(`${this.opts.apiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? (isForm ? (body as FormData) : JSON.stringify(body)) : undefined,
    });
    if (!res.ok) {
      let message = `${method} ${path} failed (${res.status})`;
      try { const j = await res.json(); if (j?.message || j?.error) message = String(j.message || j.error?.message || j.error); } catch { /* not JSON */ }
      throw new SpreeWeError('HTTP', message, new HttpError(res.status, res.statusText));
    }
    const json = await res.json();
    return (rawBody ? json : json?.data) as T;
  }
}
