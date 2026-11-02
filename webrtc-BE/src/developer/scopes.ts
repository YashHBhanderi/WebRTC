/**
 * Scopes an app can be given. Only capabilities that exist are listed; anything not here (group
 * calls, media, uploads, recording control, workspace administration, app management) is not
 * available to app tokens at all. Nothing is granted by default.
 */
export const APP_SCOPES = {
    "profile:read": "Read the user's own profile (GET /v1/me)",
    "directory:read": "List people the user can contact in the app's context (GET /v1/directory)",
    "conversations:read": "List the user's conversations (GET /v1/conversations)",
    "messages:read": "Read messages (GET /v1/conversations/{id}/messages) and receive new / edited / deleted message events over Socket.IO",
    "messages:write": "Not available: messages are end-to-end encrypted on the user's own devices, so apps cannot send them (every app sendMessage is refused). Reserved.",
    "calls:read": "Read the user's call history (GET /v1/calls)",
    "recordings:read": "Read recording details and short-lived download links (GET /v1/recordings/{id})",
    "realtime:connect": "Open a Socket.IO connection; receive presence of people visible in the app's context",
} as const;

export type AppScope = keyof typeof APP_SCOPES;

/** Scopes that exist but grant nothing today (shown as unavailable in the portal and consent) */
export const UNAVAILABLE_SCOPES: ReadonlySet<string> = new Set(["messages:write"]);

export const ALL_SCOPES = Object.keys(APP_SCOPES) as AppScope[];

export function isScope(value: unknown): value is AppScope {
    return typeof value === "string" && value in APP_SCOPES;
}

/**
 * Socket.IO events an app socket may send, by scope. Every other event (calls, media, groups,
 * archive, receipts, presence:set …) is refused for app sockets.
 */
export const SOCKET_EVENT_SCOPES: Record<string, AppScope> = {
    // App sockets never join rooms, so room-based events (joinConversation, typing) are not offered
    sendMessage: "messages:write",
};

/** Events delivered to app sockets, by scope; everything else is withheld. */
export const DELIVERED_EVENT_SCOPES: Record<string, AppScope> = {
    receiveMessage: "messages:read",
    "message:updated": "messages:read",
    "message:deleted": "messages:read",
    "user:presence": "realtime:connect",
    "rate-limited": "realtime:connect",
};
