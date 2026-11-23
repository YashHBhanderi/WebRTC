import { Emitter, SpreeWeError, Store, isSpreeWeError, type ReadableStore, type SpreeWeClient, type Unsubscribe } from "@spreewe/core";
import type {
    Meeting,
    MeetingInput,
    MeetingJoinResult,
    MeetingOccurrence,
    MeetingPatch,
    MeetingPreview,
    MeetingRangeState,
    MeetingUpdatedEvent,
    RecurrenceInput,
} from "./types.js";

const MEETINGS_SERVICE = Symbol.for("spreewe.meetings");
const DAY_MS = 86_400_000;
/** The server refuses ranges longer than this (meeting.service.ts MAX_RANGE_DAYS); longer ranges are split. */
export const MAX_RANGE_DAYS = 62;
/** Server rule for meeting codes (meeting.service.ts byCode) */
const CODE_RE = /^[a-z0-9-]{8,16}$/;

/** The client's meetings service (created on first use). */
export function getMeetings(client: SpreeWeClient): MeetingsService {
    return client.service(MEETINGS_SERVICE, (c) => new MeetingsService(c));
}

/**
 * Meeting code from what a user typed or pasted: a code ("k7p-q2xm-4tz"), a SpreeWe link
 * (".../meet/k7p-q2xm-4tz") or a URL with ?code=. Returns null when it can't be a meeting code.
 */
export function parseMeetingCode(input: string | null | undefined): string | null {
    const s = (input || "").trim();
    if (!s) return null;
    let candidate = s;
    const path = /\/meet\/([A-Za-z0-9-]{8,16})(?:[/?#]|$)/.exec(s);
    if (path) candidate = path[1];
    else if (/^https?:\/\//i.test(s)) {
        try {
            candidate = new URL(s).searchParams.get("code") || "";
        } catch {
            candidate = "";
        }
    }
    const code = candidate.replace(/\s+/g, "").toLowerCase();
    return CODE_RE.test(code) ? code : null;
}

/** The browser's IANA time zone (used as the meeting's zone when none is given). */
export function localTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
        return "UTC";
    }
}

function toDate(value: Date | string | number, name: string): Date {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: `${name} is not a valid date.` });
    return d;
}

function recurrenceBody(r: RecurrenceInput | null): Record<string, unknown> | null {
    if (!r) return null;
    return {
        freq: r.freq,
        interval: r.interval ?? 1,
        ...(r.byWeekday?.length ? { byWeekday: [...r.byWeekday] } : {}),
        until: r.until === undefined || r.until === null || r.until === "" ? null : toDate(r.until, "Repeat end date").toISOString(),
        count: r.count ?? null,
    };
}

function meetingBody(input: MeetingPatch): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (input.title !== undefined) body.title = input.title;
    if (input.description !== undefined) body.description = input.description;
    if (input.startAt !== undefined) body.startAt = toDate(input.startAt, "Start time").toISOString();
    if (input.endAt !== undefined) body.endAt = toDate(input.endAt, "End time").toISOString();
    if (input.timeZone !== undefined) body.timeZone = input.timeZone;
    if (input.invitees !== undefined) body.invitees = [...new Set(input.invitees.map(String))];
    if (input.recurrence !== undefined) body.recurrence = recurrenceBody(input.recurrence);
    if (input.lobby !== undefined) body.lobby = !!input.lobby;
    if (input.password !== undefined) body.password = input.password;
    return body;
}

const occurrenceKey = (o: MeetingOccurrence) => `${o._id}|${o.occurrenceStart}`;
const byStart = (a: MeetingOccurrence, b: MeetingOccurrence) => Date.parse(a.occurrenceStart) - Date.parse(b.occurrenceStart);

/** Could this meeting have an occurrence in [from, to)? (cheap check before reloading a range) */
function mayOverlap(m: Meeting, from: number, to: number): boolean {
    if (m.status !== "scheduled") return false;
    const start = Date.parse(m.startAt);
    if (!(start < to)) return false;
    if (!m.recurrence) return Date.parse(m.endAt) > from;
    const until = m.recurrence.until ? Date.parse(m.recurrence.until) : Infinity;
    // Occurrences start up to `until`; one may still run into the range for its duration
    return until + (Date.parse(m.endAt) - start) > from;
}

interface RangeEntry {
    key: string;
    from: number;
    to: number;
    store: Store<MeetingRangeState>;
    refs: number;
    load: Promise<void> | null;
    /** Identifies the newest load; older answers are ignored */
    token: object | null;
    reloadTimer: ReturnType<typeof setTimeout> | null;
}

/** A live list of occurrences in a time range (see MeetingsService.watchRange). */
export interface MeetingRange {
    readonly state: ReadableStore<MeetingRangeState>;
    /** Reload from the server */
    refresh(): Promise<void>;
    /** Stop keeping this range up to date (reference-counted) */
    release(): void;
}

/**
 * Headless meetings: scheduled meetings (one-off and recurring), join links, and live updates.
 *
 * Scopes: meetings:read to list, read and preview; meetings:write to create, update, cancel and join
 * by code; realtime:connect (with meetings:read) for live `meeting:updated` events.
 *
 * Joining the call itself is not done here: every meeting has a `conversationId` (its group chat,
 * where its calls run). Hand that to the calls module.
 */
export class MeetingsService {
    readonly client: SpreeWeClient;
    private readonly events = new Emitter<{ updated: MeetingUpdatedEvent }>();
    private readonly ranges = new Map<string, RangeEntry>();
    private readonly offs: Unsubscribe[] = [];
    private live: Promise<boolean> | null = null;
    private wired = false;

    constructor(client: SpreeWeClient) {
        this.client = client;
    }

    // ------------------------------------------------------------------ live updates

    /**
     * Subscribe to `meeting:updated` over the shared socket when the token allows it (realtime:connect
     * and meetings:read). Resolves true when live updates are on, false otherwise; never rejects.
     */
    startLive(): Promise<boolean> {
        if (!this.live) {
            const attempt = (async () => {
                if (!(await this.client.hasScopes("realtime:connect", "meetings:read"))) return false;
                this.wire();
                await this.client.realtime.connect();
                return true;
            })().catch(() => {
                if (this.live === attempt) this.live = null;
                return false;
            });
            this.live = attempt;
        }
        return this.live;
    }

    /** Runs for every `meeting:updated` event (created, changed, cancelled, invited). Starts live updates. */
    onUpdated(listener: (e: MeetingUpdatedEvent) => void): Unsubscribe {
        void this.startLive();
        return this.events.on("updated", listener);
    }

    private wire(): void {
        if (this.wired) return;
        this.wired = true;
        const rt = this.client.realtime;
        this.offs.push(
            rt.on<MeetingUpdatedEvent>("meeting:updated", (p) => {
                const meetingId = String(p?.meetingId || "");
                if (!meetingId) return;
                this.events.emit("updated", { meetingId });
                void this.syncMeeting(meetingId);
            }),
            // Events missed while offline: reload what is on screen
            rt.onConnect(() => {
                for (const r of this.ranges.values()) if (r.store.value.loaded) this.scheduleReload(r);
            }),
        );
    }

    /** Bring every watched range in line with one meeting's current state. */
    private async syncMeeting(meetingId: string, known?: Meeting | null): Promise<void> {
        if (!this.ranges.size) return;
        let meeting: Meeting | null | undefined = known;
        if (meeting === undefined) {
            try {
                meeting = await this.get(meetingId);
            } catch (e) {
                // Not visible any more (removed invitee) → drop it; other failures → reload ranges that show it
                if (isSpreeWeError(e) && e.status === 404) meeting = null;
                else {
                    for (const r of this.ranges.values()) if (r.store.value.items.some((o) => o._id === meetingId)) this.scheduleReload(r);
                    return;
                }
            }
        }
        for (const r of this.ranges.values()) {
            const shown = r.store.value.items.some((o) => o._id === meetingId);
            if (!meeting || meeting.status !== "scheduled") {
                if (shown) r.store.update((s) => ({ ...s, items: s.items.filter((o) => o._id !== meetingId) }));
            } else if (shown || mayOverlap(meeting, r.from, r.to)) {
                // Times, repeat rule or cancelled occurrences may have changed: the server expands occurrences
                this.scheduleReload(r);
            }
        }
    }

    private scheduleReload(r: RangeEntry): void {
        if (r.reloadTimer) return;
        r.reloadTimer = setTimeout(() => {
            r.reloadTimer = null;
            if (this.ranges.get(r.key) === r) void this.loadRange(r).catch(() => undefined);
        }, 150);
    }

    // ------------------------------------------------------------------ reading

    /**
     * Occurrences of my meetings (organised or invited) overlapping [from, to), sorted by start. Ranges
     * longer than 62 days are fetched in parts. Cancelled meetings and cancelled occurrences are not included.
     */
    async list(range: { from: Date | string | number; to: Date | string | number }): Promise<MeetingOccurrence[]> {
        const from = toDate(range.from, "from").getTime();
        const to = toDate(range.to, "to").getTime();
        if (to <= from) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "The range must end after it starts." });
        const parts: [number, number][] = [];
        for (let a = from; a < to; a += MAX_RANGE_DAYS * DAY_MS) parts.push([a, Math.min(to, a + MAX_RANGE_DAYS * DAY_MS)]);
        const pages = await Promise.all(
            parts.map(([a, b]) =>
                this.client.http.get<MeetingOccurrence[]>("/meetings", { query: { from: new Date(a).toISOString(), to: new Date(b).toISOString() } }),
            ),
        );
        const seen = new Map<string, MeetingOccurrence>();
        for (const page of pages) for (const o of page || []) seen.set(occurrenceKey(o), o);
        return [...seen.values()].sort(byStart);
    }

    /**
     * A range kept up to date: loads now, reloads on `meeting:updated` (when live updates are available),
     * after reconnects, and after create / update / cancel through this service. Call `release()` when done.
     */
    watchRange(from: Date | string | number, to: Date | string | number): MeetingRange {
        const a = toDate(from, "from").getTime();
        const b = toDate(to, "to").getTime();
        const key = `${a}|${b}`;
        let entry = this.ranges.get(key);
        if (!entry) {
            entry = {
                key,
                from: a,
                to: b,
                refs: 0,
                load: null,
                token: null,
                reloadTimer: null,
                store: new Store<MeetingRangeState>({ from: new Date(a).toISOString(), to: new Date(b).toISOString(), items: [], loading: false, loaded: false, error: null }),
            };
            this.ranges.set(key, entry);
            void this.startLive();
            void this.loadRange(entry).catch(() => undefined);
        }
        entry.refs++;
        const e = entry;
        let released = false;
        return {
            state: e.store,
            refresh: () => this.loadRange(e, true),
            release: () => {
                if (released) return;
                released = true;
                if (--e.refs <= 0) {
                    if (e.reloadTimer) clearTimeout(e.reloadTimer);
                    this.ranges.delete(e.key);
                }
            },
        };
    }

    private loadRange(r: RangeEntry, force = false): Promise<void> {
        if (r.load && !force) return r.load;
        r.store.update((s) => ({ ...s, loading: true, error: null }));
        const token = {};
        r.token = token;
        const current = () => r.token === token;
        const load = this.list({ from: r.from, to: r.to }).then(
            (items) => {
                if (current()) r.store.set({ ...r.store.value, items, loading: false, loaded: true, error: null });
            },
            (e) => {
                if (current()) r.store.update((s) => ({ ...s, loading: false, error: e as Error }));
                throw e;
            },
        );
        r.load = load;
        const clear = () => {
            if (r.load === load) r.load = null;
        };
        load.then(clear, clear);
        return load;
    }

    /** One meeting I organise or am invited to (404 otherwise). */
    get(meetingId: string): Promise<Meeting> {
        return this.client.http.get<Meeting>(`/meetings/${encodeURIComponent(meetingId)}`);
    }

    /** What a meeting link shows before joining (works for people who were not invited). */
    async preview(codeOrLink: string): Promise<MeetingPreview> {
        return this.client.http.get<MeetingPreview>(`/meetings/code/${encodeURIComponent(this.code(codeOrLink))}`);
    }

    // ------------------------------------------------------------------ writing

    /** Schedule a meeting. The server creates its group chat and notifies the invitees. */
    async create(input: MeetingInput): Promise<Meeting> {
        const body = meetingBody({ timeZone: localTimeZone(), ...input });
        const meeting = await this.client.http.post<Meeting>("/meetings", body);
        void this.syncMeeting(meeting._id, meeting);
        return meeting;
    }

    /** Change a meeting (organiser only). Only the fields given are sent. */
    async update(meetingId: string, patch: MeetingPatch): Promise<Meeting> {
        const meeting = await this.client.http.patch<Meeting>(`/meetings/${encodeURIComponent(meetingId)}`, meetingBody(patch));
        void this.syncMeeting(meeting._id, meeting);
        return meeting;
    }

    /**
     * Cancel the whole meeting (series), or with `occurrence` (an occurrence's `occurrenceStart`) only
     * that occurrence. Organiser only.
     */
    async cancel(meetingId: string, options: { occurrence?: Date | string | number } = {}): Promise<void> {
        const occurrence = options.occurrence !== undefined ? toDate(options.occurrence, "occurrence").toISOString() : undefined;
        await this.client.http.delete<null>(`/meetings/${encodeURIComponent(meetingId)}`, { query: { occurrence } });
        for (const r of this.ranges.values()) {
            r.store.update((s) => ({
                ...s,
                items: s.items.filter((o) => o._id !== meetingId || (occurrence !== undefined && Date.parse(o.occurrenceStart) !== Date.parse(occurrence))),
            }));
        }
    }

    /**
     * Join by code or link. Invitees get the ids straight away; others give the password when the
     * meeting has one and are added to the meeting chat. Returns the ids the calls module needs.
     */
    async join(codeOrLink: string, options: { password?: string } = {}): Promise<MeetingJoinResult> {
        const code = this.code(codeOrLink);
        const res = await this.client.http.post<Omit<MeetingJoinResult, "code">>(`/meetings/code/${encodeURIComponent(code)}/join`, options.password ? { password: options.password } : {});
        return { ...res, code };
    }

    private code(codeOrLink: string): string {
        const code = parseMeetingCode(codeOrLink);
        if (!code) throw new SpreeWeError({ code: "INVALID_ARGUMENT", message: "Enter a meeting ID or link." });
        return code;
    }

    destroy(): void {
        this.offs.splice(0).forEach((off) => off());
        for (const r of this.ranges.values()) if (r.reloadTimer) clearTimeout(r.reloadTimer);
        this.ranges.clear();
        this.events.clear();
    }
}
