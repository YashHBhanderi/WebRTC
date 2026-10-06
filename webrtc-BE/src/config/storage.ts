import crypto from "crypto";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Object storage (AWS S3) settings. Authentication uses an IAM access key pair from the
 * environment (never hard-coded, never sent to clients). The SDK's default chain (EC2/ECS role,
 * ~/.aws profiles) is NOT used: without both keys, uploads stay disabled.
 *
 *   AWS_REGION                 required, e.g. ap-south-1
 *   S3_BUCKET                  required, private bucket (Block Public Access can stay on)
 *   AWS_ACCESS_KEY_ID          required, access key of an IAM user limited to this bucket
 *   AWS_SECRET_ACCESS_KEY      required, its secret key
 *   AWS_SESSION_TOKEN          optional, only for temporary (STS) keys
 *   STORAGE_KEY_PREFIX         top-level key folder, default NODE_ENV (e.g. "production")
 *   FILE_URL_BASE              path/URL the browser uses to reach this API, default "/api"
 *   FILE_URL_SECRET            HMAC key for signed file links (falls back to a key derived from secretKey)
 *   FILE_URL_TTL_SECONDS       lifetime of signed links to private files, default 21600 (6 h)
 *   S3_SIGNED_URL_TTL_SECONDS  lifetime of the S3 pre-signed URL a file link redirects to, default 3600
 *   S3_ENDPOINT                optional S3-compatible endpoint (local emulators); unset for AWS
 *   S3_FORCE_PATH_STYLE        "true" for most S3-compatible emulators
 */
function positiveInt(value: string | undefined, fallback: number): number {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function keyPrefix(value: string): string {
    const cleaned = value.toLowerCase().replace(/[^a-z0-9-]/g, "");
    return cleaned || "development";
}

/**
 * S3_ENDPOINT is for S3-compatible servers (local emulators). A standard AWS S3 address
 * (e.g. https://<bucket>.s3.<region>.amazonaws.com) must not be used as a custom endpoint:
 * the SDK would add the bucket again and objects would land under the wrong key / fail to sign.
 * Those are ignored so the SDK uses AWS's normal endpoint. VPC endpoints ("vpce") are kept.
 */
function customEndpoint(value: string | undefined): string | undefined {
    const raw = (value || "").trim();
    if (!raw) {
        return undefined;
    }
    try {
        const host = new URL(raw).hostname.toLowerCase();
        if (/^([a-z0-9.-]+\.)?s3([.-][a-z0-9-]+)*\.amazonaws\.com(\.cn)?$/.test(host) && !host.includes("vpce")) {
            console.warn("[storage] S3_ENDPOINT points at AWS S3 itself; ignoring it (and S3_FORCE_PATH_STYLE). Remove it from .env — it is only for S3-compatible servers.");
            return undefined;
        }
    } catch {
        console.warn("[storage] S3_ENDPOINT is not a valid URL; ignoring it");
        return undefined;
    }
    return raw;
}

const endpoint = customEndpoint(process.env.S3_ENDPOINT);

function fileUrlSecret(): Buffer {
    if (process.env.FILE_URL_SECRET) {
        return Buffer.from(process.env.FILE_URL_SECRET, "utf8");
    }
    // Derived (not reused) so a file-link key can never be used as a JWT key and vice versa
    return crypto.createHmac("sha256", process.env.secretKey || "").update("file-url-signing").digest();
}

export const storageConfig = {
    provider: "s3" as const,
    region: (process.env.AWS_REGION || "").trim(),
    bucket: (process.env.S3_BUCKET || "").trim(),
    accessKeyId: (process.env.AWS_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: (process.env.AWS_SECRET_ACCESS_KEY || "").trim(),
    sessionToken: (process.env.AWS_SESSION_TOKEN || "").trim() || undefined,
    endpoint,
    forcePathStyle: !!endpoint && process.env.S3_FORCE_PATH_STYLE === "true",
    keyPrefix: keyPrefix(process.env.STORAGE_KEY_PREFIX || process.env.NODE_ENV || "development"),
    fileUrlBase: (process.env.FILE_URL_BASE ?? "/api").replace(/\/+$/, ""),
    fileUrlSecret: fileUrlSecret(),
    fileUrlTtlSeconds: positiveInt(process.env.FILE_URL_TTL_SECONDS, 6 * 60 * 60),
    s3UrlTtlSeconds: positiveInt(process.env.S3_SIGNED_URL_TTL_SECONDS, 60 * 60),
};

export const isStorageConfigured = (): boolean =>
    !!(storageConfig.region && storageConfig.bucket && storageConfig.accessKeyId && storageConfig.secretAccessKey);

if (!isStorageConfigured()) {
    // Names only — never log the key values
    const missing = [
        ["AWS_REGION", storageConfig.region],
        ["S3_BUCKET", storageConfig.bucket],
        ["AWS_ACCESS_KEY_ID", storageConfig.accessKeyId],
        ["AWS_SECRET_ACCESS_KEY", storageConfig.secretAccessKey],
    ].filter(([, value]) => !value).map(([name]) => name);
    console.warn(`[storage] ${missing.join(", ")} not set — uploads are disabled until they are configured`);
}
if (!process.env.FILE_URL_SECRET && process.env.NODE_ENV === "production") {
    console.warn("[storage] FILE_URL_SECRET not set — file links are signed with a key derived from secretKey");
}
