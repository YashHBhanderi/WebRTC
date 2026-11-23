import { css, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { PresenceUpdate, SpreeWeClient } from "@spreewe/core";
import {
    SpreeWeElement,
    baseStyles,
    buttonStyles,
    formatListTime,
    icon,
    inputStyles,
    presenceKind,
    scrollStyles,
    stateStyles,
    t,
} from "@spreewe/ui";
import { getChat, type ChatService } from "../service.js";
import type { ConversationListState, ConversationSummary } from "../types.js";
import { previewText, spinner } from "./shared.js";
import "../strings.js";

export interface ConversationSelectDetail {
    conversationId: string;
    conversation: ConversationSummary;
}

/**
 * <spreewe-conversation-list> — the user's direct chats and groups, newest first, with live updates,
 * unread counts, presence and decrypted previews.
 *
 * Attributes: selected (conversation id), filter = "all" | "direct" | "groups", archived, no-search, actions.
 * Events: spreewe-conversation-select { conversationId, conversation }.
 * Slots: header (above the search box), empty (no conversations), footer.
 * CSS parts: search, list, item, item-selected, avatar, title, time, preview, badge, menu.
 */
export class SpreeWeConversationList extends SpreeWeElement {
    static override properties = {
        selected: { reflect: true },
        filter: { reflect: true },
        archived: { type: Boolean, reflect: true },
        noSearch: { type: Boolean, attribute: "no-search" },
        actions: { type: Boolean },
        query: { state: true },
        menuFor: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        inputStyles,
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
            .search {
                padding: var(--_s3);
                border-bottom: var(--_bw) solid var(--_border);
                position: relative;
            }
            .search .input {
                padding-left: calc(var(--_s3) + 22px);
            }
            .search .icon {
                position: absolute;
                left: calc(var(--_s3) * 2);
                top: 50%;
                transform: translateY(-50%);
                color: var(--_muted);
                pointer-events: none;
            }
            ul {
                list-style: none;
                margin: 0;
                padding: var(--_s1) 0;
                flex: 1;
                min-height: 0;
            }
            li {
                position: relative;
            }
            .item {
                display: grid;
                grid-template-columns: auto 1fr auto;
                gap: var(--_s3);
                align-items: center;
                width: 100%;
                padding: var(--_s2) var(--_s3);
                border: 0;
                background: transparent;
                color: inherit;
                font: inherit;
                text-align: left;
                cursor: pointer;
                border-left: 3px solid transparent;
            }
            .item:hover {
                background: var(--_hover);
            }
            .item[aria-current="true"] {
                background: var(--_active);
                border-left-color: var(--_brand);
            }
            .body {
                min-width: 0;
                display: grid;
                gap: 2px;
            }
            .title {
                font-weight: var(--_fw-medium);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                display: flex;
                align-items: center;
                gap: var(--_s1);
            }
            .unread .title,
            .unread .preview {
                font-weight: var(--_fw-bold);
                color: var(--_text);
            }
            .preview {
                color: var(--_muted);
                font-size: var(--_fs-sm);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .meta {
                display: grid;
                justify-items: end;
                gap: var(--_s1);
                align-self: start;
                padding-top: 2px;
            }
            .time {
                font-size: var(--_fs-sm);
                color: var(--_muted);
                white-space: nowrap;
            }
            .badge {
                min-width: 20px;
                height: 20px;
                padding: 0 6px;
                border-radius: var(--_r-pill);
                background: var(--_brand);
                color: var(--_on-brand);
                font-size: 11px;
                font-weight: var(--_fw-bold);
                display: inline-grid;
                place-items: center;
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
            .menu-btn {
                position: absolute;
                right: var(--_s2);
                top: 50%;
                transform: translateY(-50%);
                opacity: 0;
                background: var(--_surface);
                box-shadow: var(--_shadow-sm);
            }
            li:hover .menu-btn,
            .menu-btn:focus-visible,
            .menu-btn[aria-expanded="true"] {
                opacity: 1;
            }
            .menu {
                position: absolute;
                right: var(--_s2);
                top: calc(100% - 6px);
                z-index: 5;
                min-width: 180px;
                padding: var(--_s1);
                background: var(--_surface);
                border: var(--_bw) solid var(--_border);
                border-radius: var(--_r);
                box-shadow: var(--_shadow);
                display: grid;
            }
            .menu button {
                justify-content: flex-start;
                border: 0;
            }
            .note {
                margin: var(--_s2) var(--_s3);
                font-size: var(--_fs-sm);
                color: var(--_muted);
            }
        `,
    ];

    declare selected: string;
    declare filter: "all" | "direct" | "groups";
    declare archived: boolean;
    declare noSearch: boolean;
    declare actions: boolean;
    declare query: string;
    declare menuFor: string;

    private chat: ChatService | null = null;
    private presence: ReadonlyMap<string, PresenceUpdate> = new Map();
    private me = "";

    constructor() {
        super();
        this.selected = "";
        this.filter = "all";
        this.archived = false;
        this.noSearch = false;
        this.actions = true;
        this.query = "";
        this.menuFor = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.chat = client ? getChat(client) : null;
        if (!client || !this.chat) return;
        this.observe(this.chat.conversations);
        this.observe(client.people.presence, (p) => (this.presence = p));
        void client.userId().then((id) => {
            this.me = id;
            this.requestUpdate();
        }, () => undefined);
        void this.chat.loadConversations({ archived: this.archived }).catch(() => undefined);
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("archived") && changed.get("archived") !== undefined && this.chat) {
            void this.chat.loadConversations({ archived: this.archived, refresh: true }).catch(() => undefined);
        }
    }

    /** Reload from the server */
    refresh(): Promise<void> {
        return this.chat?.loadConversations({ archived: this.archived, refresh: true }) ?? Promise.resolve();
    }

    private get visibleItems(): ConversationSummary[] {
        const items = (this.chat?.conversations.value.items || []).filter((c) => {
            if (this.filter === "direct" && c.isGroup) return false;
            if (this.filter === "groups" && !c.isGroup) return false;
            return true;
        });
        const q = this.query.trim().toLowerCase();
        return q ? items.filter((c) => c.title.toLowerCase().includes(q) || c.members?.some((m) => m.username?.toLowerCase().includes(q))) : items;
    }

    private select(c: ConversationSummary): void {
        this.selected = c.id;
        this.menuFor = "";
        this.fire<ConversationSelectDetail>("spreewe-conversation-select", { conversationId: c.id, conversation: c });
    }

    private onKey(e: KeyboardEvent): void {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>("button.item")];
        const i = buttons.indexOf(this.renderRoot.querySelector<HTMLButtonElement>("button.item:focus")!);
        const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) {
            e.preventDefault();
            next.focus();
        }
    }

    private async act(c: ConversationSummary, action: "favorite" | "archive"): Promise<void> {
        this.menuFor = "";
        try {
            if (action === "favorite") await this.chat?.setFavorite(c.id, !c.isFavorite);
            else await this.chat?.setArchived(c.id, !c.isArchived);
            if (action === "archive") await this.refresh();
        } catch (e) {
            this.fire("spreewe-error", { error: e, action });
        }
    }

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        const state: ConversationListState = this.chat!.conversations.value;
        const items = this.visibleItems;
        return html`
            <slot name="header"></slot>
            ${this.noSearch
                ? nothing
                : html`<div class="search" part="search">
                      ${icon("search", 18)}
                      <input class="input" type="search" .value=${this.query} placeholder=${t("chat.list.search")} aria-label=${t("chat.list.search")}
                          @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)} />
                  </div>`}
            ${state.error && !state.items.length
                ? html`<div class="state" role="alert"><span>${state.error.message}</span><button class="btn" @click=${() => this.refresh()}>${t("common.retry")}</button></div>`
                : nothing}
            ${state.loading && !state.loaded ? html`<div class="state">${spinner()}</div>` : nothing}
            ${state.loaded && !items.length
                ? this.query
                    ? html`<div class="state">${t("chat.list.noMatch", { q: this.query })}</div>`
                    : html`<slot name="empty"><div class="state"><strong>${t("chat.list.empty.title")}</strong><span>${t("chat.list.empty.text")}</span></div></slot>`
                : nothing}
            <ul class="scroll" part="list" role="list" @keydown=${this.onKey}>
                ${repeat(items, (c) => c.id, (c) => this.renderItem(c))}
            </ul>
            ${state.groupsUnavailable && this.filter !== "direct" ? html`<p class="note">${t("chat.list.groupsUnavailable")}</p>` : nothing}
            <slot name="footer"></slot>
        `;
    }

    private renderItem(c: ConversationSummary) {
        const current = c.id === this.selected;
        const presence = !c.isGroup && c.peer ? presenceKind(this.presence.get(String(c.peer._id)) ?? { isOnline: !!c.peer.isOnline, status: c.peer.status }) : "";
        const preview = previewText(c, this.me);
        return html`<li>
            <button class="item ${c.unread ? "unread" : ""}" part=${current ? "item item-selected" : "item"} aria-current=${current ? "true" : "false"} @click=${() => this.select(c)}>
                <spreewe-avatar part="avatar" .client=${this.sw} name=${c.title} src=${c.avatar || ""} presence=${presence} shape=${c.isGroup ? "square" : "circle"}></spreewe-avatar>
                <span class="body">
                    <span class="title" part="title">
                        <span>${c.title}</span>
                        ${c.scope === "external" ? html`<span class="tag">ext</span>` : nothing}
                        ${c.isFavorite ? html`<span title=${t("chat.list.favorite")}>${icon("pin", 14)}</span>` : nothing}
                    </span>
                    <span class="preview" part="preview">${preview || " "}</span>
                </span>
                <span class="meta">
                    <span class="time" part="time">${formatListTime(c.lastMessageAt)}</span>
                    ${c.unread ? html`<span class="badge" part="badge" aria-label=${t("chat.list.unread", { n: c.unread })}>${c.unread > 99 ? "99+" : c.unread}</span>` : nothing}
                </span>
            </button>
            ${this.actions
                ? html`<button class="icon-btn menu-btn" part="menu" aria-label=${t("chat.list.actions")} aria-haspopup="menu" aria-expanded=${this.menuFor === c.id ? "true" : "false"}
                          @click=${(e: Event) => {
                              e.stopPropagation();
                              this.menuFor = this.menuFor === c.id ? "" : c.id;
                          }}>${icon("more", 18)}</button>
                      ${this.menuFor === c.id
                          ? html`<div class="menu" role="menu" @keydown=${(e: KeyboardEvent) => e.key === "Escape" && (this.menuFor = "")}>
                                <button class="btn ghost" role="menuitem" @click=${() => this.act(c, "favorite")}>${icon("pin", 16)} ${c.isFavorite ? t("chat.list.unfavorite") : t("chat.list.favorite")}</button>
                                <button class="btn ghost" role="menuitem" @click=${() => this.act(c, "archive")}>${icon("download", 16)} ${c.isArchived ? t("chat.list.unarchive") : t("chat.list.archive")}</button>
                            </div>`
                          : nothing}`
                : nothing}
        </li>`;
    }
}
