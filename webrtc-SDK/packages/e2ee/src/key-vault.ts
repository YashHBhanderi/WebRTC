/**
 * Per-browser secrets for an encryption device, in IndexedDB (never localStorage, never the server).
 *
 * The crypto library keeps private keys in its own IndexedDB store, encrypted with a passphrase. That
 * passphrase is random (32 bytes) and stored only wrapped by a NON-EXTRACTABLE AES-GCM key: page
 * script can use the key to unwrap it but can't export its bytes. This protects keys at rest
 * against copying the browser profile; it does NOT protect against malicious script running on
 * your page (no browser storage can). Same scheme as the SpreeWe web app.
 */
export interface VaultRecord {
    userId: string;
    deviceId: string;
    wrapKey: CryptoKey;
    iv: Uint8Array<ArrayBuffer>;
    wrappedPassphrase: ArrayBuffer;
    /** Last acknowledged device-message id (not secret) */
    ack: string | null;
}

const STORE = "devices";

function open(db: string): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(db, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "userId" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function tx<T>(dbName: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open(dbName);
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

/** Random device id: 10 characters [A-Z2-9] (the server accepts [A-Za-z0-9_-]{4,64}). */
export function newDeviceId(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => alphabet[b % alphabet.length]).join("");
}

export class KeyVault {
    constructor(private readonly dbName: string) {}

    /** This browser's device for the user, created on first use: device id + crypto-store passphrase. */
    async deviceFor(userId: string): Promise<{ deviceId: string; passphrase: string; ack: string | null }> {
        let record = await tx<VaultRecord | undefined>(this.dbName, "readonly", (s) => s.get(userId));
        if (!record) {
            const wrapKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const passphraseBytes = crypto.getRandomValues(new Uint8Array(32));
            const wrappedPassphrase = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, passphraseBytes);
            passphraseBytes.fill(0);
            record = { userId, deviceId: newDeviceId(), wrapKey, iv, wrappedPassphrase, ack: null };
            await tx(this.dbName, "readwrite", (s) => s.put(record!));
        }
        const raw = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: record.iv }, record.wrapKey, record.wrappedPassphrase));
        const passphrase = b64(raw);
        raw.fill(0);
        return { deviceId: record.deviceId, passphrase, ack: record.ack };
    }

    async saveAck(userId: string, ack: string | null): Promise<void> {
        const record = await tx<VaultRecord | undefined>(this.dbName, "readonly", (s) => s.get(userId));
        if (record) await tx(this.dbName, "readwrite", (s) => s.put({ ...record, ack }));
    }

    /** Forget the device (revoked, or removed here): the wrapped passphrase and the crypto store are deleted. */
    async forget(userId: string, storeName: string): Promise<void> {
        await tx(this.dbName, "readwrite", (s) => s.delete(userId));
        for (const name of [`${storeName}::matrix-sdk-crypto`, `${storeName}::matrix-sdk-crypto-meta`, storeName]) {
            await new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(name);
                req.onsuccess = req.onerror = req.onblocked = () => resolve();
            });
        }
    }
}
