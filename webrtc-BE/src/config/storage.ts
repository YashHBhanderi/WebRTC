import crypto from "crypto";
import * as dotenv from "dotenv";

dotenv.config();

/**
 * Object storage (AWS S3) settings. Credentials are NOT configured here: the AWS SDK's default
 * provider chain is used (IAM role / ECS task role / instance profile, or the standard
 * AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY + AWS_SESSION_TOKEN variables, or ~/.aws profiles).
 *
 *   AWS_REGION                 required, e.g. ap-south-1
 *   S3_BUCKET                  required, private bucket (Block Public Access can stay on)
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

function fileUrlSecret(): Buffer {
    if (process.env.FILE_URL_SECRET) {
        return Buffer.from(process.env.FILE_URL_SECRET, "utf8");
    }
    // Derived (not reused) so a file-link key can never be used as a JWT key and vice versa
    return crypto.createHmac("sha256", process.env.secretKey || "").update("file-url-signing").digest();
}

export const storageConfig = {
    provider: "s3" as const,
    region: process.env.AWS_REGION || "",
    bucket: process.env.S3_BUCKET || "",
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    keyPrefix: keyPrefix(process.env.STORAGE_KEY_PREFIX || process.env.NODE_ENV || "development"),
    fileUrlBase: (process.env.FILE_URL_BASE ?? "/api").replace(/\/+$/, ""),
    fileUrlSecret: fileUrlSecret(),
    fileUrlTtlSeconds: positiveInt(process.env.FILE_URL_TTL_SECONDS, 6 * 60 * 60),
    s3UrlTtlSeconds: positiveInt(process.env.S3_SIGNED_URL_TTL_SECONDS, 60 * 60),
};

export const isStorageConfigured = (): boolean => !!(storageConfig.region && storageConfig.bucket);

if (!isStorageConfigured()) {
    console.warn("[storage] AWS_REGION / S3_BUCKET not set — uploads are disabled until they are configured");
}
if (!process.env.FILE_URL_SECRET && process.env.NODE_ENV === "production") {
    console.warn("[storage] FILE_URL_SECRET not set — file links are signed with a key derived from secretKey");
}
