import { css, html, nothing, type ReactiveControllerHost, type TemplateResult } from "lit";
import { isSpreeWeError } from "@spreewe/core";
import { formatBytes, formatDateTime, formatListTime, icon, t } from "@spreewe/ui";
import type { FilesService } from "../service.js";
import type { FileItem, FileKind } from "../types.js";

export interface FileSelectDetail {
    item: FileItem;
}

/** The scope a refused request needed, when the server said so ("The token lacks the x:y scope"). */
export function missingScope(e: unknown): string | null {
    if (!isSpreeWeError(e)) return null;
    if (e.status !== 403 && e.code !== "MISSING_SCOPE") return null;
    return /lacks the ([a-z0-9]+:[a-z]+) scope/i.exec(e.message)?.[1] ?? (e.code === "MISSING_SCOPE" ? "files:read" : null);
}

export function errorText(e: unknown): string {
    const scope = missingScope(e);
    if (scope !== null) return t("files.missingScope", { scope });
    return e instanceof Error && e.message ? e.message : t("common.error");
}

/** Name to show: the real one, else the kind ("Photo") */
export function displayName(item: FileItem): string {
    if (item.name) return item.name;
    return item.encrypted && item.state !== "ok" && item.state !== "pending" ? t("files.encrypted") : t(`files.one.${item.kind}`);
}

export function kindIcon(kind: FileKind): string {
    switch (kind) {
        case "image":
            return "image";
        case "video":
            return "video";
        case "audio":
            return "mic";
        default:
            return "file";
    }
}

/** Why an item can't be opened (empty when it can) */
export function stateText(item: FileItem): string {
    return item.state === "ok" ? "" : t(`files.state.${item.state}`);
}

export function canDownload(item: FileItem): boolean {
    return item.state === "ok" && !!(item.downloadUrl || item.url);
}

/** "in Chat · from Ana · 1.2 MB · 14:05" */
export function metaLine(item: FileItem, opts: { conversation?: boolean; sender?: boolean } = {}): string {
    const parts = [
        opts.conversation && item.conversationTitle ? t("files.in", { name: item.conversationTitle }) : "",
        opts.sender && item.sender?.username ? t("files.from", { name: item.sender.username }) : "",
        item.state === "ok" || !item.encrypted ? formatBytes(item.size) : "",
        formatListTime(item.createdAt),
    ];
    return parts.filter(Boolean).join(" · ");
}

export function itemLabel(item: FileItem, opts: { conversation?: boolean; sender?: boolean } = {}): string {
    const state = stateText(item);
    return [displayName(item), metaLine({ ...item, createdAt: "" }, opts), formatDateTime(item.createdAt), state].filter(Boolean).join(". ");
}

export function spinner(): TemplateResult {
    return html`<span class="spinner" role="status" aria-label=${t("common.loading")}></span>`;
}

type Host = ReactiveControllerHost & HTMLElement & { dispatchEvent(e: Event): boolean };

/**
 * Per-item download and preview bookkeeping shared by the file components: busy flags, error
 * messages, and decrypted thumbnails (object URLs owned by the FilesService cache).
 */
export class FileActions {
    readonly busy = new Set<string>();
    readonly errors = new Map<string, string>();
    readonly thumbs = new Map<string, string | null>();
    private readonly host: Host;

    constructor(host: Host) {
        this.host = host;
    }

    reset(): void {
        this.busy.clear();
        this.errors.clear();
        this.thumbs.clear();
    }

    /** Fires spreewe-file-download (cancelable); unless prevented, saves the file through the browser. */
    async download(service: FilesService | null, item: FileItem): Promise<void> {
        if (!service || this.busy.has(item.id)) return;
        const proceed = this.host.dispatchEvent(new CustomEvent<FileSelectDetail>("spreewe-file-download", { detail: { item }, bubbles: true, composed: true, cancelable: true }));
        if (!proceed) return;
        this.busy.add(item.id);
        this.errors.delete(item.id);
        this.host.requestUpdate();
        try {
            await service.save(item);
        } catch (e) {
            this.errors.set(item.id, e instanceof Error ? e.message : t("common.error"));
            this.host.dispatchEvent(new CustomEvent("spreewe-error", { detail: { error: e, action: "download", item }, bubbles: true, composed: true }));
        } finally {
            this.busy.delete(item.id);
            this.host.requestUpdate();
        }
    }

    /** Thumbnail URL for an image item (requests it once; re-renders when it arrives) */
    thumb(service: FilesService | null, item: FileItem): string | null {
        if (!service || item.state !== "ok") return null;
        if (this.thumbs.has(item.id)) return this.thumbs.get(item.id) ?? null;
        this.thumbs.set(item.id, null);
        void service.preview(item).then((url) => {
            if (!url) return;
            this.thumbs.set(item.id, url);
            this.host.requestUpdate();
        });
        return null;
    }

    downloadButton(service: FilesService | null, item: FileItem): TemplateResult | typeof nothing {
        if (!canDownload(item)) return nothing;
        const busy = this.busy.has(item.id);
        return html`<button class="icon-btn download" part="download" aria-label=${t("files.download", { name: displayName(item) })} title=${t("files.download", { name: displayName(item) })}
            ?disabled=${busy} aria-busy=${busy ? "true" : "false"} @click=${(e: Event) => {
                e.stopPropagation();
                void this.download(service, item);
            }}>${busy ? spinner() : icon("download", 18)}</button>`;
    }
}

/** Tab strip styles shared by both components */
export const tabStyles = css`
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
        flex: none;
    }
    .tab[aria-selected="true"] {
        background: var(--_brand);
        border-color: var(--_brand);
        color: var(--_on-brand);
    }
    .count {
        opacity: 0.75;
        font-variant-numeric: tabular-nums;
    }
`;

/** Row styles (file list and the documents / audio tabs of shared media) */
export const rowStyles = css`
    ul.rows {
        list-style: none;
        margin: 0;
        padding: var(--_s1) 0;
    }
    .row {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: var(--_s2);
        padding: 0 var(--_s2) 0 0;
    }
    .row:hover {
        background: var(--_hover);
    }
    .open {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: var(--_s3);
        align-items: center;
        min-width: 0;
        padding: var(--_s2) var(--_s3);
        border: 0;
        background: transparent;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
        grid-column: 1 / 3;
    }
    .thumb {
        width: 40px;
        height: 40px;
        border-radius: var(--_r-sm);
        background: var(--_brand-soft);
        color: var(--_text-2);
        display: grid;
        place-items: center;
        overflow: hidden;
        flex: none;
        position: relative;
    }
    .thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }
    .thumb .lock {
        position: absolute;
        right: 1px;
        bottom: 1px;
        color: var(--_muted);
        background: var(--_surface);
        border-radius: 50%;
        display: grid;
        place-items: center;
        width: 16px;
        height: 16px;
    }
    .text {
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
    .meta,
    .note {
        font-size: var(--_fs-sm);
        color: var(--_muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .note.error {
        color: var(--_danger);
        white-space: normal;
    }
    .locked .name {
        color: var(--_text-2);
    }
`;
