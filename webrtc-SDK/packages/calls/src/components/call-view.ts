import { css, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, formatDuration, icon, scrollStyles, stateStyles, t } from "@spreewe/ui";
import { getCalls, type CallService } from "../service.js";
import type { CallState, Participant } from "../types.js";
import { NameBook } from "./names.js";
import "../strings.js";

/**
 * <spreewe-call-view> — the call stage for the client's current call: video grid (or presenter
 * layout while someone shares), remote audio, controls, participants panel with host and lobby
 * controls, and the joining / lobby / reconnecting / other-device / ended states. Renders nothing
 * while there is no call (`hidden-when-idle` keeps it out of the layout).
 *
 * Attributes: heading (header text), hide-header, hide-controls.
 * Events: spreewe-call-closed (after the ended screen is dismissed), spreewe-error { error }.
 * Slots: header-actions, controls-start, controls-end, ended (replace the ended screen), empty.
 * CSS parts: stage, header, grid, tile, presenter, controls, panel.
 */
export class SpreeWeCallView extends SpreeWeElement {
    static override properties = {
        heading: {},
        hideHeader: { type: Boolean, attribute: "hide-header" },
        hideControls: { type: Boolean, attribute: "hide-controls" },
        panelOpen: { state: true },
        now: { state: true },
        error: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        scrollStyles,
        stateStyles,
        css`
            :host {
                display: block;
                height: 100%;
                min-height: 320px;
                container-type: inline-size;
                container-name: sw-call;
            }
            :host([data-idle]) {
                display: none;
            }
            .stage {
                position: relative;
                display: grid;
                grid-template-rows: auto 1fr auto;
                height: 100%;
                background: var(--_call-bg);
                color: var(--_call-text);
                border-radius: var(--sw-call-radius, var(--_r));
                overflow: hidden;
            }
            header {
                display: flex;
                align-items: center;
                gap: var(--_s3);
                padding: var(--_s2) var(--_s4);
                min-height: 48px;
            }
            .title {
                flex: 1;
                min-width: 0;
                font-weight: var(--_fw-bold);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .pill {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 2px 10px;
                border-radius: var(--_r-pill);
                background: rgba(255, 255, 255, 0.08);
                font-size: var(--_fs-sm);
                color: var(--_call-muted);
            }
            .pill.rec {
                color: #ff8a8a;
            }
            .pill.rec .dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #ff5c5c;
            }
            .body {
                display: grid;
                grid-template-columns: 1fr auto;
                min-height: 0;
            }
            .main {
                min-height: 0;
                padding: var(--_s2) var(--_s3);
                display: grid;
                gap: var(--_s2);
            }
            .grid {
                display: grid;
                gap: var(--_s2);
                grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
                align-content: center;
                min-height: 0;
                overflow: auto;
            }
            .presenter {
                display: grid;
                grid-template-rows: 1fr auto;
                gap: var(--_s2);
                min-height: 0;
            }
            .presenter > spreewe-participant-tile {
                aspect-ratio: auto;
                height: 100%;
            }
            .strip {
                display: flex;
                gap: var(--_s2);
                overflow-x: auto;
            }
            .strip spreewe-participant-tile {
                width: 180px;
                flex: none;
            }
            .panel {
                width: min(320px, 100cqw);
                background: var(--_call-surface);
                border-left: 1px solid rgba(255, 255, 255, 0.08);
                display: flex;
                flex-direction: column;
                min-height: 0;
            }
            .panel h3 {
                margin: 0;
                padding: var(--_s3) var(--_s4);
                font-size: var(--_fs);
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .panel ul {
                list-style: none;
                margin: 0;
                padding: 0 var(--_s2) var(--_s2);
            }
            .panel li {
                display: flex;
                align-items: center;
                gap: var(--_s2);
                padding: var(--_s1) var(--_s2);
                border-radius: var(--_r-sm);
            }
            .panel li .name {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .panel .btn {
                min-height: 28px;
                padding: 0 var(--_s2);
                font-size: var(--_fs-sm);
                background: var(--_call-control);
                color: var(--_call-text);
                border-color: transparent;
            }
            .panel .role {
                font-size: 11px;
                color: var(--_call-muted);
            }
            .panel label {
                display: flex;
                align-items: center;
                gap: var(--_s2);
                padding: var(--_s1) var(--_s4);
                font-size: var(--_fs-sm);
            }
            .overlay {
                display: grid;
                place-items: center;
                align-content: center;
                gap: var(--_s3);
                text-align: center;
                padding: var(--_s5);
                min-height: 0;
            }
            .overlay .btn {
                background: var(--_call-control);
                color: var(--_call-text);
                border-color: transparent;
            }
            .banner {
                position: absolute;
                top: 56px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 4;
                padding: var(--_s1) var(--_s3);
                border-radius: var(--_r-pill);
                background: rgba(0, 0, 0, 0.7);
                font-size: var(--_fs-sm);
            }
            .spinner {
                border-color: rgba(255, 255, 255, 0.2);
                border-top-color: var(--_call-text);
            }
            @container sw-call (max-width: 640px) {
                .body {
                    grid-template-columns: 1fr;
                }
                .panel {
                    position: absolute;
                    inset: 48px 0 72px 0;
                    width: auto;
                    z-index: 6;
                    border-left: 0;
                }
                .strip spreewe-participant-tile {
                    width: 120px;
                }
            }
        `,
    ];

    declare heading: string;
    declare hideHeader: boolean;
    declare hideControls: boolean;
    declare panelOpen: boolean;
    declare now: number;
    declare error: string;

    private calls: CallService | null = null;
    private names: NameBook | null = null;
    private ticker: ReturnType<typeof setInterval> | null = null;

    constructor() {
        super();
        this.heading = "";
        this.hideHeader = false;
        this.hideControls = false;
        this.panelOpen = false;
        this.now = Date.now();
        this.error = "";
        this.addEventListener("spreewe-toggle-participants", () => (this.panelOpen = !this.panelOpen));
        this.addEventListener("spreewe-error", (e) => {
            const err = (e as CustomEvent<{ error: unknown }>).detail?.error;
            this.error = err instanceof Error ? err.message : "";
        });
    }

    override connectedCallback(): void {
        super.connectedCallback();
        this.ticker = setInterval(() => (this.now = Date.now()), 1000);
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        if (this.ticker) clearInterval(this.ticker);
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.calls = client ? getCalls(client) : null;
        this.names = client ? new NameBook(client, () => this.requestUpdate()) : null;
        if (this.calls) {
            this.observe(this.calls.state, (s) => this.toggleAttribute("data-idle", s.phase === "idle"));
            void this.calls.start().catch(() => undefined);
        }
    }

    private name(userId: string): string {
        if (userId === this.calls?.myUserId) return t("calls.tile.you");
        return this.names?.name(userId, t("calls.someone")) || t("calls.someone");
    }

    private async run(fn: () => Promise<unknown>): Promise<void> {
        this.error = "";
        try {
            await fn();
        } catch (e) {
            this.error = e instanceof Error ? e.message : t("common.error");
        }
    }

    protected override render() {
        const c = this.calls;
        if (!c) return html`<slot name="empty"></slot>`;
        const s = c.state.value;
        if (s.phase === "idle") return html`<slot name="empty"></slot>`;
        return html`<div class="stage" part="stage">
            ${this.hideHeader ? html`<span></span>` : this.renderHeader(s)}
            <div class="body">
                ${this.renderMain(s)}
                ${this.panelOpen && s.phase === "connected" ? this.renderPanel(s) : nothing}
            </div>
            ${this.hideControls || !["connected", "reconnecting"].includes(s.phase)
                ? html`<span></span>`
                : html`<spreewe-call-controls part="controls" .client=${this.sw}><slot name="controls-start" slot="start"></slot><slot name="controls-end" slot="end"></slot></spreewe-call-controls>`}
            ${this.error || s.error ? html`<div class="banner" role="alert">${this.error || s.error}</div>` : nothing}
            ${s.participants.map((p) => (p.stream && p.hasAudio ? html`<audio .srcObject=${p.stream} autoplay hidden></audio>` : nothing))}
        </div>`;
    }

    private renderHeader(s: CallState) {
        const elapsed = s.startedAt && s.phase === "connected" ? formatDuration(this.now - s.startedAt) : "";
        return html`<header part="header">
            <span class="title">${this.heading || (s.callType === "video" ? t("calls.button.video") : t("calls.button.audio"))}</span>
            ${s.recording?.active ? html`<span class="pill rec"><span class="dot"></span>${t("calls.recording")}</span>` : nothing}
            ${s.connection === "disconnected" || s.connection === "failed" ? html`<span class="pill">${icon("alert", 14)} ${t("calls.connection.poor")}</span>` : nothing}
            ${elapsed ? html`<span class="pill">${elapsed}</span>` : nothing}
            <slot name="header-actions"></slot>
        </header>`;
    }

    private renderMain(s: CallState) {
        const c = this.calls!;
        switch (s.phase) {
            case "starting":
            case "joining":
                return html`<div class="overlay" role="status"><span class="spinner"></span>${t(s.phase === "starting" ? "calls.phase.starting" : "calls.phase.joining")}</div>`;
            case "lobby":
                return html`<div class="overlay" role="status"><span class="spinner"></span>${t("calls.phase.lobby")}
                    <button class="btn" @click=${() => this.run(() => c.leave())}>${t("calls.controls.leave")}</button></div>`;
            case "elsewhere":
                return html`<div class="overlay">${icon("info", 28)} ${t("calls.phase.elsewhere")}
                    <button class="btn" @click=${() => this.run(() => c.takeOver())}>${t("calls.phase.takeOver")}</button>
                    <button class="btn" @click=${() => this.run(() => c.leave())}>${t("common.cancel")}</button></div>`;
            case "ended":
                return html`<slot name="ended"><div class="overlay" role="status"><strong>${t("calls.ended.title")}</strong>
                    <span>${t(`calls.ended.${s.endReason || "ended"}`)}</span>
                    <button class="btn" @click=${() => (c.reset(), this.fire("spreewe-call-closed"))}>${t("calls.ended.close")}</button></div></slot>`;
            default:
                return this.renderMedia(s);
        }
    }

    private renderMedia(s: CallState) {
        const c = this.calls!;
        const me = c.myUserId;
        const local = html`<spreewe-participant-tile part="tile" .client=${this.sw} .stream=${s.local.stream} name=${t("calls.tile.you")} mirror ?muted=${!s.local.audio} ?hand=${s.local.handRaised}></spreewe-participant-tile>`;
        const tile = (p: Participant) =>
            html`<spreewe-participant-tile part="tile" .client=${this.sw} .stream=${p.stream} name=${this.name(p.userId)} avatar=${this.names?.get(p.userId)?.avatar || ""}
                ?muted=${!p.hasAudio} .speaking=${p.level} ?hand=${p.handRaised} reaction=${p.reaction || ""}></spreewe-participant-tile>`;
        const sharer = s.participants.find((p) => p.screen);
        const screen = s.local.sharing ? s.local.screen : sharer?.screen;
        return html`<div class="main">
            ${s.phase === "reconnecting" ? html`<div class="banner" role="status">${t("calls.phase.reconnecting")}</div>` : nothing}
            ${screen
                ? html`<div class="presenter" part="presenter">
                      <spreewe-participant-tile .client=${this.sw} screen .stream=${screen} name=${s.local.sharing ? t("calls.tile.yourScreen") : t("calls.tile.presenting", { name: this.name(sharer!.userId) })}></spreewe-participant-tile>
                      <div class="strip">${local}${repeat(s.participants.filter((p) => p.userId !== me), (p) => p.userId, tile)}</div>
                  </div>`
                : html`<div class="grid" part="grid">${repeat(s.participants.filter((p) => p.userId !== me), (p) => p.userId, tile)}${local}</div>`}
        </div>`;
    }

    private renderPanel(s: CallState) {
        const c = this.calls!;
        const mod = c.isModerator;
        const me = c.myUserId;
        const roleOf = (id: string) => (s.hostIds.includes(id) ? t("calls.panel.host") : s.cohostIds.includes(id) ? t("calls.panel.cohost") : "");
        return html`<aside class="panel scroll" part="panel" aria-label=${t("calls.controls.participants")}>
            ${mod && s.lobby.length
                ? html`<h3>${t("calls.panel.lobby", { n: s.lobby.length })}<button class="btn" @click=${() => this.run(() => c.admit("all"))}>${t("calls.panel.admitAll")}</button></h3>
                      <ul>${s.lobby.map((w) => html`<li><spreewe-avatar .client=${this.sw} size="28" name=${this.name(w.userId)}></spreewe-avatar><span class="name">${this.name(w.userId)}</span>
                          <button class="btn" @click=${() => this.run(() => c.admit(w.userId))}>${t("calls.panel.admit")}</button>
                          <button class="btn" @click=${() => this.run(() => c.deny(w.userId))}>${t("calls.panel.deny")}</button></li>`)}</ul>`
                : nothing}
            <h3>${t("calls.panel.title", { n: s.participants.filter((p) => p.userId !== me).length + 1 })}
                ${mod ? html`<button class="btn" @click=${() => this.run(() => c.muteAll())}>${t("calls.panel.muteAll")}</button>` : nothing}</h3>
            <ul>
                <li><spreewe-avatar .client=${this.sw} size="28" name=${t("calls.tile.you")}></spreewe-avatar><span class="name">${t("calls.tile.you")}</span><span class="role">${roleOf(me)}</span></li>
                ${s.participants.filter((p) => p.userId !== me).map(
                    (p) => html`<li>
                        <spreewe-avatar .client=${this.sw} size="28" name=${this.name(p.userId)} src=${this.names?.get(p.userId)?.avatar || ""}></spreewe-avatar>
                        <span class="name">${this.name(p.userId)}${p.handRaised ? " ✋" : ""}</span>
                        <span class="role">${roleOf(p.userId)}</span>
                        ${mod && !s.hostIds.includes(p.userId)
                            ? html`${p.hasAudio ? html`<button class="btn" title=${t("calls.panel.mute")} @click=${() => this.run(() => c.muteParticipant(p.userId))}>${icon("mic-off", 14)}</button>` : nothing}
                                  ${s.hostIds.includes(me)
                                      ? html`<button class="btn" @click=${() => this.run(() => c.setCohost(p.userId, !s.cohostIds.includes(p.userId)))}>${s.cohostIds.includes(p.userId) ? t("calls.panel.removeCohost") : t("calls.panel.makeCohost")}</button>`
                                      : nothing}
                                  <button class="btn" title=${t("calls.panel.remove")} @click=${() => this.run(() => c.removeParticipant(p.userId))}>${icon("user-minus", 14)}</button>`
                            : nothing}
                    </li>`,
                )}
            </ul>
            ${mod
                ? html`<label><input type="checkbox" .checked=${!!s.settings.lobby} @change=${(e: Event) => this.run(() => c.updateSettings({ lobby: (e.target as HTMLInputElement).checked }))} /> ${t("calls.panel.lobbySetting")}</label>
                      <label><input type="checkbox" .checked=${s.settings.allowUnmute !== false} @change=${(e: Event) => this.run(() => c.updateSettings({ allowUnmute: (e.target as HTMLInputElement).checked }))} /> ${t("calls.panel.allowUnmute")}</label>
                      <label><input type="checkbox" .checked=${s.settings.allowShare !== false} @change=${(e: Event) => this.run(() => c.updateSettings({ allowShare: (e.target as HTMLInputElement).checked }))} /> ${t("calls.panel.allowShare")}</label>
                      <label><button class="btn" @click=${() => this.run(() => (s.recording?.active ? c.stopRecording() : c.startRecording()))}>${icon("record", 14)} ${s.recording?.active ? t("calls.panel.stopRecord") : t("calls.panel.record")}</button></label>`
                : nothing}
        </aside>`;
    }
}
