import { css, html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SpreeWeClient, UserSummary } from "@spreewe/core";
import {
    SpreeWeElement,
    baseStyles,
    buttonStyles,
    formatBytes,
    formatDay,
    formatDuration,
    formatTime,
    icon,
    scrollStyles,
    stateStyles,
    t,
} from "@spreewe/ui";
import { getChat, type ChatService, type ConversationSession } from "../service.js";
import type { ChatMessage, MessagesState } from "../types.js";
import { QUICK_EMOJI, bodyStateText, spinner, typeLabel } from "./shared.js";
import "../strings.js";

export interface MessageActionDetail {
    message: ChatMessage;
}

const GROUP_WINDOW_MS = 5 * 60_000;

/**
 * <spreewe-message-list conversation-id="…"> — messages of one conversation with live updates,
 * decryption, attachments, reactions, receipts and actions.
 *
 * Attributes: conversation-id, readonly (no actions), show-avatars ("auto" | "always" | "never").
 * Events: spreewe-reply { message }, spreewe-edit { message } (the composer listens when both are in a
 * <spreewe-chat-window>), spreewe-delete-request { message } (cancelable: preventDefault() to show your
 * own confirmation instead of the browser's), spreewe-error { error }.
 * CSS parts: scroller, day, message, message-mine, bubble, bubble-mine, author, meta, reactions,
 * attachment, actions, system, jump.
 */
export class SpreeWeMessageList extends SpreeWeElement {
    static override properties = {
        conversationId: { attribute: "conversation-id", reflect: true },
        readonly: { type: Boolean, reflect: true },
        showAvatars: { attribute: "show-avatars" },
        pickerFor: { state: true },
        atBottom: { state: true },
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
                flex: 1;
                position: relative;
                background: var(--_chat-bg);
            }
            .scroll {
                flex: 1;
                min-height: 0;
                padding: var(--_s3) var(--_s4) var(--_s2);
                display: flex;
                flex-direction: column;
            }
            .spacer {
                flex: 1;
            }
            .older {
                align-self: center;
                margin: var(--_s2) 0;
            }
            .day {
                align-self: center;
                margin: var(--_s3) 0 var(--_s2);
                padding: 2px var(--_s3);
                border-radius: var(--_r-pill);
                background: var(--_surface);
                border: var(--_bw) solid var(--_border);
                color: var(--_muted);
                font-size: var(--_fs-sm);
                font-weight: var(--_fw-medium);
            }
            .row {
                display: flex;
                gap: var(--_s2);
                align-items: flex-end;
                margin-top: 2px;
                position: relative;
                max-width: 100%;
            }
            .row.first {
                margin-top: var(--_s3);
            }
            .row.mine {
                flex-direction: row-reverse;
            }
            .avatar-slot {
                width: 32px;
                flex: none;
            }
            .stack {
                display: flex;
                flex-direction: column;
                max-width: min(72%, 640px);
                min-width: 0;
            }
            .mine .stack {
                align-items: flex-end;
            }
            .author {
                font-size: var(--_fs-sm);
                font-weight: var(--_fw-bold);
                color: var(--_text-2);
                margin: 0 var(--_s2) 2px;
            }
            .bubble {
                position: relative;
                padding: var(--_s2) var(--_s3);
                border-radius: var(--_r-bubble);
                background: var(--_bubble-in);
                color: var(--_bubble-in-text);
                border: var(--_bw) solid var(--_bubble-in-border);
                overflow-wrap: anywhere;
                white-space: pre-wrap;
                min-width: 0;
            }
            .mine .bubble {
                background: var(--_bubble-out);
                color: var(--_bubble-out-text);
                border-color: var(--_bubble-out-border);
            }
            .row:not(.last):not(.mine) .bubble {
                border-bottom-left-radius: var(--_r-sm);
            }
            .row:not(.last).mine .bubble {
                border-bottom-right-radius: var(--_r-sm);
            }
            .bubble.muted {
                font-style: italic;
                opacity: 0.85;
            }
            .quote {
                display: block;
                margin-bottom: var(--_s1);
                padding: var(--_s1) var(--_s2);
                border-left: 3px solid currentColor;
                border-radius: var(--_r-sm);
                background: color-mix(in srgb, currentColor 8%, transparent);
                font-size: var(--_fs-sm);
                opacity: 0.85;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 100%;
            }
            .meta {
                display: inline-flex;
                align-items: center;
                gap: var(--_s1);
                font-size: 11px;
                color: var(--_muted);
                margin: 2px var(--_s2) 0;
            }
            .meta.failed {
                color: var(--_danger);
            }
            .meta .seen {
                color: var(--_read);
            }
            .meta button {
                font: inherit;
                background: none;
                border: 0;
                color: inherit;
                text-decoration: underline;
                cursor: pointer;
                padding: 0;
            }
            .warning {
                display: inline-flex;
                gap: 4px;
                align-items: center;
                font-size: 11px;
                color: var(--_warning);
                margin: 2px var(--_s2) 0;
            }
            .media {
                display: block;
                max-width: min(320px, 100%);
                max-height: 320px;
                border-radius: var(--_r);
                margin-bottom: var(--_s1);
                background: color-mix(in srgb, currentColor 8%, transparent);
            }
            .file {
                display: flex;
                align-items: center;
                gap: var(--_s2);
                padding: var(--_s2);
                border-radius: var(--_r-sm);
                background: color-mix(in srgb, currentColor 8%, transparent);
                margin-bottom: var(--_s1);
                min-width: 200px;
                white-space: normal;
            }
            .file .name {
                font-weight: var(--_fw-medium);
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .file .size {
                font-size: 11px;
                opacity: 0.8;
            }
            .file .grow {
                flex: 1;
                min-width: 0;
                display: grid;
            }
            .file button {
                color: inherit;
            }
            .reactions {
                display: flex;
                flex-wrap: wrap;
                gap: 4px;
                margin: 2px var(--_s1) 0;
            }
            .chip {
                font: inherit;
                font-size: var(--_fs-sm);
                display: inline-flex;
                gap: 4px;
                align-items: center;
                padding: 0 8px;
                height: 24px;
                border-radius: var(--_r-pill);
                border: var(--_bw) solid var(--_border);
                background: var(--_surface);
                color: var(--_text);
                cursor: pointer;
            }
            .chip.mine {
                border-color: var(--_brand);
                background: var(--_brand-soft);
            }
            .actions {
                position: absolute;
                top: -14px;
                display: none;
                gap: 2px;
                padding: 2px;
                border-radius: var(--_r-pill);
                background: var(--_surface);
                border: var(--_bw) solid var(--_border);
                box-shadow: var(--_shadow-sm);
                z-index: 2;
            }
            .row:not(.mine) .actions {
                right: auto;
                left: calc(32px + var(--_s2) + 40px);
            }
            .row.mine .actions {
                right: 40px;
            }
            .row:hover .actions,
            .row:focus-within .actions,
            .actions.open {
                display: flex;
            }
            .actions .icon-btn {
                width: 28px;
                height: 28px;
            }
            .picker {
                position: absolute;
                top: -52px;
                z-index: 3;
                display: flex;
                gap: 2px;
                padding: var(--_s1);
                background: var(--_surface);
                border: var(--_bw) solid var(--_border);
                border-radius: var(--_r-pill);
                box-shadow: var(--_shadow);
            }
            .row:not(.mine) .picker {
                left: calc(32px + var(--_s2));
            }
            .row.mine .picker {
                right: 0;
            }
            .picker button {
                font-size: 20px;
                width: 36px;
                height: 36px;
                border: 0;
                background: none;
                cursor: pointer;
                border-radius: 50%;
            }
            .picker button:hover {
                background: var(--_hover);
            }
            .system {
                align-self: center;
                margin: var(--_s2) 0;
                font-size: var(--_fs-sm);
                color: var(--_muted);
                display: inline-flex;
                align-items: center;
                gap: var(--_s1);
                text-align: center;
            }
            .jump {
                position: absolute;
                right: var(--_s4);
                bottom: var(--_s3);
                box-shadow: var(--_shadow);
                border-radius: var(--_r-pill);
            }
            :host([readonly]) .actions {
                display: none !important;
            }
            @media (max-width: 520px) {
                .stack {
                    max-width: 86%;
                }
            }
        `,
    ];

    declare conversationId: string;
    declare readonly: boolean;
    declare showAvatars: "auto" | "always" | "never";
    declare pickerFor: string;
    declare atBottom: boolean;

    private chat: ChatService | null = null;
    private session: ConversationSession | null = null;
    private me = "";
    private scroller: HTMLElement | null = null;
    private prevHeight = 0;
    private prevCount = 0;
    private prevFirstId = "";
    private sentinel: IntersectionObserver | null = null;
    private readonly onVisibility = () => this.session?.setVisible(this.isShown());

    constructor() {
        super();
        this.conversationId = "";
        this.readonly = false;
        this.showAvatars = "auto";
        this.pickerFor = "";
        this.atBottom = true;
    }

    /** The open conversation session (null until a client and conversation-id are set) */
    get conversation(): ConversationSession | null {
        return this.session;
    }

    override connectedCallback(): void {
        super.connectedCallback();
        document.addEventListener("visibilitychange", this.onVisibility);
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        document.removeEventListener("visibilitychange", this.onVisibility);
        this.sentinel?.disconnect();
        this.sentinel = null;
        this.closeSession();
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.chat = client ? getChat(client) : null;
        if (client) {
            void client.userId().then((id) => {
                this.me = id;
                this.requestUpdate();
            }, () => undefined);
            this.observe(client.people.presence);
            this.observe(client.config);
        }
        this.openSession();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("conversationId") && changed.get("conversationId") !== undefined) this.openSession();
    }

    private openSession(): void {
        this.closeSession();
        if (!this.chat || !this.conversationId) return;
        this.session = this.chat.open(this.conversationId);
        this.atBottom = true;
        this.prevCount = 0;
        this.prevFirstId = "";
        const s = this.session;
        this.watch(s.messages, (state) => this.autoLoadImages(state));
        this.watch(s.typing);
        s.setVisible(this.isShown());
        // Opening a chat in an app that wasn't listing conversations: load them for names / members
        if (!this.chat.conversations.value.loaded) void this.chat.loadConversations().catch(() => undefined);
        this.observeList();
    }

    private closeSession(): void {
        if (!this.session) return;
        this.unwatch(this.session.messages);
        this.unwatch(this.session.typing);
        this.session.setVisible(false);
        this.session.release();
        this.session = null;
    }

    private isShown(): boolean {
        return this.isConnected && document.visibilityState === "visible";
    }

    private autoLoadImages(state: MessagesState): void {
        for (const m of state.items) {
            const a = m.attachment;
            if (a && a.state === "idle" && a.secure && (a.kind === "image" || a.kind === "audio" || a.kind === "video")) void this.session?.loadAttachment(m._id);
        }
    }

    // ------------------------------------------------------------------ scrolling

    protected override firstUpdated(): void {
        this.scroller = this.renderRoot.querySelector(".scroll");
        this.scroller?.addEventListener("scroll", () => {
            const el = this.scroller!;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (bottom !== this.atBottom) this.atBottom = bottom;
        }, { passive: true });
        this.observeList();
    }

    private observeList(): void {
        if (!this.scroller || typeof IntersectionObserver === "undefined") return;
        this.sentinel?.disconnect();
        this.sentinel = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) void this.session?.loadOlder();
        }, { root: this.scroller, rootMargin: "200px 0px 0px 0px" });
        requestAnimationFrame(() => {
            const top = this.renderRoot.querySelector(".top-sentinel");
            if (top) this.sentinel?.observe(top);
        });
    }

    protected override update(changed: PropertyValues): void {
        if (this.scroller) this.prevHeight = this.scroller.scrollHeight;
        super.update(changed);
    }

    protected override updated(): void {
        const el = this.scroller;
        const items = this.session?.messages.value.items || [];
        if (!el) return;
        const firstId = items[0]?._id || "";
        if (items.length !== this.prevCount) {
            const prepended = this.prevFirstId && firstId !== this.prevFirstId && items.length > this.prevCount;
            const lastMine = items[items.length - 1]?.userId === this.me && items[items.length - 1]?.local === "sending";
            if (prepended && !this.atBottom) {
                // Older history loaded above: keep what the user is reading in place
                el.scrollTop += el.scrollHeight - this.prevHeight;
            } else if (this.atBottom || lastMine || !this.prevCount) {
                el.scrollTop = el.scrollHeight;
            }
            this.prevCount = items.length;
            this.prevFirstId = firstId;
        }
    }

    /** Scroll to the newest message */
    scrollToLatest(): void {
        if (this.scroller) this.scroller.scrollTop = this.scroller.scrollHeight;
        this.atBottom = true;
    }

    // ------------------------------------------------------------------ actions

    private nameOf(userId: string, m?: ChatMessage): string {
        if (userId === this.me) return t("common.you");
        const members = this.session?.members || [];
        const u: Partial<UserSummary> | undefined = members.find((x) => String(x._id) === userId) || (m?.user?._id === userId ? m.user : undefined);
        return u?.username || t("chat.messages.unknownUser");
    }

    private async deleteMessage(m: ChatMessage): Promise<void> {
        // Hosts can show their own dialog: preventDefault() and call list.conversation.delete(id) themselves
        if (!this.fire<MessageActionDetail>("spreewe-delete-request", { message: m }, { cancelable: true })) return;
        if (!confirm(t("chat.messages.deleteConfirm"))) return;
        try {
            await this.session?.delete(m._id);
        } catch (error) {
            this.fire("spreewe-error", { error, action: "delete" });
        }
    }

    private react(m: ChatMessage, emoji: string): void {
        this.pickerFor = "";
        try {
            this.session?.react(m._id, emoji);
        } catch (error) {
            this.fire("spreewe-error", { error, action: "react" });
        }
    }

    private async retry(m: ChatMessage): Promise<void> {
        this.session?.discard(m._id);
        try {
            await this.session?.send(m.text);
        } catch (error) {
            this.fire("spreewe-error", { error, action: "send" });
        }
    }

    private async download(m: ChatMessage): Promise<void> {
        const a = (await this.session?.loadAttachment(m._id)) || m.attachment;
        if (!a?.url) return;
        const link = document.createElement("a");
        link.href = a.url;
        link.download = a.name || "file";
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
    }

    // ------------------------------------------------------------------ render

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        if (!this.session) return html`<div class="scroll"></div>`;
        const state = this.session.messages.value;
        const items = state.items;
        const isGroup = !!this.chat?.findConversation(this.conversationId)?.isGroup;
        const avatars = this.showAvatars === "always" || (this.showAvatars === "auto" && isGroup);
        const rows: TemplateResult[] = [];
        let lastDay = "";
        items.forEach((m, i) => {
            const day = formatDay(m.createdAt);
            if (day !== lastDay) {
                rows.push(html`<div class="day" part="day" role="separator">${day}</div>`);
                lastDay = day;
            }
            const prev = items[i - 1];
            const next = items[i + 1];
            const sameAsPrev = !!prev && prev.userId === m.userId && prev.type !== "system" && Date.parse(m.createdAt) - Date.parse(prev.createdAt) < GROUP_WINDOW_MS && formatDay(prev.createdAt) === day;
            const sameAsNext = !!next && next.userId === m.userId && next.type !== "system" && Date.parse(next.createdAt) - Date.parse(m.createdAt) < GROUP_WINDOW_MS && formatDay(next.createdAt) === day;
            rows.push(this.renderMessage(m, { first: !sameAsPrev, last: !sameAsNext, avatars, isGroup }));
        });
        return html`
            <div class="scroll" part="scroller" role="log" aria-live="polite" aria-relevant="additions">
                <div class="top-sentinel" aria-hidden="true"></div>
                <div class="spacer"></div>
                ${state.loadingOlder ? html`<div class="older">${spinner()}</div>` : nothing}
                ${!state.loadingOlder && state.hasOlder && items.length && !state.loading
                    ? html`<button class="btn ghost older" @click=${() => this.session?.loadOlder()}>${t("chat.messages.loadOlder")}</button>`
                    : nothing}
                ${state.loading && !items.length ? html`<div class="state">${spinner()}</div>` : nothing}
                ${state.error && !items.length ? html`<div class="state" role="alert">${state.error.message}</div>` : nothing}
                ${!state.loading && !state.error && !items.length ? html`<div class="state">${t("chat.messages.empty")}</div>` : nothing}
                ${rows}
            </div>
            ${!this.atBottom && items.length
                ? html`<button class="btn jump" part="jump" @click=${() => this.scrollToLatest()}>${icon("arrow-down", 16)} ${t("chat.messages.jumpLatest")}</button>`
                : nothing}
        `;
    }

    private renderMessage(m: ChatMessage, o: { first: boolean; last: boolean; avatars: boolean; isGroup: boolean }) {
        if (m.type === "system") return html`<div class="system" part="system">${m.text || m.content}</div>`;
        if (m.type === "call") {
            const missed = m.call?.outcome === "missed";
            return html`<div class="system" part="system">${icon(m.call?.callType === "video" ? "video" : "phone", 16)}
                ${missed ? t("chat.messages.callMissed") : m.call?.duration ? t("chat.messages.callEnded", { duration: formatDuration(m.call.duration * 1000) }) : t("chat.messages.call")}
                · ${formatTime(m.createdAt)}</div>`;
        }
        const mine = m.userId === this.me;
        const author = this.nameOf(m.userId, m);
        const classes = ["row", mine ? "mine" : "", o.first ? "first" : "", o.last ? "last" : ""].join(" ");
        const canAct = !this.readonly && !m.local && !m.isDeleted;
        return html`<div class=${classes} part=${mine ? "message message-mine" : "message"} data-id=${m._id}>
            ${o.avatars && !mine
                ? html`<div class="avatar-slot">${o.last ? html`<spreewe-avatar .client=${this.sw} size="32" name=${author} src=${m.user?.avatar || ""}></spreewe-avatar>` : nothing}</div>`
                : nothing}
            <div class="stack">
                ${o.first && o.isGroup && !mine ? html`<span class="author" part="author">${author}</span>` : nothing}
                ${this.renderBubble(m, mine)}
                ${m.warning
                    ? html`<span class="warning">${icon("shield", 12)} ${m.bodyState === "ok" || !m.bodyState ? t("chat.messages.unverified") : m.warning}</span>`
                    : nothing}
                ${m.reactions?.length ? this.renderReactions(m) : nothing}
                ${o.last || m.local ? this.renderMeta(m, mine) : nothing}
            </div>
            ${canAct
                ? html`<div class="actions ${this.pickerFor === m._id ? "open" : ""}" part="actions">
                      <button class="icon-btn" title=${t("chat.messages.react")} aria-label=${t("chat.messages.react")} @click=${() => (this.pickerFor = this.pickerFor === m._id ? "" : m._id)}>${icon("smile", 16)}</button>
                      <button class="icon-btn" title=${t("chat.messages.reply")} aria-label=${t("chat.messages.reply")} @click=${() => this.fire<MessageActionDetail>("spreewe-reply", { message: m })}>${icon("reply", 16)}</button>
                      ${mine && m.bodyState === "ok" && !m.attachment
                          ? html`<button class="icon-btn" title=${t("chat.messages.edit")} aria-label=${t("chat.messages.edit")} @click=${() => this.fire<MessageActionDetail>("spreewe-edit", { message: m })}>${icon("edit", 16)}</button>`
                          : nothing}
                      ${mine ? html`<button class="icon-btn" title=${t("chat.messages.delete")} aria-label=${t("chat.messages.delete")} @click=${() => this.deleteMessage(m)}>${icon("trash", 16)}</button>` : nothing}
                  </div>`
                : nothing}
            ${this.pickerFor === m._id
                ? html`<div class="picker" role="menu" @keydown=${(e: KeyboardEvent) => e.key === "Escape" && (this.pickerFor = "")}>
                      ${QUICK_EMOJI.map((e) => html`<button role="menuitem" aria-label=${e} @click=${() => this.react(m, e)}>${e}</button>`)}
                  </div>`
                : nothing}
        </div>`;
    }

    private renderBubble(m: ChatMessage, mine: boolean) {
        if (m.isDeleted) return html`<div class="bubble muted" part=${mine ? "bubble bubble-mine" : "bubble"}>${t("chat.messages.deleted")}</div>`;
        if (m.bodyState !== "ok") {
            return html`<div class="bubble muted" part=${mine ? "bubble bubble-mine" : "bubble"}>${icon("lock", 14)} ${bodyStateText(m.bodyState)}</div>`;
        }
        return html`<div class="bubble" part=${mine ? "bubble bubble-mine" : "bubble"}>${m.quote
                ? html`<span class="quote">${this.nameOf(m.quote.authorId)}: ${m.quote.bodyState === "ok" ? m.quote.text || "…" : t("chat.preview.encrypted")}</span>`
                : nothing}${m.attachment ? this.renderAttachment(m) : nothing}${m.text}</div>`;
    }

    private renderAttachment(m: ChatMessage) {
        const a = m.attachment!;
        if (a.state === "ready" && a.url) {
            if (a.kind === "image") return html`<img class="media" part="attachment" src=${a.url} alt=${a.name} loading="lazy" @click=${() => window.open(a.url, "_blank", "noopener")} />`;
            if (a.kind === "video") return html`<video class="media" part="attachment" src=${a.url} controls preload="metadata"></video>`;
            if (a.kind === "audio") return html`<audio part="attachment" src=${a.url} controls preload="metadata"></audio>`;
        }
        return html`<span class="file" part="attachment">
            ${icon(a.kind === "image" ? "image" : "file", 22)}
            <span class="grow">
                <span class="name">${a.name || typeLabel(a.kind)}</span>
                <span class="size">${a.state === "loading" ? t("chat.messages.loadingFile") : a.state === "error" ? t("chat.messages.fileError") : formatBytes(a.size)}</span>
            </span>
            ${a.state === "loading"
                ? spinner()
                : html`<button class="icon-btn" title=${t("chat.messages.download")} aria-label=${t("chat.messages.download")} @click=${() => this.download(m)}>${icon("download", 18)}</button>`}
        </span>`;
    }

    private renderReactions(m: ChatMessage) {
        const counts = new Map<string, { n: number; mine: boolean }>();
        for (const r of m.reactions || []) {
            const c = counts.get(r.emoji) || { n: 0, mine: false };
            c.n++;
            if (String(r.userId) === this.me) c.mine = true;
            counts.set(r.emoji, c);
        }
        return html`<div class="reactions" part="reactions">
            ${[...counts].map(
                ([emoji, c]) => html`<button class="chip ${c.mine ? "mine" : ""}" ?disabled=${this.readonly} aria-pressed=${c.mine ? "true" : "false"} @click=${() => this.react(m, emoji)}>
                    <span>${emoji}</span><span>${c.n}</span>
                </button>`,
            )}
        </div>`;
    }

    private renderMeta(m: ChatMessage, mine: boolean) {
        if (m.local === "sending") return html`<span class="meta" part="meta">${t("chat.messages.sending")}</span>`;
        if (m.local === "failed") {
            return html`<span class="meta failed" part="meta" role="alert">${icon("alert", 12)} ${m.failure || t("chat.messages.failed")}
                ${!m.attachment ? html`· <button @click=${() => this.retry(m)}>${t("chat.messages.retry")}</button>` : nothing}
                · <button @click=${() => this.session?.discard(m._id)}>${t("chat.messages.discard")}</button></span>`;
        }
        const status = mine && m.status ? m.status : "";
        return html`<span class="meta" part="meta">
            <time datetime=${m.createdAt}>${formatTime(m.createdAt)}</time>
            ${m.editedAt ? html`· ${t("chat.messages.edited")}` : nothing}
            ${status
                ? html`<span class=${status === "seen" ? "seen" : ""} title=${t(`chat.messages.${status}`)} aria-label=${t(`chat.messages.${status}`)}>${icon(status === "sent" ? "check" : "check-double", 14)}</span>`
                : nothing}
        </span>`;
    }
}
