import { css, html, nothing } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, formatListTime, scrollStyles, stateStyles, t } from "@spreewe/ui";
import { getGroups, type GroupListItem, type GroupsService } from "../service.js";
import "../strings.js";

/**
 * <spreewe-group-list> — the user's groups (scope groups:read), live.
 * Attributes: selected (group id). Events: spreewe-group-select { groupId, group }.
 * Slots: header, empty. CSS parts: list, item, item-selected, name, meta, badge.
 */
export class SpreeWeGroupList extends SpreeWeElement {
    static override properties = {
        selected: { reflect: true },
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
            ul {
                list-style: none;
                margin: 0;
                padding: var(--_s1) 0;
                flex: 1;
                min-height: 0;
            }
            button.item {
                display: grid;
                grid-template-columns: auto 1fr auto;
                align-items: center;
                gap: var(--_s3);
                width: 100%;
                padding: var(--_s2) var(--_s3);
                border: 0;
                border-left: 3px solid transparent;
                background: none;
                color: inherit;
                font: inherit;
                text-align: left;
                cursor: pointer;
            }
            button.item:hover {
                background: var(--_hover);
            }
            button.item[aria-current="true"] {
                background: var(--_active);
                border-left-color: var(--_brand);
            }
            .name {
                font-weight: var(--_fw-medium);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .meta {
                font-size: var(--_fs-sm);
                color: var(--_muted);
            }
            .side {
                display: grid;
                justify-items: end;
                gap: 4px;
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
            .body {
                min-width: 0;
                display: grid;
            }
        `,
    ];

    declare selected: string;
    private service: GroupsService | null = null;

    constructor() {
        super();
        this.selected = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.service = client ? getGroups(client) : null;
        if (this.service) {
            this.observe(this.service.groups);
            void this.service.loadGroups().catch(() => undefined);
        }
    }

    private select(g: GroupListItem): void {
        this.selected = g.id;
        this.fire("spreewe-group-select", { groupId: g.id, group: g });
    }

    protected override render() {
        if (!this.sw || !this.service) return html`<div class="state">${t("common.noClient")}</div>`;
        const s = this.service.groups.value;
        return html`<slot name="header"></slot>
            ${s.loading && !s.loaded ? html`<div class="state"><span class="spinner"></span></div>` : nothing}
            ${s.error && !s.items.length ? html`<div class="state" role="alert">${s.error.message}<button class="btn" @click=${() => this.service?.loadGroups({ refresh: true })}>${t("common.retry")}</button></div>` : nothing}
            ${s.loaded && !s.items.length ? html`<slot name="empty"><div class="state">${t("groups.list.empty")}</div></slot>` : nothing}
            <ul class="scroll" part="list">
                ${repeat(s.items, (g) => g.id, (g) => html`<li>
                    <button class="item" part=${g.id === this.selected ? "item item-selected" : "item"} aria-current=${g.id === this.selected ? "true" : "false"} @click=${() => this.select(g)}>
                        <spreewe-avatar .client=${this.sw} shape="square" name=${g.name} src=${g.avatar}></spreewe-avatar>
                        <span class="body"><span class="name" part="name">${g.name}</span><span class="meta" part="meta">${t("groups.list.members", { n: g.memberCount })}</span></span>
                        <span class="side"><span class="meta">${formatListTime(g.lastMessageAt)}</span>${g.unread ? html`<span class="badge" part="badge">${g.unread}</span>` : nothing}</span>
                    </button>
                </li>`)}
            </ul>`;
    }
}
