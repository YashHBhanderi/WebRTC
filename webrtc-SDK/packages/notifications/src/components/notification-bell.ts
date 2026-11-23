import { css, html, nothing, type PropertyValues } from "lit";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, t } from "@spreewe/ui";
import { getNotifications, type NotificationsService } from "../service.js";
import type { NotificationView } from "../types.js";
import "../strings.js";

export interface NotificationPanelToggleDetail {
    open: boolean;
}

const GAP = 8;
const DEFAULT_PANEL_WIDTH = 380;

/**
 * <spreewe-notification-bell> — an icon button with the unread badge that opens the activity feed
 * (<spreewe-notification-list>) in a popover panel.
 *
 * Attributes: open (reflects), align = "end" | "start" (panel edge aligned with the button),
 *   view (initial view of the list), no-panel (button and badge only: handle
 *   spreewe-notification-bell-click yourself), keep-open (don't close after a selection).
 * Events: spreewe-notification-panel-toggle { open }, spreewe-notification-bell-click (with
 *   no-panel), and the list's spreewe-notification-select / spreewe-error bubble through.
 * Slots: icon (replaces the bell icon), header and empty (forwarded to the list).
 * CSS parts: button, badge, panel, list.
 * CSS custom properties: --sw-notification-panel-width (default 380px), --sw-notification-panel-height (default 520px).
 */
export class SpreeWeNotificationBell extends SpreeWeElement {
    static override properties = {
        open: { type: Boolean, reflect: true },
        align: { reflect: true },
        view: {},
        noPanel: { type: Boolean, attribute: "no-panel" },
        keepOpen: { type: Boolean, attribute: "keep-open" },
        panelStyle: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        css`
            :host {
                display: inline-block;
                position: relative;
            }
            .bell {
                position: relative;
                color: var(--_text-2);
            }
            .bell[aria-expanded="true"] {
                background: var(--_active);
                color: var(--_text);
            }
            .badge {
                position: absolute;
                top: 2px;
                right: 0;
                min-width: 18px;
                height: 18px;
                padding: 0 5px;
                border-radius: var(--_r-pill);
                background: var(--_danger);
                color: #fff;
                font-size: 11px;
                font-weight: var(--_fw-bold);
                line-height: 18px;
                text-align: center;
                border: 2px solid var(--_surface);
                box-sizing: content-box;
                pointer-events: none;
            }
            .panel {
                position: fixed;
                z-index: 1000;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                background: var(--_surface);
                border: var(--_bw) solid var(--_border);
                border-radius: var(--_r-lg);
                box-shadow: var(--_shadow);
            }
            .panel:focus {
                outline: none;
            }
            spreewe-notification-list {
                flex: 1;
                min-height: 0;
            }
        `,
    ];

    declare open: boolean;
    declare align: "end" | "start";
    declare view: NotificationView;
    declare noPanel: boolean;
    declare keepOpen: boolean;
    declare panelStyle: string;

    private service: NotificationsService | null = null;

    constructor() {
        super();
        this.open = false;
        this.align = "end";
        this.view = "all";
        this.noPanel = false;
        this.keepOpen = false;
        this.panelStyle = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.service = client ? getNotifications(client) : null;
        if (!client || !this.service) return;
        this.observe(this.service.unread);
        void this.service.start();
        void this.service.refreshUnread().catch(() => undefined);
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        this.removeGlobalListeners();
    }

    /** Open or close the panel */
    toggle(force?: boolean): void {
        const next = force ?? !this.open;
        if (next === this.open) return;
        this.open = next;
        this.fire<NotificationPanelToggleDetail>("spreewe-notification-panel-toggle", { open: next });
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("open")) {
            if (this.open && !this.noPanel) {
                this.place();
                this.addGlobalListeners();
            } else this.removeGlobalListeners();
        }
    }

    protected override updated(changed: PropertyValues): void {
        super.updated(changed);
        if (changed.has("open") && changed.get("open") !== undefined) {
            if (this.open && !this.noPanel) this.renderRoot.querySelector<HTMLElement>(".panel")?.focus();
            else if (!this.open) this.button?.focus();
        }
    }

    private get button(): HTMLButtonElement | null {
        return this.renderRoot.querySelector<HTMLButtonElement>("button.bell");
    }

    /** Fixed position under the button, kept inside the viewport (works at 320 px) */
    private place(): void {
        const rect = (this.button ?? this).getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const cs = getComputedStyle(this);
        const wanted = parseFloat(cs.getPropertyValue("--sw-notification-panel-width")) || DEFAULT_PANEL_WIDTH;
        const tall = parseFloat(cs.getPropertyValue("--sw-notification-panel-height")) || 520;
        const width = Math.max(200, Math.min(wanted, vw - GAP * 2));
        const preferred = this.align === "start" ? rect.left : rect.right - width;
        const left = Math.max(GAP, Math.min(preferred, vw - width - GAP));
        const top = Math.min(rect.bottom + 6, vh - 200);
        const height = Math.max(200, Math.min(tall, vh - top - GAP));
        this.panelStyle = `left:${left}px;top:${top}px;width:${width}px;height:${height}px;`;
    }

    private readonly onOutside = (e: Event) => {
        if (!e.composedPath().includes(this)) this.toggle(false);
    };
    private readonly onViewport = () => this.place();
    private listening = false;

    private addGlobalListeners(): void {
        if (this.listening || typeof window === "undefined") return;
        this.listening = true;
        document.addEventListener("pointerdown", this.onOutside, true);
        window.addEventListener("resize", this.onViewport);
        window.addEventListener("scroll", this.onViewport, true);
    }

    private removeGlobalListeners(): void {
        if (!this.listening) return;
        this.listening = false;
        document.removeEventListener("pointerdown", this.onOutside, true);
        window.removeEventListener("resize", this.onViewport);
        window.removeEventListener("scroll", this.onViewport, true);
    }

    private onClick(): void {
        if (this.noPanel) {
            this.fire("spreewe-notification-bell-click", { unread: this.service?.unread.value ?? 0 });
            return;
        }
        this.toggle();
    }

    private onPanelKey(e: KeyboardEvent): void {
        if (e.key === "Escape") {
            e.stopPropagation();
            this.toggle(false);
        }
    }

    private onSelect(e: Event): void {
        if (this.keepOpen) return;
        // Let the host see (and possibly cancel) the event first; it keeps bubbling past us
        queueMicrotask(() => {
            if (!e.defaultPrevented) this.toggle(false);
        });
    }

    protected override render() {
        const unread = this.service?.unread.value ?? 0;
        const label = unread ? t("notifications.bell.labelUnread", { n: unread }) : t("notifications.bell.label");
        return html`
            <button class="icon-btn bell" part="button" aria-label=${label} title=${label}
                aria-haspopup=${this.noPanel ? nothing : "dialog"} aria-expanded=${this.noPanel ? nothing : this.open ? "true" : "false"}
                ?disabled=${!this.sw} @click=${this.onClick}>
                <slot name="icon">${icon("bell", 22)}</slot>
                ${unread ? html`<span class="badge" part="badge" aria-hidden="true">${unread > 99 ? "99+" : unread}</span>` : nothing}
            </button>
            ${this.open && !this.noPanel && this.sw
                ? html`<div class="panel" part="panel" role="dialog" aria-label=${t("notifications.title")} tabindex="-1" style=${this.panelStyle}
                      @keydown=${this.onPanelKey} @spreewe-notification-select=${this.onSelect}>
                      <spreewe-notification-list part="list" .client=${this.sw} view=${this.view}>
                          <slot name="header" slot="header"></slot>
                          ${this.querySelector(':scope > [slot="empty"]') ? html`<slot name="empty" slot="empty"></slot>` : nothing}
                      </spreewe-notification-list>
                  </div>`
                : nothing}
        `;
    }
}
