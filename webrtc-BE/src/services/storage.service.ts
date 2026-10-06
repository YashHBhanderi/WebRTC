import { Readable } from "stream";
import {
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
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
                new GetObjectCommand({ Bucket: storageConfig.bucket, Key: key }),
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
