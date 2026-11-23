import { css, html, nothing, type PropertyValues } from "lit";
import { live } from "lit/directives/live.js";
import { isSpreeWeError, type SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, formatDateTime, formatTime, icon, inputStyles, stateStyles, t } from "@spreewe/ui";
import { getMeetings, parseMeetingCode, type MeetingsService } from "../service.js";
import type { MeetingPreview } from "../types.js";
import type { MeetingJoinDetail } from "./meeting-list.js";
import { errorText, spinner } from "./shared.js";
import "../strings.js";

/**
 * <spreewe-meeting-join> — enter a meeting ID or link, see what it is, give the password when asked,
 * and join. Joining adds people who weren't invited to the meeting chat; entering the call is the
 * calls module's job (handle `spreewe-meeting-join`).
 *
 * Attributes: code (a code or link; previews immediately).
 * Events: spreewe-meeting-preview { preview }, spreewe-meeting-join { meetingId, conversationId, code, lobby }.
 * Slots: header.
 * CSS parts: form, input, continue, preview, title, meta, password, join, error.
 */
export class SpreeWeMeetingJoin extends SpreeWeElement {
    static override properties = {
        code: {},
        value: { state: true },
        preview: { state: true },
        password: { state: true },
        busy: { state: true },
        error: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        inputStyles,
        stateStyles,
        css`
            :host {
                display: block;
                background: var(--_surface);
                color: var(--_text);
            }
            .wrap {
                display: grid;
                gap: var(--_s3);
                padding: var(--_s4);
            }
            form {
                display: grid;
                gap: var(--_s3);
            }
            .line {
                display: flex;
                gap: var(--_s2);
                flex-wrap: wrap;
            }
            .line .input {
                flex: 1 1 180px;
            }
            .card {
                display: grid;
                gap: var(--_s2);
                padding: var(--_s3);
                border: var(--_bw) solid var(--_border);
                border-radius: var(--_r);
                background: var(--_surface-2);
            }
            .card h3 {
                margin: 0;
                font-size: var(--_fs-lg);
                font-weight: var(--_fw-bold);
                overflow-wrap: anywhere;
            }
            .meta {
                display: grid;
                gap: 2px;
                font-size: var(--_fs-sm);
                color: var(--_text-2);
            }
            .meta span {
                display: flex;
                align-items: center;
                gap: var(--_s1);
            }
            .note {
                font-size: var(--_fs-sm);
                color: var(--_muted);
                margin: 0;
            }
            .cancelled {
                color: var(--_danger);
                font-weight: var(--_fw-medium);
            }
            .error-banner {
                margin: 0;
            }
        `,
    ];

    declare code: string;
    declare value: string;
    declare preview: MeetingPreview | null;
    declare password: string;
    declare busy: "" | "preview" | "join";
    declare error: unknown;

    private meetings: MeetingsService | null = null;
    private seq = 0;

    constructor() {
        super();
        this.code = "";
        this.value = "";
        this.preview = null;
        this.password = "";
        this.busy = "";
        this.error = null;
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.meetings = client ? getMeetings(client) : null;
        if (this.code && client) void this.lookUp(this.code);
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("code") && this.code !== this.value) {
            this.value = this.code;
            this.preview = null;
            if (this.code && this.meetings) void this.lookUp(this.code);
        }
    }

    /** Preview a code or link (also what the Continue button does). */
    async lookUp(input: string = this.value): Promise<MeetingPreview | null> {
        if (!this.meetings) return null;
        this.error = null;
        const code = parseMeetingCode(input);
        if (!code) {
            this.error = new Error(t("meetings.join.invalid"));
            return null;
        }
        const seq = ++this.seq;
        this.busy = "preview";
        try {
            const preview = await this.meetings.preview(code);
            if (seq !== this.seq) return null;
            this.preview = preview;
            this.password = "";
            this.fire("spreewe-meeting-preview", { preview });
            return preview;
        } catch (e) {
            if (seq === this.seq) this.error = isSpreeWeError(e) && e.status === 404 ? new Error(t("meetings.join.notFound")) : e;
            return null;
        } finally {
            if (seq === this.seq) this.busy = "";
        }
    }

    private async join(): Promise<void> {
        if (!this.meetings || !this.preview || this.busy) return;
        this.error = null;
        this.busy = "join";
        try {
            const res = await this.meetings.join(this.preview.code, { password: this.preview.needsPassword ? this.password : undefined });
            this.fire<MeetingJoinDetail>("spreewe-meeting-join", { meetingId: res.meetingId, conversationId: res.conversationId, code: res.code, lobby: res.lobby });
        } catch (e) {
            this.error = e;
            if (isSpreeWeError(e) && e.status === 410 && this.preview) this.preview = { ...this.preview, cancelled: true };
        } finally {
            this.busy = "";
        }
    }

    private reset(): void {
        this.preview = null;
        this.password = "";
        this.error = null;
        this.value = "";
        void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>("#code")?.focus());
    }

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        const p = this.preview;
        const error = this.error
            ? html`<div class="error-banner" part="error" role="alert">${icon("alert", 16)}<span>${errorText(this.error)}</span></div>`
            : nothing;
        return html`<div class="wrap">
            <slot name="header"></slot>
            ${p ? this.renderPreview(p) : html`<form part="form" novalidate @submit=${(e: Event) => (e.preventDefault(), void this.lookUp())}>
                      <label class="field">
                          <span>${t("meetings.join.label")}</span>
                          <span class="line">
                              <input id="code" class="input" part="input" autocomplete="off" spellcheck="false" .value=${live(this.value)}
                                  placeholder=${t("meetings.join.placeholder")} aria-invalid=${this.error ? "true" : "false"}
                                  @input=${(e: Event) => (this.value = (e.target as HTMLInputElement).value)} />
                              <button class="btn primary" part="continue" type="submit" ?disabled=${!!this.busy || !this.value.trim()}>
                                  ${this.busy === "preview" ? spinner() : t("meetings.join.continue")}
                              </button>
                          </span>
                      </label>
                  </form>`}
            ${error}
        </div>`;
    }

    private renderPreview(p: MeetingPreview) {
        const when = `${formatDateTime(p.startAt)} – ${formatTime(p.endAt)}`;
        return html`<div class="card" part="preview" aria-live="polite">
            <h3 part="title">${p.title}</h3>
            <div class="meta" part="meta">
                <span>${icon("calendar", 14)} ${when}</span>
                ${p.recurrence ? html`<span>${p.recurrence}</span>` : nothing}
                ${p.organizerName ? html`<span>${icon("users", 14)} ${t("meetings.join.organizer", { name: p.organizerName })}</span>` : nothing}
            </div>
            ${p.cancelled
                ? html`<p class="note cancelled">${t("meetings.join.cancelled")}</p>`
                : html`<p class="note">${p.invited ? t("meetings.join.invited") : t("meetings.join.notInvited")}</p>`}
            <form class="line" novalidate @submit=${(e: Event) => (e.preventDefault(), void this.join())}>
                ${p.needsPassword && !p.cancelled
                    ? html`<input class="input" part="password" type="password" autocomplete="off" aria-label=${t("meetings.join.password")}
                          placeholder=${t("meetings.join.password")} .value=${live(this.password)} @input=${(e: Event) => (this.password = (e.target as HTMLInputElement).value)} />`
                    : nothing}
                <button class="btn primary" part="join" type="submit" ?disabled=${!!this.busy || p.cancelled || (p.needsPassword && !this.password)}>
                    ${this.busy === "join" ? t("meetings.join.joining") : html`${icon("video", 16)} ${t("meetings.join.join")}`}
                </button>
                <button class="btn ghost" type="button" @click=${() => this.reset()}>${t("meetings.join.other")}</button>
            </form>
        </div>`;
    }
}
