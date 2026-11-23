import { AppError } from "../utils/errors";

/**
 * An end-to-end encrypted message as stored and relayed by the server: Megolm ciphertext plus the
 * public identifiers a recipient needs to find the right session. The server can't decrypt it and
 * only checks its shape and size. Everything the message says (text, captions, attachment keys and
 * names, reply quotes) is inside `ciphertext`.
 */
export interface EncryptedPayload {
    algorithm: "m.megolm.v1.aes-sha2";
    ciphertext: string;
    session_id: string;
    sender_key: string;
    device_id: string;
}

const B64 = /^[A-Za-z0-9+/_=-]+$/;
export const MAX_CIPHERTEXT_LENGTH = 128 * 1024;

export function validateEncryptedPayload(raw: unknown): EncryptedPayload {
    const p = raw as Partial<EncryptedPayload> | null;
    const ok = !!p && typeof p === "object"
        && p.algorithm === "m.megolm.v1.aes-sha2"
        && typeof p.ciphertext === "string" && p.ciphertext.length > 0 && p.ciphertext.length <= MAX_CIPHERTEXT_LENGTH && B64.test(p.ciphertext)
        && typeof p.session_id === "string" && p.session_id.length <= 128 && B64.test(p.session_id)
        && typeof p.sender_key === "string" && p.sender_key.length <= 128 && B64.test(p.sender_key)
        && typeof p.device_id === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(p.device_id);
    if (!ok) throw new AppError("Messages must be end-to-end encrypted", 400);
    // Only these fields are kept: nothing else a client attaches is stored
    return { algorithm: "m.megolm.v1.aes-sha2", ciphertext: p!.ciphertext!, session_id: p!.session_id!, sender_key: p!.sender_key!, device_id: p!.device_id! };
}
