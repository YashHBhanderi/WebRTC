import { css, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, formatTime, icon, scrollStyles, stateStyles, t } from "@spreewe/ui";
import { getMeetings, type MeetingRange, type MeetingsService } from "../service.js";
import type { MeetingOccurrence, MeetingRangeState } from "../types.js";
import { dayLabel, errorState, spinner, startOfDay } from "./shared.js";
import "../strings.js";

export interface MeetingSelectDetail {
    meetingId: string;
    occurrenceStart: string;
    meeting: MeetingOccurrence;
}

/** Ids a host app hands to the calls module to enter the meeting's call. */
export interface MeetingJoinDetail {
    meetingId: string;
    conversationId: string;
    code: string;
    /** Set when joined from the list */
    occurrenceStart?: string;
    /** A call is already ringing / active in the meeting chat */
    activeCallId?: string | null;
    /** Set when joined by code (the meeting's lobby default) */
    lobby?: boolean;
}

/**
 * <spreewe-meeting-list> — the user's meetings (organised or invited) in a date range, grouped by
 * day, with live updates.
 *
 * Attributes: from (date or date-time; default: start of today), days (default 7), to (overrides days),
 * selected (meeting id), hide-ended.
 * Events: spreewe-meeting-select { meetingId, occurrenceStart, meeting },
 *         spreewe-meeting-join { meetingId, conversationId, code, occurrenceStart, activeCallId }.
 * Slots: header, empty, footer.
 * CSS parts: list, day, day-label, item, item-selected, time, title, meta, badge, join, error.
 */
export class SpreeWeMeetingList extends SpreeWeElement {
    static override properties = {
        from: {},
        to: {},
        days: { type: Number },
        selected: { reflect: true },
        hideEnded: { type: Boolean, attribute: "hide-ended" },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        scrollStyles,
        stateStyles,
        css`
            :host {
                display: flex;
                flex-direction: column;
                min-height: 0;
                height: 100%;
                background: var(--_surface);
            }
            .scroll {
                flex: 1;
                min-height: 0;
                padding-bottom: var(--_s2);
            }
            section + section {
                border-top: var(--_bw) solid var(--_border);
            }
            h3 {
                margin: 0;
                padding: var(--_s3) var(--_s3) var(--_s1);
                font-size: var(--_fs-sm);
                font-weight: var(--_fw-bold);
                color: var(--_muted);
                text-transform: uppercase;
                letter-spacing: 0.04em;
            }
            ul {
                list-style: none;
                margin: 0;
                padding: 0;
            }
            .item {
                display: flex;
                align-items: center;
                gap: var(--_s2);
                padding: var(--_s1) var(--_s3) var(--_s1) 0;
                border-left: 3px solid transparent;
            }
            .item:hover {
                background: var(--_hover);
            }
            .item.current {
                background: var(--_active);
                border-left-color: var(--_brand);
            }
            .item.ended {
                opacity: 0.65;
            }
            .main {
                flex: 1;
                min-width: 0;
                display: grid;
                grid-template-columns: auto 1fr;
                column-gap: var(--_s3);
                row-gap: 2px;
                align-items: baseline;
                padding: var(--_s2) 0 var(--_s2) var(--_s3);
                border: 0;
                border-radius: var(--_r-sm);
                background: transparent;
                color: inherit;
                font: inherit;
                text-align: left;
                cursor: pointer;
            }
            .time {
                grid-row: span 2;
                font-size: var(--_fs-sm);
                font-variant-numeric: tabular-nums;
                color: var(--_text-2);
                white-space: nowrap;
                min-width: 4.5em;
            }
            .title {
                font-weight: var(--_fw-medium);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .meta {
                grid-column: 2;
                font-size: var(--_fs-sm);
                color: var(--_muted);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .badge {
                flex: none;
                font-size: 10px;
                font-weight: var(--_fw-bold);
                text-transform: uppercase;
                letter-spacing: 0.04em;
                padding: 2px 6px;
                border-radius: var(--_r-pill);
                background: color-mix(in srgb, var(--_success) 16%, transparent);
                color: var(--_success);
            }
            .badge.ended {
                background: var(--_brand-soft);
                color: var(--_text-2);
            }
            .join {
                flex: none;
                min-height: 30px;
                padding: 0 var(--_s3);
            }
            @media (max-width: 380px) {
                .time {
                    grid-row: auto;
                    grid-column: 1 / -1;
                }
                .meta {
                    grid-column: 1 / -1;
                }
            }
        `,
    ];

    declare from: string;
    declare to: string;
    declare days: number;
    declare selected: string;
    declare hideEnded: boolean;

    private meetings: MeetingsService | null = null;
    private range: MeetingRange | null = null;
    private rangeKey = "";
    private ticker: ReturnType<typeof setInterval> | null = null;

    constructor() {
        super();
        this.from = "";
        this.to = "";
        this.days = 7;
        this.selected = "";
        this.hideEnded = false;
    }

    override connectedCallback(): void {
        super.connectedCallback();
        // "Ended" / join availability follow the clock
        this.ticker = setInterval(() => this.requestUpdate(), 60_000);
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = null;
        this.releaseRange();
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.releaseRange();
        this.meetings = client ? getMeetings(client) : null;
        this.attachRange();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if ((changed.has("from") || changed.has("to") || changed.has("days")) && this.meetings && this.rangeKey !== this.computeKey()) {
            this.releaseRange();
            this.attachRange();
        }
    }

    /** The range shown: [from, to) */
    get rangeBounds(): { from: Date; to: Date } {
        const parsed = this.from ? new Date(this.from) : null;
        const from = parsed && !Number.isNaN(parsed.getTime()) ? (/T/.test(this.from) ? parsed : startOfDay(new Date(`${this.from}T00:00:00`))) : startOfDay(new Date());
        const toParsed = this.to ? new Date(/T/.test(this.to) ? this.to : `${this.to}T00:00:00`) : null;
        const days = Number.isFinite(this.days) && this.days > 0 ? this.days : 7;
        const to = toParsed && !Number.isNaN(toParsed.getTime()) && toParsed > from ? toParsed : new Date(from.getFullYear(), from.getMonth(), from.getDate() + days, from.getHours(), from.getMinutes());
        return { from, to };
    }

    private computeKey(): string {
        const { from, to } = this.rangeBounds;
        return `${from.getTime()}|${to.getTime()}`;
    }

    private attachRange(): void {
        if (!this.meetings || !this.isConnected) return;
        const { from, to } = this.rangeBounds;
        this.rangeKey = this.computeKey();
        this.range = this.meetings.watchRange(from, to);
        this.observe(this.range.state);
    }

    private releaseRange(): void {
        this.range?.release();
        this.range = null;
        this.rangeKey = "";
    }

    /** Reload from the server */
    refresh(): Promise<void> {
        return this.range?.refresh() ?? Promise.resolve();
    }

    private select(o: MeetingOccurrence): void {
        this.selected = o._id;
        this.fire<MeetingSelectDetail>("spreewe-meeting-select", { meetingId: o._id, occurrenceStart: o.occurrenceStart, meeting: o });
    }

    private join(o: MeetingOccurrence): void {
        this.fire<MeetingJoinDetail>("spreewe-meeting-join", {
            meetingId: o._id,
            conversationId: o.conversationId,
            code: o.code,
            occurrenceStart: o.occurrenceStart,
            activeCallId: o.activeCallId,
        });
    }

    private onKey(e: KeyboardEvent): void {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>("button.main")];
        if (!buttons.length) return;
        const i = buttons.indexOf(this.renderRoot.querySelector<HTMLButtonElement>("button.main:focus")!);
        const next =
            e.key === "Home" ? buttons[0] : e.key === "End" ? buttons[buttons.length - 1] : buttons[Math.max(0, Math.min(buttons.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) {
            e.preventDefault();
            next.focus();
        }
    }

    protected override render() {
        if (!this.sw || !this.range) return html`<div class="state">${t("common.noClient")}</div>`;
        const state: MeetingRangeState = this.range.state.value;
        const now = Date.now();
        const items = this.hideEnded ? state.items.filter((o) => Date.parse(o.occurrenceEnd) > now) : state.items;
        const groups: { key: string; day: Date; items: MeetingOccurrence[] }[] = [];
        for (const o of items) {
            const start = new Date(o.occurrenceStart);
            const key = startOfDay(start).toDateString();
            const last = groups[groups.length - 1];
            if (last?.key === key) last.items.push(o);
            else groups.push({ key, day: start, items: [o] });
        }
        return html`
            <slot name="header"></slot>
            ${state.error && !state.items.length ? errorState(state.error, () => void this.refresh().catch(() => undefined), "meetings:read") : nothing}
            ${state.loading && !state.loaded ? html`<div class="state">${spinner()}</div>` : nothing}
            ${state.loaded && !items.length && !state.error
                ? html`<slot name="empty"><div class="state"><strong>${t("meetings.list.empty.title")}</strong><span>${t("meetings.list.empty.text")}</span></div></slot>`
                : nothing}
            <div class="scroll" part="list" role="region" aria-label=${t("meetings.list.label")} aria-busy=${state.loading ? "true" : "false"} @keydown=${this.onKey}>
                ${repeat(groups, (g) => g.key, (g) => {
                    const id = `day-${g.key.replace(/\W+/g, "-")}`;
                    return html`<section part="day" aria-labelledby=${id}>
                        <h3 id=${id} part="day-label">${dayLabel(g.day)}</h3>
                        <ul role="list">
                            ${repeat(g.items, (o) => `${o._id}|${o.occurrenceStart}`, (o) => this.renderItem(o, now))}
                        </ul>
                    </section>`;
                })}
            </div>
            <slot name="footer"></slot>
        `;
    }

    private renderItem(o: MeetingOccurrence, now: number) {
        const current = o._id === this.selected;
        const ended = Date.parse(o.occurrenceEnd) <= now;
        const live = !!o.activeCallId;
        const invitees = o.invitees?.length || 0;
        const meta = [
            o.recurrenceText,
            o.isOrganizer ? t("meetings.list.organizerYou") : o.organizer?.username ? t("meetings.list.organizer", { name: o.organizer.username }) : "",
            invitees ? (invitees === 1 ? t("meetings.list.invitees.one") : t("meetings.list.invitees.many", { n: invitees })) : "",
        ].filter(Boolean);
        const time = `${formatTime(o.occurrenceStart)} – ${formatTime(o.occurrenceEnd)}`;
        return html`<li>
            <div class="item ${current ? "current" : ""} ${ended && !live ? "ended" : ""}" part=${current ? "item item-selected" : "item"}>
                <button class="main" type="button" aria-current=${current ? "true" : "false"} @click=${() => this.select(o)}>
                    <span class="time" part="time">${time}</span>
                    <span class="title" part="title">${o.title}</span>
                    ${meta.length ? html`<span class="meta" part="meta">${meta.join(" · ")}</span>` : nothing}
                </button>
                ${live
                    ? html`<span class="badge" part="badge">${t("meetings.list.live")}</span>`
                    : ended
                      ? html`<span class="badge ended" part="badge">${t("meetings.list.ended")}</span>`
                      : nothing}
                ${!ended || live
                    ? html`<button class="btn primary join" type="button" part="join" aria-label=${t("meetings.list.joinLabel", { title: o.title })} @click=${() => this.join(o)}>
                          ${icon("video", 16)}<span>${t("meetings.list.join")}</span>
                      </button>`
                    : nothing}
            </div>
        </li>`;
    }
}
