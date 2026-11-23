import { css, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, formatDateTime, formatListTime, icon, scrollStyles, stateStyles, t } from "@spreewe/ui";
import { getNotifications, type NotificationFeed, type NotificationsService } from "../service.js";
import type { NotificationFeedState, NotificationView, SpreeWeNotification } from "../types.js";
import { errorText, missingScope, notificationHeadline, notificationPreview, notificationTitle, spinner, typeIcon } from "./shared.js";
import "../strings.js";

export interface NotificationSelectDetail {
    notification: SpreeWeNotification;
    conversationId: string | null;
    messageId: string | null;
}

const VIEWS: NotificationView[] = ["all", "unread", "mentions"];

/**
 * <spreewe-notification-list> — the user's activity feed, newest first, with live updates.
 *
 * Attributes: view = "all" | "unread" | "mentions", no-tabs, no-header, no-auto-read.
 * Events: spreewe-notification-select { notification, conversationId, messageId } (cancelable:
 *   preventDefault() keeps it unread), spreewe-error { error, action }.
 * Slots: header (above the toolbar), empty (no notifications).
 * CSS parts: toolbar, title, mark-all, tabs, tab, tab-selected, list, item, item-unread, avatar,
 *   type-icon, headline, actor, preview, time, dot, load-more, error.
 */
export class SpreeWeNotificationList extends SpreeWeElement {
    static override properties = {
        view: { reflect: true },
        noTabs: { type: Boolean, attribute: "no-tabs" },
        noHeader: { type: Boolean, attribute: "no-header" },
        noAutoRead: { type: Boolean, attribute: "no-auto-read" },
        canWrite: { state: true },
        actionError: { state: true },
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
                height: 100%;
                background: var(--_surface);
            }
            .toolbar {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--_s2);
                padding: var(--_s2) var(--_s3);
                border-bottom: var(--_bw) solid var(--_border);
                flex-wrap: wrap;
            }
            .title {
                margin: 0;
                font-size: var(--_fs-lg);
                font-weight: var(--_fw-bold);
            }
            .mark-all {
                min-height: 30px;
                padding: 0 var(--_s2);
                font-size: var(--_fs-sm);
                color: var(--_accent);
            }
            .tabs {
                display: flex;
                gap: var(--_s1);
                padding: var(--_s2) var(--_s3);
                border-bottom: var(--_bw) solid var(--_border);
                overflow-x: auto;
                scrollbar-width: none;
            }
            .tab {
                min-height: 30px;
                padding: 0 var(--_s3);
                border-radius: var(--_r-pill);
                font-size: var(--_fs-sm);
                border-color: var(--_border);
            }
            .tab[aria-selected="true"] {
                background: var(--_brand);
                border-color: var(--_brand);
                color: var(--_on-brand);
            }
            ul {
                list-style: none;
                margin: 0;
                padding: var(--_s1) 0;
                flex: 1;
                min-height: 0;
            }
            .item {
                display: grid;
                grid-template-columns: auto 1fr auto;
                gap: var(--_s3);
                align-items: start;
                width: 100%;
                padding: var(--_s2) var(--_s3);
                border: 0;
                border-left: 3px solid transparent;
                background: transparent;
                color: inherit;
                font: inherit;
                text-align: left;
                cursor: pointer;
            }
            .item:hover {
                background: var(--_hover);
            }
            .item.unread {
                background: color-mix(in srgb, var(--_accent) 7%, transparent);
                border-left-color: var(--_accent);
            }
            .item.unread:hover {
                background: color-mix(in srgb, var(--_accent) 12%, transparent);
            }
            .type-icon {
                width: var(--_avatar);
                height: var(--_avatar);
                border-radius: 50%;
                display: grid;
                place-items: center;
                background: var(--_brand-soft);
                color: var(--_text-2);
                flex: none;
            }
            .body {
                min-width: 0;
                display: grid;
                gap: 2px;
            }
            .headline {
                color: var(--_text-2);
                overflow-wrap: anywhere;
            }
            .headline strong {
                color: var(--_text);
                font-weight: var(--_fw-bold);
            }
            .unread .headline {
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
                padding-top: 2px;
            }
            .time {
                font-size: var(--_fs-sm);
                color: var(--_muted);
                white-space: nowrap;
            }
            .dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: var(--_accent);
            }
            .more {
                display: flex;
                justify-content: center;
                padding: var(--_s2) var(--_s3) var(--_s3);
            }
            @media (max-width: 360px) {
                .item {
                    gap: var(--_s2);
                    padding: var(--_s2);
                }
            }
        `,
    ];

    declare view: NotificationView;
    declare noTabs: boolean;
    declare noHeader: boolean;
    declare noAutoRead: boolean;
    declare canWrite: boolean;
    declare actionError: string;

    private service: NotificationsService | null = null;
    private feedRef: NotificationFeed | null = null;

    constructor() {
        super();
        this.view = "all";
        this.noTabs = false;
        this.noHeader = false;
        this.noAutoRead = false;
        this.canWrite = false;
        this.actionError = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.service = client ? getNotifications(client) : null;
        if (this.feedRef) this.unwatch(this.feedRef.state);
        this.feedRef = null;
        this.canWrite = false;
        if (!client || !this.service) return;
        this.observe(this.service.unread);
        this.attachFeed();
        void this.service.canMarkRead().then((ok) => (this.canWrite = ok));
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("view") && changed.get("view") !== undefined && this.service) this.attachFeed();
    }

    private attachFeed(): void {
        if (!this.service) return;
        const view = VIEWS.includes(this.view) ? this.view : "all";
        const feed = this.service.feed(view);
        if (feed === this.feedRef) return;
        if (this.feedRef) this.unwatch(this.feedRef.state);
        this.feedRef = feed;
        this.watch(feed.state);
        void feed.load().catch(() => undefined);
    }

    /** Reload the current view from the server */
    refresh(): Promise<void> {
        return this.feedRef?.load({ refresh: true }) ?? Promise.resolve();
    }

    private async select(n: SpreeWeNotification): Promise<void> {
        const proceed = this.fire<NotificationSelectDetail>("spreewe-notification-select", { notification: n, conversationId: n.conversationId, messageId: n.messageId }, { cancelable: true });
        if (!proceed || this.noAutoRead || n.read || !this.canWrite || !this.service) return;
        try {
            await this.service.markRead([n._id]);
        } catch (e) {
            this.actionError = errorText(e, "write");
            this.fire("spreewe-error", { error: e, action: "mark-read" });
        }
    }

    private async markAll(): Promise<void> {
        if (!this.service) return;
        this.actionError = "";
        try {
            await this.service.markAllRead();
        } catch (e) {
            this.actionError = errorText(e, "write");
            this.fire("spreewe-error", { error: e, action: "mark-all-read" });
        }
    }

    private setView(view: NotificationView): void {
        if (view === this.view) return;
        this.view = view;
        this.fire("spreewe-notification-view-change", { view });
    }

    private onTabKey(e: KeyboardEvent): void {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const i = VIEWS.indexOf(this.view);
        const next = VIEWS[(i + (e.key === "ArrowRight" ? 1 : VIEWS.length - 1)) % VIEWS.length];
        e.preventDefault();
        this.setView(next);
        void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>(`.tab[data-view="${next}"]`)?.focus());
    }

    private onListKey(e: KeyboardEvent): void {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
        const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>("button.item")];
        if (!buttons.length) return;
        const i = buttons.indexOf(this.renderRoot.querySelector<HTMLButtonElement>("button.item:focus")!);
        const target =
            e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        e.preventDefault();
        buttons[target]?.focus();
    }

    protected override render() {
        if (!this.sw || !this.feedRef) return html`<div class="state">${t("common.noClient")}</div>`;
        const state: NotificationFeedState = this.feedRef.state.value;
        const unread = this.service!.unread.value || state.items.some((n) => !n.read);
        return html`
            <slot name="header"></slot>
            ${this.noHeader
                ? nothing
                : html`<div class="toolbar" part="toolbar">
                      <h2 class="title" part="title">${t("notifications.title")}</h2>
                      ${this.canWrite && unread
                          ? html`<button class="btn ghost mark-all" part="mark-all" @click=${() => this.markAll()}>${icon("check-double", 16)} ${t("notifications.markAllRead")}</button>`
                          : nothing}
                  </div>`}
            ${this.noTabs
                ? nothing
                : html`<div class="tabs" part="tabs" role="tablist" aria-label=${t("notifications.views")} @keydown=${this.onTabKey}>
                      ${VIEWS.map(
                          (v) => html`<button class="btn tab" role="tab" data-view=${v} part=${v === this.view ? "tab tab-selected" : "tab"}
                              aria-selected=${v === this.view ? "true" : "false"} tabindex=${v === this.view ? "0" : "-1"} @click=${() => this.setView(v)}>
                              ${t(`notifications.view.${v}`)}
                          </button>`,
                      )}
                  </div>`}
            ${this.actionError ? html`<div class="error-banner" part="error" role="alert">${icon("alert", 16)}<span>${this.actionError}</span></div>` : nothing}
            ${this.renderBody(state)}
        `;
    }

    private renderBody(state: NotificationFeedState) {
        if (state.error && !state.items.length) {
            const scope = missingScope(state.error);
            return html`<div class="state" part="error" role="alert">
                <span>${errorText(state.error, "read")}</span>
                ${scope === null ? html`<button class="btn" @click=${() => this.refresh().catch(() => undefined)}>${t("common.retry")}</button>` : nothing}
            </div>`;
        }
        if (state.loading && !state.loaded) return html`<div class="state">${spinner()}</div>`;
        if (state.loaded && !state.items.length) {
            return html`<slot name="empty">
                <div class="state">
                    ${this.view === "all"
                        ? html`<strong>${t("notifications.empty.title")}</strong><span>${t("notifications.empty.text")}</span>`
                        : html`<span>${t(`notifications.empty.${this.view}`)}</span>`}
                </div>
            </slot>`;
        }
        return html`
            <ul class="scroll" part="list" role="list" aria-label=${t("notifications.title")} aria-busy=${state.loading ? "true" : "false"} @keydown=${this.onListKey}>
                ${repeat(state.items, (n) => n._id, (n) => this.renderItem(n))}
                ${state.error && state.items.length
                    ? html`<li class="error-banner" part="error" role="alert">
                          <span>${errorText(state.error, "read")}</span>
                          <button class="btn ghost" @click=${() => (state.hasMore ? this.feedRef?.loadMore() : this.refresh())?.catch(() => undefined)}>${t("common.retry")}</button>
                      </li>`
                    : nothing}
                ${state.hasMore && !state.error
                    ? html`<li class="more">
                          ${state.loadingMore
                              ? spinner()
                              : html`<button class="btn" part="load-more" @click=${() => this.feedRef?.loadMore().catch(() => undefined)}>${t("notifications.loadMore")}</button>`}
                      </li>`
                    : nothing}
            </ul>
        `;
    }

    private renderItem(n: SpreeWeNotification) {
        const preview = notificationPreview(n);
        const label = `${notificationTitle(n)}${preview ? `. ${preview}` : ""}. ${formatDateTime(n.createdAt)}${n.read ? "" : `. ${t("notifications.unread")}`}`;
        return html`<li>
            <button class="item ${n.read ? "" : "unread"}" part=${n.read ? "item" : "item item-unread"} aria-label=${label} @click=${() => this.select(n)}>
                ${n.actor
                    ? html`<spreewe-avatar part="avatar" .client=${this.sw} name=${n.actor.username} src=${n.actor.avatar || ""}></spreewe-avatar>`
                    : html`<span class="type-icon" part="type-icon" aria-hidden="true">${icon(typeIcon(n.type), 18)}</span>`}
                <span class="body">
                    <span class="headline" part="headline">${notificationHeadline(n)}</span>
                    ${preview ? html`<span class="preview" part="preview">${preview}</span>` : nothing}
                </span>
                <span class="meta">
                    <time class="time" part="time" datetime=${n.createdAt} title=${formatDateTime(n.createdAt)}>${formatListTime(n.createdAt)}</time>
                    ${n.read ? nothing : html`<span class="dot" part="dot" aria-hidden="true"></span>`}
                </span>
            </button>
        </li>`;
    }
}
