import crypto from "crypto";
import fs from "fs";
import path from "path";
import storage from "./storage.service";
import Message from "../models/messageModel";
import { storageConfig } from "../config/storage";
import { IStoredFile } from "../models/storedFile.schema";
import { compatibleMimeTypes, readHead } from "../utils/file-signature";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";

/**
 * App-level file rules on top of the storage service: what may be uploaded where, how objects
 * are named, who may attach them, and which URLs clients get.
 *
 * Object keys (prefix = STORAGE_KEY_PREFIX, e.g. "production"):
 *   {prefix}/users/{userId}/avatar/{uuid}.{ext}                                   profile pictures
 *   {prefix}/groups/{groupId}/avatar/{uuid}.{ext}                                 group photos
 *   {prefix}/conversations/{conversationId}/{images|videos|audio|documents}/{yyyy}/{mm}/{uuid}.{ext}
 *
 * Profile and group pictures get a stable, unguessable link (they are shown to every signed-in
 * user, as before). Chat attachments are private: each response carries a signed, expiring link.
 * Both kinds of link point at GET /files/*, which redirects to a short-lived S3 pre-signed URL.
 */

const MB = 1024 * 1024;

export type MediaKind = "image" | "video" | "audio" | "pdf";

interface KindRule {
    folder: string;
    maxBytes: number;
    /** Accepted MIME type → file extension used in the key. */
    types: Record<string, string>;
}

const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };

export const MEDIA_RULES: Record<MediaKind, KindRule> = {
    image: { folder: "images", maxBytes: 10 * MB, types: IMAGE_TYPES },
    video: { folder: "videos", maxBytes: 100 * MB, types: { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" } },
    audio: {
        folder: "audio",
        maxBytes: 25 * MB,
        types: {
            "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a",
            "audio/aac": "aac", "audio/ogg": "ogg", "audio/webm": "weba", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
        },
    },
    pdf: { folder: "documents", maxBytes: 25 * MB, types: { "application/pdf": "pdf" } },
};

const AVATAR_RULE: KindRule = { folder: "avatar", maxBytes: 5 * MB, types: IMAGE_TYPES };

/** Outer cap for multer; the per-kind limits above are stricter. */
export const MAX_UPLOAD_BYTES = Math.max(...Object.values(MEDIA_RULES).map((r) => r.maxBytes), AVATAR_RULE.maxBytes);

const FOLDER_KIND: Record<string, MediaKind> = { images: "image", videos: "video", audio: "audio", documents: "pdf" };

export type UploadTarget =
    | { purpose: "avatar"; userId: string }
    | { purpose: "group-avatar"; groupId: string }
    | { purpose: "message"; conversationId: string };

export interface StoredUpload {
    stored: IStoredFile;
    kind: MediaKind;
}

// ------------------------------------------------------------------ keys

const P = storageConfig.keyPrefix;
const OID = "[a-f0-9]{24}";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EXT = "[a-z0-9]{2,5}";
const AVATAR_KEY = new RegExp(`^${P}/(users|groups)/(${OID})/avatar/${UUID}\\.${EXT}$`);
const MESSAGE_KEY = new RegExp(`^${P}/conversations/(${OID})/(images|videos|audio|documents)/\\d{4}/\\d{2}/${UUID}\\.${EXT}$`);

/** Only keys this service creates are ever served, attached or deleted. */
export function isManagedKey(key: string): boolean {
    return AVATAR_KEY.test(key) || MESSAGE_KEY.test(key);
}

export function isPublicKey(key: string): boolean {
    return AVATAR_KEY.test(key);
}

function buildKey(target: UploadTarget, rule: KindRule, ext: string): string {
    const id = crypto.randomUUID();
    switch (target.purpose) {
        case "avatar":
            return `${P}/users/${target.userId}/avatar/${id}.${ext}`;
        case "group-avatar":
            return `${P}/groups/${target.groupId}/avatar/${id}.${ext}`;
        case "message": {
            const now = new Date();
            const month = String(now.getUTCMonth() + 1).padStart(2, "0");
            return `${P}/conversations/${target.conversationId}/${rule.folder}/${now.getUTCFullYear()}/${month}/${id}.${ext}`;
        }
    }
}

// ------------------------------------------------------------------ upload

function kindForMime(mime: string): MediaKind | null {
    return (Object.keys(MEDIA_RULES) as MediaKind[]).find((k) => mime in MEDIA_RULES[k].types) ?? null;
}

/** multer/busboy hands non-ASCII names over as latin1; recover UTF-8 and strip anything unsafe. */
function cleanOriginalName(name: string): string {
    let value = name || "file";
    const utf8 = Buffer.from(value, "latin1").toString("utf8");
    if (!utf8.includes("�")) {
        value = utf8;
    }
    return path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) || "file";
}

function decodeName(value: string | undefined): string {
    try {
        return value ? decodeURIComponent(value) : "";
    } catch {
        return "";
    }
}

/**
 * Validate a spooled upload (type allow-list, size, content sniffing), stream it to storage
 * under a fresh unique key, and remove the temp file. Nothing is written to the database here.
 */
export async function storeUpload(file: Express.Multer.File | undefined, target: UploadTarget, uploaderId: string): Promise<StoredUpload> {
    try {
        if (!file) {
            throw new AppError("No file uploaded");
        }
        const mimeType = (file.mimetype || "").toLowerCase();
        const kind = kindForMime(mimeType);
        const isAvatar = target.purpose !== "message";
        const rule = isAvatar ? AVATAR_RULE : kind ? MEDIA_RULES[kind] : null;
        const ext = rule?.types[mimeType];
        if (!rule || !ext || !kind) {
            throw new AppError(isAvatar
                ? "Please choose a JPG, PNG, GIF or WebP image"
                : "Unsupported file type. Please upload an image, video, audio or PDF file.", 415);
        }
        if (!file.size) {
            throw new AppError("The file is empty");
        }
        if (file.size > rule.maxBytes) {
            throw new AppError(`File is too large (max ${Math.round(rule.maxBytes / MB)} MB for this type)`, 413);
        }
        if (!compatibleMimeTypes(await readHead(file.path)).has(mimeType)) {
            throw new AppError("The file's content does not match its type", 415);
        }

        const originalName = cleanOriginalName(file.originalname);
        const key = buildKey(target, rule, ext);
        await storage.put({
            key,
            body: fs.createReadStream(file.path),
            contentType: mimeType,
            contentLength: file.size,
            metadata: { "uploader-id": uploaderId, "original-name": encodeURIComponent(originalName) },
            // Keys are never reused, so the object itself can be cached for good
            cacheControl: "private, max-age=31536000, immutable",
        });
        return {
            stored: { storageKey: key, storageProvider: storageConfig.provider, mimeType, originalName, size: file.size },
            kind,
        };
    } finally {
        if (file?.path) {
            await fs.promises.rm(file.path, { force: true }).catch(() => undefined);
        }
    }
}

// ------------------------------------------------------------------ attach (verify a key a client sent back)

async function verifiedObject(key: string, uploaderId: string): Promise<IStoredFile> {
    const info = await storage.head(key);
    if (!info) {
        throw new NotFoundError("The uploaded file was not found, please upload it again");
    }
    if (info.metadata["uploader-id"] !== String(uploaderId)) {
        throw new ForbiddenError("You can only attach files you uploaded");
    }
    return {
        storageKey: key,
        storageProvider: storageConfig.provider,
        mimeType: info.contentType,
        originalName: decodeName(info.metadata["original-name"]),
        size: info.size,
    };
}

/** A chat attachment: must be in this conversation's folder and uploaded by this user. */
export async function attachMessageFile(key: unknown, conversationId: string, uploaderId: string): Promise<{ file: IStoredFile; type: MediaKind }> {
    const match = typeof key === "string" ? MESSAGE_KEY.exec(key) : null;
    if (!match || match[1] !== String(conversationId)) {
        throw new ForbiddenError("This file does not belong to this conversation");
    }
    return { file: await verifiedObject(match[0], uploaderId), type: FOLDER_KIND[match[2]] };
}

/** A group photo uploaded for this group by this user. */
export async function attachGroupAvatar(key: unknown, groupId: string, uploaderId: string): Promise<IStoredFile> {
    const match = typeof key === "string" ? AVATAR_KEY.exec(key) : null;
    if (!match || match[1] !== "groups" || match[2] !== String(groupId)) {
        throw new ForbiddenError("This photo does not belong to this group");
    }
    return verifiedObject(match[0], uploaderId);
}

// ------------------------------------------------------------------ links

function sign(key: string, exp: number): string {
    return crypto.createHmac("sha256", storageConfig.fileUrlSecret).update(`${key}\n${exp}`).digest("base64url");
}

/** Stable link for profile/group pictures (safe to store in the database). */
export function publicFileUrl(key: string): string {
    return `${storageConfig.fileUrlBase}/files/${key}`;
}

/**
 * Signed, expiring link for a private file. The expiry is aligned to a time window, so the same
 * file gets the same URL for a while and the browser can reuse its cached copy.
 */
export function signedFileUrl(key: string, nowMs = Date.now()): string {
    const window = Math.max(60, Math.floor(storageConfig.fileUrlTtlSeconds / 2));
    const exp = (Math.floor(nowMs / 1000 / window) + 2) * window;
    return `${storageConfig.fileUrlBase}/files/${key}?exp=${exp}&sig=${sign(key, exp)}`;
}

export function verifySignedFileUrl(key: string, exp: unknown, sig: unknown, nowMs = Date.now()): boolean {
    const expiry = Number(exp);
    if (!Number.isInteger(expiry) || expiry * 1000 < nowMs || typeof sig !== "string") {
        return false;
    }
    const expected = Buffer.from(sign(key, expiry));
    const given = Buffer.from(sig);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

/** Short-lived S3 URL for a redirect; window-aligned so repeated requests reuse one URL. */
export async function storageRedirect(key: string, nowMs = Date.now()): Promise<{ url: string; cacheSeconds: number }> {
    const ttl = Math.max(120, storageConfig.s3UrlTtlSeconds);
    const window = Math.floor(ttl / 2);
    const signingDate = new Date(Math.floor(nowMs / 1000 / window) * window * 1000);
    const url = await storage.signedGetUrl(key, { expiresInSeconds: ttl, signingDate });
    // The pre-signed URL stays valid for at least `window` more seconds
    return { url, cacheSeconds: Math.max(0, window - 30) };
}

/** URL fields a client renders for a message (signed for stored files, as-is for legacy/call links). */
export function messageMedia(m: { file?: IStoredFile | null; fileUrl?: string; thumbnailUrl?: string }) {
    if (m.file?.storageKey) {
        const url = signedFileUrl(m.file.storageKey);
        return { fileUrl: url, thumbnailUrl: url, fileName: m.file.originalName, fileSize: m.file.size, mimeType: m.file.mimeType };
    }
    return { fileUrl: m.fileUrl || "", thumbnailUrl: m.thumbnailUrl || m.fileUrl || "" };
}

// ------------------------------------------------------------------ cleanup

/** Delete a stored avatar/group photo (no other document references these). */
export async function releaseFile(file: IStoredFile | null | undefined): Promise<void> {
    if (file?.storageKey && isManagedKey(file.storageKey)) {
        await storage.deleteQuietly(file.storageKey);
    }
}

/** Delete message attachments that no visible message references any more (forwards share objects). */
export async function releaseMessageFiles(keys: (string | undefined | null)[]): Promise<void> {
    for (const key of new Set(keys.filter((k): k is string => !!k && isManagedKey(k)))) {
        const stillUsed = await Message.exists({ "file.storageKey": key, isDeleted: { $ne: true } });
        if (!stillUsed) {
            await storage.deleteQuietly(key);
        }
    }
}
