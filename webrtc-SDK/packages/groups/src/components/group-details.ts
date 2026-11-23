import { css, html, nothing, type PropertyValues } from "lit";
import type { DirectoryEntry, PresenceUpdate, ReadableStore, SpreeWeClient, UserSummary } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, inputStyles, presenceKind, scrollStyles, stateStyles, t } from "@spreewe/ui";
import { getGroups, type DetailsState, type GroupsService } from "../service.js";
import "../strings.js";

/**
 * <spreewe-group-details group-id="…"> — group header, description, members with roles, and the
 * actions the user's role allows: edit name / description / photo, add / remove members, promote /
 * demote admins (group admins), leave, delete (admins). The server enforces every rule again.
 *
 * Attributes: group-id, readonly (hide every action).
 * Events: spreewe-member-select { user }, spreewe-group-left { groupId }, spreewe-group-deleted { groupId },
 *         spreewe-confirm-request { message, action } (cancelable: preventDefault() and call `confirmAction()`
 *         to replace the browser's confirm dialog), spreewe-error { error }.
 * Slots: header-actions, footer. CSS parts: header, name, description, members, member, role, actions, danger.
 */
export class SpreeWeGroupDetails extends SpreeWeElement {
    static override properties = {
        groupId: { attribute: "group-id", reflect: true },
        readonly: { type: Boolean },
        editing: { state: true },
        adding: { state: true },
        menuFor: { state: true },
        busy: { state: true },
        error: { state: true },
        draftName: { state: true },
        draftDescription: { state: true },
        toAdd: { state: true },
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
            .scroll {
                flex: 1;
                min-height: 0;
            }
            header {
                display: grid;
                justify-items: center;
                gap: var(--_s2);
                padding: var(--_s5) var(--_s4) var(--_s4);
                text-align: center;
                border-bottom: var(--_bw) solid var(--_border);
            }
            .name {
                font-size: var(--_fs-xl);
                font-weight: var(--_fw-bold);
                margin: 0;
                overflow-wrap: anywhere;
            }
            .description {
                color: var(--_text-2);
                white-space: pre-wrap;
                overflow-wrap: anywhere;
                margin: 0;
            }
            .description.empty {
                color: var(--_muted);
                font-style: italic;
            }
            .row-actions {
                display: flex;
                flex-wrap: wrap;
                justify-content: center;
                gap: var(--_s2);
            }
            section {
                padding: var(--_s3) var(--_s4);
                border-bottom: var(--_bw) solid var(--_border);
            }
            h3 {
                margin: 0 0 var(--_s2);
                font-size: var(--_fs);
                font-weight: var(--_fw-bold);
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: var(--_s2);
            }
            ul {
                list-style: none;
                margin: 0;
                padding: 0;
            }
            li {
                position: relative;
                display: flex;
                align-items: center;
                gap: var(--_s3);
                padding: var(--_s2) 0;
            }
            .member {
                flex: 1;
                min-width: 0;
                display: flex;
                align-items: center;
                gap: var(--_s3);
                background: none;
                border: 0;
                color: inherit;
                font: inherit;
                text-align: left;
                cursor: pointer;
                padding: 0;
            }
            .member span {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .role {
                font-size: 11px;
                font-weight: var(--_fw-bold);
                padding: 1px 8px;
                border-radius: var(--_r-pill);
                background: var(--_brand-soft);
                color: var(--_text-2);
                display: inline-flex;
                gap: 4px;
                align-items: center;
            }
            .menu {
                position: absolute;
                right: 0;
                top: calc(100% - 4px);
                z-index: 5;
                display: grid;
                min-width: 190px;
                padding: var(--_s1);
                background: var(--_surface);
                border: var(--_bw) solid var(--_border);
                border-radius: var(--_r);
                box-shadow: var(--_shadow);
            }
            .menu .btn {
                justify-content: flex-start;
                border: 0;
            }
            .menu .danger,
            .danger {
                color: var(--_danger);
            }
            form {
                display: grid;
                gap: var(--_s2);
                width: 100%;
                text-align: left;
            }
            .form-actions {
                display: flex;
                justify-content: flex-end;
                gap: var(--_s2);
            }
            .danger-zone {
                display: grid;
                gap: var(--_s2);
            }
            .danger-zone .btn {
                justify-content: flex-start;
            }
        `,
    ];

    declare groupId: string;
    declare readonly: boolean;
    declare editing: boolean;
    declare adding: boolean;
    declare menuFor: string;
    declare busy: boolean;
    declare error: string;
    declare draftName: string;
    declare draftDescription: string;
    declare toAdd: DirectoryEntry[];

    private service: GroupsService | null = null;
    private details: ReadableStore<DetailsState> | null = null;
    private presence: ReadonlyMap<string, PresenceUpdate> = new Map();
    private me = "";
    private can = { write: false, manage: false, del: false, files: false };
    private pendingConfirm: (() => Promise<void>) | null = null;

    constructor() {
        super();
        this.groupId = "";
        this.readonly = false;
        this.editing = false;
        this.adding = false;
        this.menuFor = "";
        this.busy = false;
        this.error = "";
        this.draftName = "";
        this.draftDescription = "";
        this.toAdd = [];
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.service = client ? getGroups(client) : null;
        if (client) {
            void client.userId().then((id) => ((this.me = id), this.requestUpdate()), () => undefined);
            void Promise.all([client.hasScopes("groups:write"), client.hasScopes("groups:manage"), client.hasScopes("conversations:delete"), client.hasScopes("files:write")]).then(
                ([write, manage, del, files]) => ((this.can = { write, manage, del, files }), this.requestUpdate()),
                () => undefined,
            );
            this.observe(client.people.presence, (p) => (this.presence = p));
        }
        this.bind();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("groupId") && changed.get("groupId") !== undefined) this.bind();
    }

    private bind(): void {
        if (this.details) this.unwatch(this.details);
        this.details = this.service && this.groupId ? this.service.group(this.groupId) : null;
        if (this.details) this.watch(this.details);
        this.editing = this.adding = false;
        this.menuFor = "";
    }

    private async run(action: string, fn: () => Promise<unknown>): Promise<void> {
        this.busy = true;
        this.error = "";
        try {
            await fn();
        } catch (error) {
            this.error = error instanceof Error ? error.message : t("common.error");
            this.fire("spreewe-error", { error, action });
        } finally {
            this.busy = false;
        }
    }

    private confirmThen(message: string, action: string, fn: () => Promise<void>): void {
        this.menuFor = "";
        this.pendingConfirm = fn;
        if (!this.fire("spreewe-confirm-request", { message, action }, { cancelable: true })) return;
        if (confirm(message)) void this.confirmAction();
        else this.pendingConfirm = null;
    }

    /** Run the action a cancelled spreewe-confirm-request was asking about */
    async confirmAction(): Promise<void> {
        const fn = this.pendingConfirm;
        this.pendingConfirm = null;
        if (fn) await fn();
    }

    private async save(e: Event): Promise<void> {
        e.preventDefault();
        await this.run("update", () => this.service!.update(this.groupId, { name: this.draftName, description: this.draftDescription }));
        if (!this.error) this.editing = false;
    }

    private async addSelected(): Promise<void> {
        const ids = this.toAdd.map((u) => u._id);
        await this.run("add-members", () => this.service!.addMembers(this.groupId, ids));
        if (!this.error) {
            this.adding = false;
            this.toAdd = [];
        }
    }

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        const state = this.details?.value;
        if (!state) return html``;
        if (state.gone) return html`<div class="state" role="status">${t(`groups.details.gone.${state.gone}`)}</div>`;
        if (state.loading && !state.group) return html`<div class="state"><span class="spinner"></span></div>`;
        if (state.error && !state.group) {
            return html`<div class="state" role="alert">${state.error.message}<button class="btn" @click=${() => this.service?.loadDetails(this.groupId).catch(() => undefined)}>${t("common.retry")}</button></div>`;
        }
        const g = state.group!;
        const admin = this.service!.isAdmin(g, this.me);
        const ro = this.readonly;
        const members = [...g.members].sort((a, b) => Number(g.admins.includes(String(b._id))) - Number(g.admins.includes(String(a._id))) || (a.username || "").localeCompare(b.username || ""));
        return html`<div class="scroll">
            <header part="header">
                <spreewe-avatar .client=${this.sw} size="72" shape="square" name=${g.name} src=${g.avatar}></spreewe-avatar>
                ${this.editing
                    ? html`<form @submit=${this.save}>
                          <label class="field">${t("groups.create.name")}<input class="input" required maxlength="100" .value=${this.draftName} @input=${(e: Event) => (this.draftName = (e.target as HTMLInputElement).value)} /></label>
                          <label class="field">${t("groups.create.description")}<textarea class="input" rows="3" maxlength="500" .value=${this.draftDescription} @input=${(e: Event) => (this.draftDescription = (e.target as HTMLTextAreaElement).value)}></textarea></label>
                          ${this.can.files
                              ? html`<label class="field">${t("groups.details.changePhoto")}<input type="file" accept="image/jpeg,image/png,image/gif,image/webp"
                                    @change=${(e: Event) => {
                                        const f = (e.target as HTMLInputElement).files?.[0];
                                        if (f) void this.run("photo", () => this.service!.setPhoto(this.groupId, f));
                                    }} /></label>`
                              : nothing}
                          <div class="form-actions">
                              <button type="button" class="btn" @click=${() => (this.editing = false)}>${t("common.cancel")}</button>
                              <button type="submit" class="btn primary" ?disabled=${this.busy || !this.draftName.trim()}>${t("groups.details.save")}</button>
                          </div>
                      </form>`
                    : html`<h2 class="name" part="name">${g.name}</h2>
                          <p class="description ${g.description ? "" : "empty"}" part="description">${g.description || t("groups.details.noDescription")}</p>
                          <div class="row-actions">
                              ${!ro && admin && this.can.write
                                  ? html`<button class="btn" @click=${() => ((this.draftName = g.name), (this.draftDescription = g.description), (this.editing = true))}>${icon("edit", 16)} ${t("groups.details.edit")}</button>`
                                  : nothing}
                              <slot name="header-actions"></slot>
                          </div>`}
            </header>
            ${this.error ? html`<div class="error-banner" role="alert">${icon("alert", 16)} ${this.error}</div>` : nothing}
            <section>
                <h3>${t("groups.details.members", { n: g.members.length })}
                    ${!ro && admin && this.can.manage && !this.adding ? html`<button class="btn" @click=${() => (this.adding = true)}>${icon("user-plus", 16)} ${t("groups.details.addMembers")}</button>` : nothing}
                </h3>
                ${this.adding
                    ? html`<spreewe-member-picker .client=${this.sw} .selected=${this.toAdd} .exclude=${g.members.map((m) => String(m._id))} @spreewe-change=${(e: CustomEvent<{ selected: DirectoryEntry[] }>) => (this.toAdd = e.detail.selected)}></spreewe-member-picker>
                          <div class="form-actions" style="margin-top: var(--_s2)">
                              <button class="btn" @click=${() => ((this.adding = false), (this.toAdd = []))}>${t("common.cancel")}</button>
                              <button class="btn primary" ?disabled=${!this.toAdd.length || this.busy} @click=${this.addSelected}>${t("groups.details.add")}</button>
                          </div>`
                    : nothing}
                <ul part="members">${members.map((m) => this.renderMember(m, g.admins, admin))}</ul>
            </section>
            ${ro
                ? nothing
                : html`<section class="danger-zone" part="danger">
                      ${this.can.manage
                          ? html`<button class="btn ghost danger" ?disabled=${this.busy} @click=${() =>
                                this.confirmThen(t("groups.details.leaveConfirm"), "leave", async () => {
                                    await this.run("leave", () => this.service!.leave(this.groupId));
                                    if (!this.error) this.fire("spreewe-group-left", { groupId: this.groupId });
                                })}>${icon("logout", 16)} ${t("groups.details.leave")}</button>`
                          : nothing}
                      ${admin && this.can.del
                          ? html`<button class="btn ghost danger" ?disabled=${this.busy} @click=${() =>
                                this.confirmThen(t("groups.details.deleteConfirm"), "delete", async () => {
                                    await this.run("delete", () => this.service!.delete(this.groupId));
                                    if (!this.error) this.fire("spreewe-group-deleted", { groupId: this.groupId });
                                })}>${icon("trash", 16)} ${t("groups.details.delete")}</button>`
                          : nothing}
                  </section>`}
            <slot name="footer"></slot>
        </div>`;
    }

    private renderMember(m: UserSummary, admins: string[], iAmAdmin: boolean) {
        const id = String(m._id);
        const isAdmin = admins.includes(id);
        const isMe = id === this.me;
        const presence = presenceKind(this.presence.get(id) ?? { isOnline: !!m.isOnline, status: m.status });
        const actions = !this.readonly && iAmAdmin && this.can.manage && !isMe;
        return html`<li part="member">
            <button class="member" @click=${() => this.fire("spreewe-member-select", { user: m })}>
                <spreewe-avatar .client=${this.sw} size="36" name=${m.username || ""} src=${m.avatar || ""} presence=${presence}></spreewe-avatar>
                <span>${m.username}${isMe ? html` (${t("groups.details.you")})` : nothing}</span>
            </button>
            ${isAdmin ? html`<span class="role" part="role">${icon("crown", 12)} ${t("groups.details.admin")}</span>` : nothing}
            ${actions
                ? html`<button class="icon-btn" part="actions" aria-label=${t("groups.details.memberActions", { name: m.username })} aria-haspopup="menu" aria-expanded=${this.menuFor === id ? "true" : "false"}
                          @click=${() => (this.menuFor = this.menuFor === id ? "" : id)}>${icon("more", 18)}</button>
                      ${this.menuFor === id
                          ? html`<div class="menu" role="menu" @keydown=${(e: KeyboardEvent) => e.key === "Escape" && (this.menuFor = "")}>
                                ${isAdmin
                                    ? html`<button class="btn ghost" role="menuitem" @click=${() => ((this.menuFor = ""), this.run("demote", () => this.service!.demote(this.groupId, id)))}>${t("groups.details.demote")}</button>`
                                    : html`<button class="btn ghost" role="menuitem" @click=${() => ((this.menuFor = ""), this.run("promote", () => this.service!.promote(this.groupId, id)))}>${icon("crown", 16)} ${t("groups.details.promote")}</button>`}
                                <button class="btn ghost danger" role="menuitem" @click=${() =>
                                    this.confirmThen(t("groups.details.removeConfirm", { name: m.username }), "remove-member", () => this.run("remove-member", () => this.service!.removeMember(this.groupId, id)))}>${icon("user-minus", 16)} ${t("groups.details.remove")}</button>
                            </div>`
                          : nothing}`
                : nothing}
        </li>`;
    }
}
