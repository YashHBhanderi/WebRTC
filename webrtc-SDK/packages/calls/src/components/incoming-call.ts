import { css, html, nothing, type PropertyValues } from "lit";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, t } from "@spreewe/ui";
import { getCalls, isCallPhaseActive, type CallService } from "../service.js";
import type { CallInvite } from "../types.js";
import { NameBook } from "./names.js";
import "../strings.js";

/**
 * <spreewe-incoming-call> — shows ringing calls (and, with `show-active`, group calls in progress the
 * user can join) with accept / decline. Place it once, anywhere: it renders nothing without invites.
 *
 * Attributes: show-active, ringtone (URL of an audio file to loop while ringing; none by default),
 *             position = "top-right" (default) | "bottom-right" | "inline".
 * Events: spreewe-call-accepted { invite }, spreewe-call-declined { invite }, spreewe-incoming-call { invite }
 *         (cancelable: preventDefault() to handle the invite with your own UI).
 * CSS parts: card, title, accept, decline.
 */
export class SpreeWeIncomingCall extends SpreeWeElement {
    static override properties = {
        showActive: { type: Boolean, attribute: "show-active" },
        ringtone: {},
        position: { reflect: true },
        error: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        css`
            :host {
                position: fixed;
                top: var(--_s4);
                right: var(--_s4);
                z-index: var(--sw-incoming-z, 1000);
                display: grid;
                gap: var(--_s2);
                width: min(360px, calc(100vw - 2 * var(--_s4)));
            }
            :host([position="bottom-right"]) {
                top: auto;
                bottom: var(--_s4);
            }
            :host([position="inline"]) {
                position: static;
                width: auto;
            }
            .card {
                display: grid;
                grid-template-columns: auto 1fr;
                gap: var(--_s3);
                align-items: center;
                padding: var(--_s3);
                border-radius: var(--_r-lg);
                background: var(--_surface);
                border: var(--_bw) solid var(--_border);
                box-shadow: var(--_shadow);
                animation: in 180ms ease-out;
            }
            .title {
                font-weight: var(--_fw-bold);
            }
            .sub {
                font-size: var(--_fs-sm);
                color: var(--_muted);
            }
            .actions {
                grid-column: 1 / -1;
                display: flex;
                gap: var(--_s2);
                justify-content: flex-end;
                flex-wrap: wrap;
            }
            .accept {
                background: var(--_success);
                border-color: var(--_success);
                color: #fff;
            }
            .decline {
                background: var(--_danger);
                border-color: var(--_danger);
                color: #fff;
            }
            .err {
                grid-column: 1 / -1;
                color: var(--_danger);
                font-size: var(--_fs-sm);
            }
            @keyframes in {
                from {
                    opacity: 0;
                    transform: translateY(-8px);
                }
            }
            @media (prefers-reduced-motion: reduce) {
                .card {
                    animation: none;
                }
            }
        `,
    ];

    declare showActive: boolean;
    declare ringtone: string;
    declare position: "top-right" | "bottom-right" | "inline";
    declare error: string;

    private calls: CallService | null = null;
    private names: NameBook | null = null;
    private announced = new Set<string>();
    private audio: HTMLAudioElement | null = null;

    constructor() {
        super();
        this.showActive = false;
        this.ringtone = "";
        this.position = "top-right";
        this.error = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.calls = client ? getCalls(client) : null;
        this.names = client ? new NameBook(client, () => this.requestUpdate()) : null;
        if (!this.calls) return;
        this.observe(this.calls.invites, (list) => {
            for (const inv of list) {
                if (this.announced.has(inv.callId)) continue;
                this.announced.add(inv.callId);
                this.fire("spreewe-incoming-call", { invite: inv }, { cancelable: true });
            }
            this.updateRingtone(list);
        });
        this.observe(this.calls.state);
        void this.calls.start().catch(() => undefined);
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        this.audio?.pause();
        this.audio = null;
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("ringtone") && this.audio) {
            this.audio.pause();
            this.audio = null;
        }
    }

    private visible(): CallInvite[] {
        const list = this.calls?.invites.value || [];
        return list.filter((i) => i.kind === "ring" || this.showActive);
    }

    private updateRingtone(list: CallInvite[]): void {
        const ringing = list.some((i) => i.kind === "ring") && !isCallPhaseActive(this.calls?.state.value.phase || "idle");
        if (!this.ringtone) return;
        if (ringing) {
            this.audio ||= Object.assign(new Audio(this.ringtone), { loop: true });
            void this.audio.play().catch(() => undefined);
        } else this.audio?.pause();
    }

    private async accept(inv: CallInvite, video: boolean): Promise<void> {
        this.error = "";
        this.audio?.pause();
        try {
            await this.calls!.accept(inv, { callType: video ? "video" : "audio" });
            this.fire("spreewe-call-accepted", { invite: inv });
        } catch (e) {
            this.error = e instanceof Error ? e.message : t("common.error");
        }
    }

    protected override render() {
        if (!this.calls) return nothing;
        const busy = isCallPhaseActive(this.calls.state.value.phase);
        const list = this.visible();
        if (!list.length) return nothing;
        return html`${list.map((inv) => {
            const name = this.names?.name(inv.initiatedBy, t("calls.someone")) || t("calls.someone");
            const ring = inv.kind === "ring";
            return html`<div class="card" part="card" role="alertdialog" aria-live="assertive" aria-label=${ring ? t(`calls.incoming.${inv.callType}`) : t("calls.incoming.active")}>
                <spreewe-avatar .client=${this.sw} size="44" name=${name} src=${this.names?.get(inv.initiatedBy)?.avatar || ""}></spreewe-avatar>
                <div><div class="title" part="title">${name}</div><div class="sub">${ring ? t(`calls.incoming.${inv.callType}`) : t("calls.incoming.active")}</div></div>
                ${this.error ? html`<div class="err" role="alert">${this.error}</div>` : nothing}
                <div class="actions">
                    ${ring
                        ? html`<button class="btn decline" part="decline" @click=${() => (this.calls!.reject(inv), this.fire("spreewe-call-declined", { invite: inv }))}>${icon("phone-off", 18)} ${t("calls.incoming.decline")}</button>`
                        : html`<button class="btn" @click=${() => this.calls!.dismiss(inv.callId)}>${t("calls.incoming.dismiss")}</button>`}
                    ${inv.callType === "video"
                        ? html`<button class="btn accept" part="accept" ?disabled=${busy} @click=${() => this.accept(inv, true)}>${icon("video", 18)} ${ring ? t("calls.incoming.acceptVideo") : t("calls.incoming.join")}</button>`
                        : nothing}
                    <button class="btn accept" part="accept" ?disabled=${busy} @click=${() => this.accept(inv, false)}>${icon("phone", 18)} ${ring ? t("calls.incoming.accept") : t("calls.incoming.join")}</button>
                </div>
            </div>`;
        })}`;
    }
}
