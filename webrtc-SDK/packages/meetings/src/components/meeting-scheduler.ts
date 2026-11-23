import { css, html, nothing, type PropertyValues } from "lit";
import { live } from "lit/directives/live.js";
import { isSpreeWeError, type DirectoryEntry, type SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, inputStyles, scrollStyles, stateStyles, t } from "@spreewe/ui";
import { getMeetings, localTimeZone, type MeetingsService } from "../service.js";
import type { Meeting, MeetingInput, MeetingPerson, RecurrenceFreq, RecurrenceInput } from "../types.js";
import { dateInputValue, errorState, errorText, fromInputs, isMissingScope, spinner, timeInputValue, weekdayNames } from "./shared.js";
import "../strings.js";

export interface MeetingSavedDetail {
    meeting: Meeting;
    created: boolean;
}

type Ends = "never" | "until" | "count";
type FieldErrors = Partial<Record<"title" | "time" | "until" | "count" | "weekdays" | "password", string>>;

const DAY_MS = 86_400_000;
/** Open-ended series are stored with until = start + 730 days (meeting.service.ts recurrence()) */
const OPEN_ENDED_MS = 730 * DAY_MS;

/**
 * <spreewe-meeting-scheduler> — form to schedule a meeting or edit one (organiser only).
 *
 * Attributes: meeting-id (edit that meeting), start (default start for a new meeting, ISO date-time;
 * default: next half hour), duration (minutes, default 30), no-recurrence, no-password.
 * Events: spreewe-meeting-saved { meeting, created }, spreewe-meeting-cancelled { meetingId },
 *         spreewe-cancel (the form's Cancel button).
 * Slots: header (replaces the heading), actions (extra buttons next to Save).
 * CSS parts: form, heading, field, input, invitees, chip, suggestions, suggestion, error, save, cancel, cancel-meeting.
 */
export class SpreeWeMeetingScheduler extends SpreeWeElement {
    static override properties = {
        meetingId: { attribute: "meeting-id" },
        start: {},
        duration: { type: Number },
        noRecurrence: { type: Boolean, attribute: "no-recurrence" },
        noPassword: { type: Boolean, attribute: "no-password" },
        // form state
        meeting: { state: true },
        loading: { state: true },
        loadError: { state: true },
        title: { state: true },
        description: { state: true },
        date: { state: true },
        startTime: { state: true },
        endTime: { state: true },
        invitees: { state: true },
        freq: { state: true },
        interval: { state: true },
        byWeekday: { state: true },
        ends: { state: true },
        untilDate: { state: true },
        count: { state: true },
        lobby: { state: true },
        password: { state: true },
        removePassword: { state: true },
        saving: { state: true },
        error: { state: true },
        fieldErrors: { state: true },
        query: { state: true },
        suggestions: { state: true },
        searching: { state: true },
        directoryUnavailable: { state: true },
        activeSuggestion: { state: true },
        confirmCancel: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        inputStyles,
        scrollStyles,
        stateStyles,
        css`
            :host {
                display: block;
                background: var(--_surface);
                color: var(--_text);
            }
            form {
                display: grid;
                gap: var(--_s4);
                padding: var(--_s4);
            }
            h2 {
                margin: 0;
                font-size: var(--_fs-lg);
                font-weight: var(--_fw-bold);
            }
            .row {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
                gap: var(--_s3);
            }
            .hint {
                font-size: var(--_fs-sm);
                color: var(--_muted);
                margin: 0;
            }
            .field-error {
                font-size: var(--_fs-sm);
                color: var(--_danger);
                font-weight: normal;
            }
            .input[aria-invalid="true"] {
                border-color: var(--_danger);
            }
            textarea.input {
                min-height: 72px;
                resize: vertical;
            }
            select.input {
                appearance: auto;
            }
            fieldset {
                border: 0;
                margin: 0;
                padding: 0;
                display: grid;
                gap: var(--_s2);
                min-width: 0;
            }
            legend {
                padding: 0;
                margin-bottom: var(--_s1);
                font-size: var(--_fs-sm);
                font-weight: var(--_fw-medium);
                color: var(--_text-2);
            }
            .chips {
                display: flex;
                flex-wrap: wrap;
                gap: var(--_s1);
            }
            .chip {
                display: inline-flex;
                align-items: center;
                gap: var(--_s1);
                padding: 2px 2px 2px var(--_s1);
                border-radius: var(--_r-pill);
                background: var(--_brand-soft);
                font-size: var(--_fs-sm);
                max-width: 100%;
            }
            .chip span {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .chip .icon-btn {
                width: 24px;
                height: 24px;
            }
            .picker {
                position: relative;
            }
            .suggestions {
                position: absolute;
                z-index: 5;
                left: 0;
                right: 0;
                top: calc(100% + 4px);
                margin: 0;
                padding: var(--_s1);
                list-style: none;
                max-height: 240px;
                background: var(--_surface);
                border: var(--_bw) solid var(--_border);
                border-radius: var(--_r);
                box-shadow: var(--_shadow);
            }
            .suggestions li {
                display: flex;
                align-items: center;
                gap: var(--_s2);
                padding: var(--_s2);
                border-radius: var(--_r-sm);
                cursor: pointer;
            }
            .suggestions li[aria-selected="true"],
            .suggestions li:hover {
                background: var(--_hover);
            }
            .suggestions .note {
                cursor: default;
                color: var(--_muted);
            }
            .days {
                display: flex;
                flex-wrap: wrap;
                gap: var(--_s1);
            }
            .day {
                min-width: 44px;
                min-height: 32px;
                padding: 0 var(--_s2);
            }
            .day[aria-pressed="true"] {
                background: var(--_brand);
                border-color: var(--_brand);
                color: var(--_on-brand);
            }
            .check {
                display: flex;
                align-items: center;
                gap: var(--_s2);
                font-size: var(--_fs);
                color: var(--_text);
            }
            .check input {
                width: 16px;
                height: 16px;
                margin: 0;
            }
            .actions {
                display: flex;
                flex-wrap: wrap;
                gap: var(--_s2);
                align-items: center;
            }
            .actions .spacer {
                flex: 1;
            }
            .notice {
                margin: 0;
                padding: var(--_s2) var(--_s3);
                border-radius: var(--_r-sm);
                background: var(--_brand-soft);
                color: var(--_text-2);
                font-size: var(--_fs-sm);
            }
            .error-banner {
                margin: 0;
            }
            .confirm {
                display: flex;
                flex-wrap: wrap;
                gap: var(--_s2);
                align-items: center;
            }
        `,
    ];

    declare meetingId: string;
    declare start: string;
    declare duration: number;
    declare noRecurrence: boolean;
    declare noPassword: boolean;
    declare meeting: Meeting | null;
    declare loading: boolean;
    declare loadError: unknown;
    declare title: string;
    declare description: string;
    declare date: string;
    declare startTime: string;
    declare endTime: string;
    declare invitees: MeetingPerson[];
    declare freq: RecurrenceFreq | "";
    declare interval: number;
    declare byWeekday: number[];
    declare ends: Ends;
    declare untilDate: string;
    declare count: number;
    declare lobby: boolean;
    declare password: string;
    declare removePassword: boolean;
    declare saving: boolean;
    declare error: unknown;
    declare fieldErrors: FieldErrors;
    declare query: string;
    declare suggestions: DirectoryEntry[] | null;
    declare searching: boolean;
    declare directoryUnavailable: boolean;
    declare activeSuggestion: number;
    declare confirmCancel: boolean;

    private meetings: MeetingsService | null = null;
    private searchTimer: ReturnType<typeof setTimeout> | null = null;
    private searchSeq = 0;
    private loadSeq = 0;
    private loadedFor = "";

    constructor() {
        super();
        this.meetingId = "";
        this.start = "";
        this.duration = 30;
        this.noRecurrence = false;
        this.noPassword = false;
        this.meeting = null;
        this.loading = false;
        this.loadError = null;
        this.invitees = [];
        this.saving = false;
        this.error = null;
        this.fieldErrors = {};
        this.query = "";
        this.suggestions = null;
        this.searching = false;
        this.directoryUnavailable = false;
        this.activeSuggestion = -1;
        this.confirmCancel = false;
        this.resetForm();
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.meetings = client ? getMeetings(client) : null;
        if (this.meetingId) void this.load();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("meetingId") && this.meetingId !== this.loadedFor) {
            if (this.meetingId) void this.load();
            else {
                this.loadedFor = "";
                this.meeting = null;
                this.resetForm();
            }
        }
        if ((changed.has("start") || changed.has("duration")) && !this.meetingId && !this.meeting) this.resetTimes();
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        if (this.searchTimer) clearTimeout(this.searchTimer);
    }

    // ------------------------------------------------------------------ state

    /** Clear the form (new meeting with the default start / duration). */
    resetForm(): void {
        this.title = "";
        this.description = "";
        this.invitees = [];
        this.freq = "";
        this.interval = 1;
        this.ends = "never";
        this.untilDate = "";
        this.count = 10;
        this.lobby = false;
        this.password = "";
        this.removePassword = false;
        this.error = null;
        this.fieldErrors = {};
        this.confirmCancel = false;
        this.resetTimes();
    }

    private resetTimes(): void {
        let start = this.start ? new Date(this.start) : null;
        if (!start || Number.isNaN(start.getTime())) {
            start = new Date();
            start.setSeconds(0, 0);
            start.setMinutes(start.getMinutes() < 30 ? 30 : 60);
        }
        const minutes = Number.isFinite(this.duration) && this.duration > 0 ? Math.min(this.duration, 24 * 60) : 30;
        const end = new Date(start.getTime() + minutes * 60_000);
        this.date = dateInputValue(start);
        this.startTime = timeInputValue(start);
        this.endTime = timeInputValue(end);
        this.byWeekday = [start.getDay()];
    }

    private async load(): Promise<void> {
        if (!this.meetings || !this.meetingId) return;
        this.loadedFor = this.meetingId;
        const seq = ++this.loadSeq;
        this.loading = true;
        this.loadError = null;
        try {
            const m = await this.meetings.get(this.meetingId);
            if (seq !== this.loadSeq) return;
            this.meeting = m;
            this.fill(m);
        } catch (e) {
            if (seq === this.loadSeq) this.loadError = e;
        } finally {
            if (seq === this.loadSeq) this.loading = false;
        }
    }

    private fill(m: Meeting): void {
        const start = new Date(m.startAt);
        const end = new Date(m.endAt);
        this.title = m.title;
        this.description = m.description || "";
        this.date = dateInputValue(start);
        this.startTime = timeInputValue(start);
        this.endTime = timeInputValue(end);
        this.invitees = [...(m.invitees || [])];
        this.lobby = !!m.lobby;
        this.password = "";
        this.removePassword = false;
        this.error = null;
        this.fieldErrors = {};
        const r = m.recurrence;
        this.freq = r?.freq || "";
        this.interval = r?.interval || 1;
        this.byWeekday = r?.byWeekday?.length ? [...r.byWeekday] : [start.getDay()];
        this.count = r?.count || 10;
        if (r?.count) this.ends = "count";
        else if (r?.until && Math.abs(Date.parse(r.until) - start.getTime() - OPEN_ENDED_MS) > DAY_MS) {
            this.ends = "until";
            this.untilDate = dateInputValue(new Date(r.until));
        } else {
            this.ends = "never";
            this.untilDate = "";
        }
    }

    private get editing(): boolean {
        return !!this.meetingId && !!this.meeting;
    }

    private get readOnly(): boolean {
        return this.editing && (!this.meeting!.isOrganizer || this.meeting!.status === "cancelled");
    }

    // ------------------------------------------------------------------ invitee picker

    private onSearchInput(value: string): void {
        this.query = value;
        this.activeSuggestion = -1;
        if (this.searchTimer) clearTimeout(this.searchTimer);
        if (!value.trim()) {
            this.suggestions = null;
            return;
        }
        this.searchTimer = setTimeout(() => void this.search(value.trim()), 250);
    }

    private async search(q: string): Promise<void> {
        if (!this.sw) return;
        const seq = ++this.searchSeq;
        this.searching = true;
        try {
            const page = await this.sw.people.directory({ q, limit: 8 });
            if (seq !== this.searchSeq) return;
            this.sw.people.seedPresence(page.items);
            const picked = new Set(this.invitees.map((p) => p._id));
            this.suggestions = page.items.filter((p) => !picked.has(String(p._id)));
            this.directoryUnavailable = false;
        } catch (e) {
            if (seq !== this.searchSeq) return;
            this.suggestions = [];
            if (isMissingScope(e) || (isSpreeWeError(e) && e.status === 403)) this.directoryUnavailable = true;
            else this.error = e;
        } finally {
            if (seq === this.searchSeq) this.searching = false;
        }
    }

    private addInvitee(p: DirectoryEntry | MeetingPerson): void {
        if (!this.invitees.some((x) => x._id === String(p._id))) this.invitees = [...this.invitees, { _id: String(p._id), username: p.username, avatar: p.avatar }];
        this.query = "";
        this.suggestions = null;
        this.activeSuggestion = -1;
        this.renderRoot.querySelector<HTMLInputElement>("#invite")?.focus();
    }

    private removeInvitee(id: string): void {
        this.invitees = this.invitees.filter((p) => p._id !== id);
    }

    private onSearchKey(e: KeyboardEvent): void {
        const list = this.suggestions || [];
        if (e.key === "ArrowDown" && list.length) {
            e.preventDefault();
            this.activeSuggestion = (this.activeSuggestion + 1) % list.length;
        } else if (e.key === "ArrowUp" && list.length) {
            e.preventDefault();
            this.activeSuggestion = this.activeSuggestion <= 0 ? list.length - 1 : this.activeSuggestion - 1;
        } else if (e.key === "Enter") {
            // Enter in the picker picks a person; it never submits the form
            e.preventDefault();
            const pick = list[this.activeSuggestion] ?? (list.length === 1 ? list[0] : undefined);
            if (pick) this.addInvitee(pick);
        } else if (e.key === "Escape" && this.suggestions) {
            e.preventDefault();
            this.suggestions = null;
        } else if (e.key === "Backspace" && !this.query && this.invitees.length) {
            this.removeInvitee(this.invitees[this.invitees.length - 1]._id);
        }
    }

    // ------------------------------------------------------------------ submit

    private toggleWeekday(d: number): void {
        this.byWeekday = this.byWeekday.includes(d) ? this.byWeekday.filter((x) => x !== d) : [...this.byWeekday, d].sort();
    }

    private times(): { startAt: Date; endAt: Date } | null {
        const startAt = fromInputs(this.date, this.startTime);
        let endAt = fromInputs(this.date, this.endTime);
        if (!startAt || !endAt) return null;
        // An end time before the start means the next day (overnight meeting)
        if (endAt.getTime() <= startAt.getTime()) endAt = new Date(endAt.getTime() + DAY_MS);
        return { startAt, endAt };
    }

    private validate(): { input: MeetingInput } | null {
        const errors: FieldErrors = {};
        const title = this.title.replace(/\s+/g, " ").trim();
        if (!title) errors.title = t("meetings.scheduler.err.title");
        else if (title.length > 120) errors.title = t("meetings.scheduler.err.titleLong");
        const times = this.times();
        if (!times) errors.time = t("meetings.scheduler.err.time");
        else if (times.endAt.getTime() - times.startAt.getTime() > DAY_MS) errors.time = t("meetings.scheduler.err.length");
        let recurrence: RecurrenceInput | null = null;
        if (this.freq && !this.noRecurrence) {
            recurrence = { freq: this.freq, interval: this.freq === "weekdays" ? 1 : Math.min(Math.max(Math.floor(this.interval) || 1, 1), 30) };
            if (this.freq === "weekly") {
                if (!this.byWeekday.length) errors.weekdays = t("meetings.scheduler.err.weekdays");
                recurrence.byWeekday = [...this.byWeekday];
            }
            if (this.ends === "until") {
                const until = fromInputs(this.untilDate, "23:59");
                if (!until || (times && until.getTime() < times.startAt.getTime())) errors.until = t("meetings.scheduler.err.until");
                else recurrence.until = new Date(until.getTime() + 59_000);
            } else if (this.ends === "count") {
                const n = Math.floor(Number(this.count));
                if (!Number.isFinite(n) || n < 1 || n > 500) errors.count = t("meetings.scheduler.err.count");
                else recurrence.count = n;
            }
        }
        const password = this.password.trim();
        if (!this.noPassword && password && (password.length < 4 || password.length > 64)) errors.password = t("meetings.scheduler.err.password");
        this.fieldErrors = errors;
        if (Object.keys(errors).length || !times) return null;
        const input: MeetingInput = {
            title,
            description: this.description.trim(),
            startAt: times.startAt,
            endAt: times.endAt,
            invitees: this.invitees.map((p) => p._id),
            recurrence,
            lobby: this.lobby,
        };
        if (!this.noPassword) {
            if (password) input.password = password;
            else if (this.editing && this.removePassword) input.password = "";
        }
        return { input };
    }

    private async submit(e: Event): Promise<void> {
        e.preventDefault();
        if (!this.meetings || this.saving || this.readOnly) return;
        this.error = null;
        const valid = this.validate();
        if (!valid) {
            await this.updateComplete;
            this.renderRoot.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
            return;
        }
        this.saving = true;
        try {
            const created = !this.editing;
            if (!created && this.noRecurrence) delete valid.input.recurrence;
            const meeting = created ? await this.meetings.create(valid.input) : await this.meetings.update(this.meetingId, valid.input);
            this.meeting = created ? null : meeting;
            if (!created) this.fill(meeting);
            else this.resetForm();
            this.fire<MeetingSavedDetail>("spreewe-meeting-saved", { meeting, created });
        } catch (err) {
            this.error = err;
        } finally {
            this.saving = false;
        }
    }

    private async cancelMeeting(): Promise<void> {
        if (!this.meetings || !this.meeting) return;
        this.saving = true;
        this.error = null;
        try {
            const id = this.meeting._id;
            await this.meetings.cancel(id);
            this.confirmCancel = false;
            this.meeting = { ...this.meeting, status: "cancelled" };
            this.fire("spreewe-meeting-cancelled", { meetingId: id });
        } catch (err) {
            this.error = err;
        } finally {
            this.saving = false;
        }
    }

    // ------------------------------------------------------------------ render

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        if (this.meetingId && this.loading && !this.meeting) return html`<div class="state">${spinner()}</div>`;
        if (this.meetingId && this.loadError && !this.meeting) return errorState(this.loadError, () => void this.load(), "meetings:read");
        const ro = this.readOnly;
        const fe = this.fieldErrors;
        const times = this.times();
        const overnight = !!times && times.startAt.getDate() !== times.endAt.getDate();
        const names = weekdayNames("short");
        return html`
            <form part="form" novalidate @submit=${this.submit} aria-busy=${this.saving ? "true" : "false"}>
                <slot name="header"><h2 part="heading">${this.editing ? t("meetings.scheduler.titleEdit") : t("meetings.scheduler.titleNew")}</h2></slot>
                ${this.editing && this.meeting!.status === "cancelled"
                    ? html`<p class="notice" role="status">${t("meetings.scheduler.cancelled")}</p>`
                    : ro
                      ? html`<p class="notice" role="status">${t("meetings.scheduler.notOrganizer")}</p>`
                      : nothing}

                <label class="field" part="field">
                    <span>${t("meetings.scheduler.title")}</span>
                    <input id="title" class="input" part="input" maxlength="120" required ?disabled=${ro} .value=${live(this.title)}
                        placeholder=${t("meetings.scheduler.titlePlaceholder")} aria-invalid=${fe.title ? "true" : "false"} aria-describedby=${fe.title ? "title-err" : ""}
                        @input=${(e: Event) => (this.title = (e.target as HTMLInputElement).value)} />
                    ${fe.title ? html`<span id="title-err" class="field-error">${fe.title}</span>` : nothing}
                </label>

                <div class="row">
                    <label class="field" part="field">
                        <span>${t("meetings.scheduler.date")}</span>
                        <input class="input" part="input" type="date" required ?disabled=${ro} .value=${live(this.date)} aria-invalid=${fe.time ? "true" : "false"}
                            @input=${(e: Event) => {
                                this.date = (e.target as HTMLInputElement).value;
                                const d = fromInputs(this.date, "12:00");
                                if (d && this.freq !== "weekly") this.byWeekday = [d.getDay()];
                            }} />
                    </label>
                    <label class="field" part="field">
                        <span>${t("meetings.scheduler.start")}</span>
                        <input class="input" part="input" type="time" required ?disabled=${ro} .value=${live(this.startTime)} aria-invalid=${fe.time ? "true" : "false"}
                            @input=${(e: Event) => (this.startTime = (e.target as HTMLInputElement).value)} />
                    </label>
                    <label class="field" part="field">
                        <span>${t("meetings.scheduler.end")} ${overnight ? html`<span class="hint">${t("meetings.scheduler.nextDay")}</span>` : nothing}</span>
                        <input class="input" part="input" type="time" required ?disabled=${ro} .value=${live(this.endTime)} aria-invalid=${fe.time ? "true" : "false"}
                            @input=${(e: Event) => (this.endTime = (e.target as HTMLInputElement).value)} />
                    </label>
                </div>
                ${fe.time ? html`<span class="field-error" role="alert">${fe.time}</span>` : nothing}
                <p class="hint">${t("meetings.scheduler.timeZone", { zone: this.meeting?.timeZone || localTimeZone() })}</p>

                ${this.renderInvitees(ro)}

                <label class="field" part="field">
                    <span>${t("meetings.scheduler.description")}</span>
                    <textarea class="input" part="input" maxlength="2000" ?disabled=${ro} .value=${live(this.description)}
                        @input=${(e: Event) => (this.description = (e.target as HTMLTextAreaElement).value)}></textarea>
                </label>

                ${this.noRecurrence ? nothing : this.renderRecurrence(ro, names)}

                <label class="check">
                    <input type="checkbox" ?disabled=${ro} .checked=${live(this.lobby)} @change=${(e: Event) => (this.lobby = (e.target as HTMLInputElement).checked)} />
                    <span>${t("meetings.scheduler.lobby")}</span>
                </label>

                ${this.noPassword ? nothing : this.renderPassword(ro)}

                ${this.error ? html`<div class="error-banner" part="error" role="alert">${icon("alert", 16)}<span>${errorText(this.error, "meetings:write")}</span></div>` : nothing}
                ${Object.keys(fe).length && !this.error ? html`<span class="sr-only" role="alert">${t("meetings.scheduler.err.form")}</span>` : nothing}

                <div class="actions">
                    ${ro ? nothing : html`<button class="btn primary" part="save" type="submit" ?disabled=${this.saving}>
                              ${this.saving ? t("meetings.scheduler.saving") : this.editing ? t("meetings.scheduler.save") : t("meetings.scheduler.create")}
                          </button>`}
                    <button class="btn" part="cancel" type="button" @click=${() => this.fire("spreewe-cancel")}>${t("common.cancel")}</button>
                    <slot name="actions"></slot>
                    <span class="spacer"></span>
                    ${this.editing && !ro ? this.renderCancelMeeting() : nothing}
                </div>
            </form>
        `;
    }

    private renderInvitees(ro: boolean) {
        const list = this.suggestions;
        const open = !!list && !!this.query.trim() && !this.searching;
        return html`<fieldset part="invitees" ?disabled=${ro}>
            <legend>${t("meetings.scheduler.invitees")}</legend>
            ${this.invitees.length
                ? html`<div class="chips" role="list">
                      ${this.invitees.map(
                          (p) => html`<span class="chip" part="chip" role="listitem">
                              <spreewe-avatar .client=${this.sw} name=${p.username || "?"} src=${p.avatar || ""} size="20"></spreewe-avatar>
                              <span>${p.username || "?"}</span>
                              ${ro ? nothing : html`<button class="icon-btn" type="button" aria-label=${t("meetings.scheduler.inviteRemove", { name: p.username || "?" })}
                                        @click=${() => this.removeInvitee(p._id)}>${icon("x", 14)}</button>`}
                          </span>`,
                      )}
                  </div>`
                : nothing}
            ${ro
                ? nothing
                : this.directoryUnavailable
                  ? html`<p class="hint">${t("meetings.scheduler.directoryUnavailable")}</p>`
                  : html`<div class="picker">
                        <input id="invite" class="input" part="input" type="search" autocomplete="off" role="combobox"
                            aria-label=${t("meetings.scheduler.inviteSearch")} placeholder=${t("meetings.scheduler.inviteSearch")}
                            aria-expanded=${open ? "true" : "false"} aria-controls="suggestions" aria-autocomplete="list"
                            aria-activedescendant=${open && this.activeSuggestion >= 0 ? `sugg-${this.activeSuggestion}` : ""}
                            .value=${live(this.query)} @input=${(e: Event) => this.onSearchInput((e.target as HTMLInputElement).value)} @keydown=${this.onSearchKey} />
                        ${open
                            ? html`<ul id="suggestions" class="suggestions scroll" part="suggestions" role="listbox" aria-label=${t("meetings.scheduler.invitees")}>
                                  ${list!.length
                                      ? list!.map(
                                            (p, i) => html`<li id=${`sugg-${i}`} role="option" part="suggestion" aria-selected=${i === this.activeSuggestion ? "true" : "false"}
                                                @mousedown=${(e: Event) => e.preventDefault()} @click=${() => this.addInvitee(p)}>
                                                <spreewe-avatar .client=${this.sw} name=${p.username} src=${p.avatar || ""} size="24"></spreewe-avatar>
                                                <span>${p.username}</span>
                                            </li>`,
                                        )
                                      : html`<li class="note" role="option" aria-disabled="true" aria-selected="false">${t("meetings.scheduler.inviteNone", { q: this.query.trim() })}</li>`}
                              </ul>`
                            : nothing}
                    </div>`}
        </fieldset>`;
    }

    private renderRecurrence(ro: boolean, names: string[]) {
        const fe = this.fieldErrors;
        const unit = this.freq === "daily" ? "daily" : this.freq === "weekly" ? "weekly" : this.freq === "monthly" ? "monthly" : "";
        return html`<fieldset ?disabled=${ro}>
            <legend>${t("meetings.scheduler.repeat")}</legend>
            <div class="row">
                <select class="input" part="input" aria-label=${t("meetings.scheduler.repeat")} .value=${live(this.freq)}
                    @change=${(e: Event) => (this.freq = (e.target as HTMLSelectElement).value as RecurrenceFreq | "")}>
                    ${(["", "daily", "weekdays", "weekly", "monthly"] as const).map(
                        (f) => html`<option value=${f} ?selected=${this.freq === f}>${t(`meetings.scheduler.repeat.${f || "none"}`)}</option>`,
                    )}
                </select>
                ${unit
                    ? html`<label class="field">
                          <span>${t("meetings.scheduler.interval")} (${t(`meetings.scheduler.interval.${unit}`)})</span>
                          <input class="input" part="input" type="number" min="1" max="30" .value=${live(String(this.interval))}
                              @input=${(e: Event) => (this.interval = Number((e.target as HTMLInputElement).value))} />
                      </label>`
                    : nothing}
            </div>
            ${this.freq === "weekly"
                ? html`<div class="days" role="group" aria-label=${t("meetings.scheduler.weekdays")}>
                          ${names.map(
                              (n, d) => html`<button class="btn day" type="button" aria-pressed=${this.byWeekday.includes(d) ? "true" : "false"} @click=${() => this.toggleWeekday(d)}>${n}</button>`,
                          )}
                      </div>
                      ${fe.weekdays ? html`<span class="field-error" role="alert">${fe.weekdays}</span>` : nothing}`
                : nothing}
            ${this.freq
                ? html`<div class="row">
                      <label class="field">
                          <span>${t("meetings.scheduler.ends")}</span>
                          <select class="input" part="input" .value=${live(this.ends)} @change=${(e: Event) => (this.ends = (e.target as HTMLSelectElement).value as Ends)}>
                              ${(["never", "until", "count"] as const).map((v) => html`<option value=${v} ?selected=${this.ends === v}>${t(`meetings.scheduler.ends.${v}`)}</option>`)}
                          </select>
                      </label>
                      ${this.ends === "until"
                          ? html`<label class="field">
                                <span>${t("meetings.scheduler.untilDate")}</span>
                                <input class="input" part="input" type="date" .value=${live(this.untilDate)} aria-invalid=${fe.until ? "true" : "false"}
                                    @input=${(e: Event) => (this.untilDate = (e.target as HTMLInputElement).value)} />
                                ${fe.until ? html`<span class="field-error">${fe.until}</span>` : nothing}
                            </label>`
                          : this.ends === "count"
                            ? html`<label class="field">
                                  <span>${t("meetings.scheduler.count")}</span>
                                  <input class="input" part="input" type="number" min="1" max="500" .value=${live(String(this.count))} aria-invalid=${fe.count ? "true" : "false"}
                                      @input=${(e: Event) => (this.count = Number((e.target as HTMLInputElement).value))} />
                                  ${fe.count ? html`<span class="field-error">${fe.count}</span>` : nothing}
                              </label>`
                            : nothing}
                  </div>`
                : nothing}
        </fieldset>`;
    }

    private renderPassword(ro: boolean) {
        const fe = this.fieldErrors;
        const has = this.editing && this.meeting!.hasPassword;
        return html`<label class="field" part="field">
                <span>${t("meetings.scheduler.password")}</span>
                <input class="input" part="input" type="password" autocomplete="new-password" maxlength="64" ?disabled=${ro || this.removePassword}
                    placeholder=${has ? t("meetings.scheduler.passwordKeep") : ""} .value=${live(this.password)} aria-invalid=${fe.password ? "true" : "false"}
                    @input=${(e: Event) => (this.password = (e.target as HTMLInputElement).value)} />
                ${fe.password ? html`<span class="field-error">${fe.password}</span>` : nothing}
            </label>
            ${has && !ro
                ? html`<label class="check">
                      <input type="checkbox" .checked=${live(this.removePassword)} @change=${(e: Event) => (this.removePassword = (e.target as HTMLInputElement).checked)} />
                      <span>${t("meetings.scheduler.passwordRemove")}</span>
                  </label>`
                : nothing}`;
    }

    private renderCancelMeeting() {
        return this.confirmCancel
            ? html`<span class="confirm" role="group" aria-label=${t("meetings.scheduler.cancelConfirm")}>
                  <span>${t("meetings.scheduler.cancelConfirm")}</span>
                  <button class="btn danger" type="button" ?disabled=${this.saving} @click=${() => this.cancelMeeting()}>${t("meetings.scheduler.cancelYes")}</button>
                  <button class="btn" type="button" @click=${() => (this.confirmCancel = false)}>${t("meetings.scheduler.cancelNo")}</button>
              </span>`
            : html`<button class="btn ghost" part="cancel-meeting" type="button" @click=${() => (this.confirmCancel = true)}>${icon("trash", 16)} ${t("meetings.scheduler.cancelMeeting")}</button>`;
    }
}
