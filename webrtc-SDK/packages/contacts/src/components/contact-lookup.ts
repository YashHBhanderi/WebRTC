import { css, html, nothing, type PropertyValues } from "lit";
import { live } from "lit/directives/live.js";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, inputStyles, stateStyles, t } from "@spreewe/ui";
import { getContacts, type ContactsService } from "../service.js";
import type { ContactLookupResult, ContactScope } from "../types.js";
import { errorBanner, spinner } from "./shared.js";
import "../strings.js";

export interface ConversationStartDetail {
    conversationId: string;
    external: boolean;
    user: { _id: string; username: string; avatar: string };
    /** false when the conversation already existed and no request was needed */
    started: boolean;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/**
 * <spreewe-contact-lookup> — find a person by exact e-mail and start (or open) a direct chat with them.
 * Does not open the chat itself: handle `spreewe-conversation-start` (e.g. with @spreewe/chat).
 *
 * Attributes: email (prefill), allow-external (in an organization, offer "someone outside my organization").
 * Events: spreewe-conversation-start { conversationId, external, user, started }.
 * Slots: header.
 * CSS parts: form, input, find, scope, result, avatar, name, start, error.
 */
export class SpreeWeContactLookup extends SpreeWeElement {
    static override properties = {
        email: {},
        allowExternal: { type: Boolean, attribute: "allow-external" },
        value: { state: true },
        scope: { state: true },
        result: { state: true },
        busy: { state: true },
        error: { state: true },
        inOrganization: { state: true },
        canStart: { state: true },
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
                flex-wrap: wrap;
                gap: var(--_s2);
            }
            .line .input {
                flex: 1 1 180px;
            }
            fieldset {
                border: 0;
                margin: 0;
                padding: 0;
                display: grid;
                gap: var(--_s1);
            }
            legend {
                padding: 0;
                margin-bottom: var(--_s1);
                font-size: var(--_fs-sm);
                font-weight: var(--_fw-medium);
                color: var(--_text-2);
            }
            .radio {
                display: flex;
                align-items: center;
                gap: var(--_s2);
            }
            .result {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: var(--_s3);
                padding: var(--_s3);
                border: var(--_bw) solid var(--_border);
                border-radius: var(--_r);
                background: var(--_surface-2);
            }
            .who {
                flex: 1 1 140px;
                min-width: 0;
                display: flex;
                align-items: center;
                gap: var(--_s2);
            }
            .name {
                font-weight: var(--_fw-medium);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .tag {
                font-size: 10px;
                font-weight: var(--_fw-bold);
                text-transform: uppercase;
                letter-spacing: 0.04em;
                padding: 1px 6px;
                border-radius: var(--_r-pill);
                background: var(--_brand-soft);
                color: var(--_text-2);
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

    declare email: string;
    declare allowExternal: boolean;
    declare value: string;
    declare scope: ContactScope;
    declare result: ContactLookupResult | null;
    declare busy: "" | "lookup" | "start";
    declare error: unknown;
    declare inOrganization: boolean;
    declare canStart: boolean;

    private contacts: ContactsService | null = null;
    private seq = 0;

    constructor() {
        super();
        this.email = "";
        this.allowExternal = false;
        this.value = "";
        this.scope = "member";
        this.result = null;
        this.busy = "";
        this.error = null;
        this.inOrganization = false;
        this.canStart = true;
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.contacts = client ? getContacts(client) : null;
        this.result = null;
        if (!client) return;
        void client.loadMe().then((me) => (this.inOrganization = !!me.context?.tenantId), () => (this.inOrganization = false));
        void client.hasScopes("contacts:write").then((ok) => (this.canStart = ok), () => undefined);
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("email") && this.email !== this.value) {
            this.value = this.email;
            this.result = null;
        }
    }

    private get effectiveScope(): ContactScope | undefined {
        // The scope only exists in an organization; the personal context refuses "external" (400)
        return this.inOrganization && this.allowExternal ? this.scope : undefined;
    }

    /** Look up the e-mail in the input (what the Find button does). */
    async lookUp(): Promise<ContactLookupResult | null> {
        if (!this.contacts || this.busy) return null;
        const email = this.value.trim();
        this.error = null;
        this.result = null;
        if (!EMAIL.test(email)) {
            this.error = new Error(t("contacts.lookup.invalid"));
            return null;
        }
        const seq = ++this.seq;
        this.busy = "lookup";
        try {
            const result = await this.contacts.lookup(email, { scope: this.effectiveScope });
            if (seq === this.seq) this.result = result;
            return result;
        } catch (e) {
            if (seq === this.seq) this.error = e;
            return null;
        } finally {
            if (seq === this.seq) this.busy = "";
        }
    }

    private async start(): Promise<void> {
        const r = this.result;
        if (!this.contacts || !r?.found || !r.user || this.busy) return;
        if (r.conversationId) {
            this.fire<ConversationStartDetail>("spreewe-conversation-start", { conversationId: r.conversationId, external: !!r.external, user: r.user, started: false });
            return;
        }
        this.busy = "start";
        this.error = null;
        try {
            const res = await this.contacts.startConversation(this.value.trim(), { scope: this.effectiveScope });
            this.result = { ...r, conversationId: res.conversationId, external: res.external };
            this.fire<ConversationStartDetail>("spreewe-conversation-start", { conversationId: res.conversationId, external: res.external, user: r.user, started: true });
        } catch (e) {
            this.error = e;
        } finally {
            this.busy = "";
        }
    }

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        const r = this.result;
        return html`<div class="wrap">
            <slot name="header"></slot>
            <form part="form" novalidate @submit=${(e: Event) => (e.preventDefault(), void this.lookUp())}>
                ${this.inOrganization && this.allowExternal
                    ? html`<fieldset part="scope">
                          <legend>${t("contacts.lookup.scope")}</legend>
                          ${(["member", "external"] as const).map(
                              (s) => html`<label class="radio">
                                  <input type="radio" name="scope" value=${s} .checked=${live(this.scope === s)} @change=${() => ((this.scope = s), (this.result = null))} />
                                  <span>${t(`contacts.lookup.scope.${s}`)}</span>
                              </label>`,
                          )}
                      </fieldset>`
                    : nothing}
                <label class="field">
                    <span>${t("contacts.lookup.label")}</span>
                    <span class="line">
                        <input class="input" part="input" type="email" inputmode="email" autocomplete="off" spellcheck="false" maxlength="254"
                            placeholder=${t("contacts.lookup.placeholder")} .value=${live(this.value)} aria-invalid=${this.error && !r ? "true" : "false"}
                            @input=${(e: Event) => {
                                this.value = (e.target as HTMLInputElement).value;
                                this.result = null;
                            }} />
                        <button class="btn primary" part="find" type="submit" ?disabled=${!!this.busy || !this.value.trim()}>
                            ${this.busy === "lookup" ? spinner() : html`${icon("search", 16)} ${t("contacts.lookup.find")}`}
                        </button>
                    </span>
                </label>
            </form>
            ${r && !r.found ? html`<p class="note" role="status">${r.message || ""}</p>` : nothing}
            ${r?.found && r.user ? this.renderResult(r) : nothing}
            ${this.error ? errorBanner(this.error, "directory:read") : nothing}
        </div>`;
    }

    private renderResult(r: ContactLookupResult) {
        const u = r.user!;
        const exists = !!r.conversationId;
        return html`<div class="result" part="result" role="status">
            <span class="who">
                <spreewe-avatar part="avatar" .client=${this.sw} name=${u.username} src=${u.avatar || ""}></spreewe-avatar>
                <span class="name" part="name">${u.username}</span>
                ${r.external ? html`<span class="tag">${t("contacts.lookup.external")}</span>` : nothing}
            </span>
            ${exists || this.canStart
                ? html`<button class="btn primary" part="start" type="button" ?disabled=${!!this.busy} @click=${() => this.start()}>
                      ${this.busy === "start" ? t("contacts.lookup.starting") : html`${icon("message", 16)} ${exists ? t("contacts.lookup.open") : t("contacts.lookup.start")}`}
                  </button>`
                : html`<p class="note">${t("contacts.lookup.noStart")}</p>`}
        </div>`;
    }
}
