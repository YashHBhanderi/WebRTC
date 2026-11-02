/**
 * Permissions (scopes) a developer application can be given. Nothing is granted by default; a user
 * token carries only scopes present in the app, the user's grant and the token request. Every REST
 * route and Socket.IO event an app token can reach names exactly one scope (routes/routes.ts,
 * routes/tenant.routes.ts, api/v1/*.routes.ts, SOCKET_EVENT_SCOPES below); everything else refuses
 * app tokens. The server still applies the user's own permissions (membership, roles, policies).
 *
 * UNAVAILABLE_SCOPES are listed so developers can see what is coming, but grant nothing yet and can't
 * be added to apps (see the phase notes in docs/developer/authentication.md).
 */
export const APP_SCOPES = {
    // ---- profile & people
    "profile:read": "Read the user's own profile (GET /v1/me, GET /web/user/me) and profiles of people visible to the user",
    "profile:write": "Update the user's profile (name, bio, picture) and set their presence status",
    "directory:read": "List and look up people the user can contact in the app's context (directory, contact lookup)",
    "contacts:write": "Start conversations with contacts found by lookup, and block or unblock people for the user",
    // ---- conversations & groups
    "conversations:read": "List the user's direct conversations and read their state (archived, favourite, unread)",
    "conversations:write": "Open direct conversations, external conversations, and archive / favourite / clear chats for the user",
    "conversations:delete": "Delete group conversations the user administers",
    "groups:read": "List the user's groups and read group details and members",
    "groups:write": "Create groups and update group name, description and picture",
    "groups:manage": "Add and remove group members, promote or demote admins, and leave groups for the user",
    // ---- messages
    "messages:read": "Read message history and metadata, search, receive message / typing / receipt events, send typing indicators and read / delivery receipts. Encrypted content is never included.",
    "messages:react": "Add or remove reactions, pin messages, and save (star) messages for the user",
    "messages:delete": "Delete the user's own messages",
    "messages:write": "Send end-to-end encrypted messages from an encryption device the app registers for the user (requires e2ee:device)",
    "messages:edit": "Edit the user's own end-to-end encrypted messages (requires e2ee:device)",
    "e2ee:device": "Register an end-to-end encryption device for the user. The app's device can read the user's messages in conversations it receives keys for; it is listed, labelled with the app's name, in the user's devices and can be revoked.",
    // ---- files
    "files:read": "List the user's files and the shared media of conversations (encrypted attachments stay encrypted)",
    "files:write": "Upload files (encrypted attachments, group and profile pictures) for the user",
    // ---- calls, meetings, recordings
    "calls:read": "Read the user's call history and the state of calls they are in",
    "calls:write": "Start, accept, reject, join, leave and end audio / video calls, including media and screen sharing",
    "calls:manage": "Host controls in calls the user hosts: mute, remove, admit, co-hosts and call settings",
    "meetings:read": "Read the user's scheduled meetings and meeting links",
    "meetings:write": "Schedule, update and cancel meetings, and join meetings by code",
    "recordings:read": "Read recordings of the user's conversations, transcripts and short-lived download links",
    "recordings:write": "Start and stop call recordings and retry transcriptions",
    // ---- notifications & search
    "notifications:read": "Read the user's notifications and unread count, and receive new-notification events",
    "notifications:write": "Mark the user's notifications as read",
    "search:read": "Search across the user's people, conversations, messages and files",
    // ---- organizations
    "organizations:read": "Read the user's organizations, workspaces, members, teams and channels, and their invitations",
    "organizations:write": "Create and join organizations, request to join, accept invitations, and create or join teams and channels",
    "organizations:manage": "Administer workspaces the user administers: members, roles, invitations, join requests, settings, teams and channels (the user's own role still applies)",
    // ---- realtime
    "realtime:connect": "Open a Socket.IO connection and receive presence of people visible in the app's context",
} as const;

export type AppScope = keyof typeof APP_SCOPES;

export const ALL_SCOPES = Object.keys(APP_SCOPES) as AppScope[];

/** Listed, but grant nothing yet (their functionality ships in a later phase) and can't be added to apps */
export const UNAVAILABLE_SCOPES: ReadonlySet<string> = new Set<AppScope>([
    "messages:write", "messages:edit", "e2ee:device",
]);

export function isScope(value: unknown): value is AppScope {
    return typeof value === "string" && value in APP_SCOPES;
}

/**
 * Socket.IO events an app socket may send, by scope. Unlisted events are refused for app sockets.
 * The handlers are the same as for SpreeWe's own clients, with the same membership / role checks.
 */
export const SOCKET_EVENT_SCOPES: Record<string, AppScope> = {
    // conversations & rooms
    joinConversation: "messages:read",
    typing: "messages:read",
    stopTyping: "messages:read",
    markMessagesRead: "messages:read",
    "message:delivered": "messages:read",
    "chat:archive": "conversations:write",
    "chat:unarchive": "conversations:write",
    "chat:favorite": "conversations:write",
    "chat:unfavorite": "conversations:write",
    "chat:clear": "conversations:write",
    "chat:block": "contacts:write",
    "chat:unblock": "contacts:write",
    // messages
    sendMessage: "messages:write",
    "message:edit": "messages:edit",
    reactToMessage: "messages:react",
    "message:pin": "messages:react",
    // presence
    "presence:set": "profile:write",
    "presence:idle": "profile:write",
    // groups
    "group:update": "groups:write",
    "group:add-member": "groups:manage",
    "group:remove-member": "groups:manage",
    "group:promote-admin": "groups:manage",
    "group:remove-admin": "groups:manage",
    "group:leave": "groups:manage",
    // calls: state
    "call:getState": "calls:read",
    "call:getActive": "calls:read",
    "call:session": "calls:read",
    // calls: taking part (signaling, media, screen sharing)
    "call:start": "calls:write",
    "call:accept": "calls:write",
    "call:reject": "calls:write",
    "call:leave": "calls:write",
    "call:end": "calls:write",
    "call:upgrade": "calls:write",
    "call:media-state": "calls:write",
    "call:hand": "calls:write",
    "call:reaction": "calls:write",
    "call:takeover": "calls:write",
    "ice:getServers": "calls:write",
    "mediasoup:getRouterRtpCapabilities": "calls:write",
    "mediasoup:joinCall": "calls:write",
    "mediasoup:createSendTransport": "calls:write",
    "mediasoup:createRecvTransport": "calls:write",
    "mediasoup:connectTransport": "calls:write",
    "mediasoup:restartIce": "calls:write",
    "mediasoup:produce": "calls:write",
    "mediasoup:closeProducer": "calls:write",
    "mediasoup:consume": "calls:write",
    "mediasoup:resumeConsumer": "calls:write",
    "mediasoup:setPreferredLayers": "calls:write",
    "mediasoup:syncProducers": "calls:write",
    "screen:join": "calls:write",
    "screen:start": "calls:write",
    "screen:stop": "calls:write",
    "screen:getState": "calls:write",
    // calls: host controls (the server checks that the user hosts / co-hosts the call)
    "call:mute-participant": "calls:manage",
    "call:mute-all": "calls:manage",
    "call:remove-participant": "calls:manage",
    "call:admit": "calls:manage",
    "call:deny": "calls:manage",
    "call:set-cohost": "calls:manage",
    "call:settings": "calls:manage",
    // recording control (the server checks who may record)
    "call:record-start": "recordings:write",
    "call:record-stop": "recordings:write",
};

/**
 * Events delivered to app sockets, by scope (direct and room deliveries alike, see io.ts). Unlisted
 * events are withheld from app sockets.
 */
export const DELIVERED_EVENT_SCOPES: Record<string, AppScope> = {
    // messages & conversations
    receiveMessage: "messages:read",
    "message:updated": "messages:read",
    "message:deleted": "messages:read",
    "message:rejected": "messages:read",
    "message:pins": "messages:read",
    messageReactionUpdated: "messages:read",
    messagesMarkedRead: "messages:read",
    "receipts:updated": "messages:read",
    userTyping: "messages:read",
    // groups
    "group:added": "groups:read",
    "group:removed": "groups:read",
    "group:updated": "groups:read",
    // presence & connection
    "user:presence": "realtime:connect",
    "rate-limited": "realtime:connect",
    // notifications
    "notification:new": "notifications:read",
    "notification:read": "notifications:read",
    // meetings & recordings
    "meeting:updated": "meetings:read",
    "recording:updated": "recordings:read",
    "call:recording": "recordings:read",
    // calls: invitations and lifecycle
    "call:incoming": "calls:read",
    "call:pending-rings": "calls:read",
    "call:meeting-active": "calls:read",
    "call:started": "calls:read",
    "call:ended": "calls:read",
    "call:participant-joined": "calls:read",
    "call:participant-left": "calls:read",
    "call:participant-rejected": "calls:read",
    "call:error": "calls:read",
    // calls: in-call (media and controls)
    "call:media-updated": "calls:write",
    "call:settings": "calls:write",
    "call:lobby": "calls:write",
    "call:admitted": "calls:write",
    "call:denied": "calls:write",
    "call:removed": "calls:write",
    "call:force-muted": "calls:write",
    "call:force-leave": "calls:write",
    "call:audio-levels": "calls:write",
    "call:hand": "calls:write",
    "call:reaction": "calls:write",
    "call:share-stopped": "calls:write",
    "mediasoup:newProducer": "calls:write",
    "mediasoup:producerClosed": "calls:write",
    "screen:started": "calls:write",
    "screen:stopped": "calls:write",
};
