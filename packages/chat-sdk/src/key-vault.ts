/**
 * Per-browser secrets for end-to-end encryption, in IndexedDB (never localStorage, never the server).
 *
 * The encryption library keeps its private keys in its own IndexedDB store, encrypted with a passphrase.
 * That passphrase is random (32 bytes) and is itself stored only wrapped by a NON-EXTRACTABLE AES-GCM
 * key: page script can use the key to unwrap it, but can't export the key's raw bytes. This protects
 * keys at rest against copying the browser profile's files; it does NOT protect against malicious
 * code running in the page (no browser storage can), see docs/security/end-to-end-encryption.md.
 */
// Copied from webrtc-FE/src/app/core/crypto/key-vault.ts. Own database: the SDK is its own E2EE device,
// never sharing a key store with the SpreeWe web app on the same origin (two machines on one store corrupt it)
const DB = 'spreewe-sdk-e2ee-vault';
const STORE = 'devices';

export interface VaultRecord {
  userId: string;
  deviceId: string;
  wrapKey: CryptoKey;
  iv: Uint8Array;
  wrappedPassphrase: ArrayBuffer;
  /** Last acknowledged device-message id (not secret) */
  ack: string | null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'userId' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** Random device id: 10 characters [A-Z0-9] (the server accepts [A-Za-z0-9_-]{4,64}). */
function newDeviceId(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % alphabet.length]).join('');
}

/** This browser's device for the user, created on first use: device id + the crypto-store passphrase. */
export async function deviceFor(userId: string): Promise<{ deviceId: string; passphrase: string; record: VaultRecord }> {
  let record = await tx<VaultRecord | undefined>('readonly', (s) => s.get(userId));
  if (!record) {
    const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const passphraseBytes = crypto.getRandomValues(new Uint8Array(32));
    const wrappedPassphrase = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrapKey, passphraseBytes);
    record = { userId, deviceId: newDeviceId(), wrapKey, iv, wrappedPassphrase, ack: null };
    await tx('readwrite', (s) => s.put(record!));
  }
  const raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, record.wrapKey, record.wrappedPassphrase));
  return { deviceId: record.deviceId, passphrase: b64(raw), record };
}

export async function saveAck(userId: string, ack: string | null): Promise<void> {
  const record = await tx<VaultRecord | undefined>('readonly', (s) => s.get(userId));
  if (record) await tx('readwrite', (s) => s.put({ ...record, ack }));
}

/**
 * Forget this browser's device for the user (it was removed from the account, or the user removes
 * it here): the wrapped passphrase and the library's encrypted store are deleted.
 */
export async function forgetDevice(userId: string, storeName: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(userId));
  for (const name of [`${storeName}::matrix-sdk-crypto`, `${storeName}::matrix-sdk-crypto-meta`, storeName]) {
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  }
}
