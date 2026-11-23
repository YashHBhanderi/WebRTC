import { css, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { live } from "lit/directives/live.js";
import type { DirectoryEntry, PresenceUpdate, SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, inputStyles, presenceKind, scrollStyles, stateStyles, t } from "@spreewe/ui";
import { getContacts, type ContactsService, type DirectoryQuery } from "../service.js";
import type { DirectoryState } from "../types.js";
import { errorState, presenceText, spinner } from "./shared.js";
import "../strings.js";

export interface ContactSelectDetail {
    userId: string;
    user: DirectoryEntry;
}

/**
 * <spreewe-contact-list> — searchable people directory with live presence and cursor paging
 * (infinite scroll plus a "Load more" button).
 *
 * Attributes: query (initial search), page-size (default 30), selected (user id), actions
 * (space/comma list; "message" adds a Message button per person), no-search.
 * Events: spreewe-contact-select { userId, user }, spreewe-contact-message { userId, user }.
 * Slots: header, empty, footer.
 * CSS parts: search, list, item, item-selected, avatar, name, status, message, load-more, error.
 */
export class SpreeWeContactList extends SpreeWeElement {
    static override properties = {
        query: {},
        pageSize: { type: Number, attribute: "page-size" },
        selected: { reflect: true },
        actions: {},
        noSearch: { type: Boolean, attribute: "no-search" },
        q: { state: true },
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
            .search svg {
                position: absolute;
                left: calc(var(--_s3) * 2);
                top: 50%;
                transform: translateY(-50%);
                color: var(--_muted);
                pointer-events: none;
            }
            .scroll {
                flex: 1;
                min-height: 0;
            }
            ul {
                list-style: none;
                margin: 0;
                padding: var(--_s1) 0;
            }
            li {
                display: flex;
                align-items: center;
                gap: var(--_s1);
                padding-right: var(--_s2);
                border-left: 3px solid transparent;
            }
            li:hover {
                background: var(--_hover);
            }
            li.current {
                background: var(--_active);
                border-left-color: var(--_brand);
            }
            .item {
                flex: 1;
                min-width: 0;
                display: flex;
                align-items: center;
                gap: var(--_s3);
                padding: var(--_s2) var(--_s3);
                border: 0;
                border-radius: var(--_r-sm);
                background: transparent;
                color: inherit;
                font: inherit;
                text-align: left;
                cursor: pointer;
            }
            .body {
                min-width: 0;
                display: grid;
                gap: 2px;
            }
            .name {
                font-weight: var(--_fw-medium);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .status {
                font-size: var(--_fs-sm);
                color: var(--_muted);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .more {
                display: flex;
                justify-content: center;
                padding: var(--_s2) var(--_s3) var(--_s3);
            }
            .sentinel {
                height: 1px;
            }
            .error-banner {
                margin: var(--_s2) var(--_s3);
            }
        `,
    ];

    declare query: string;
    declare pageSize: number;
    declare selected: string;
    declare actions: string;
    declare noSearch: boolean;
    declare q: string;

    private contacts: ContactsService | null = null;
    private dq: DirectoryQuery | null = null;
    private dqOff: (() => void) | null = null;
    private presence: ReadonlyMap<string, PresenceUpdate> = new Map();
    private searchTimer: ReturnType<typeof setTimeout> | null = null;
    private io: IntersectionObserver | null = null;
    private observedSentinel: Element | null = null;

    constructor() {
        super();
        this.query = "";
        this.pageSize = 30;
        this.selected = "";
        this.actions = "";
        this.noSearch = false;
        this.q = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.dq = null;
        this.contacts = client ? getContacts(client) : null;
        if (!client || !this.contacts) return;
        this.observe(client.people.presence, (p) => (this.presence = p));
        void this.contacts.startPresence();
        this.startQuery();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("query") && this.query !== this.q) {
            this.q = this.query;
            if (this.contacts) this.startQuery();
        }
        if (changed.has("pageSize") && changed.get("pageSize") !== undefined && this.contacts) this.startQuery();
    }

    protected override updated(changed: PropertyValues): void {
        super.updated(changed);
        this.watchSentinel();
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.io?.disconnect();
        this.io = null;
        this.observedSentinel = null;
    }

    private startQuery(): void {
        if (!this.contacts) return;
        this.dqOff?.();
        const dq = this.contacts.browse({ q: this.q, pageSize: this.pageSize });
        this.dq = dq;
        // One subscription at a time: a new search replaces the previous one
        const off = dq.state.subscribe(() => this.requestUpdate());
        this.dqOff = () => {
            off();
            if (this.dqOff === release) this.dqOff = null;
        };
        const release = this.dqOff;
        this.untilClientChanges(release);
    }

    /** Reload from the first page */
    refresh(): Promise<void> {
        return this.dq?.refresh() ?? Promise.resolve();
    }

    /** Load the next page */
    loadMore(): Promise<void> {
        return this.dq?.loadMore() ?? Promise.resolve();
    }

    private onSearch(value: string): void {
        this.q = value;
        if (this.searchTimer) clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => this.startQuery(), 250);
    }

    private watchSentinel(): void {
        const sentinel = this.renderRoot.querySelector(".sentinel");
        if (sentinel === this.observedSentinel) return;
        this.io?.disconnect();
        this.observedSentinel = sentinel;
        if (!sentinel || typeof IntersectionObserver === "undefined") return;
        const root = this.renderRoot.querySelector(".scroll");
        this.io = new IntersectionObserver(
            (entries) => {
                const s = this.dq?.state.value;
                if (entries.some((e) => e.isIntersecting) && s && s.loaded && !s.loading && !s.done && !s.error) void this.loadMore().catch(() => undefined);
            },
            { root, rootMargin: "120px" },
        );
        this.io.observe(sentinel);
    }

    private get actionList(): string[] {
        return (this.actions || "").split(/[\s,]+/).filter(Boolean);
    }

    private select(u: DirectoryEntry): void {
        this.selected = String(u._id);
        this.fire<ContactSelectDetail>("spreewe-contact-select", { userId: String(u._id), user: u });
    }

    private onKey(e: KeyboardEvent): void {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>("button.item")];
        if (!buttons.length) return;
        const i = buttons.indexOf(this.renderRoot.querySelector<HTMLButtonElement>("button.item:focus")!);
        const next =
            e.key === "Home" ? buttons[0] : e.key === "End" ? buttons[buttons.length - 1] : buttons[Math.max(0, Math.min(buttons.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) {
            e.preventDefault();
            next.focus();
            // Reaching the end with the keyboard loads the next page
            if (next === buttons[buttons.length - 1]) {
                const s = this.dq?.state.value;
                if (s && !s.done && !s.loading && !s.error) void this.loadMore().catch(() => undefined);
            }
        }
    }

    protected override render() {
        if (!this.sw || !this.dq) return html`<div class="state">${t("common.noClient")}</div>`;
        const s: DirectoryState = this.dq.state.value;
        const message = this.actionList.includes("message");
        return html`
            <slot name="header"></slot>
            ${this.noSearch
                ? nothing
                : html`<div class="search" part="search" role="search">
                      ${icon("search", 18)}
                      <input class="input" type="search" .value=${live(this.q)} placeholder=${t("contacts.list.search")} aria-label=${t("contacts.list.search")}
                          @input=${(e: Event) => this.onSearch((e.target as HTMLInputElement).value)}
                          @keydown=${(e: KeyboardEvent) => {
                              if (e.key === "ArrowDown") {
                                  e.preventDefault();
                                  this.renderRoot.querySelector<HTMLButtonElement>("button.item")?.focus();
                              }
                          }} />
                  </div>`}
            ${s.error && !s.items.length ? errorState(s.error, () => void this.refresh().catch(() => undefined), "directory:read") : nothing}
            ${s.loading && !s.loaded ? html`<div class="state">${spinner()}</div>` : nothing}
            ${s.loaded && !s.items.length && !s.error
                ? s.q
                    ? html`<div class="state">${t("contacts.list.noMatch", { q: s.q })}</div>`
                    : html`<slot name="empty"><div class="state"><strong>${t("contacts.list.empty.title")}</strong><span>${t("contacts.list.empty.text")}</span></div></slot>`
                : nothing}
            <div class="scroll" part="list" role="region" aria-label=${t("contacts.list.label")} aria-busy=${s.loading ? "true" : "false"}>
                <ul role="list" @keydown=${this.onKey}>
                    ${repeat(s.items, (u) => u._id, (u) => this.renderItem(u, message))}
                </ul>
                ${s.error && s.items.length
                    ? html`<div class="error-banner" part="error" role="alert"><span>${s.error.message}</span>
                          <button class="btn" type="button" @click=${() => void this.loadMore().catch(() => undefined)}>${t("common.retry")}</button></div>`
                    : nothing}
                ${s.loaded && !s.done
                    ? html`<div class="sentinel" aria-hidden="true"></div>
                          <div class="more">
                              <button class="btn" part="load-more" type="button" ?disabled=${s.loading} @click=${() => void this.loadMore().catch(() => undefined)}>
                                  ${s.loading ? spinner() : t("contacts.list.loadMore")}
                              </button>
                          </div>`
                    : nothing}
            </div>
            <slot name="footer"></slot>
        `;
    }

    private renderItem(u: DirectoryEntry, message: boolean) {
        const id = String(u._id);
        const current = id === this.selected;
        const p = this.presence.get(id) ?? { userId: id, isOnline: !!u.isOnline, status: u.status, statusMessage: u.statusMessage };
        const kind = presenceKind(p);
        const statusMessage = (p.statusMessage as string | undefined) ?? u.statusMessage;
        return html`<li class=${current ? "current" : ""} part=${current ? "item item-selected" : "item"}>
            <button class="item" type="button" aria-current=${current ? "true" : "false"} @click=${() => this.select(u)}>
                <spreewe-avatar part="avatar" .client=${this.sw} name=${u.username} src=${u.avatar || ""} presence=${kind}></spreewe-avatar>
                <span class="body">
                    <span class="name" part="name">${u.username}</span>
                    <span class="status" part="status">${kind !== "offline" && statusMessage ? statusMessage : presenceText(p)}</span>
                </span>
            </button>
            ${message
                ? html`<button class="icon-btn" part="message" type="button" aria-label=${t("contacts.list.message", { name: u.username })}
                          title=${t("contacts.list.message", { name: u.username })}
                          @click=${() => this.fire<ContactSelectDetail>("spreewe-contact-message", { userId: id, user: u })}>${icon("message", 18)}</button>`
                : nothing}
        </li>`;
    }
}
