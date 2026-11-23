import { css, html, nothing, type PropertyValues } from "lit";
import { isSpreeWeError, type PresenceUpdate, type SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, formatDateTime, icon, presenceKind, stateStyles, t } from "@spreewe/ui";
import { getContacts, type ContactsService } from "../service.js";
import type { ContactProfile } from "../types.js";
import { errorBanner, errorState, presenceText, spinner } from "./shared.js";
import "../strings.js";

export interface ContactBlockDetail {
    userId: string;
    blocked: boolean;
}

/**
 * <spreewe-profile-card user-id="…"> — someone's picture, name, status, status message and bio, with
 * Message and Block / Unblock actions.
 *
 * Attributes: user-id, conversation-id (optional: their direct chat, used to read whether you blocked
 * them; needs conversations:read), no-actions.
 * Properties: blocked (boolean | undefined; set it when your app knows the block state).
 * Events: spreewe-contact-message { userId, user }, spreewe-contact-block { userId, blocked }.
 * Slots: actions (extra buttons after the built-in ones).
 * CSS parts: card, avatar, name, status, status-message, bio, actions, message, block, error.
 */
export class SpreeWeProfileCard extends SpreeWeElement {
    static override properties = {
        userId: { attribute: "user-id" },
        conversationId: { attribute: "conversation-id" },
        noActions: { type: Boolean, attribute: "no-actions" },
        blocked: { type: Boolean },
        profile: { state: true },
        loading: { state: true },
        loadError: { state: true },
        actionError: { state: true },
        canBlock: { state: true },
        confirmBlock: { state: true },
        busy: { state: true },
        me: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        stateStyles,
        css`
            :host {
                display: block;
                background: var(--_surface);
                color: var(--_text);
            }
            .card {
                display: grid;
                justify-items: center;
                gap: var(--_s2);
                padding: var(--_s5) var(--_s4) var(--_s4);
                text-align: center;
            }
            spreewe-avatar {
                --sw-avatar-ring: var(--_surface);
            }
            h2 {
                margin: var(--_s2) 0 0;
                font-size: var(--_fs-xl);
                font-weight: var(--_fw-bold);
                overflow-wrap: anywhere;
            }
            .status {
                display: inline-flex;
                align-items: center;
                gap: var(--_s1);
                font-size: var(--_fs-sm);
                color: var(--_text-2);
            }
            .dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
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
            .status-message {
                font-style: italic;
                color: var(--_text-2);
                overflow-wrap: anywhere;
            }
            .bio {
                margin: 0;
                color: var(--_text);
                overflow-wrap: anywhere;
                white-space: pre-line;
            }
            .muted {
                font-size: var(--_fs-sm);
                color: var(--_muted);
            }
            .actions {
                display: flex;
                flex-wrap: wrap;
                justify-content: center;
                gap: var(--_s2);
                margin-top: var(--_s2);
            }
            .confirm {
                display: grid;
                gap: var(--_s2);
                justify-items: center;
            }
            .error-banner {
                margin: 0;
            }
        `,
    ];

    declare userId: string;
    declare conversationId: string;
    declare noActions: boolean;
    declare blocked: boolean | undefined;
    declare profile: ContactProfile | null;
    declare loading: boolean;
    declare loadError: unknown;
    declare actionError: unknown;
    declare canBlock: boolean;
    declare confirmBlock: boolean;
    declare busy: boolean;
    declare me: string;

    private contacts: ContactsService | null = null;
    private presence: ReadonlyMap<string, PresenceUpdate> = new Map();
    private blockedMap: ReadonlyMap<string, boolean> = new Map();
    private seq = 0;
    private loadedKey = "";

    constructor() {
        super();
        this.userId = "";
        this.conversationId = "";
        this.noActions = false;
        this.blocked = undefined;
        this.profile = null;
        this.loading = false;
        this.loadError = null;
        this.actionError = null;
        this.canBlock = false;
        this.confirmBlock = false;
        this.busy = false;
        this.me = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.contacts = client ? getContacts(client) : null;
        if (!client || !this.contacts) return;
        this.observe(client.people.presence, (p) => (this.presence = p));
        this.observe(this.contacts.blocked, (b) => (this.blockedMap = b));
        void this.contacts.startPresence();
        void client.hasScopes("contacts:write", "realtime:connect").then((ok) => (this.canBlock = ok), () => (this.canBlock = false));
        void client.userId().then((id) => (this.me = id), () => undefined);
        void this.load();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if ((changed.has("userId") || changed.has("conversationId")) && this.contacts && `${this.userId}|${this.conversationId}` !== this.loadedKey) void this.load();
    }

    /** Reload the profile */
    async load(): Promise<void> {
        if (!this.contacts || !this.userId) return;
        this.loadedKey = `${this.userId}|${this.conversationId}`;
        const seq = ++this.seq;
        const userId = this.userId;
        this.loading = true;
        this.loadError = null;
        this.actionError = null;
        this.confirmBlock = false;
        if (this.profile && String(this.profile._id) !== userId) this.profile = null;
        try {
            const profile = await this.contacts.profile(userId);
            if (seq !== this.seq) return;
            this.profile = profile;
            if (this.conversationId) {
                // Optional: only with conversations:read; the card works without it
                await this.contacts.blockedInConversation(this.conversationId).catch(() => undefined);
            }
        } catch (e) {
            if (seq === this.seq) this.loadError = e;
        } finally {
            if (seq === this.seq) this.loading = false;
        }
    }

    private get isBlocked(): boolean | undefined {
        return this.blocked ?? this.blockedMap.get(this.userId);
    }

    private async toggleBlock(): Promise<void> {
        if (!this.contacts || this.busy) return;
        const block = !this.isBlocked;
        this.busy = true;
        this.actionError = null;
        try {
            const res = await (block ? this.contacts.block(this.userId) : this.contacts.unblock(this.userId));
            this.blocked = undefined;
            this.confirmBlock = false;
            this.fire<ContactBlockDetail>("spreewe-contact-block", { userId: res.userId, blocked: res.blocked });
        } catch (e) {
            this.actionError = e;
        } finally {
            this.busy = false;
        }
    }

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        const p = this.profile;
        if (!p) {
            if (this.loadError) {
                const gone = isSpreeWeError(this.loadError) && this.loadError.status === 404;
                return gone ? html`<div class="state" part="error">${t("contacts.profile.notFound")}</div>` : errorState(this.loadError, () => void this.load(), "profile:read");
            }
            return html`<div class="state">${spinner()}</div>`;
        }
        const id = String(p._id);
        const live = this.presence.get(id) ?? { userId: id, isOnline: !!p.isOnline, status: p.status, statusMessage: p.statusMessage, autoAway: p.autoAway };
        const kind = presenceKind(live);
        const statusMessage = (live.statusMessage as string | undefined) ?? p.statusMessage;
        const lastSeen = (live.lastSeen as string | undefined) ?? p.lastSeen;
        const self = !!this.me && this.me === id;
        const blocked = this.isBlocked;
        return html`<div class="card" part="card">
            <spreewe-avatar part="avatar" .client=${this.sw} name=${p.username} src=${p.avatar || ""} presence=${kind} size="72"></spreewe-avatar>
            <h2 part="name">${p.username}</h2>
            <span class="status" part="status"><span class="dot ${kind}" aria-hidden="true"></span>${presenceText(live)}</span>
            ${kind === "offline" && lastSeen ? html`<span class="muted">${t("contacts.profile.lastSeen", { time: formatDateTime(lastSeen) })}</span>` : nothing}
            ${statusMessage && kind !== "offline" ? html`<span class="status-message" part="status-message">${statusMessage}</span>` : nothing}
            ${p.bio ? html`<p class="bio" part="bio">${p.bio}</p>` : nothing}
            ${blocked ? html`<span class="muted" role="status">${t("contacts.profile.blocked", { name: p.username })}</span>` : nothing}
            ${self ? html`<span class="muted">${t("contacts.profile.you")}</span>` : nothing}
            ${this.actionError ? errorBanner(this.actionError, "contacts:write") : nothing}
            ${this.noActions || self ? html`<div class="actions"><slot name="actions"></slot></div>` : this.renderActions(p, blocked)}
        </div>`;
    }

    private renderActions(p: ContactProfile, blocked: boolean | undefined) {
        if (this.confirmBlock) {
            return html`<div class="confirm" role="group" aria-label=${t("contacts.profile.block")}>
                <span>${t("contacts.profile.blockConfirm", { name: p.username })}</span>
                <div class="actions">
                    <button class="btn danger" type="button" ?disabled=${this.busy} @click=${() => this.toggleBlock()}>${t("contacts.profile.blockYes")}</button>
                    <button class="btn" type="button" @click=${() => (this.confirmBlock = false)}>${t("common.cancel")}</button>
                </div>
            </div>`;
        }
        return html`<div class="actions" part="actions">
            ${blocked
                ? nothing
                : html`<button class="btn primary" part="message" type="button"
                      @click=${() => this.fire("spreewe-contact-message", { userId: String(p._id), user: p })}>${icon("message", 16)} ${t("contacts.profile.message")}</button>`}
            ${this.canBlock
                ? html`<button class="btn" part="block" type="button" ?disabled=${this.busy}
                      @click=${() => (blocked ? this.toggleBlock() : (this.confirmBlock = true))}>${icon("shield", 16)} ${blocked ? t("contacts.profile.unblock") : t("contacts.profile.block")}</button>`
                : nothing}
            <slot name="actions"></slot>
        </div>`;
    }
}
