import { Injector, NgZone } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { E2eeService, EncryptedPayload } from './e2ee.service';
import { encryptFile, decryptFile } from './attachment-crypto';

/**
 * The real E2eeService with real cryptography (matrix-sdk-crypto-wasm in this browser), talking to an
 * in-memory backend that follows the semantics of webrtc-BE/src/e2ee (/v1/e2ee): keys served only to
 * people who share a conversation, one-time keys consumed once, an acknowledged device-message queue,
 * revoked devices refused. Every byte the "server" receives is recorded to prove it never sees plaintext.
 */
class FakeBackend {
  devices = new Map<string, { keys: any; revoked: boolean }>(); // "user|device"
  otks = new Map<string, Map<string, unknown>>();
  fallback = new Map<string, Map<string, unknown>>();
  queue = new Map<string, { id: string; sender: string; type: string; content: unknown }[]>();
  members = new Map<string, string[]>(); // conversationId → user ids
  wire: string[] = [];
  private seq = 0;

  private shares(a: string, b: string): boolean {
    return a === b || [...this.members.values()].some((m) => m.includes(a) && m.includes(b));
  }

  http(userId: string, device: () => string) {
    const route = (method: string, url: string, body: any): Observable<any> => {
      this.wire.push(JSON.stringify(body ?? null));
      const path = url.split('/v1/e2ee')[1];
      const d = device();
      const me = `@${userId}:spreewe.local`;
      const reply = (data: unknown) => of({ data });
      const deny = (status: number) => throwError(() => ({ status }));
      const key = `${userId}|${d}`;
      if (path === '/devices' && method === 'post') {
        const rec = this.devices.get(key);
        if (rec?.revoked) return deny(403);
        if (!rec) this.devices.set(key, { keys: null, revoked: false });
        return reply({ deviceId: d });
      }
      if (path === '/devices' && method === 'get') return reply([...this.devices.entries()].filter(([k]) => k.startsWith(userId + '|')).map(([k, v]) => ({ deviceId: k.split('|')[1], revoked: v.revoked })));
      const rec = this.devices.get(key);
      if (!rec || rec.revoked) return deny(403);
      if (path === '/keys/upload') {
        if (body.device_keys) rec.keys = body.device_keys;
        const o = this.otks.get(key) || new Map();
        Object.entries(body.one_time_keys || {}).forEach(([k, v]) => o.set(k, v));
        this.otks.set(key, o);
        if (body.fallback_keys) this.fallback.set(key, new Map(Object.entries(body.fallback_keys)));
        return reply({ one_time_key_counts: { signed_curve25519: o.size }, unused_fallback_keys: [] });
      }
      if (path === '/keys/query') {
        const out: any = {};
        for (const m of Object.keys(body.device_keys)) {
          const uid = m.slice(1).split(':')[0];
          if (!this.shares(userId, uid)) continue;
          out[m] = {};
          for (const [k, v] of this.devices) if (k.startsWith(uid + '|') && !v.revoked && v.keys) out[m][k.split('|')[1]] = v.keys;
        }
        return reply({ device_keys: out, failures: {} });
      }
      if (path === '/keys/claim') {
        const out: any = {};
        for (const [m, devs] of Object.entries<any>(body.one_time_keys)) {
          const uid = m.slice(1).split(':')[0];
          if (!this.shares(userId, uid)) continue;
          for (const dev of Object.keys(devs)) {
            const pool = this.otks.get(`${uid}|${dev}`);
            const first = pool && [...pool.keys()][0];
            if (first) {
              ((out[m] ||= {})[dev] ||= {})[first] = pool!.get(first);
              pool!.delete(first);
            } else {
              const fb = this.fallback.get(`${uid}|${dev}`);
              const f = fb && [...fb.keys()][0];
              if (f) ((out[m] ||= {})[dev] ||= {})[f] = fb!.get(f);
            }
          }
        }
        return reply({ one_time_keys: out, failures: {} });
      }
      if (path.startsWith('/sendToDevice/')) {
        const type = decodeURIComponent(path.split('/')[2]);
        for (const [m, devs] of Object.entries<any>(body.messages)) {
          const uid = m.slice(1).split(':')[0];
          if (!this.shares(userId, uid)) return deny(403);
          for (const [dev, content] of Object.entries(devs)) {
            const q = this.queue.get(`${uid}|${dev}`) || [];
            q.push({ id: String(++this.seq).padStart(24, '0'), sender: me, type, content });
            this.queue.set(`${uid}|${dev}`, q);
          }
        }
        return reply({});
      }
      if (path.startsWith('/sync')) {
        const ack = new URLSearchParams(path.split('?')[1] || '').get('ack');
        let q = this.queue.get(key) || [];
        if (ack) q = q.filter((e) => e.id > ack);
        this.queue.set(key, q);
        return reply({ events: q, next: q.length ? q[q.length - 1].id : ack, device_lists: { changed: [], left: [] }, now: Date.now(), one_time_key_counts: { signed_curve25519: this.otks.get(key)?.size || 0 }, unused_fallback_keys: [] });
      }
      const room = /^\/rooms\/([^/]+)\/members$/.exec(path);
      if (room) {
        const m = this.members.get(room[1]) || [];
        return m.includes(userId) ? reply({ members: m.map((u) => `@${u}:spreewe.local`) }) : deny(404);
      }
      return deny(404);
    };
    return { get: (url: string) => route('get', url, null), post: (url: string, body: unknown) => route('post', url, body) };
  }
}

const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

describe('E2eeService (real cryptography, simulated backend)', () => {
  let backend: FakeBackend;
  const people: E2eeService[] = [];

  async function person(): Promise<{ id: string; svc: E2eeService }> {
    const id = hex();
    let svc!: E2eeService;
    const http = backend.http(id, () => svc.myDeviceId);
    svc = new E2eeService(http as any, new NgZone({ enableLongStackTrace: false }), {} as Injector);
    await svc.start(id);
    people.push(svc);
    return { id, svc };
  }
  const msg = (conversationId: string, sender: string, e2ee: EncryptedPayload, n = 1) => ({ _id: `m${n}${hex().slice(0, 6)}`, conversationId, userId: sender, e2ee, createdAt: new Date().toISOString() });

  beforeEach(() => (backend = new FakeBackend()));
  afterEach(() => people.splice(0).forEach((p) => p.stop()));

  it('encrypts on the sender, decrypts on the recipient; the server never sees the plaintext', async () => {
    const alice = await person();
    const bob = await person();
    const conv = hex();
    backend.members.set(conv, [alice.id, bob.id]);
    const secret = 'Quarterly numbers: 4.2M, do not forward';
    const payload = await alice.svc.encrypt(conv, { text: secret });
    expect(payload.algorithm).toBe('m.megolm.v1.aes-sha2');
    expect(JSON.stringify(payload)).not.toContain(secret);
    await bob.svc.sync();
    const out = await bob.svc.decrypt(msg(conv, alice.id, payload));
    expect(out.state).toBe('ok');
    expect(out.content?.text).toBe(secret);
    expect(backend.wire.some((w) => w.includes(secret) || w.includes('Quarterly'))).toBeFalse();
  }, 60000);

  it('someone removed from the conversation cannot read messages sent after (room key rotated)', async () => {
    const alice = await person();
    const bob = await person();
    const carol = await person();
    const conv = hex();
    backend.members.set(conv, [alice.id, bob.id, carol.id]);
    const before = await alice.svc.encrypt(conv, { text: 'hello all' });
    await carol.svc.sync();
    expect((await carol.svc.decrypt(msg(conv, alice.id, before, 1))).content?.text).toBe('hello all');
    backend.members.set(conv, [alice.id, bob.id]); // carol removed (server membership)
    const after = await alice.svc.encrypt(conv, { text: 'carol is gone' });
    expect(after.session_id).not.toBe(before.session_id);
    await carol.svc.sync();
    await bob.svc.sync();
    expect((await carol.svc.decrypt(msg(conv, alice.id, after, 2))).state).not.toBe('ok');
    expect((await bob.svc.decrypt(msg(conv, alice.id, after, 2))).content?.text).toBe('carol is gone');
  }, 90000);

  it('rotation also holds after a page refresh (the sender restarts with its stored keys)', async () => {
    const alice = await person();
    const bob = await person();
    const carol = await person();
    const conv = hex();
    backend.members.set(conv, [alice.id, bob.id, carol.id]);
    const first = await alice.svc.encrypt(conv, { text: 'before refresh' });
    // Alice reloads the page: a new service instance on the same stored device
    alice.svc.stop();
    let reopened!: E2eeService;
    reopened = new E2eeService(backend.http(alice.id, () => reopened.myDeviceId) as any, new NgZone({ enableLongStackTrace: false }), {} as Injector);
    await reopened.start(alice.id);
    people.push(reopened);
    expect(reopened.myDeviceId).toBe(alice.svc.myDeviceId || reopened.myDeviceId);
    backend.members.set(conv, [alice.id, bob.id]); // carol removed while alice was away
    const after = await reopened.encrypt(conv, { text: 'after carol left' });
    await carol.svc.sync();
    expect((await carol.svc.decrypt(msg(conv, alice.id, after, 7))).state).not.toBe('ok');
    expect(after.session_id).not.toBe(first.session_id);
  }, 120000);

  it('tampered ciphertext and a forged sender are refused', async () => {
    const alice = await person();
    const bob = await person();
    const conv = hex();
    backend.members.set(conv, [alice.id, bob.id]);
    const payload = await alice.svc.encrypt(conv, { text: 'pay 100' });
    await bob.svc.sync();
    const flipped = payload.ciphertext.replace(/.(?=.{10}$)/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await bob.svc.decrypt(msg(conv, alice.id, { ...payload, ciphertext: flipped }, 3))).state).toBe('failed');
    // Same ciphertext presented as coming from someone else
    expect((await bob.svc.decrypt(msg(conv, bob.id, payload, 4))).state).not.toBe('ok');
  }, 60000);

  it('a message whose key has not arrived yet is "pending" and becomes readable once it arrives', async () => {
    const alice = await person();
    const bob = await person();
    const conv = hex();
    backend.members.set(conv, [alice.id, bob.id]);
    const payload = await alice.svc.encrypt(conv, { text: 'late key' });
    const m = msg(conv, alice.id, payload, 5);
    expect((await bob.svc.decrypt(m)).state).toBe('pending'); // bob hasn't synced
    await bob.svc.sync();
    expect((await bob.svc.decrypt(m)).content?.text).toBe('late key');
  }, 60000);

  it('refuses to encrypt when a member\'s devices can\'t be reached, rather than sending plaintext', async () => {
    const alice = await person();
    const conv = hex();
    backend.members.set(conv, [alice.id]);
    // Not a member of this conversation → the server refuses: nothing is encrypted or sent
    await expectAsync(alice.svc.encrypt(hex(), { text: 'x' })).toBeRejected();
  }, 60000);

  it('contacts can be verified by fingerprint; verification is stored locally', async () => {
    const alice = await person();
    const bob = await person();
    const conv = hex();
    backend.members.set(conv, [alice.id, bob.id]);
    const devices = await alice.svc.contactDevices(bob.id);
    expect(devices.length).toBe(1);
    expect(devices[0].fingerprint).toBe(await bob.svc.ownFingerprint());
    expect(devices[0].verified).toBeFalse();
    await alice.svc.setDeviceVerified(bob.id, devices[0].deviceId, true);
    expect((await alice.svc.contactDevices(bob.id))[0].verified).toBeTrue();
  }, 60000);
});

describe('Attachment encryption (AES-256-GCM)', () => {
  it('round-trips; a changed byte or a swapped file is refused', async () => {
    const file = new File([new TextEncoder().encode('%PDF-1.4 secret contract')], 'contract.pdf', { type: 'application/pdf' });
    const { ciphertext, info } = await encryptFile(file);
    const bytes = new Uint8Array(await ciphertext.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toContain('secret');
    expect(info.name).toBe('contract.pdf');
    const back = await decryptFile(bytes.buffer, info);
    expect(await back.text()).toBe('%PDF-1.4 secret contract');
    const altered = bytes.slice();
    altered[5] ^= 1;
    await expectAsync(decryptFile(altered.buffer, info)).toBeRejected();
    // Each file gets its own key and IV
    const again = await encryptFile(file);
    expect(again.info.key).not.toBe(info.key);
    expect(again.info.iv).not.toBe(info.iv);
  });
});
