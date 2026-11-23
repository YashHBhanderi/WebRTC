import { css, html, nothing } from "lit";
import type { DirectoryEntry, SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, inputStyles, stateStyles, t } from "@spreewe/ui";
import { getGroups, type GroupsService } from "../service.js";
import "../strings.js";

/**
 * <spreewe-create-group> — form to create a group (scope groups:write; directory:read for the picker).
 * Events: spreewe-group-created { groupId }, spreewe-cancel.
 * Slots: title (replaces the heading). CSS parts: form, actions, submit.
 */
export class SpreeWeCreateGroup extends SpreeWeElement {
    static override properties = {
        name: { state: true },
        description: { state: true },
        members: { state: true },
        photo: { state: true },
        busy: { state: true },
        error: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        inputStyles,
        stateStyles,
        css`
            :host {
                display: block;
                background: var(--_surface);
            }
            form {
                display: grid;
                gap: var(--_s3);
                padding: var(--_s4);
            }
            h2 {
                margin: 0;
                font-size: var(--_fs-xl);
            }
            .actions {
                display: flex;
                justify-content: flex-end;
                gap: var(--_s2);
                flex-wrap: wrap;
            }
            .hint {
                font-size: var(--_fs-sm);
                color: var(--_muted);
            }
            .error-banner {
                margin: 0;
            }
        `,
    ];

    declare name: string;
    declare description: string;
    declare members: DirectoryEntry[];
    declare photo: File | null;
    declare busy: boolean;
    declare error: string;

    private groups: GroupsService | null = null;

    constructor() {
        super();
        this.name = "";
        this.description = "";
        this.members = [];
        this.photo = null;
        this.busy = false;
        this.error = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.groups = client ? getGroups(client) : null;
    }

    /** Clear the form */
    reset(): void {
        this.name = "";
        this.description = "";
        this.members = [];
        this.photo = null;
        this.error = "";
    }

    private async submit(e: Event): Promise<void> {
        e.preventDefault();
        if (!this.groups || this.busy) return;
        if (this.members.length < 2) {
            this.error = t("groups.create.minMembers");
            return;
        }
        this.busy = true;
        this.error = "";
        try {
            const groupId = await this.groups.create({ name: this.name, description: this.description, memberIds: this.members.map((m) => m._id), photo: this.photo || undefined });
            this.fire("spreewe-group-created", { groupId });
            this.reset();
        } catch (err) {
            this.error = err instanceof Error ? err.message : t("common.error");
        } finally {
            this.busy = false;
        }
    }

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        return html`<form part="form" @submit=${this.submit} novalidate>
            <slot name="title"><h2>${t("groups.create.title")}</h2></slot>
            <label class="field">${t("groups.create.name")}
                <input class="input" required maxlength="100" .value=${this.name} @input=${(e: Event) => (this.name = (e.target as HTMLInputElement).value)} />
            </label>
            <label class="field">${t("groups.create.description")}
                <textarea class="input" rows="2" maxlength="500" .value=${this.description} @input=${(e: Event) => (this.description = (e.target as HTMLTextAreaElement).value)}></textarea>
            </label>
            <label class="field">${t("groups.create.photo")}
                <input type="file" accept="image/jpeg,image/png,image/gif,image/webp" @change=${(e: Event) => (this.photo = (e.target as HTMLInputElement).files?.[0] || null)} />
            </label>
            <div class="field">
                <span>${t("groups.create.members")}</span>
                <spreewe-member-picker .client=${this.sw} .selected=${this.members} @spreewe-change=${(e: CustomEvent<{ selected: DirectoryEntry[] }>) => (this.members = e.detail.selected)}></spreewe-member-picker>
                <span class="hint">${t("groups.create.minMembers")}</span>
            </div>
            ${this.error ? html`<div class="error-banner" role="alert">${icon("alert", 16)} ${this.error}</div>` : nothing}
            <div class="actions" part="actions">
                <button type="button" class="btn" @click=${() => this.fire("spreewe-cancel")}>${t("common.cancel")}</button>
                <button type="submit" class="btn primary" part="submit" ?disabled=${this.busy || !this.name.trim()}>${this.busy ? t("groups.create.creating") : t("groups.create.submit")}</button>
            </div>
        </form>`;
    }
}
