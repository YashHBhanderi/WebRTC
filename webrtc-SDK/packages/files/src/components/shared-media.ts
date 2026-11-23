import { css, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, scrollStyles, stateStyles, t } from "@spreewe/ui";
import { getFiles, type FileCollection, type FilesService } from "../service.js";
import type { FileCollectionState, FileItem } from "../types.js";
import { FileActions, displayName, errorText, itemLabel, kindIcon, metaLine, missingScope, rowStyles, spinner, stateText, tabStyles, type FileSelectDetail } from "./shared.js";
import "../strings.js";

export type SharedMediaTab = "media" | "docs" | "audio";
const TABS: SharedMediaTab[] = ["media", "docs", "audio"];
/** GET /conversations/:id/media returns at most this many items (MessageService.sharedMedia) */
const SERVER_LIMIT = 300;

function tabOf(item: FileItem): SharedMediaTab {
    if (item.kind === "image" || item.kind === "video") return "media";
    if (item.kind === "audio") return "audio";
    return "docs";
}

/**
 * <spreewe-shared-media conversation-id="…"> — what was shared in one conversation: photos and
 * videos as a grid (encrypted images decrypted on this device for thumbnails), documents and audio as lists.
 *
 * Attributes: conversation-id (required), tab = "media" | "docs" | "audio", no-tabs, no-header.
 * Events: spreewe-file-select { item }, spreewe-file-download { item } (cancelable),
 *   spreewe-media-tab-change { tab }, spreewe-error { error, action, item }.
 * Slots: header (above the tabs), empty (nothing shared).
 * CSS parts: toolbar, title, tabs, tab, tab-selected, grid, tile, thumb, list, item, name, meta,
 *   state, download, notice, error.
 * CSS custom property: --sw-media-tile-size (minimum tile width, default 96px).
 */
export class SpreeWeSharedMedia extends SpreeWeElement {
    static override properties = {
        conversationId: { attribute: "conversation-id", reflect: true },
        tab: { reflect: true },
        noTabs: { type: Boolean, attribute: "no-tabs" },
        noHeader: { type: Boolean, attribute: "no-header" },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        scrollStyles,
        stateStyles,
        tabStyles,
        rowStyles,
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
                gap: var(--_s2);
                padding: var(--_s2) var(--_s3);
                border-bottom: var(--_bw) solid var(--_border);
            }
            .title {
                margin: 0;
                font-size: var(--_fs-lg);
                font-weight: var(--_fw-bold);
            }
            .scroll {
                flex: 1;
                min-height: 0;
            }
            .grid {
                list-style: none;
                margin: 0;
                padding: var(--_s2);
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(var(--sw-media-tile-size, 96px), 1fr));
                gap: var(--_s1);
            }
            .tile {
                position: relative;
                aspect-ratio: 1;
                border-radius: var(--_r-sm);
                overflow: hidden;
                background: var(--_brand-soft);
            }
            .tile .open {
                display: grid;
                place-items: center;
                width: 100%;
                height: 100%;
                padding: 0;
                border: 0;
                background: transparent;
                color: var(--_text-2);
                cursor: pointer;
                font: inherit;
            }
            .tile img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }
            .tile .badge {
                position: absolute;
                left: var(--_s1);
                bottom: var(--_s1);
                display: inline-flex;
                align-items: center;
                gap: 2px;
                padding: 1px 6px;
                border-radius: var(--_r-pill);
                background: var(--_overlay);
                color: #fff;
                font-size: 11px;
                pointer-events: none;
            }
            .tile .download {
                position: absolute;
                top: var(--_s1);
                right: var(--_s1);
                width: 30px;
                height: 30px;
                background: var(--_surface);
                color: var(--_text);
                opacity: 0;
                transition: opacity var(--_t);
            }
            .tile:hover .download,
            .tile:focus-within .download {
                opacity: 1;
            }
            @media (hover: none) {
                .tile .download {
                    opacity: 1;
                }
            }
            .tile.locked .open {
                color: var(--_muted);
            }
            .notice {
                margin: var(--_s2) var(--_s3);
                font-size: var(--_fs-sm);
                color: var(--_muted);
            }
            @media (max-width: 360px) {
                .grid {
                    grid-template-columns: repeat(3, 1fr);
                    padding: var(--_s1);
                }
            }
        `,
    ];

    declare conversationId: string;
    declare tab: SharedMediaTab;
    declare noTabs: boolean;
    declare noHeader: boolean;

    private service: FilesService | null = null;
    private collection: FileCollection | null = null;
    private readonly actions = new FileActions(this);

    constructor() {
        super();
        this.conversationId = "";
        this.tab = "media";
        this.noTabs = false;
        this.noHeader = false;
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.service = client ? getFiles(client) : null;
        this.detach();
        if (client) this.attach();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("conversationId") && changed.get("conversationId") !== undefined && this.service) {
            this.detach();
            this.attach();
        }
    }

    private detach(): void {
        if (this.collection) this.unwatch(this.collection.state);
        this.collection = null;
        this.actions.reset();
    }

    private attach(): void {
        if (!this.service || !this.conversationId) return;
        this.collection = this.service.conversation(this.conversationId);
        this.watch(this.collection.state);
        void this.collection.load().catch(() => undefined);
    }

    /** Reload from the server */
    refresh(): Promise<void> {
        return this.collection?.refresh() ?? Promise.resolve();
    }

    private setTab(tab: SharedMediaTab): void {
        if (tab === this.tab) return;
        this.tab = tab;
        this.fire("spreewe-media-tab-change", { tab });
    }

    private onTabKey(e: KeyboardEvent): void {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const i = TABS.indexOf(this.tab);
        const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
        e.preventDefault();
        this.setTab(next);
        void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>(`.tab[data-tab="${next}"]`)?.focus());
    }

    private select(item: FileItem): void {
        this.fire<FileSelectDetail>("spreewe-file-select", { item });
    }

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        if (!this.collection) return html`<div class="state">${t("files.media.empty")}</div>`;
        const state: FileCollectionState = this.collection.state.value;
        const counts: Record<SharedMediaTab, number> = { media: 0, docs: 0, audio: 0 };
        for (const i of state.items) counts[tabOf(i)]++;
        const tab = TABS.includes(this.tab) ? this.tab : "media";
        return html`
            <slot name="header"></slot>
            ${this.noHeader ? nothing : html`<div class="toolbar" part="toolbar"><h2 class="title" part="title">${t("files.media.title")}</h2></div>`}
            ${this.noTabs
                ? nothing
                : html`<div class="tabs" part="tabs" role="tablist" aria-label=${t("files.kinds")} @keydown=${this.onTabKey}>
                      ${TABS.map(
                          (k) => html`<button class="btn tab" role="tab" data-tab=${k} part=${k === tab ? "tab tab-selected" : "tab"}
                              aria-selected=${k === tab ? "true" : "false"} tabindex=${k === tab ? "0" : "-1"} @click=${() => this.setTab(k)}>
                              ${t(`files.tab.${k}`)} ${state.loaded ? html`<span class="count">${counts[k]}</span>` : nothing}
                          </button>`,
                      )}
                  </div>`}
            ${this.renderBody(state, tab)}
        `;
    }

    private renderBody(state: FileCollectionState, tab: SharedMediaTab) {
        if (state.error && !state.items.length) {
            const scope = missingScope(state.error);
            return html`<div class="state" part="error" role="alert">
                <span>${errorText(state.error)}</span>
                ${scope === null ? html`<button class="btn" @click=${() => this.refresh().catch(() => undefined)}>${t("common.retry")}</button>` : nothing}
            </div>`;
        }
        if (state.loading && !state.loaded) return html`<div class="state">${spinner()}</div>`;
        if (state.loaded && !state.items.length) {
            return html`<slot name="empty"><div class="state">${t("files.media.empty")}</div></slot>`;
        }
        const items = this.noTabs ? state.items : state.items.filter((i) => tabOf(i) === tab);
        return html`<div class="scroll">
            ${state.error ? html`<div class="error-banner" part="error" role="alert"><span>${errorText(state.error)}</span>
                <button class="btn ghost" @click=${() => this.refresh().catch(() => undefined)}>${t("common.retry")}</button></div>` : nothing}
            ${!items.length
                ? html`<div class="state">${t("files.media.emptyTab")}</div>`
                : tab === "media" && !this.noTabs
                  ? html`<ul class="grid" part="grid" role="list" aria-label=${t("files.tab.media")}>${repeat(items, (i) => i.id, (i) => this.renderTile(i))}</ul>`
                  : html`<ul class="rows" part="list" role="list" aria-label=${t(`files.tab.${tab}`)}>${repeat(items, (i) => i.id, (i) => this.renderRow(i))}</ul>`}
            ${state.items.length >= SERVER_LIMIT ? html`<p class="notice" part="notice">${t("files.media.limit", { n: SERVER_LIMIT })}</p>` : nothing}
        </div>`;
    }

    private renderTile(item: FileItem) {
        const thumb = item.kind === "image" ? this.actions.thumb(this.service, item) : null;
        const blocked = item.encrypted && item.state !== "ok";
        return html`<li class="tile ${blocked ? "locked" : ""}" part="tile">
            <button class="open" aria-label=${itemLabel(item, { sender: false })} title=${stateText(item) || displayName(item)} @click=${() => this.select(item)}>
                ${thumb
                    ? html`<img part="thumb" src=${thumb} alt="" loading="lazy" />`
                    : item.state === "pending"
                      ? spinner()
                      : icon(blocked ? "lock" : kindIcon(item.kind), 26)}
            </button>
            ${this.actions.errors.has(item.id)
                ? html`<span class="badge" part="state" role="alert" title=${this.actions.errors.get(item.id)!}>${icon("alert", 12)}<span class="sr-only">${this.actions.errors.get(item.id)}</span></span>`
                : item.kind === "video"
                  ? html`<span class="badge" aria-hidden="true">${icon("video", 12)}</span>`
                  : nothing}
            ${this.actions.downloadButton(this.service, item)}
        </li>`;
    }

    private renderRow(item: FileItem) {
        const blocked = item.encrypted && item.state !== "ok";
        const note = this.actions.errors.get(item.id) || stateText(item);
        return html`<li class="row ${blocked ? "locked" : ""}" part="item">
            <button class="open" aria-label=${itemLabel(item)} @click=${() => this.select(item)}>
                <span class="thumb" aria-hidden="true">
                    ${icon(kindIcon(item.kind), 20)}
                    ${blocked ? html`<span class="lock">${icon("lock", 12)}</span>` : nothing}
                </span>
                <span class="text">
                    <span class="name" part="name">${displayName(item)}</span>
                    <span class="meta" part="meta">${metaLine(item)}</span>
                    ${note ? html`<span class="note ${this.actions.errors.has(item.id) ? "error" : ""}" part="state">${note}</span>` : nothing}
                </span>
            </button>
            ${this.actions.downloadButton(this.service, item)}
        </li>`;
    }
}
