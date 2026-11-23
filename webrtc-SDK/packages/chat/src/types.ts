import type { Message, SecureFile, UserSummary } from "@spreewe/core";

/** How a message's body could be read on this device */
export type BodyState =
    /** Plaintext (system / call notices) or decrypted */
    | "ok"
    /** Waiting for the room key (it travels separately); retried automatically */
    | "pending"
    /** Can't be decrypted on this device (sent before the device existed, or tampered) */
    | "failed"
    /** No encryption device: enable @spreewe/e2ee (and the e2ee:device scope) to read it */
    | "locked"
    /** The server withheld the ciphertext: this app lacks the e2ee:device scope */
    | "withheld";

export interface AttachmentView {
    name: string;
    size?: number;
    mimeType: string;
    kind: "image" | "video" | "audio" | "pdf" | "file";
    /** Object URL of the decrypted file once loaded */
    url?: string;
    state: "idle" | "loading" | "ready" | "error";
    error?: string;
    /** Present for end-to-end encrypted attachments */
    secure?: SecureFile;
    /** Signed link to the ciphertext (encrypted) or the file (legacy plaintext) */
    sourceUrl?: string;
}

/** A message ready to display: server fields plus what this device could read. */
export interface ChatMessage extends Message {
    /** Text to display (decrypted, or the plaintext notice) */
    text: string;
    bodyState: BodyState;
    /** Sender device unverified or unknown */
    warning?: string;
    attachment?: AttachmentView;
    quote?: { messageId: string; authorId: string; text: string; bodyState: BodyState };
    /** Sent from this client, not yet confirmed by the server */
    local?: "sending" | "failed";
    failure?: string;
}

export interface ConversationSummary {
    id: string;
    isGroup: boolean;
    title: string;
    avatar?: string;
    /** Direct chats: the other person */
    peer?: UserSummary;
    /** Group chats: members (as listed by the server) */
    members?: UserSummary[];
    admins?: string[];
    description?: string;
    scope?: "global" | "tenant" | "external";
    unread: number;
    isFavorite: boolean;
    isArchived: boolean;
    /** Preview of the last message (decrypted when possible) */
    preview: string;
    previewState: BodyState;
    lastMessageAt?: string;
    lastMessageAuthorId?: string;
    lastMessageStatus?: "sent" | "delivered" | "seen";
    lastMessageType?: string;
}

export interface ConversationListState {
    items: ConversationSummary[];
    loading: boolean;
    loaded: boolean;
    error: Error | null;
    /** Groups couldn't be listed (token without groups:read) */
    groupsUnavailable: boolean;
}

export interface MessagesState {
    items: ChatMessage[];
    loading: boolean;
    loadingOlder: boolean;
    hasOlder: boolean;
    error: Error | null;
}

export interface SendOptions {
    replyTo?: string | null;
    /** Member user ids mentioned in the text */
    mentions?: string[];
}

/** Why the user can't send in this conversation, or null when they can */
export type SendBlocker = null | { reason: "no-e2ee" | "e2ee-starting" | "e2ee-error" | "missing-scope" | "blocked" | "not-member"; message: string };
