/**
 * Feasibility spike (not product code): can @matrix-org/matrix-sdk-crypto-wasm run in the browser and
 * carry SpreeWe users, devices and conversations end to end? A fake key server below plays the role
 * the SpreeWe backend will have to play: it stores and hands out PUBLIC keys and queues to-device
 * messages; it never sees private keys or plaintext.
 */
import * as Sdk from '@matrix-org/matrix-sdk-crypto-wasm';

const SERVER = 'spreewe.local';
const uid = (id: string) => new Sdk.UserId(`@${id}:${SERVER}`);
const room = (id: string) => new Sdk.RoomId(`!${id}:${SERVER}`);

/** In-memory stand-in for the backend key directory + to-device queue. */
class FakeKeyServer {
  deviceKeys: Record<string, Record<string, unknown>> = {};
  oneTimeKeys: Record<string, Record<string, Record<string, unknown>>> = {};
  inbox: Record<string, unknown[]> = {};
  seenPlaintext: string[] = [];

  async run(machine: Sdk.OlmMachine): Promise<void> {
    for (let round = 0; round < 5; round++) {
      const reqs = await machine.outgoingRequests();
      if (!reqs.length) return;
      for (const r of reqs as any[]) await machine.markRequestAsSent(r.id, r.type, this.handle(machine, r));
    }
  }

  private handle(machine: Sdk.OlmMachine, r: any): string {
    const body = JSON.parse(r.body);
    this.seenPlaintext.push(r.body);
    const user = machine.userId.toString();
    const device = machine.deviceId.toString();
    switch (r.type) {
      case Sdk.RequestType.KeysUpload: {
        if (body.device_keys) (this.deviceKeys[user] ||= {})[device] = body.device_keys;
        const otks = ((this.oneTimeKeys[user] ||= {})[device] ||= {});
        Object.assign(otks, body.one_time_keys || {});
        return JSON.stringify({ one_time_key_counts: { signed_curve25519: Object.keys(otks).length } });
      }
      case Sdk.RequestType.KeysQuery: {
        const out: Record<string, unknown> = {};
        for (const u of Object.keys(body.device_keys)) out[u] = this.deviceKeys[u] || {};
        return JSON.stringify({ device_keys: out, failures: {} });
      }
      case Sdk.RequestType.KeysClaim: {
        const out: Record<string, Record<string, Record<string, unknown>>> = {};
        for (const [u, devices] of Object.entries<any>(body.one_time_keys)) {
          for (const d of Object.keys(devices)) {
            const pool = this.oneTimeKeys[u]?.[d] || {};
            const keyId = Object.keys(pool)[0];
            if (keyId) {
              ((out[u] ||= {})[d] ||= {})[keyId] = pool[keyId];
              delete pool[keyId]; // one-time: never handed out twice
            }
          }
        }
        return JSON.stringify({ one_time_keys: out, failures: {} });
      }
      case Sdk.RequestType.ToDevice: {
        for (const [u, devices] of Object.entries<any>(body.messages)) {
          for (const [d, content] of Object.entries(devices)) (this.inbox[`${u}|${d}`] ||= []).push({ sender: user, type: r.event_type, content });
        }
        return '{}';
      }
      default:
        return '{}';
    }
  }

  async deliver(machine: Sdk.OlmMachine): Promise<void> {
    const key = `${machine.userId.toString()}|${machine.deviceId.toString()}`;
    const events = this.inbox[key] || [];
    this.inbox[key] = [];
    await machine.receiveSyncChanges(JSON.stringify(events), new Sdk.DeviceLists(), new Map([['signed_curve25519', 50]]), new Set());
  }
}

describe('E2EE feasibility (matrix-sdk-crypto-wasm in the browser)', () => {
  beforeAll(async () => {
    await Sdk.initAsync(new URL('assets/crypto/matrix_sdk_crypto_wasm_bg.wasm', document.baseURI));
  }, 60000);

  it('two SpreeWe users exchange an encrypted message; the server only sees ciphertext; tampering and outsiders fail', async () => {
    const server = new FakeKeyServer();
    const alice = await Sdk.OlmMachine.initialize(uid('alice'), new Sdk.DeviceId('ALICEDEV1'));
    const bob = await Sdk.OlmMachine.initialize(uid('bob'), new Sdk.DeviceId('BOBDEV1'));
    const eve = await Sdk.OlmMachine.initialize(uid('eve'), new Sdk.DeviceId('EVEDEV1'));
    for (const m of [alice, bob, eve]) await server.run(m); // upload identity + one-time keys

    const conversation = room('conv123');
    await alice.updateTrackedUsers([uid('bob')]);
    await server.run(alice); // keys/query for bob
    const claim = await alice.getMissingSessions([uid('bob')]);
    if (claim) await alice.markRequestAsSent(claim.id, claim.type, (server as any).handle(alice, claim));
    const shares = await alice.shareRoomKey(conversation, [uid('bob')], new Sdk.EncryptionSettings());
    for (const s of shares) await alice.markRequestAsSent(s.id, s.type, (server as any).handle(alice, s));
    await server.deliver(bob);

    const secret = 'The launch code is 4471 — do not share';
    const encrypted = await alice.encryptRoomEvent(conversation, 'm.room.message', JSON.stringify({ msgtype: 'm.text', body: secret }));
    const event = { type: 'm.room.encrypted', event_id: '$ev1', sender: '@alice:' + SERVER, origin_server_ts: Date.now(), content: JSON.parse(encrypted) };

    // The server never saw the plaintext (key uploads, claims, to-device payloads, the message)
    expect([...server.seenPlaintext, encrypted].some((s) => s.includes(secret))).toBeFalse();

    const decrypted = await bob.decryptRoomEvent(JSON.stringify(event), conversation, new Sdk.DecryptionSettings(Sdk.TrustRequirement.Untrusted));
    expect(JSON.parse((decrypted as any).event).content.body).toBe(secret);

    // Tampered ciphertext is rejected (authenticated encryption)
    const tampered = { ...event, content: { ...event.content, ciphertext: (event.content.ciphertext as string).replace(/.$/, (c: string) => (c === 'A' ? 'B' : 'A')) } };
    await expectAsync(bob.decryptRoomEvent(JSON.stringify(tampered), conversation, new Sdk.DecryptionSettings(Sdk.TrustRequirement.Untrusted))).toBeRejected();

    // Someone never given the room key can't decrypt
    await expectAsync(eve.decryptRoomEvent(JSON.stringify(event), conversation, new Sdk.DecryptionSettings(Sdk.TrustRequirement.Untrusted))).toBeRejected();

    for (const m of [alice, bob, eve]) m.close();
  }, 60000);
});
