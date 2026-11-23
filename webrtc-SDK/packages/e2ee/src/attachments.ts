import type { SecureFile } from "@spreewe/core";

/**
 * Attachment encryption: AES-256-GCM (WebCrypto) with a fresh random key and IV per file. Only the
 * ciphertext is uploaded; key, IV, ciphertext hash, real type and name travel inside the end-to-end
 * encrypted message. Same format as the SpreeWe apps, so files are readable on every device.
 */
export type EncryptedFileInfo = Omit<SecureFile, "storageKey">;

const toB64 = (buf: ArrayBuffer | Uint8Array) => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
};
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptFile(file: Blob & { name?: string }): Promise<{ ciphertext: Blob; info: EncryptedFileInfo }> {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, await file.arrayBuffer());
    const sha = await crypto.subtle.digest("SHA-256", data);
    const keyB64 = toB64(keyBytes);
    keyBytes.fill(0);
    return {
        ciphertext: new Blob([data], { type: "application/octet-stream" }),
        info: { key: keyB64, iv: toB64(iv), sha256: toB64(sha), mimeType: file.type || "application/octet-stream", name: file.name || "file", size: file.size },
    };
}

/** Decrypt downloaded ciphertext; fails if it was altered or replaced (hash and GCM tag are checked). */
export async function decryptFile(ciphertext: ArrayBuffer, info: Pick<SecureFile, "key" | "iv" | "sha256" | "mimeType">): Promise<Blob> {
    const sha = toB64(await crypto.subtle.digest("SHA-256", ciphertext));
    if (sha !== info.sha256) throw new Error("This file was changed or replaced, so it was not opened.");
    const key = await crypto.subtle.importKey("raw", fromB64(info.key), "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(info.iv) }, key, ciphertext);
    return new Blob([plain], { type: info.mimeType });
}
