/**
 * Shapes of the SpreeWe activity feed, as the server sends them (checked against
 * webrtc-BE/src/models/notificationModel.ts and NotificationService.present() in
 * webrtc-BE/src/services/notification.service.ts).
 */

/** Every type the server creates (NOTIFICATION_TYPES in notificationModel.ts). */
export const NOTIFICATION_TYPES = ["mention", "reply", "reaction", "missed-call", "meeting-invite", "meeting-reminder", "recording"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Server-side views of GET /notifications (`view` query): everything, not yet read, or @mentions only. */
export type NotificationView = "all" | "unread" | "mentions";

export interface NotificationActor {
    _id: string;
    username: string;
    avatar?: string;
}

/** One activity entry (GET /notifications item and the `notification:new` payload). */
export interface SpreeWeNotification {
    _id: string;
    /** A type from NOTIFICATION_TYPES; future server types arrive as plain strings */
    type: NotificationType | (string & {});
    /** Who caused it (null for system entries such as meeting reminders and recordings) */
    actor: NotificationActor | null;
    conversationId: string | null;
    messageId: string | null;
    callId: string | null;
    meetingId: string | null;
    recordingId: string | null;
    /**
     * Short server-made preview (at most 140 characters): an emoji for reactions, "Video call" /
     * "Audio call" for missed calls, the meeting title, a recording milestone. For mentions and
     * replies in end-to-end encrypted chats it is a fixed "New message": the server can't read them.
     */
    text: string;
    read: boolean;
    createdAt: string;
}

export interface NotificationFeedState {
    view: NotificationView;
    /** Newest first */
    items: SpreeWeNotification[];
    loading: boolean;
    loadingMore: boolean;
    /** True once the first page arrived */
    loaded: boolean;
    hasMore: boolean;
    error: Error | null;
}
