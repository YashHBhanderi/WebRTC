import { css, html, nothing, type PropertyValues } from "lit";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, t } from "@spreewe/ui";
import { getCalls, isCallPhaseActive, type CallService } from "../service.js";
import type { CallMode, CallType } from "../types.js";
import "../strings.js";

/**
 * <spreewe-call-button conversation-id="…" call-type="video"> — starts a call in a conversation, or
 * joins the one already running there. Put it in <spreewe-chat-window>'s `header-actions` slot.
 *
 * Attributes: conversation-id, call-type ("audio" | "video"), mode ("ring" | "meetNow"; server default
 * when omitted), label (show text next to the icon).
 * Events: spreewe-call-started { conversationId, callType }, spreewe-error { error }.
 * CSS part: button.
 */
export class SpreeWeCallButton extends SpreeWeElement {
    static override properties = {
        conversationId: { attribute: "conversation-id", reflect: true },
        callType: { attribute: "call-type" },
        mode: {},
        label: { type: Boolean },
        activeCallId: { state: true },
        busy: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        css`
            :host {
                display: inline-block;
            }
            .join {
                color: var(--_success);
            }
        `,
    ];

    declare conversationId: string;
    declare callType: CallType;
    declare mode: CallMode | "";
    declare label: boolean;
    declare activeCallId: string;
    declare busy: boolean;

    private calls: CallService | null = null;

    constructor() {
        super();
        this.conversationId = "";
        this.callType = "video";
        this.mode = "";
        this.label = false;
        this.activeCallId = "";
        this.busy = false;
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.calls = client ? getCalls(client) : null;
        if (!this.calls) return;
        this.observe(this.calls.state);
        this.observe(this.calls.invites, (list) => {
            const active = list.find((i) => i.conversationId === this.conversationId);
            if (active) this.activeCallId = active.callId;
        });
        void this.check();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("conversationId") && changed.get("conversationId") !== undefined) void this.check();
    }

    private async check(): Promise<void> {
        this.activeCallId = "";
        if (!this.calls || !this.conversationId) return;
        try {
            this.activeCallId = (await this.calls.activeCall(this.conversationId))?.callId || "";
        } catch {
            // calls:read missing or not a member: the button still starts calls
        }
    }

    private async go(): Promise<void> {
        if (!this.calls || this.busy) return;
        this.busy = true;
        try {
            if (this.activeCallId) await this.calls.accept(this.activeCallId, { callType: this.callType });
            else await this.calls.startCall(this.conversationId, this.callType, this.mode ? { mode: this.mode } : {});
            this.fire("spreewe-call-started", { conversationId: this.conversationId, callType: this.callType });
        } catch (error) {
            this.fire("spreewe-error", { error, action: "call" });
        } finally {
            this.busy = false;
        }
    }

    protected override render() {
        const inCall = isCallPhaseActive(this.calls?.state.value.phase || "idle");
        const text = this.activeCallId ? t("calls.button.join") : this.callType === "video" ? t("calls.button.video") : t("calls.button.audio");
        return html`<button part="button" class="${this.label ? "btn" : "icon-btn"} ${this.activeCallId ? "join" : ""}" title=${text} aria-label=${text}
            ?disabled=${!this.sw || !this.conversationId || inCall || this.busy} @click=${this.go}>
            ${icon(this.callType === "video" ? "video" : "phone", 20)}${this.label ? html`<span>${text}</span>` : nothing}
        </button>`;
    }
}
