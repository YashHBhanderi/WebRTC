import type { EncryptedPayload, SecureFile } from "@spreewe/core";

/**
 * Shapes of the SpreeWe file endpoints, checked against webrtc-BE/src/services/search.service.ts
 * (files(), GET /files), message.service.ts (sharedMedia(), GET /conversations/:id/media) and
 * file.service.ts (messageMedia()).
 */

/** Media kinds the server files attachments under (MEDIA_TYPES / the `type` query of GET /files) */
export const FILE_KINDS = ["image", "video", "audio", "pdf", "file"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

/** GET /files item, as sent */
export interface RawLibraryFile {
    _id: string;
    conversationId: string;
    conversationTitle?: string;
    type: FileKind;
    createdAt: string;
    user: { _id: string; username?: string; avatar?: string } | null;
    fileUrl?: string;
    thumbnailUrl?: string;
    downloadUrl?: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    /** End-to-end encrypted attachment: the links point at ciphertext; GET /files never includes the message's `e2ee` */
    encrypted?: boolean;
}

/** GET /conversations/:conversationId/media item, as sent */
export interface RawSharedMedia {
    _id: string;
    conversationId: string;
    userId: string;
    /** The message's ciphertext (present for SpreeWe sessions and apps with e2ee:device) */
    e2ee?: EncryptedPayload;
    /** Set when the attachment is encrypted, or when the server withheld the ciphertext from the app */
    encrypted?: boolean;
    content?: null;
    type: FileKind;
    createdAt: string;
    fileUrl?: string;
    thumbnailUrl?: string;
    downloadUrl?: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
}

/**
 * What the SDK knows about an item:
 * - "ok": name and type known; downloadable (decrypted on this device when encrypted)
 * - "pending": encrypted, and this device is waiting for the message key (retried automatically)
 * - "locked": encrypted, and the client has no ready encryption device (@spreewe/e2ee)
 * - "withheld": encrypted, and the server doesn't share the ciphertext with this app (no e2ee:device)
 * - "unavailable": encrypted, and its message couldn't be found to read the key (see README)
 * - "failed": the message couldn't be decrypted on this device
 */
export type FileState = "ok" | "pending" | "locked" | "withheld" | "unavailable" | "failed";

export interface FileItem {
    /** The message id */
    id: string;
    conversationId: string;
    /** Chat name (GET /files only) */
    conversationTitle?: string;
    kind: FileKind;
    createdAt: string;
    senderId: string;
    sender?: { _id: string; username?: string; avatar?: string };
    encrypted: boolean;
    state: FileState;
    /** File name: decrypted for encrypted items; "" while unknown */
    name: string;
    /** Real content type: decrypted for encrypted items; "" while unknown */
    mimeType: string;
    /** Bytes as stored (ciphertext size for encrypted items until decrypted) */
    size?: number;
    /** Caption sent with the file (encrypted items, once decrypted) */
    caption?: string;
    /** Signed link for inline display (plaintext items; "" for download-only documents) */
    url?: string;
    /** Signed link to download (ciphertext for encrypted items) */
    downloadUrl?: string;
    /** Signed thumbnail link (plaintext images and videos only) */
    thumbnailUrl?: string;
    /** Decryption info from inside the encrypted message (never sent to the server) */
    secure?: SecureFile;
    /** Why the item isn't "ok", for display */
    reason?: string;
}

export interface FileCollectionState {
    items: FileItem[];
    loading: boolean;
    loadingMore: boolean;
    loaded: boolean;
    hasMore: boolean;
    error: Error | null;
}
