import fs from "fs";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import {
    DeleteObjectCommand,
    GetBucketLifecycleConfigurationCommand,
    GetObjectCommand,
    HeadObjectCommand,
    PutBucketLifecycleConfigurationCommand,
    PutObjectCommand,
    S3Client,
    S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { isStorageConfigured, storageConfig } from "../config/storage";
import { AppError } from "../utils/errors";

export interface PutObjectInput {
    key: string;
    body: Readable | Buffer;
    contentType: string;
    contentLength: number;
    /** Stored as x-amz-meta-*; values must be ASCII (encode user text first). */
    metadata?: Record<string, string>;
    cacheControl?: string;
}

export interface StoredObjectInfo {
    contentType: string;
    size: number;
    metadata: Record<string, string>;
}

export interface SignedUrlOptions {
    expiresInSeconds: number;
    /** Fixed signing time → identical URLs within a window, so browsers can cache the object. */
    signingDate?: Date;
    /** Content-Disposition S3 should answer with (e.g. to force a download with a file name). */
    contentDisposition?: string;
}

/**
 * Thin, provider-specific wrapper around S3. Knows nothing about users, chats or URLs the app
 * hands out — that lives in file.service. Errors are logged here and surfaced as AppError.
 */
class StorageService {
    private client: S3Client | null = null;

    private s3(): S3Client {
        if (!isStorageConfigured()) {
            throw new AppError("File storage is not configured", 503);
        }
        if (!this.client) {
            this.client = new S3Client({
                region: storageConfig.region,
                // Explicit key pair from the environment; the default chain (instance role) is not used
                credentials: {
                    accessKeyId: storageConfig.accessKeyId,
                    secretAccessKey: storageConfig.secretAccessKey,
                    sessionToken: storageConfig.sessionToken,
                },
                endpoint: storageConfig.endpoint,
                forcePathStyle: storageConfig.forcePathStyle,
                // S3-compatible servers often can't decode the SDK's default streaming checksums
                // (aws-chunked) and would store the framing as file content; AWS keeps defaults.
                ...(storageConfig.endpoint ? { requestChecksumCalculation: "WHEN_REQUIRED" as const, responseChecksumValidation: "WHEN_REQUIRED" as const } : {}),
            });
        }
        return this.client;
    }

    async put(input: PutObjectInput): Promise<void> {
        try {
            await this.s3().send(new PutObjectCommand({
                Bucket: storageConfig.bucket,
                Key: input.key,
                Body: input.body,
                ContentType: input.contentType,
                ContentLength: input.contentLength,
                Metadata: input.metadata,
                CacheControl: input.cacheControl,
            }));
        } catch (error) {
            throw this.wrap("upload", input.key, error);
        }
    }

    /** null when the object does not exist. */
    async head(key: string): Promise<StoredObjectInfo | null> {
        try {
            const out = await this.s3().send(new HeadObjectCommand({ Bucket: storageConfig.bucket, Key: key }));
            return {
                contentType: out.ContentType || "application/octet-stream",
                size: out.ContentLength ?? 0,
                metadata: out.Metadata || {},
            };
        } catch (error) {
            if (this.isNotFound(error)) {
                return null;
            }
            throw this.wrap("read", key, error);
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await this.s3().send(new DeleteObjectCommand({ Bucket: storageConfig.bucket, Key: key }));
        } catch (error) {
            throw this.wrap("delete", key, error);
        }
    }

    /**
     * Makes sure objects under `prefix` expire after `days` via an S3 lifecycle rule (so retention
     * does not depend on this app running). PutBucketLifecycleConfiguration replaces the whole
     * configuration, so the existing rules are read first and only our own rule is added/updated.
     */
    async ensureExpiryRule(prefix: string, days: number): Promise<void> {
        const id = `expire-${prefix.replace(/[^\w-]+/g, "-")}-${days}d`;
        let rules: any[] = [];
        try {
            const current = await this.s3().send(new GetBucketLifecycleConfigurationCommand({ Bucket: storageConfig.bucket }));
            rules = current.Rules || [];
        } catch (error) {
            // NoSuchLifecycleConfiguration just means there are no rules yet
            if (!(error instanceof S3ServiceException) || error.name !== 'NoSuchLifecycleConfiguration') {
                throw this.wrap('lifecycle-read', prefix, error);
            }
        }
        const mine = { ID: id, Status: 'Enabled' as const, Filter: { Prefix: prefix }, Expiration: { Days: days }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } };
        const existing = rules.find((r) => r.ID === id);
        if (existing && existing.Status === 'Enabled' && existing.Expiration?.Days === days && existing.Filter?.Prefix === prefix) {
            return;
        }
        rules = [...rules.filter((r) => r.ID !== id), mine];
        try {
            await this.s3().send(new PutBucketLifecycleConfigurationCommand({ Bucket: storageConfig.bucket, LifecycleConfiguration: { Rules: rules } }));
        } catch (error) {
            throw this.wrap('lifecycle-write', prefix, error);
        }
    }

    /** Stream an object to a local file (server-side processing; never exposed to clients). */
    async downloadToFile(key: string, file: string): Promise<void> {
        try {
            const out = await this.s3().send(new GetObjectCommand({ Bucket: storageConfig.bucket, Key: key }));
            if (!(out.Body instanceof Readable)) {
                throw new Error("Unexpected response body");
            }
            await pipeline(out.Body, fs.createWriteStream(file));
        } catch (error) {
            throw this.wrap("download", key, error);
        }
    }

    /** Best-effort delete for cleanup paths: never throws, logs failures. */
    async deleteQuietly(key: string | null | undefined): Promise<void> {
        if (!key) {
            return;
        }
        try {
            await this.delete(key);
        } catch {
            // already logged by wrap()
        }
    }

    /** Pre-signed GET URL (works with a fully private bucket). */
    async signedGetUrl(key: string, options: SignedUrlOptions): Promise<string> {
        try {
            return await getSignedUrl(
                this.s3(),
                new GetObjectCommand({ Bucket: storageConfig.bucket, Key: key, ResponseContentDisposition: options.contentDisposition }),
                { expiresIn: options.expiresInSeconds, signingDate: options.signingDate }
            );
        } catch (error) {
            throw this.wrap("sign", key, error);
        }
    }

    private isNotFound(error: unknown): boolean {
        const e = error as S3ServiceException & { $metadata?: { httpStatusCode?: number } };
        return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
    }

    private wrap(action: string, key: string, error: unknown): AppError {
        if (error instanceof AppError) {
            return error;
        }
        console.error(`[storage] ${action} failed for ${key}:`, error instanceof Error ? error.message : error);
        return new AppError("File storage is unavailable, please try again", 502);
    }
}

export default new StorageService();
