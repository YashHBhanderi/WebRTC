import type { SpreeWeClient } from "./client.js";
import type { ReadableStore, Unsubscribe } from "./store.js";
import type { EncryptedPayload } from "./types.js";

/**
 * Contract between feature modules (chat, files) and an end-to-end encryption device. The
 * implementation lives in @spreewe/e2ee and registers itself on the client, so chat works without
 * importing the crypto library: without a device, messages show as encrypted and can't be sent.
 */

/** What travels inside the ciphertext (the server never sees any of it). Same format as the SpreeWe apps. */
export interface SecureContent {
    text?: string;
    file?: SecureFile;
    forwardedFrom?: string;
}

export interface SecureFile {
    storageKey: string;
    /** AES-256-GCM key, base64 */
    key: string;
    /** 96-bit IV, base64 */
    iv: string;
    /** SHA-256 of the ciphertext, base64 */
    sha256: string;
    mimeType: string;
    name: string;
    size: number;
}

export type DecryptState = "ok" | "pending" | "failed";

export interface Decrypted {
    state: DecryptState;
    content?: SecureContent;
    /** Sender device unverified or unknown */
    warning?: string;
}

export type E2eeStatus = "idle" | "starting" | "ready" | "unsupported" | "revoked" | "error";

export interface E2eeEngine {
    readonly status: ReadableStore<E2eeStatus>;
    /** Human-readable reason when status is unsupported / revoked / error */
    readonly statusMessage: string;
    /** This device's id (X-SpreeWe-Device), empty until started */
    readonly deviceId: string;
    start(): Promise<void>;
    /** Encrypt for the conversation's current members' devices. Throws instead of falling back to plaintext. */
    encrypt(conversationId: string, content: SecureContent): Promise<EncryptedPayload>;
    decrypt(message: { _id: string; conversationId: string; e2ee?: EncryptedPayload; userId?: string; createdAt?: string }): Promise<Decrypted>;
    /** New room keys may have arrived: re-try messages that were "pending" */
    onKeysChanged(listener: () => void): Unsubscribe;
    encryptFile(file: Blob & { name?: string }): Promise<{ ciphertext: Blob; info: Omit<SecureFile, "storageKey"> }>;
    decryptFile(ciphertext: ArrayBuffer, info: SecureFile): Promise<Blob>;
}

/** Registry key used by @spreewe/e2ee */
export const E2EE_SERVICE = Symbol.for("spreewe.e2ee");

/** The client's encryption device, if @spreewe/e2ee was enabled for it. */
export function getE2ee(client: SpreeWeClient): E2eeEngine | null {
    return client.peekService<E2eeEngine>(E2EE_SERVICE);
}
