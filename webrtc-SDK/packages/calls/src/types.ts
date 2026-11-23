export type CallType = "audio" | "video";
export type CallMode = "ring" | "meetNow";

/** A call announced to this user (ringing, or a group "meet now" call they can join) */
export interface CallInvite {
    callId: string;
    /** Conversation the call belongs to */
    conversationId: string;
    callType: CallType;
    mode: CallMode;
    initiatedBy: string;
    /** "ring" invites ring; "active" invites are calls in progress the user can join */
    kind: "ring" | "active";
}

export type CallPhase =
    /** No call */
    | "idle"
    /** Starting a call (waiting for call:started) */
    | "starting"
    /** Getting media and joining the media server */
    | "joining"
    /** Waiting for a host to admit you */
    | "lobby"
    /** In the call */
    | "connected"
    /** Connection lost; rejoining */
    | "reconnecting"
    /** In the call on another device (use takeOver()) */
    | "elsewhere"
    /** The call ended or you left; see `endReason` */
    | "ended";

export interface Participant {
    userId: string;
    /** Remote camera / microphone tracks combined (attach to a <video> or <audio>) */
    stream: MediaStream | null;
    /** Remote screen share */
    screen: MediaStream | null;
    hasAudio: boolean;
    hasVideo: boolean;
    handRaised: boolean;
    /** 0..1, from call:audio-levels */
    level: number;
    /** Last reaction emoji (cleared after a few seconds) */
    reaction?: string;
}

export interface CallSettings {
    lobby?: boolean;
    allowUnmute?: boolean;
    allowShare?: boolean;
    [key: string]: unknown;
}

export interface CallState {
    phase: CallPhase;
    callId: string | null;
    conversationId: string | null;
    callType: CallType;
    mode: CallMode | null;
    initiatedBy: string | null;
    /** Epoch ms when the call (not just your session) started, when known */
    startedAt: number | null;
    /** Your role: host / cohost / attendee (from call:getState) */
    role: string | null;
    hostIds: string[];
    cohostIds: string[];
    settings: CallSettings;
    /** Waiting in the lobby (moderators only) */
    lobby: { userId: string }[];
    participants: Participant[];
    local: {
        stream: MediaStream | null;
        screen: MediaStream | null;
        audio: boolean;
        video: boolean;
        sharing: boolean;
        handRaised: boolean;
    };
    /** User id of the person sharing their screen, if anyone */
    screenSharerUserId: string | null;
    recording: { active: boolean; startedAt?: string; byName?: string } | null;
    /** Media connection health: worst state of the two transports */
    connection: "new" | "connecting" | "connected" | "disconnected" | "failed";
    endReason?: "left" | "ended" | "removed" | "denied" | "other-device" | "error" | "rejected" | "missed";
    error: string | null;
}
