import { Injectable, Injector, NgZone } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { BehaviorSubject, Subject, firstValueFrom } from 'rxjs';
import { environment } from 'src/environments/environment';
import { deviceFor, forgetDevice, saveAck } from './key-vault';
import { decryptFile } from './attachment-crypto';
import type * as SdkTypes from '@matrix-org/matrix-sdk-crypto-wasm';

/**
 * End-to-end encryption for every message (Olm/Megolm via @matrix-org/matrix-sdk-crypto-wasm).
 *
 * - Private keys are created and kept on this device (the library's IndexedDB store, encrypted with
 *   a passphrase from key-vault.ts). The server only ever receives public keys and ciphertext.
 * - Each conversation is a Megolm "room": a sender session key is shared, over Olm (per device), with
 *   the devices of the conversation's CURRENT members, as reported by the server. When someone leaves,
 *   the session is replaced before the next message, so they can't read what follows.
 * - No plaintext fallback: if a message can't be encrypted it isn't sent.
 * See docs/security/end-to-end-encryption.md.
 */
export const E2EE_SERVER = 'spreewe.local';
export const matrixUser = (id: string) => `@${id}:${E2EE_SERVER}`;
export const matrixRoom = (conversationId: string) => `!${conversationId}:${E2EE_SERVER}`;

/** What travels inside the ciphertext (the server never sees any of it). */
export interface SecureContent {
  /** Message text or caption */
  text?: string;
  /** Encrypted attachment: where it is and how to decrypt it */
  file?: { storageKey: string; key: string; iv: string; sha256: string; mimeType: string; name: string; size: number };
  /** Forwarded from (name shown on the copy) */
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
  /** Sender device not verified / unknown: shown as a warning on the message */
  warning?: string;
}

export type E2eeStatus = 'idle' | 'starting' | 'ready' | 'unsupported' | 'error';

@Injectable({ providedIn: 'root' })
export class E2eeService {
  readonly status$ = new BehaviorSubject<E2eeStatus>('idle');
  /** New room keys may have arrived: views re-try messages that were 'pending' */
  readonly keysChanged$ = new Subject<void>();
  statusMessage = '';

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
  /** Who each room's current outbound session was shared with (to rotate when someone leaves) */
  private sharedWith = new Map<string, Set<string>>();
  private cache = new Map<string, Decrypted>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private syncAgain = false;

  constructor(private http: HttpClient, private zone: NgZone, private injector: Injector) {}

  get ready(): boolean {
    return this.status$.value === 'ready';
  }

  get myDeviceId(): string {
    return this.deviceId;
  }

  /** Start for the signed-in user (idempotent). Rejects only if this browser can't do E2EE. */
  start(userId: string): Promise<void> {
    if (this.starting && this.userId === userId) return this.starting;
    this.userId = userId;
    this.starting = this.zone.runOutsideAngular(() => this.boot()).catch((e) => {
      this.status$.next(this.status$.value === 'unsupported' ? 'unsupported' : 'error');
      this.statusMessage = this.statusMessage || (e instanceof Error ? e.message : 'Encryption could not start.');
      this.starting = null;
      throw e;
    });
    return this.starting;
  }

  private async boot(): Promise<void> {
    this.status$.next('starting');
    if (!('indexedDB' in window) || !crypto?.subtle || typeof WebAssembly === 'undefined') {
      this.status$.next('unsupported');
      this.statusMessage = "This browser can't keep encryption keys (IndexedDB, WebCrypto or WebAssembly is unavailable), so it can't send or read messages.";
      throw new Error(this.statusMessage);
    }
    const sdk = await import('@matrix-org/matrix-sdk-crypto-wasm');
    await sdk.initAsync(new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI));
    this.sdk = sdk;
    this.storeName = `spreewe-e2ee-${this.userId}`;
    await this.openDevice();
    this.status$.next('ready');
    await this.sync();
    if (!this.syncTimer) this.syncTimer = setInterval(() => void this.sync(), 60_000);
  }

  private async openDevice(): Promise<void> {
    const sdk = this.sdk!;
    const local = await deviceFor(this.userId);
    this.deviceId = local.deviceId;
    this.ack = local.record.ack;
    try {
      await this.api('post', '/devices', { displayName: browserName() });
    } catch (e: any) {
      if (e?.status !== 403) throw e;
      // This device was removed from the account (e.g. from another device): start over with a NEW
      // device and identity; contacts are told of the change. Old messages stay unreadable here.
      await forgetDevice(this.userId, this.storeName);
      return this.openDevice();
    }
    this.machine?.close();
    this.machine = await sdk.OlmMachine.initialize(new sdk.UserId(matrixUser(this.userId)), new sdk.DeviceId(this.deviceId), this.storeName, local.passphrase);
    await this.processRequests();
  }

  /** Stop and keep the keys (sign-out). */
  stop(): void {
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
    this.machine?.close();
    this.machine = null;
    this.starting = null;
    this.cache.clear();
    this.sharedWith.clear();
    this.status$.next('idle');
  }

  // ------------------------------------------------------------------ server I/O

  private headers(): HttpHeaders {
    return new HttpHeaders({ 'X-SpreeWe-Device': this.deviceId });
  }

  private async api<T = any>(method: 'get' | 'post', path: string, body?: unknown): Promise<T> {
    const url = `${environment.apiUrl}/v1/e2ee${path}`;
    const res = method === 'get'
      ? await firstValueFrom(this.http.get<{ data: T }>(url, { headers: this.headers() }))
      : await firstValueFrom(this.http.post<{ data: T }>(url, body ?? {}, { headers: this.headers() }));
    return res.data;
  }

  /** Send everything the library wants to send (key uploads, queries, claims, device messages), one at a time. */
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
      default: response = {}; // signature upload / key backup: not used (see docs)
    }
    await this.machine!.markRequestAsSent(r.id, r.type, JSON.stringify(response));
  }

  /** Fetch device messages (room keys, verification) and contacts' device changes; at-least-once. */
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
          const sdk = this.sdk!;
          const changed = (res.device_lists?.changed || []).map((u: string) => new sdk.UserId(u));
          await this.machine!.receiveSyncChanges(
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

  /** Encrypt content for the conversation's current members' devices. Throws instead of falling back. */
  async encrypt(conversationId: string, content: SecureContent): Promise<EncryptedPayload> {
    await this.requireReady();
    return this.inRoom(conversationId, async () => {
      const sdk = this.sdk!;
      const machine = this.machine!;
      // wasm-bindgen: several calls take ownership of identifier objects, so each call gets fresh ones
      const room = () => new sdk.RoomId(matrixRoom(conversationId));
      // Who may read is the server's membership, never a client-side list
      const { members } = await this.api<{ members: string[] }>('get', `/rooms/${conversationId}/members`);
      const now = new Set(members);
      const before = this.sharedWith.get(conversationId);
      // Someone left since the session was shared: rotate, so they can't read what follows
      if (before && [...before].some((m) => !now.has(m))) await machine.invalidateGroupSession(room());
      const users = () => members.map((m) => new sdk.UserId(m));
      await machine.updateTrackedUsers(users());
      await this.processRequests();
      // Fresh device lists before every share: a device added since (or while this page was closed) gets
      // the key for this message too. The cached lists alone miss it until the next device-change sync.
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

  /** Room operations run one at a time per conversation (key sharing must not interleave). */
  private inRoom<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
    const prev = this.roomLocks.get(conversationId) || Promise.resolve();
    const next = prev.then(run, run);
    this.roomLocks.set(conversationId, next.catch(() => undefined));
    return next;
  }

  private async requireReady(): Promise<void> {
    if (this.starting) await this.starting;
    if (!this.ready || !this.machine) throw new Error(this.statusMessage || 'Encryption is still starting. Try again in a moment.');
  }

  // ------------------------------------------------------------------ decrypt

  /**
   * Decrypt a stored / received message (by its server fields). Results are cached in memory only;
   * 'pending' = the key hasn't arrived yet (retried when keys arrive).
   */
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
      // Megolm binds a session to the sending DEVICE key, not to a user id: make sure that key belongs
      // to the person the server says sent the message, or a relay could re-attribute messages
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
      // The key may still arrive (it's sent separately): retried after the next device sync
      const missingKey = e?.code === this.sdk?.DecryptionErrorCode.MissingRoomKey || e?.code === this.sdk?.DecryptionErrorCode.UnknownMessageIndex;
      const out: Decrypted = { state: missingKey ? 'pending' : 'failed' };
      this.cache.set(cacheKey, out);
      return out;
    }
  }

  /** Is this Curve25519 device key one of the user's devices? (Refreshes their device list once if unknown.) */
  private async deviceKeyBelongsTo(userId: string, curve25519: string): Promise<boolean> {
    const sdk = this.sdk!;
    const has = async () => (await this.machine!.getUserDevices(new sdk.UserId(matrixUser(userId)))).devices().some((d) => d.curve25519Key?.toBase64() === curve25519);
    if (await has()) return true;
    await this.machine!.updateTrackedUsers([new sdk.UserId(matrixUser(userId))]);
    await this.processRequests();
    return has();
  }

  private retryPending(): void {
    for (const [k, v] of this.cache) if (v.state === 'pending') this.cache.delete(k);
    this.zone.run(() => this.keysChanged$.next());
  }

  /**
   * Fill a message's display fields from its ciphertext, in memory only: text, attachment (decrypted to a
   * local object URL; the ciphertext link is kept for forwarding), state and trust warning. Messages
   * without `e2ee` (from before encryption, calls, system) are left as they are.
   */
  async reveal<T extends Record<string, any>>(m: T, conversationId?: string): Promise<T> {
    const msg = m as any;
    // A quoted reply carries its own ciphertext: the quote is decrypted like the message itself
    const quoted = msg?.replyTo;
    if (quoted && typeof quoted === 'object' && quoted.e2ee && !quoted.e2eeState) {
      const q = await this.decrypt({ ...quoted, _id: String(quoted._id), userId: String(quoted.userId?._id || quoted.userId || ''), conversationId: String(msg.conversationId || conversationId || '') });
      quoted.e2eeState = q.state;
      quoted.content = q.state === 'ok' ? (q.content?.text || q.content?.file?.name || '') : 'Encrypted message';
    }
    if (!m?.['e2ee']) return m;
    const d = await this.decrypt({ ...msg, conversationId: String(msg.conversationId || conversationId || '') });
    msg.e2eeState = d.state;
    msg.e2eeWarning = d.warning;
    if (d.state !== 'ok') {
      msg.content = d.state === 'pending' ? 'Waiting for this message\'s key…' : (d.warning || 'This message can\'t be decrypted on this device.');
      return m;
    }
    msg.content = d.content?.text || '';
    if (d.content?.forwardedFrom) msg.forwardedFrom = d.content.forwardedFrom;
    const file = d.content?.file;
    if (file) {
      msg.e2eeFile = file;
      msg.fileName = file.name;
      msg.fileSize = file.size;
      msg.mimeType = file.mimeType;
      if (!msg.e2eeCipherUrl) msg.e2eeCipherUrl = msg.fileUrl || msg.downloadUrl;
      if (msg.e2eeCipherUrl && !msg.e2eeObjectUrl) {
        try {
          const res = await fetch(msg.e2eeCipherUrl);
          if (!res.ok) throw new Error(String(res.status));
          const blob = await decryptFile(await res.arrayBuffer(), file);
          msg.e2eeObjectUrl = URL.createObjectURL(blob);
        } catch {
          msg.e2eeFileError = "This attachment couldn't be downloaded or decrypted.";
        }
      }
      msg.fileUrl = msg.thumbnailUrl = msg.downloadUrl = msg.e2eeObjectUrl || '';
    }
    return m;
  }

  /**
   * A reference to a message (pin, saved item): its text and file name only, decrypted in memory.
   * Attachments aren't downloaded here; opening the message shows them.
   */
  async revealRef<T extends { messageId: string; conversationId?: string; e2ee?: EncryptedPayload; content?: string; fileName?: string; user?: { _id: string } | null }>(ref: T): Promise<T> {
    if (!ref?.e2ee) return ref;
    const d = await this.decrypt({ _id: String(ref.messageId), conversationId: String(ref.conversationId || ''), e2ee: ref.e2ee, userId: String(ref.user?._id || '') });
    (ref as any).e2eeState = d.state;
    ref.content = d.state === 'ok' ? d.content?.text || '' : 'Encrypted message';
    if (d.state === 'ok' && d.content?.file) ref.fileName = d.content.file.name;
    return ref;
  }

  async revealAll<T extends Record<string, any>>(list: T[] | null | undefined, conversationId?: string): Promise<T[]> {
    const items = list || [];
    // In order: a session's messages are ratcheted, decrypting them sequentially is cheapest
    for (const m of items) await this.reveal(m, conversationId);
    return items;
  }

  // ------------------------------------------------------------------ devices & verification

  /** My devices on the server, plus this one's fingerprint. */
  async myDevices(): Promise<{ deviceId: string; displayName: string; ed25519: string | null; revoked: boolean; current: boolean; lastSeenAt: string }[]> {
    const list = await this.api<any[]>('get', '/devices');
    return list.map((d) => ({ ...d, current: d.deviceId === this.deviceId }));
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.api('post', `/devices/${encodeURIComponent(deviceId)}/revoke`);
    if (deviceId === this.deviceId) {
      await forgetDevice(this.userId, this.storeName);
      this.stop();
    }
  }

  /** Devices of a contact with fingerprints and whether I verified them (comparison is done out of band). */
  async contactDevices(userId: string): Promise<{ deviceId: string; fingerprint: string; verified: boolean }[]> {
    await this.requireReady();
    const sdk = this.sdk!;
    await this.machine!.updateTrackedUsers([new sdk.UserId(matrixUser(userId))]);
    await this.processRequests();
    const devices = await this.machine!.getUserDevices(new sdk.UserId(matrixUser(userId)));
    return devices.devices().map((d) => ({ deviceId: d.deviceId.toString(), fingerprint: fingerprint(d.ed25519Key?.toBase64() || ''), verified: d.isLocallyTrusted() }));
  }

  async setDeviceVerified(userId: string, deviceId: string, verified: boolean): Promise<void> {
    await this.requireReady();
    const sdk = this.sdk!;
    const device = await this.machine!.getDevice(new sdk.UserId(matrixUser(userId)), new sdk.DeviceId(deviceId));
    if (!device) throw new Error('Device not found');
    await device.setLocalTrust(verified ? sdk.LocalTrust.Verified : sdk.LocalTrust.Unset);
    this.retryPending();
  }

  /** This device's fingerprint, to read out to a contact who verifies it. */
  async ownFingerprint(): Promise<string> {
    await this.requireReady();
    return fingerprint(this.machine!.identityKeys.ed25519.toBase64());
  }
}

/** Human-comparable fingerprint: the ed25519 key in groups of 4. */
export function fingerprint(key: string): string {
  return key.replace(/[^A-Za-z0-9+/]/g, '').match(/.{1,4}/g)?.join(' ') || '';
}

function browserName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ' on ' + os : ''}`;
}
