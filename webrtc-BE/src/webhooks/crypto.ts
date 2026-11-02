import crypto from "crypto";

/**
 * Webhook signing secrets must be usable for every delivery, so (unlike API secrets) they are
 * stored encrypted, not hashed: AES-256-GCM with WEBHOOK_SECRET_KEY (server-only; required in
 * production; same on every instance). Format: "v1:<iv>:<tag>:<ciphertext>" (base64url).
 *
 * Signature sent with each delivery (receivers verify; see docs/integrations/outbound-webhooks.md):
 *   SpreeWe-Webhook-Signature: v1=<hex HMAC-SHA256(secret, `${deliveryId}.${timestamp}.${body}`)>
 * During secret rotation the header carries one v1= entry per valid secret.
 */
let ephemeral: Buffer | null = null;

function key(): Buffer {
    const configured = process.env.WEBHOOK_SECRET_KEY;
    if (configured && configured.length >= 32) {
        return crypto.createHash("sha256").update(configured).digest();
    }
    if (process.env.NODE_ENV === "production") {
        throw new Error("WEBHOOK_SECRET_KEY (32+ characters) must be set in production");
    }
    ephemeral = ephemeral || crypto.randomBytes(32);
    return ephemeral;
}

export function newWebhookSecret(): string {
    return `swh_${crypto.randomBytes(32).toString("base64url")}`;
}

export function encryptSecret(secret: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
    const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(":");
}

export function decryptSecret(blob: string): string {
    const [v, iv, tag, ct] = blob.split(":");
    if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported secret format");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function sign(secret: string, deliveryId: string, timestamp: number, body: string): string {
    return crypto.createHmac("sha256", secret).update(`${deliveryId}.${timestamp}.${body}`).digest("hex");
}

/**
 * Reference verification for receivers (also used by tests): checks timestamp tolerance and any
 * v1 signature with a timing-safe comparison. Receivers should also de-duplicate by delivery id.
 */
export function verifySignature(secret: string, headers: { id: string; timestamp: string; signature: string }, body: string, toleranceSeconds = 300, nowMs = Date.now()): boolean {
    const ts = Number(headers.timestamp);
    if (!Number.isInteger(ts) || Math.abs(nowMs / 1000 - ts) > toleranceSeconds) return false;
    const expected = Buffer.from(sign(secret, headers.id, ts, body));
    return headers.signature.split(/[ ,]+/).some((part) => {
        const [scheme, value] = part.split("=");
        if (scheme !== "v1" || !value) return false;
        const given = Buffer.from(value);
        return given.length === expected.length && crypto.timingSafeEqual(given, expected);
    });
}
