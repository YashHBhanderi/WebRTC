import { css, html, nothing } from "lit";
import type { DirectoryEntry, SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, inputStyles, scrollStyles, stateStyles, t } from "@spreewe/ui";
import "../strings.js";

/**
 * <spreewe-member-picker> — search the directory (scope directory:read) and pick people.
 * Properties: selected (DirectoryEntry[]), exclude (user ids not offered, e.g. existing members).
 * Events: spreewe-change { selected }.
 * CSS parts: search, results, chip.
 */
export class SpreeWeMemberPicker extends SpreeWeElement {
    static override properties = {
        selected: { attribute: false },
        exclude: { attribute: false },
        query: { state: true },
        results: { state: true },
        loading: { state: true },
        error: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        inputStyles,
        scrollStyles,
        stateStyles,
        css`
            :host {
                display: grid;
                gap: var(--_s2);
            }
            .chips {
                display: flex;
                flex-wrap: wrap;
                gap: var(--_s1);
            }
            .chip {
                display: inline-flex;
                align-items: center;
                gap: var(--_s1);
                padding: 2px 4px 2px 2px;
                border-radius: var(--_r-pill);
                background: var(--_brand-soft);
                font-size: var(--_fs-sm);
            }
            .chip button {
                width: 22px;
                height: 22px;
            }
            ul {
                list-style: none;
                margin: 0;
                padding: 0;
                max-height: 240px;
                border: var(--_bw) solid var(--_border);
                border-radius: var(--_r-sm);
            }
            li button {
                display: flex;
                align-items: center;
                gap: var(--_s2);
                width: 100%;
                padding: var(--_s2);
                border: 0;
                background: none;
                color: inherit;
                font: inherit;
                text-align: left;
                cursor: pointer;
            }
            li button:hover,
            li button:focus-visible {
                background: var(--_hover);
            }
            li button[aria-pressed="true"] {
                background: var(--_active);
            }
            .grow {
                flex: 1;
            }
            .state {
                min-height: 60px;
                padding: var(--_s3);
            }
        `,
    ];

    declare selected: DirectoryEntry[];
    declare exclude: string[];
    declare query: string;
    declare results: DirectoryEntry[];
    declare loading: boolean;
    declare error: string;

    private timer: ReturnType<typeof setTimeout> | null = null;
    private seq = 0;

    constructor() {
        super();
        this.selected = [];
        this.exclude = [];
        this.query = "";
        this.results = [];
        this.loading = false;
        this.error = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        if (client) void this.search();
    }

    private onInput(e: Event): void {
        this.query = (e.target as HTMLInputElement).value;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.search(), 250);
    }

    private async search(): Promise<void> {
        if (!this.sw) return;
        const seq = ++this.seq;
        this.loading = true;
        this.error = "";
        try {
            const page = await this.sw.people.directory({ q: this.query.trim() || undefined, limit: 20 });
            if (seq !== this.seq) return;
            this.results = page.items;
            this.sw.people.seedPresence(page.items);
        } catch (e) {
            if (seq === this.seq) this.error = e instanceof Error ? e.message : t("common.error");
        } finally {
            if (seq === this.seq) this.loading = false;
        }
    }

    private toggle(u: DirectoryEntry): void {
        const has = this.selected.some((s) => s._id === u._id);
        this.selected = has ? this.selected.filter((s) => s._id !== u._id) : [...this.selected, u];
        this.fire("spreewe-change", { selected: this.selected });
    }

    protected override render() {
        const exclude = new Set(this.exclude.map(String));
        const results = this.results.filter((r) => !exclude.has(String(r._id)));
        return html`
            ${this.selected.length
                ? html`<div class="chips">${this.selected.map(
                      (u) => html`<span class="chip" part="chip"><spreewe-avatar .client=${this.sw} size="22" name=${u.username} src=${u.avatar || ""}></spreewe-avatar>${u.username}
                          <button class="icon-btn" aria-label=${t("groups.picker.remove", { name: u.username })} @click=${() => this.toggle(u)}>${icon("x", 14)}</button></span>`,
                  )}</div>`
                : nothing}
            <input class="input" part="search" type="search" placeholder=${t("groups.picker.search")} aria-label=${t("groups.picker.search")} .value=${this.query} @input=${this.onInput} />
            ${this.error ? html`<div class="error-banner" role="alert">${this.error}</div>` : nothing}
            <ul class="scroll" part="results" aria-busy=${this.loading ? "true" : "false"}>
                ${!this.loading && !results.length ? html`<li class="state">${t("groups.picker.none")}</li>` : nothing}
                ${results.map((u) => {
                    const on = this.selected.some((s) => s._id === u._id);
                    return html`<li><button aria-pressed=${on ? "true" : "false"} @click=${() => this.toggle(u)}>
                        <spreewe-avatar .client=${this.sw} size="32" name=${u.username} src=${u.avatar || ""}></spreewe-avatar>
                        <span class="grow">${u.username}</span>
                        ${on ? icon("check", 18) : nothing}
                    </button></li>`;
                })}
            </ul>
        `;
    }
}
