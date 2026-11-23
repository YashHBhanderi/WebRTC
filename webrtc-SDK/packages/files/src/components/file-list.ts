import { css, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, inputStyles, scrollStyles, stateStyles, t } from "@spreewe/ui";
import { getFiles, type FileCollection, type FilesService, type LibraryKind } from "../service.js";
import { FILE_KINDS, type FileCollectionState, type FileItem } from "../types.js";
import { FileActions, displayName, errorText, itemLabel, kindIcon, metaLine, missingScope, rowStyles, spinner, stateText, tabStyles, type FileSelectDetail } from "./shared.js";
import "../strings.js";

const KINDS: LibraryKind[] = ["all", ...FILE_KINDS];

/**
 * <spreewe-file-list> — files shared in the user's chats (GET /files), newest first, with a kind
 * filter (server side), a name filter over the loaded items, and downloads decrypted on this device.
 *
 * Attributes: kind = "all" | "image" | "video" | "audio" | "pdf" | "file", no-tabs, no-search, no-header.
 * Events: spreewe-file-select { item }, spreewe-file-download { item } (cancelable: preventDefault()
 *   to handle the download yourself), spreewe-error { error, action, item }.
 * Slots: header (above the toolbar), empty (no files).
 * CSS parts: toolbar, title, search, tabs, tab, tab-selected, list, item, thumb, name, meta, state,
 *   download, load-more, error.
 */
export class SpreeWeFileList extends SpreeWeElement {
    static override properties = {
        kind: { reflect: true },
        noTabs: { type: Boolean, attribute: "no-tabs" },
        noSearch: { type: Boolean, attribute: "no-search" },
        noHeader: { type: Boolean, attribute: "no-header" },
        query: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        inputStyles,
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
                flex-wrap: wrap;
            }
            .title {
                margin: 0;
                font-size: var(--_fs-lg);
                font-weight: var(--_fw-bold);
                flex: 1 1 auto;
            }
            .search {
                position: relative;
                flex: 1 1 180px;
                min-width: 0;
            }
            .search .input {
                padding-left: calc(var(--_s3) + 22px);
            }
            .search .icon {
                position: absolute;
                left: var(--_s3);
                top: 50%;
                transform: translateY(-50%);
                color: var(--_muted);
                pointer-events: none;
                display: flex;
            }
            .scroll {
                flex: 1;
                min-height: 0;
            }
            .more {
                display: flex;
                justify-content: center;
                padding: var(--_s2) var(--_s3) var(--_s3);
            }
            .note-bar {
                margin: var(--_s2) var(--_s3);
                font-size: var(--_fs-sm);
                color: var(--_muted);
            }
        `,
    ];

    declare kind: LibraryKind;
    declare noTabs: boolean;
    declare noSearch: boolean;
    declare noHeader: boolean;
    declare query: string;

    private service: FilesService | null = null;
    private collection: FileCollection | null = null;
    private readonly actions = new FileActions(this);

    constructor() {
        super();
        this.kind = "all";
        this.noTabs = false;
        this.noSearch = false;
        this.noHeader = false;
        this.query = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.service = client ? getFiles(client) : null;
        if (this.collection) this.unwatch(this.collection.state);
        this.collection = null;
        this.actions.reset();
        if (client) this.attach();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("kind") && changed.get("kind") !== undefined && this.service) this.attach();
    }

    private attach(): void {
        if (!this.service) return;
        const next = this.service.library(KINDS.includes(this.kind) ? this.kind : "all");
        if (next === this.collection) return;
        if (this.collection) this.unwatch(this.collection.state);
        this.collection = next;
        this.watch(next.state);
        void next.load().catch(() => undefined);
    }

    /** Reload from the server */
    refresh(): Promise<void> {
        return this.collection?.refresh() ?? Promise.resolve();
    }

    private setKind(kind: LibraryKind): void {
        if (kind === this.kind) return;
        this.kind = kind;
        this.fire("spreewe-file-kind-change", { kind });
    }

    private onTabKey(e: KeyboardEvent): void {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const i = KINDS.indexOf(this.kind);
        const next = KINDS[(i + (e.key === "ArrowRight" ? 1 : KINDS.length - 1)) % KINDS.length];
        e.preventDefault();
        this.setKind(next);
        void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLButtonElement>(`.tab[data-kind="${next}"]`)?.focus());
    }

    private onListKey(e: KeyboardEvent): void {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        const buttons = [...this.renderRoot.querySelectorAll<HTMLButtonElement>("button.open")];
        const i = buttons.indexOf(this.renderRoot.querySelector<HTMLButtonElement>("button.open:focus")!);
        const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
        if (next) {
            e.preventDefault();
            next.focus();
        }
    }

    private visible(items: FileItem[]): FileItem[] {
        const q = this.query.trim().toLowerCase();
        if (!q) return items;
        return items.filter((i) =>
            [displayName(i), i.conversationTitle, i.sender?.username, i.caption].some((v) => (v || "").toLowerCase().includes(q)),
        );
    }

    protected override render() {
        if (!this.sw || !this.collection) return html`<div class="state">${t("common.noClient")}</div>`;
        const state: FileCollectionState = this.collection.state.value;
        return html`
            <slot name="header"></slot>
            ${this.noHeader && this.noSearch
                ? nothing
                : html`<div class="toolbar" part="toolbar">
                      ${this.noHeader ? nothing : html`<h2 class="title" part="title">${t("files.title")}</h2>`}
                      ${this.noSearch
                          ? nothing
                          : html`<div class="search" part="search">
                                <span class="icon">${icon("search", 18)}</span>
                                <input class="input" type="search" .value=${this.query} placeholder=${t("files.filter")} aria-label=${t("files.filter")}
                                    @input=${(e: Event) => (this.query = (e.target as HTMLInputElement).value)} />
                            </div>`}
                  </div>`}
            ${this.noTabs
                ? nothing
                : html`<div class="tabs" part="tabs" role="tablist" aria-label=${t("files.kinds")} @keydown=${this.onTabKey}>
                      ${KINDS.map(
                          (k) => html`<button class="btn tab" role="tab" data-kind=${k} part=${k === this.kind ? "tab tab-selected" : "tab"}
                              aria-selected=${k === this.kind ? "true" : "false"} tabindex=${k === this.kind ? "0" : "-1"} @click=${() => this.setKind(k)}>
                              ${t(`files.kind.${k}`)}
                          </button>`,
                      )}
                  </div>`}
            ${this.renderBody(state)}
        `;
    }

    private renderBody(state: FileCollectionState) {
        if (state.error && !state.items.length) {
            const scope = missingScope(state.error);
            return html`<div class="state" part="error" role="alert">
                <span>${errorText(state.error)}</span>
                ${scope === null ? html`<button class="btn" @click=${() => this.refresh().catch(() => undefined)}>${t("common.retry")}</button>` : nothing}
            </div>`;
        }
        if (state.loading && !state.loaded) return html`<div class="state">${spinner()}</div>`;
        if (state.loaded && !state.items.length) {
            return html`<slot name="empty"><div class="state"><strong>${t("files.empty.title")}</strong><span>${t("files.empty.text")}</span></div></slot>`;
        }
        const items = this.visible(state.items);
        return html`<div class="scroll">
            ${this.query && !items.length ? html`<p class="note-bar">${t("files.noMatch", { q: this.query })}</p>` : nothing}
            <ul class="rows" part="list" role="list" aria-label=${t("files.title")} aria-busy=${state.loading ? "true" : "false"} @keydown=${this.onListKey}>
                ${repeat(items, (i) => i.id, (i) => this.renderRow(i))}
            </ul>
            ${state.error && state.items.length
                ? html`<div class="error-banner" part="error" role="alert">
                      <span>${errorText(state.error)}</span>
                      <button class="btn ghost" @click=${() => this.collection?.loadMore().catch(() => undefined)}>${t("common.retry")}</button>
                  </div>`
                : nothing}
            ${state.hasMore && !state.error
                ? html`<div class="more">
                      ${state.loadingMore
                          ? spinner()
                          : html`<button class="btn" part="load-more" @click=${() => this.collection?.loadMore().catch(() => undefined)}>${t("files.loadMore")}</button>`}
                  </div>`
                : nothing}
        </div>`;
    }

    private renderRow(item: FileItem) {
        const thumb = item.kind === "image" ? this.actions.thumb(this.service, item) : null;
        const blocked = item.encrypted && item.state !== "ok";
        const note = this.actions.errors.get(item.id) || stateText(item);
        return html`<li class="row ${blocked ? "locked" : ""}" part="item">
            <button class="open" aria-label=${itemLabel(item, { conversation: true, sender: true })}
                @click=${() => this.fire<FileSelectDetail>("spreewe-file-select", { item })}>
                <span class="thumb" part="thumb" aria-hidden="true">
                    ${thumb ? html`<img src=${thumb} alt="" loading="lazy" />` : icon(kindIcon(item.kind), 20)}
                    ${item.encrypted && item.state !== "ok" ? html`<span class="lock">${icon("lock", 12)}</span>` : nothing}
                </span>
                <span class="text">
                    <span class="name" part="name">${displayName(item)}</span>
                    <span class="meta" part="meta">${metaLine(item, { conversation: true, sender: true })}</span>
                    ${note ? html`<span class="note ${this.actions.errors.has(item.id) ? "error" : ""}" part="state">${note}</span>` : nothing}
                </span>
            </button>
            ${this.actions.downloadButton(this.service, item)}
        </li>`;
    }
}
