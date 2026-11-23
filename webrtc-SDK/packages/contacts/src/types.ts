import type { DirectoryEntry, PresenceStatus, PresenceUpdate } from "@spreewe/core";

/**
 * Contact shapes as the backend sends them (checked against webrtc-BE/src/contacts/contact.service.ts,
 * controllers/userController.ts, services/presence.service.ts and realtime/gateways/chat.gateway.ts).
 */

/** Organization context only: "member" = inside the organization (default), "external" = outside it. */
export type ContactScope = "member" | "external";

/** POST /v1/contacts/lookup */
export interface ContactLookupResult {
    found: boolean;
    /** Set when not found. Unregistered, blocked, opted-out and unavailable people all get the same answer. */
    message?: string;
    user?: { _id: string; username: string; avatar: string };
    /** Starting a chat would create (or reuse) an external conversation */
    external?: boolean;
    /** Already talking: the existing direct conversation (null for external lookups) */
    conversationId?: string | null;
}

/** POST /v1/contacts/start */
export interface StartedConversation {
    conversationId: string;
    external: boolean;
}

/** GET /web/user/:userId for someone else (webrtc-BE tenancy DIRECTORY_FIELDS) */
export interface ContactProfile {
    _id: string;
    username: string;
    avatar?: string;
    bio?: string;
    isOnline?: boolean;
    lastSeen?: string | null;
    status?: string;
    statusMessage?: string;
    autoAway?: boolean;
}

/** GET /web/user/me: the signed-in user's own account, with their real chosen status */
export interface MyProfile {
    _id: string;
    username: string;
    email?: string;
    avatar?: string;
    bio?: string;
    status?: PresenceStatus;
    statusMessage?: string;
    /** Personal context: whether others can find this account by e-mail */
    globalDiscoverable?: boolean;
    isOnline?: boolean;
    lastSeen?: string | null;
}

/** PATCH /web/user/profile (multipart). Only the fields given are sent. */
export interface ProfileUpdate {
    /** 3–30 characters: letters, numbers, spaces and . _ ' - */
    username?: string;
    /** Up to 160 characters */
    bio?: string;
    /** JPG, PNG, GIF or WebP, up to 5 MB */
    image?: Blob;
    /** Personal context: let others find me by e-mail */
    globalDiscoverable?: boolean;
}

/** Ack of `presence:set`: my presence as others see it, plus my real chosen status. */
export interface MyPresence extends PresenceUpdate {
    status: Exclude<PresenceStatus, "Appear offline">;
    statusMessage: string;
    ownStatus: PresenceStatus;
}

/** Ack of `chat:block` / `chat:unblock` */
export interface BlockResult {
    userId: string;
    blocked: boolean;
}

export interface DirectoryState {
    q: string;
    items: DirectoryEntry[];
    loading: boolean;
    loaded: boolean;
    error: Error | null;
    nextCursor: string | null;
    /** No more pages */
    done: boolean;
}
