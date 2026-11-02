import { deviceFor, forgetDevice, saveAck } from './key-vault';
import type * as SdkTypes from '@matrix-org/matrix-sdk-crypto-wasm';

/**
 * Framework-free port of webrtc-FE/src/app/core/crypto/e2ee.service.ts (the source of truth).
 * Same Olm/Megolm flow and server API; HttpClient → fetch, NgZone/rxjs removed. Attachments and
 * device verification UI are not ported (prototype scope).
 *
 * Private keys never leave this device: the library's IndexedDB store is encrypted with a passphrase
 * from key-vault.ts. The server only receives public keys and ciphertext.
 */
export const E2EE_SERVER = 'spreewe.local';
export const matrixUser = (id: string) => `@${id}:${E2EE_SERVER}`;
export const matrixRoom = (conversationId: string) => `!${conversationId}:${E2EE_SERVER}`;

/** What travels inside the ciphertext (same shape as the web app's SecureContent). */
export interface SecureContent {
  text?: string;
  file?: { storageKey: string; key: string; iv: string; sha256: string; mimeType: string; name: string; size: number };
  forwardedFrom?: string;
}

export interface EncryptedPayload {
  algorithm: 'm.megolm.v1.aes-sha2';
  ciphertext: string;
  session_id: string;
  sender_key: string;
  device_id: string;
}

export type DecryptState = 'ok' | 'pending' | 'failed';
export interface Decrypted {
  state: DecryptState;
  content?: SecureContent;
  warning?: string;
}

export interface E2eeOptions {
  apiUrl: string;
  getToken: () => Promise<string | null>;
  /** URL of matrix_sdk_crypto_wasm_bg.wasm, served by the host app */
  wasmUrl: string | URL;
  deviceLabel?: string;
  /** New room keys arrived: messages that were 'pending' can be retried */
  onKeysChanged?: () => void;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class E2ee {
  private sdk: typeof SdkTypes | null = null;
  private machine: SdkTypes.OlmMachine | null = null;
  private userId = '';
  private deviceId = '';
  private storeName = '';
  private ack: string | null = null;
  private since = 0;
  private starting: Promise<void> | null = null;
  private requestLock: Promise<void> = Promise.resolve();
  private roomLocks = new Map<string, Promise<unknown>>();
  private sharedWith = new Map<string, Set<string>>();
  private cache = new Map<string, Decrypted>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;
  private ready = false;

  constructor(private opts: E2eeOptions) {}

  get myDeviceId(): string {
    return this.deviceId;
  }

  start(userId: string): Promise<void> {
    if (this.starting && this.userId === userId) return this.starting;
    this.userId = userId;
    this.starting = this.boot().catch((e) => {
      this.starting = null;
      throw e;
    });
    return this.starting;
  }

  private async boot(): Promise<void> {
    if (!('indexedDB' in globalThis) || !crypto?.subtle || typeof WebAssembly === 'undefined') {
      throw new Error("This browser can't keep encryption keys (IndexedDB, WebCrypto or WebAssembly is unavailable).");
    }
    const sdk = await import('@matrix-org/matrix-sdk-crypto-wasm');
    await sdk.initAsync(this.opts.wasmUrl);
    this.sdk = sdk;
    this.storeName = `spreewe-sdk-e2ee-${this.userId}`;
    await this.openDevice();
    this.ready = true;
    await this.sync();
    if (!this.syncTimer) this.syncTimer = setInterval(() => void this.sync(), 60_000);
  }

  private async openDevice(): Promise<void> {
    const sdk = this.sdk!;
    const local = await deviceFor(this.userId);
    this.deviceId = local.deviceId;
    this.ack = local.record.ack;
    try {
      await this.api('post', '/devices', { displayName: this.opts.deviceLabel || 'SpreeWe SDK' });
    } catch (e: any) {
      if (e?.status !== 403) throw e;
      // Device removed from the account: start over with a new device and identity
      await forgetDevice(this.userId, this.storeName);
      return this.openDevice();
    }
    this.machine?.close();
    this.machine = await sdk.OlmMachine.initialize(new sdk.UserId(matrixUser(this.userId)), new sdk.DeviceId(this.deviceId), this.storeName, local.passphrase);
    await this.processRequests();
  }

  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.machine?.close();
    this.machine = null;
    this.starting = null;
    this.ready = false;
    this.cache.clear();
    this.sharedWith.clear();
  }

  // ------------------------------------------------------------------ server I/O

  private async api<T = any>(method: 'get' | 'post', path: string, body?: unknown): Promise<T> {
    const token = await this.opts.getToken();
    const res = await fetch(`${this.opts.apiUrl}/v1/e2ee${path}`, {
      method: method.toUpperCase(),
      headers: {
        'X-SpreeWe-Device': this.deviceId,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(method === 'post' ? { 'Content-Type': 'application/json' } : {}),
      },
      body: method === 'post' ? JSON.stringify(body ?? {}) : undefined,
    });
    if (!res.ok) throw new HttpError(res.status, `E2EE request failed (${res.status})`);
    return (await res.json()).data;
  }

  private processRequests(): Promise<void> {
    const run = async () => {
      const sdk = this.sdk!;
      for (let round = 0; round < 10 && this.machine; round++) {
        const requests = await this.machine.outgoingRequests();
        if (!requests.length) return;
        for (const r of requests as any[]) await this.answer(r, sdk);
      }
    };
    const next = this.requestLock.then(run, run);
    this.requestLock = next.catch(() => undefined);
    return next;
  }

  private async answer(r: any, sdk: typeof SdkTypes): Promise<void> {
    let response: unknown = {};
    switch (r.type) {
      case sdk.RequestType.KeysUpload: response = await this.api('post', '/keys/upload', JSON.parse(r.body)); break;
      case sdk.RequestType.KeysQuery: response = await this.api('post', '/keys/query', JSON.parse(r.body)); break;
      case sdk.RequestType.KeysClaim: response = await this.api('post', '/keys/claim', JSON.parse(r.body)); break;
      case sdk.RequestType.ToDevice: response = await this.api('post', `/sendToDevice/${encodeURIComponent(r.event_type)}/${encodeURIComponent(r.txn_id)}`, JSON.parse(r.body)); break;
      default: response = {};
    }
    if (!this.machine) return; // stopped meanwhile
    await this.machine.markRequestAsSent(r.id, r.type, JSON.stringify(response));
  }

  sync(): Promise<void> {
    if (!this.machine) return Promise.resolve();
    if (this.syncing) {
      this.syncAgain = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.syncAgain = false;
        for (let page = 0; page < 20; page++) {
          const q = new URLSearchParams();
          if (this.ack) q.set('ack', this.ack);
          if (this.since) q.set('since', String(this.since));
          const res = await this.api<any>('get', `/sync?${q}`);
          // Stopped (disconnect / sign-out) while the request was in flight
          const machine = this.machine;
          if (!machine) return;
          const sdk = this.sdk!;
          const changed = (res.device_lists?.changed || []).map((u: string) => new sdk.UserId(u));
          await machine.receiveSyncChanges(
            JSON.stringify(res.events.map((e: any) => ({ sender: e.sender, type: e.type, content: e.content }))),
            new sdk.DeviceLists(changed, []),
            new Map(Object.entries(res.one_time_key_counts || {})),
            new Set(res.unused_fallback_keys || []),
          );
          this.since = res.now;
          if (res.next && res.next !== this.ack) {
            this.ack = res.next;
            await saveAck(this.userId, this.ack);
          }
          await this.processRequests();
          if (res.events.length) this.retryPending();
          if (res.events.length < 100) break;
        }
      } while (this.syncAgain);
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  // ------------------------------------------------------------------ encrypt

  async encrypt(conversationId: string, content: SecureContent): Promise<EncryptedPayload> {
    await this.requireReady();
    return this.inRoom(conversationId, async () => {
      const sdk = this.sdk!;
      const machine = this.machine!;
      const room = () => new sdk.RoomId(matrixRoom(conversationId));
      // Who may read is the server's membership, never a client-side list
      const { members } = await this.api<{ members: string[] }>('get', `/rooms/${conversationId}/members`);
      const now = new Set(members);
      const before = this.sharedWith.get(conversationId);
      if (before && [...before].some((m) => !now.has(m))) await machine.invalidateGroupSession(room());
      const users = () => members.map((m) => new sdk.UserId(m));
      await machine.updateTrackedUsers(users());
      await this.processRequests();
      await this.answer(machine.queryKeysForUsers(users()), sdk);
      const claim = await machine.getMissingSessions(users());
      if (claim) await this.answer(claim, sdk);
      const shares = await machine.shareRoomKey(room(), users(), new sdk.EncryptionSettings());
      for (const s of shares) await this.answer(s, sdk);
      this.sharedWith.set(conversationId, now);
      const encrypted = JSON.parse(await machine.encryptRoomEvent(room(), 'm.room.message', JSON.stringify({ msgtype: 'spreewe.v1', ...content })));
      return {
        algorithm: 'm.megolm.v1.aes-sha2',
        ciphertext: encrypted.ciphertext,
        session_id: encrypted.session_id,
        sender_key: encrypted.sender_key,
        device_id: encrypted.device_id,
      } as EncryptedPayload;
    });
  }

  private inRoom<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.roomLocks.get(conversationId) || Promise.resolve();
    const next = prev.then(run, run);
    this.roomLocks.set(conversationId, next.catch(() => undefined));
    return next;
  }

  private async requireReady(): Promise<void> {
    if (this.starting) await this.starting;
    if (!this.ready || !this.machine) throw new Error('Encryption is not ready.');
  }

  // ------------------------------------------------------------------ decrypt

  async decrypt(message: { _id: string; conversationId: string; e2ee?: EncryptedPayload; userId?: string; user?: { _id: string }; createdAt?: string }): Promise<Decrypted> {
    if (!message.e2ee) return { state: 'ok' };
    const cacheKey = `${message._id}:${message.e2ee.session_id}:${message.e2ee.ciphertext.length}:${message.e2ee.ciphertext.slice(-16)}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.state !== 'pending') return hit;
    try {
      await this.requireReady();
      const sdk = this.sdk!;
      const sender = String(message.user?._id || message.userId || '');
      const event = {
        type: 'm.room.encrypted',
        event_id: `$${message._id}`,
        sender: matrixUser(sender),
        origin_server_ts: message.createdAt ? new Date(message.createdAt).getTime() : Date.now(),
        content: message.e2ee,
      };
      const result: any = await this.machine!.decryptRoomEvent(JSON.stringify(event), new sdk.RoomId(matrixRoom(String(message.conversationId))), new sdk.DecryptionSettings(sdk.TrustRequirement.Untrusted));
      const content = JSON.parse(result.event).content || {};
      // The sending device key must belong to the user the server says sent it (or a relay could re-attribute)
      if (!(await this.deviceKeyBelongsTo(sender, result.senderCurve25519Key))) {
        const out: Decrypted = { state: 'failed', warning: "This message's sender couldn't be confirmed, so it isn't shown." };
        this.cache.set(cacheKey, out);
        return out;
      }
      const shield = result.shieldState(false);
      const warning = shield.color === sdk.ShieldColor.Red ? (shield.message || 'Sent from an unverified device') : undefined;
      const out: Decrypted = { state: 'ok', content: { text: content.text, file: content.file, forwardedFrom: content.forwardedFrom }, warning };
      this.cache.set(cacheKey, out);
      return out;
    } catch (e: any) {
      const missingKey = e?.code === this.sdk?.DecryptionErrorCode.MissingRoomKey || e?.code === this.sdk?.DecryptionErrorCode.UnknownMessageIndex;
      const out: Decrypted = { state: missingKey ? 'pending' : 'failed' };
      this.cache.set(cacheKey, out);
      return out;
    }
  }

  private async deviceKeyBelongsTo(userId: string, curve25519: string): Promise<boolean> {
    const sdk = this.sdk!;
    const has = async () => (await this.machine!.getUserDevices(new sdk.UserId(matrixUser(userId)))).devices().some((d) => d.curve25519Key?.toBase64() === curve25519);
    if (await has()) return true;
    await this.machine!.updateTrackedUsers([new sdk.UserId(matrixUser(userId))]);
    await this.processRequests();
    return has();
  }

  // ------------------------------------------------------------------ devices

  /** The user's encryption devices (public fingerprints only); `current` marks this one. */
  async devices(): Promise<{ deviceId: string; displayName: string; ed25519: string | null; revoked: boolean; current: boolean }[]> {
    const list = await this.api<any[]>('get', '/devices');
    return list.map((d) => ({ ...d, current: d.deviceId === this.deviceId }));
  }

  /** Revoke a device (server-side; peers are told). Revoking this one also wipes its local keys. */
  async revokeDevice(deviceId: string): Promise<void> {
    await this.api('post', `/devices/${encodeURIComponent(deviceId)}/revoke`);
    if (deviceId === this.deviceId) {
      await forgetDevice(this.userId, this.storeName);
      this.stop();
    }
  }

  private retryPending(): void {
    for (const [k, v] of this.cache) if (v.state === 'pending') this.cache.delete(k);
    this.opts.onKeysChanged?.();
  }
}
