/**
 * Meeting shapes as the backend sends them (checked against webrtc-BE/src/services/meeting.service.ts
 * `summary()`, `preview()` and `joinByCode()`, and models/meetingModel.ts). Dates arrive as ISO strings.
 */

export type RecurrenceFreq = "daily" | "weekdays" | "weekly" | "monthly";

/** Repeat rule (meetingModel IRecurrence). */
export interface Recurrence {
    freq: RecurrenceFreq;
    /** Every N days / weeks / months (1–30; the server clamps) */
    interval: number;
    /** weekly: 0 = Sunday … 6 = Saturday (local days in the meeting's time zone) */
    byWeekday?: number[];
    /** Last day an occurrence may start (inclusive). Open-ended series get start + 730 days from the server. */
    until?: string | null;
    /** Maximum number of occurrences (1–500) */
    count?: number | null;
}

/** Recurrence as sent to POST / PATCH /meetings. `interval` defaults to 1. */
export interface RecurrenceInput {
    freq: RecurrenceFreq;
    interval?: number;
    byWeekday?: number[];
    until?: Date | string | number | null;
    count?: number | null;
}

export interface MeetingPerson {
    _id: string;
    username: string;
    avatar?: string;
}

/** GET /meetings/:id, POST /meetings, PATCH /meetings/:id */
export interface Meeting {
    _id: string;
    title: string;
    description: string;
    organizer: MeetingPerson;
    invitees: MeetingPerson[];
    /** True when the signed-in user organises it (only the organiser may update or cancel) */
    isOrganizer: boolean;
    /** The meeting's own group chat, where its calls run. Hand it to the calls module to join. */
    conversationId: string;
    /** First occurrence */
    startAt: string;
    endAt: string;
    /** IANA zone the organiser scheduled in */
    timeZone: string;
    recurrence: Recurrence | null;
    /** Human summary, e.g. "Weekly on Mon, Wed" ("" when not recurring) */
    recurrenceText: string;
    /** Meeting ID used in links (/meet/<code>) */
    code: string;
    hasPassword: boolean;
    /** Calls in this meeting start with the lobby on */
    lobby: boolean;
    status: "scheduled" | "cancelled";
    /** Set while a call is ringing or active in the meeting chat */
    activeCallId: string | null;
}

/** GET /meetings?from=&to= item: one entry per occurrence in the range. */
export interface MeetingOccurrence extends Meeting {
    occurrenceStart: string;
    occurrenceEnd: string;
}

/** GET /meetings/code/:code — what a join link shows before joining. */
export interface MeetingPreview {
    /** null unless the user is the organiser or an invitee */
    meetingId: string | null;
    code: string;
    title: string;
    organizerName: string;
    startAt: string;
    endAt: string;
    /** Human summary of the repeat rule ("" when not recurring). NOTE: a string here, an object on Meeting. */
    recurrence: string;
    invited: boolean;
    /** Only people who were not invited are asked */
    needsPassword: boolean;
    cancelled: boolean;
    /** null unless invited */
    conversationId: string | null;
}

/** POST /meetings/code/:code/join (plus the code that was joined). */
export interface MeetingJoinResult {
    meetingId: string;
    conversationId: string;
    lobby: boolean;
    code: string;
}

/** Body of POST /meetings. */
export interface MeetingInput {
    /** Required, up to 120 characters */
    title: string;
    /** Up to 2000 characters */
    description?: string;
    startAt: Date | string | number;
    /** After startAt, at most 24 hours later */
    endAt: Date | string | number;
    /** IANA zone; defaults to the browser's. Invalid values become "UTC" on the server. */
    timeZone?: string;
    /** User ids (up to 250). Unknown ids are dropped by the server; in an organization only its members are allowed. */
    invitees?: string[];
    recurrence?: RecurrenceInput | null;
    lobby?: boolean;
    /** 4–64 characters. On update: "" removes the password, undefined keeps it. */
    password?: string;
}

/** Body of PATCH /meetings/:id: every field optional; `recurrence: null` removes the repeat rule. */
export type MeetingPatch = Partial<MeetingInput>;

export interface MeetingRangeState {
    from: string;
    to: string;
    items: MeetingOccurrence[];
    loading: boolean;
    loaded: boolean;
    error: Error | null;
}

/** `meeting:updated` payload */
export interface MeetingUpdatedEvent {
    meetingId: string;
}
