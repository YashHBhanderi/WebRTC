/**
 * Shapes returned by the SpreeWe backend, as the server sends them (checked against
 * webrtc-BE/src/services/conversationService.ts, message.service.ts, userServices.ts and the /v1
 * route registry). Fields the server may omit are optional.
 */

export interface UserSummary {
    _id: string;
    username: string;
    email?: string;
    avatar?: string;
    isOnline?: boolean;
    lastSeen?: string;
    bio?: string;
    status?: string;
    statusMessage?: string;
}

/** GET /v1/me */
export interface Me {
    user: { _id: string; username: string; email?: string; avatar?: string; globalDiscoverable?: boolean };
    context: { tenantId: string | null; role: "owner" | "admin" | "member" | null };
}

/** End-to-end encrypted body (Megolm). The server never sees the plaintext. */
export interface EncryptedPayload {
    algorithm: "m.megolm.v1.aes-sha2";
    ciphertext: string;
    session_id: string;
    sender_key: string;
    device_id: string;
}

export type MessageType = "text" | "image" | "video" | "audio" | "pdf" | "file" | "call" | "system" | "recording";

export interface Reaction {
    userId: string;
    emoji: string;
}

export interface QuotedMessage {
    _id: string;
    content: string | null;
    e2ee?: EncryptedPayload;
    encrypted?: boolean;
    type: MessageType;
    userId: string;
}

/** A message from history (GET /messages/:conversationId) or a live `receiveMessage` event. */
export interface Message {
    _id: string;
    conversationId: string;
    userId: string;
    user?: Partial<UserSummary>;
    /** "" for encrypted messages, plaintext for system / call notices, null for apps without e2ee:device */
    content: string | null;
    e2ee?: EncryptedPayload;
    /** Set by the server for apps without e2ee:device: the content exists but isn't shared with the app */
    encrypted?: boolean;
    type: MessageType;
    isDeleted?: boolean;
    status?: "sent" | "delivered" | "seen";
    isRead?: boolean;
    editedAt?: string | null;
    mentions?: string[];
    saved?: boolean;
    reactions?: Reaction[];
    replyTo?: QuotedMessage | null;
    call?: { callId: string; callType: "audio" | "video"; mode: "ring" | "meetNow"; duration: number; outcome?: "missed" } | null;
    recording?: { recordingId: string } | null;
    /** Signed links to the (encrypted) attachment */
    fileUrl?: string;
    thumbnailUrl?: string;
    downloadUrl?: string;
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    createdAt: string;
}

/** Last message preview in conversation lists */
export interface LastMessage {
    _id: string;
    userId: string;
    content: string | null;
    e2ee?: EncryptedPayload;
    encrypted?: boolean;
    type: MessageType;
    status?: "sent" | "delivered" | "seen";
    isRead?: boolean;
    createdAt: string;
}

interface ConversationBase {
    _id: string;
    scope?: "global" | "tenant" | "external";
    externalParticipants?: string[];
    unreadCount?: number;
    isArchived?: boolean;
    isFavorite?: boolean;
    lastMessage: LastMessage | null;
    timestamp?: string;
}

/** GET /conversations item */
export interface DirectConversation extends ConversationBase {
    isGroup: false;
    sender?: UserSummary;
    /** The other person */
    receiver?: UserSummary;
}

/** GET /groupConversations item */
export interface GroupConversation extends ConversationBase {
    isGroup: true;
    groupName: string;
    groupAvatar?: string;
    groupDescription?: string;
    groupAdmin?: string;
    groupAdmins: string[];
    members: UserSummary[];
}

export type Conversation = DirectConversation | GroupConversation;

/** GET /v1/directory item */
export interface DirectoryEntry {
    _id: string;
    username: string;
    avatar?: string;
    isOnline?: boolean;
    status?: string;
    statusMessage?: string;
}

/** `user:presence` payload */
export interface PresenceUpdate {
    userId: string;
    isOnline: boolean;
    status?: string;
    statusMessage?: string;
    autoAway?: boolean;
    inCall?: boolean;
    [key: string]: unknown;
}

export const PRESENCE_STATUSES = ["Available", "Busy", "Do not disturb", "Away", "Appear offline"] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

/** GET /config (public) */
export interface PublicConfig {
    s3BaseUrl?: string;
    clerkPublishableKey?: string;
}
