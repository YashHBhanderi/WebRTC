import { css, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { PRESENCE_STATUSES, type PresenceStatus, type SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, inputStyles, presenceKind, stateStyles, t } from "@spreewe/ui";
import { STATUS_MESSAGE_MAX, getContacts, type ContactsService } from "../service.js";
import type { MyPresence, MyProfile } from "../types.js";
import { errorBanner, errorState, spinner } from "./shared.js";
import "../strings.js";

export interface PresenceChangeDetail {
    status: PresenceStatus;
    statusMessage: string;
    presence: MyPresence;
}

/**
 * <spreewe-presence-picker> — the signed-in user's status (Available, Busy, Do not disturb, Away,
 * Appear offline) and status message, set over the socket (`presence:set`).
 *
 * Scopes: profile:read (current status), profile:write + realtime:connect (change it).
 * Attributes: no-message (hide the status message field).
 * Events: spreewe-presence-change { status, statusMessage, presence }.
 * Slots: header.
 * CSS parts: statuses, status, status-selected, message, save, clear, error.
 */
export class SpreeWePresencePicker extends SpreeWeElement {
    static override properties = {
        noMessage: { type: Boolean, attribute: "no-message" },
        status: { state: true },
        statusMessage: { state: true },
        draft: { state: true },
        loading: { state: true },
        loadError: { state: true },
        error: { state: true },
        busy: { state: true },
        canWrite: { state: true },
        saved: { state: true },
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
                padding: var(--_s3);
            }
            fieldset {
                border: 0;
                margin: 0;
                padding: 0;
                display: grid;
                gap: 2px;
                min-width: 0;
            }
            legend {
                padding: 0;
                margin-bottom: var(--_s1);
                font-size: var(--_fs-sm);
                font-weight: var(--_fw-medium);
                color: var(--_text-2);
            }
            label.opt {
                display: flex;
                align-items: center;
                gap: var(--_s2);
                padding: var(--_s2);
                border-radius: var(--_r-sm);
                cursor: pointer;
            }
            label.opt:hover {
                background: var(--_hover);
            }
            label.opt.selected {
                background: var(--_active);
            }
            label.opt input {
                position: absolute;
                opacity: 0;
                width: 1px;
                height: 1px;
            }
            label.opt:focus-within {
                box-shadow: var(--_focus);
            }
            .dot {
                width: 10px;
                height: 10px;
                border-radius: 50%;
                flex: none;
                background: var(--_p-offline);
            }
            .dot.online {
                background: var(--_p-online);
            }
            .dot.busy {
                background: var(--_p-busy);
            }
            .dot.away {
                background: var(--_p-away);
            }
            .dot.offline {
                background: transparent;
                border: 2px solid var(--_p-offline);
            }
            .check {
                margin-left: auto;
                color: var(--_brand);
                font-weight: var(--_fw-bold);
            }
            form {
                display: grid;
                gap: var(--_s2);
            }
            .line {
                display: flex;
                flex-wrap: wrap;
                gap: var(--_s2);
            }
            .line .input {
                flex: 1 1 160px;
            }
            .note {
                margin: 0;
                font-size: var(--_fs-sm);
                color: var(--_muted);
            }
            .error-banner {
                margin: 0;
            }
        `,
    ];

    declare noMessage: boolean;
    declare status: PresenceStatus;
    declare statusMessage: string;
    declare draft: string;
    declare loading: boolean;
    declare loadError: unknown;
    declare error: unknown;
    declare busy: boolean;
    declare canWrite: boolean;
    declare saved: boolean;

    private contacts: ContactsService | null = null;

    constructor() {
        super();
        this.noMessage = false;
        this.status = "Available";
        this.statusMessage = "";
        this.draft = "";
        this.loading = false;
        this.loadError = null;
        this.error = null;
        this.busy = false;
        this.canWrite = true;
        this.saved = false;
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.contacts = client ? getContacts(client) : null;
        if (!client || !this.contacts) return;
        this.observe(this.contacts.me, (me) => me && this.apply(me));
        void client.hasScopes("profile:write", "realtime:connect").then((ok) => (this.canWrite = ok), () => undefined);
        void this.load();
    }

    private apply(me: Pick<MyProfile, "status" | "statusMessage">): void {
        const changedMessage = (me.statusMessage || "") !== this.statusMessage;
        this.status = me.status || "Available";
        this.statusMessage = me.statusMessage || "";
        if (changedMessage) this.draft = this.statusMessage;
    }

    private async load(): Promise<void> {
        if (!this.contacts) return;
        this.loading = true;
        this.loadError = null;
        try {
            this.apply(await this.contacts.loadMyProfile({ refresh: true }));
        } catch (e) {
            this.loadError = e;
        } finally {
            this.loading = false;
        }
    }

    private async set(update: { status?: PresenceStatus; statusMessage?: string }): Promise<void> {
        if (!this.contacts || this.busy) return;
        const before = { status: this.status, statusMessage: this.statusMessage };
        this.busy = true;
        this.error = null;
        this.saved = false;
        // Optimistic: the radio follows the click right away and reverts on failure
        if (update.status) this.status = update.status;
        try {
            const presence = await this.contacts.setPresence(update);
            this.status = presence.ownStatus;
            this.statusMessage = presence.statusMessage || "";
            this.draft = this.statusMessage;
            this.saved = true;
            this.fire<PresenceChangeDetail>("spreewe-presence-change", { status: presence.ownStatus, statusMessage: this.statusMessage, presence });
        } catch (e) {
            this.status = before.status;
            this.statusMessage = before.statusMessage;
            this.error = e;
        } finally {
            this.busy = false;
        }
    }

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        if (this.loadError && !this.contacts?.me.value) return errorState(this.loadError, () => void this.load(), "profile:read");
        if (this.loading && !this.contacts?.me.value) return html`<div class="state">${spinner()}</div>`;
        const disabled = !this.canWrite || this.busy;
        const draft = this.draft.trim();
        return html`<div class="wrap">
            <slot name="header"></slot>
            <fieldset part="statuses" ?disabled=${disabled}>
                <legend>${t("contacts.presence.label")}</legend>
                ${PRESENCE_STATUSES.map((s) => {
                    const selected = s === this.status;
                    const kind = s === "Appear offline" ? "offline" : presenceKind({ isOnline: true, status: s });
                    return html`<label class="opt ${selected ? "selected" : ""}" part=${selected ? "status status-selected" : "status"}>
                        <input type="radio" name="status" value=${s} .checked=${live(selected)} @change=${() => this.set({ status: s })} />
                        <span class="dot ${kind}" aria-hidden="true"></span>
                        <span>${t(`contacts.status.${s}`)}</span>
                        ${selected ? html`<span class="check" aria-hidden="true">✓</span>` : nothing}
                    </label>`;
                })}
            </fieldset>
            ${this.noMessage
                ? nothing
                : html`<form novalidate @submit=${(e: Event) => (e.preventDefault(), void this.set({ statusMessage: draft }))}>
                      <label class="field">
                          <span>${t("contacts.presence.message")}</span>
                          <span class="line">
                              <input class="input" part="message" maxlength=${STATUS_MESSAGE_MAX} ?disabled=${disabled} .value=${live(this.draft)}
                                  placeholder=${t("contacts.presence.messagePlaceholder")} @input=${(e: Event) => (this.draft = (e.target as HTMLInputElement).value)} />
                              <button class="btn primary" part="save" type="submit" ?disabled=${disabled || draft === this.statusMessage}>${t("contacts.presence.save")}</button>
                              ${this.statusMessage
                                  ? html`<button class="btn" part="clear" type="button" ?disabled=${disabled} @click=${() => this.set({ statusMessage: "" })}>${t("contacts.presence.clear")}</button>`
                                  : nothing}
                          </span>
                      </label>
                  </form>`}
            ${!this.canWrite ? errorBanner(new Error(t("contacts.missingScope", { scope: "profile:write, realtime:connect" }))) : nothing}
            ${this.error ? errorBanner(this.error, "profile:write") : nothing}
            ${this.saved ? html`<p class="note" role="status">${t("contacts.presence.saved")} ${t("contacts.presence.appNote")}</p>` : nothing}
        </div>`;
    }
}
