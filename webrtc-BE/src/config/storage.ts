import * as dotenv from "dotenv";

dotenv.config();

/**
 * Object storage (AWS S3) settings. Authentication uses an IAM access key pair from the
 * environment (never hard-coded, never sent to clients). The SDK's default chain (EC2/ECS role,
 * ~/.aws profiles) is NOT used: without both keys, uploads stay disabled.
 *
 *   AWS_REGION                 required, e.g. ap-south-1
 *   S3_BUCKET                  required. Profile/group pictures are read straight from the bucket
 *                              ({frontend s3BaseUrl}/{key}), so a bucket policy must allow public
 *                              s3:GetObject on {prefix}/users/{id}/avatar/* and {prefix}/groups/{id}/avatar/*.
 *                              Chat attachments stay private and are only reachable via pre-signed URLs.
 *   AWS_ACCESS_KEY_ID          required, access key of an IAM user limited to this bucket
 *   AWS_SECRET_ACCESS_KEY      required, its secret key
 *   AWS_SESSION_TOKEN          optional, only for temporary (STS) keys
 *   STORAGE_KEY_PREFIX         top-level key folder, default NODE_ENV (e.g. "production")
 *   S3_SIGNED_URL_TTL_SECONDS  lifetime of pre-signed links to chat attachments, default 21600 (6 h), max 7 days
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
    // SigV4 pre-signed URLs cannot outlive 7 days
    s3UrlTtlSeconds: Math.min(positiveInt(process.env.S3_SIGNED_URL_TTL_SECONDS, 6 * 60 * 60), 7 * 24 * 60 * 60),
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
