import { css, html, nothing } from "lit";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, icon, t } from "@spreewe/ui";
import { getCalls, type CallService } from "../service.js";
import "../strings.js";

const REACTIONS = ["👍", "👏", "😂", "❤️", "🎉", "😮"];

/**
 * <spreewe-call-controls> — microphone, camera, screen share, hand, reactions, participants and
 * leave / end buttons for the current call. Hide any with the attributes no-screen, no-hand,
 * no-reactions, no-participants.
 * Events: spreewe-toggle-participants, spreewe-error { error }.
 * Slots: start, end (extra buttons). CSS parts: bar, button, leave.
 */
export class SpreeWeCallControls extends SpreeWeElement {
    static override properties = {
        noScreen: { type: Boolean, attribute: "no-screen" },
        noHand: { type: Boolean, attribute: "no-hand" },
        noReactions: { type: Boolean, attribute: "no-reactions" },
        noParticipants: { type: Boolean, attribute: "no-participants" },
        reactOpen: { state: true },
        leaveOpen: { state: true },
    };

    static override styles = [
        baseStyles,
        css`
            :host {
                display: block;
            }
            .bar {
                display: flex;
                flex-wrap: wrap;
                justify-content: center;
                align-items: center;
                gap: var(--_s2);
                padding: var(--_s3);
                position: relative;
            }
            button {
                font: inherit;
                width: 48px;
                height: 48px;
                border-radius: 50%;
                border: 0;
                display: grid;
                place-items: center;
                background: var(--_call-control);
                color: var(--_call-text);
                cursor: pointer;
                transition: background var(--_t);
            }
            button:hover:not(:disabled) {
                background: var(--_call-control-hover);
            }
            button[aria-pressed="false"].toggle {
                background: #e8eaed;
                color: #19222b;
            }
            button.active {
                background: var(--sw-call-active, #3f7fb4);
            }
            button.leave {
                width: auto;
                padding: 0 var(--_s4);
                border-radius: var(--_r-pill);
                background: var(--_call-danger);
                display: inline-flex;
                gap: var(--_s2);
                font-weight: var(--_fw-bold);
            }
            button:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .pop {
                position: absolute;
                bottom: calc(100% - 4px);
                left: 50%;
                transform: translateX(-50%);
                display: flex;
                gap: 4px;
                padding: var(--_s1);
                border-radius: var(--_r-pill);
                background: var(--_call-surface);
                box-shadow: var(--_shadow);
                z-index: 5;
            }
            .pop button {
                width: 40px;
                height: 40px;
                font-size: 22px;
                background: transparent;
            }
            .menu {
                position: absolute;
                bottom: calc(100% - 4px);
                right: var(--_s3);
                display: grid;
                gap: 4px;
                padding: var(--_s1);
                border-radius: var(--_r);
                background: var(--_call-surface);
                box-shadow: var(--_shadow);
                z-index: 5;
            }
            .menu button {
                width: auto;
                height: 40px;
                padding: 0 var(--_s3);
                border-radius: var(--_r-sm);
                justify-content: start;
                display: flex;
                background: transparent;
            }
            .menu button.danger {
                color: #ff8a8a;
            }
            @media (max-width: 480px) {
                button {
                    width: 42px;
                    height: 42px;
                }
            }
        `,
    ];

    declare noScreen: boolean;
    declare noHand: boolean;
    declare noReactions: boolean;
    declare noParticipants: boolean;
    declare reactOpen: boolean;
    declare leaveOpen: boolean;

    private calls: CallService | null = null;
    private canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices && "getDisplayMedia" in navigator.mediaDevices;

    constructor() {
        super();
        this.noScreen = false;
        this.noHand = false;
        this.noReactions = false;
        this.noParticipants = false;
        this.reactOpen = false;
        this.leaveOpen = false;
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.calls = client ? getCalls(client) : null;
        if (this.calls) this.observe(this.calls.state);
    }

    private async run(fn: () => Promise<unknown> | void): Promise<void> {
        try {
            await fn();
        } catch (error) {
            this.fire("spreewe-error", { error });
        }
    }

    protected override render() {
        const c = this.calls;
        if (!c) return nothing;
        const s = c.state.value;
        const connected = s.phase === "connected";
        const shareBlocked = s.settings.allowShare === false && !c.isModerator;
        const someoneElseShares = !!s.screenSharerUserId && s.screenSharerUserId !== c.myUserId;
        const canEnd = !!s.conversationId;
        return html`<div class="bar" part="bar" role="toolbar" aria-label=${t("calls.controls.mic")}>
            <slot name="start"></slot>
            <button class="toggle" part="button" aria-pressed=${s.local.audio ? "true" : "false"} title=${s.local.audio ? t("calls.controls.micOn") : t("calls.controls.micOff")}
                aria-label=${s.local.audio ? t("calls.controls.micOn") : t("calls.controls.micOff")} ?disabled=${!connected} @click=${() => this.run(() => c.setMicrophone(!s.local.audio))}>
                ${icon(s.local.audio ? "mic" : "mic-off", 22)}
            </button>
            <button class="toggle" part="button" aria-pressed=${s.local.video ? "true" : "false"} title=${s.local.video ? t("calls.controls.cameraOn") : t("calls.controls.cameraOff")}
                aria-label=${s.local.video ? t("calls.controls.cameraOn") : t("calls.controls.cameraOff")} ?disabled=${!connected} @click=${() => this.run(() => c.setCamera(!s.local.video))}>
                ${icon(s.local.video ? "video" : "video-off", 22)}
            </button>
            ${this.noScreen || !this.canShare
                ? nothing
                : html`<button part="button" class=${s.local.sharing ? "active" : ""} aria-pressed=${s.local.sharing ? "true" : "false"} title=${s.local.sharing ? t("calls.controls.shareStop") : t("calls.controls.shareStart")}
                      aria-label=${s.local.sharing ? t("calls.controls.shareStop") : t("calls.controls.shareStart")} ?disabled=${!connected || (!s.local.sharing && (shareBlocked || someoneElseShares))}
                      @click=${() => this.run(() => (s.local.sharing ? c.stopScreenShare() : c.startScreenShare()))}>${icon("screen", 22)}</button>`}
            ${this.noHand
                ? nothing
                : html`<button part="button" class=${s.local.handRaised ? "active" : ""} aria-pressed=${s.local.handRaised ? "true" : "false"} title=${s.local.handRaised ? t("calls.controls.handDown") : t("calls.controls.hand")}
                      aria-label=${s.local.handRaised ? t("calls.controls.handDown") : t("calls.controls.hand")} ?disabled=${!connected} @click=${() => c.raiseHand(!s.local.handRaised)}>${icon("hand", 22)}</button>`}
            ${this.noReactions
                ? nothing
                : html`<button part="button" aria-label=${t("calls.controls.react")} title=${t("calls.controls.react")} aria-expanded=${this.reactOpen ? "true" : "false"} ?disabled=${!connected} @click=${() => (this.reactOpen = !this.reactOpen)}>${icon("smile", 22)}</button>`}
            ${this.noParticipants
                ? nothing
                : html`<button part="button" aria-label=${t("calls.controls.participants")} title=${t("calls.controls.participants")} @click=${() => this.fire("spreewe-toggle-participants")}>${icon("users", 22)}</button>`}
            <slot name="end"></slot>
            <button class="leave" part="button leave" aria-haspopup=${canEnd && c.isModerator ? "menu" : "false"} @click=${() => (c.isModerator && canEnd ? (this.leaveOpen = !this.leaveOpen) : this.run(() => c.leave()))}>
                ${icon("phone-off", 22)} ${t("calls.controls.leave")}
            </button>
            ${this.reactOpen
                ? html`<div class="pop" role="menu">${REACTIONS.map((e) => html`<button role="menuitem" aria-label=${e} @click=${() => ((this.reactOpen = false), c.react(e))}>${e}</button>`)}</div>`
                : nothing}
            ${this.leaveOpen
                ? html`<div class="menu" role="menu">
                      <button role="menuitem" @click=${() => ((this.leaveOpen = false), this.run(() => c.leave()))}>${icon("logout", 18)} ${t("calls.controls.leave")}</button>
                      <button role="menuitem" class="danger" @click=${() => ((this.leaveOpen = false), this.run(() => c.end()))}>${icon("phone-off", 18)} ${t("calls.controls.end")}</button>
                  </div>`
                : nothing}
        </div>`;
    }
}
