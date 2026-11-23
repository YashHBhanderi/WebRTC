import { css, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import type { SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, inputStyles, stateStyles, t } from "@spreewe/ui";
import { AVATAR_TYPES, BIO_MAX, USERNAME_MAX, getContacts, validateAvatar, validateUsername, type ContactsService } from "../service.js";
import type { MyProfile, ProfileUpdate } from "../types.js";
import { errorBanner, errorState, spinner } from "./shared.js";
import "../strings.js";

export interface ProfileSavedDetail {
    user: MyProfile;
}

/**
 * <spreewe-profile-editor> — edit the signed-in user's name, bio and picture (PATCH /web/user/profile)
 * and, in the personal context, whether others can find them by e-mail.
 *
 * Scopes: profile:read (load), profile:write (save).
 * Attributes: no-picture, no-discoverable.
 * Events: spreewe-profile-saved { user }, spreewe-cancel.
 * Slots: header (replaces the heading), actions (extra buttons next to Save).
 * CSS parts: form, heading, avatar, picture, input, bio, discoverable, save, cancel, error.
 */
export class SpreeWeProfileEditor extends SpreeWeElement {
    static override properties = {
        noPicture: { type: Boolean, attribute: "no-picture" },
        noDiscoverable: { type: Boolean, attribute: "no-discoverable" },
        profile: { state: true },
        username: { state: true },
        bio: { state: true },
        discoverable: { state: true },
        file: { state: true },
        preview: { state: true },
        personal: { state: true },
        loading: { state: true },
        loadError: { state: true },
        saving: { state: true },
        error: { state: true },
        fieldErrors: { state: true },
        notice: { state: true },
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
                color: var(--_text);
            }
            form {
                display: grid;
                gap: var(--_s4);
                padding: var(--_s4);
            }
            h2 {
                margin: 0;
                font-size: var(--_fs-lg);
                font-weight: var(--_fw-bold);
            }
            .picture {
                display: flex;
                flex-wrap: wrap;
                align-items: center;
                gap: var(--_s3);
            }
            .picture img {
                width: 72px;
                height: 72px;
                border-radius: 50%;
                object-fit: cover;
            }
            .file-input {
                position: absolute;
                width: 1px;
                height: 1px;
                opacity: 0;
            }
            .picture-actions {
                display: flex;
                flex-wrap: wrap;
                gap: var(--_s2);
            }
            label.btn:focus-within {
                box-shadow: var(--_focus);
            }
            textarea.input {
                min-height: 72px;
                resize: vertical;
            }
            .count {
                justify-self: end;
                font-size: var(--_fs-sm);
                color: var(--_muted);
                font-weight: normal;
            }
            .field-error {
                font-size: var(--_fs-sm);
                color: var(--_danger);
                font-weight: normal;
            }
            .input[aria-invalid="true"] {
                border-color: var(--_danger);
            }
            .check {
                display: flex;
                align-items: center;
                gap: var(--_s2);
            }
            .check input {
                width: 16px;
                height: 16px;
                margin: 0;
            }
            .actions {
                display: flex;
                flex-wrap: wrap;
                gap: var(--_s2);
            }
            .note {
                margin: 0;
                font-size: var(--_fs-sm);
                color: var(--_muted);
            }
            .error-banner {
                margin: 0;
            }
        `,
    ];

    declare noPicture: boolean;
    declare noDiscoverable: boolean;
    declare profile: MyProfile | null;
    declare username: string;
    declare bio: string;
    declare discoverable: boolean;
    declare file: File | null;
    declare preview: string;
    declare personal: boolean;
    declare loading: boolean;
    declare loadError: unknown;
    declare saving: boolean;
    declare error: unknown;
    declare fieldErrors: Partial<Record<"username" | "bio" | "picture", string>>;
    declare notice: string;

    private contacts: ContactsService | null = null;

    constructor() {
        super();
        this.noPicture = false;
        this.noDiscoverable = false;
        this.profile = null;
        this.username = "";
        this.bio = "";
        this.discoverable = true;
        this.file = null;
        this.preview = "";
        this.personal = false;
        this.loading = false;
        this.loadError = null;
        this.saving = false;
        this.error = null;
        this.fieldErrors = {};
        this.notice = "";
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.contacts = client ? getContacts(client) : null;
        if (!client) return;
        void client.loadMe().then((me) => (this.personal = !me.context?.tenantId), () => (this.personal = false));
        void this.load();
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        this.setFile(null);
    }

    /** Reload my profile and discard unsaved changes */
    async load(): Promise<void> {
        if (!this.contacts) return;
        this.loading = true;
        this.loadError = null;
        try {
            this.fill(await this.contacts.loadMyProfile({ refresh: true }));
        } catch (e) {
            this.loadError = e;
        } finally {
            this.loading = false;
        }
    }

    private fill(p: MyProfile): void {
        this.profile = p;
        this.username = p.username || "";
        this.bio = p.bio || "";
        this.discoverable = p.globalDiscoverable !== false;
        this.setFile(null);
        this.fieldErrors = {};
    }

    private setFile(file: File | null): void {
        if (this.preview) URL.revokeObjectURL(this.preview);
        this.file = file;
        this.preview = file && typeof URL.createObjectURL === "function" ? URL.createObjectURL(file) : "";
    }

    private onPick(e: Event): void {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0] || null;
        input.value = "";
        if (!file) return;
        const problem = validateAvatar(file);
        this.fieldErrors = { ...this.fieldErrors, picture: problem || undefined };
        if (!problem) this.setFile(file);
    }

    private changes(): ProfileUpdate {
        const p = this.profile;
        const update: ProfileUpdate = {};
        const name = this.username.replace(/\s+/g, " ").trim();
        if (name !== (p?.username || "")) update.username = name;
        if (this.bio.trim() !== (p?.bio || "").trim()) update.bio = this.bio.trim();
        if (this.file) update.image = this.file;
        if (this.personal && !this.noDiscoverable && this.discoverable !== (p?.globalDiscoverable !== false)) update.globalDiscoverable = this.discoverable;
        return update;
    }

    private async submit(e: Event): Promise<void> {
        e.preventDefault();
        if (!this.contacts || this.saving) return;
        this.error = null;
        this.notice = "";
        const update = this.changes();
        const errors: typeof this.fieldErrors = {};
        if (update.username !== undefined) errors.username = validateUsername(update.username) || undefined;
        if (update.bio !== undefined && update.bio.length > BIO_MAX) errors.bio = `Bio is too long (max ${BIO_MAX} characters)`;
        if (this.fieldErrors.picture) errors.picture = this.fieldErrors.picture;
        this.fieldErrors = errors;
        if (Object.values(errors).some(Boolean)) {
            await this.updateComplete;
            this.renderRoot.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
            return;
        }
        if (!Object.keys(update).length) {
            this.notice = t("contacts.editor.nothing");
            return;
        }
        this.saving = true;
        try {
            const user = await this.contacts.updateProfile(update);
            this.fill(user);
            this.notice = t("contacts.editor.saved");
            this.fire<ProfileSavedDetail>("spreewe-profile-saved", { user });
        } catch (err) {
            this.error = err;
        } finally {
            this.saving = false;
        }
    }

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        if (!this.profile) {
            if (this.loadError) return errorState(this.loadError, () => void this.load(), "profile:read");
            return html`<div class="state">${spinner()}</div>`;
        }
        const fe = this.fieldErrors;
        return html`<form part="form" novalidate @submit=${this.submit} aria-busy=${this.saving ? "true" : "false"}>
            <slot name="header"><h2 part="heading">${t("contacts.editor.title")}</h2></slot>
            ${this.noPicture
                ? nothing
                : html`<div class="picture" part="picture" role="group" aria-label=${t("contacts.editor.picture")}>
                      ${this.preview
                          ? html`<img src=${this.preview} alt=${t("contacts.editor.picture")} />`
                          : html`<spreewe-avatar part="avatar" .client=${this.sw} name=${this.username || this.profile.username} src=${this.profile.avatar || ""} size="72"></spreewe-avatar>`}
                      <div class="picture-actions">
                          <label class="btn">
                              ${icon("image", 16)} ${t("contacts.editor.choose")}
                              <input class="file-input" type="file" accept=${AVATAR_TYPES.join(",")} ?disabled=${this.saving} @change=${this.onPick} />
                          </label>
                          ${this.file ? html`<button class="btn ghost" type="button" @click=${() => this.setFile(null)}>${t("contacts.editor.undoPicture")}</button>` : nothing}
                      </div>
                      ${fe.picture ? html`<span class="field-error" role="alert">${fe.picture}</span>` : nothing}
                  </div>`}
            <label class="field">
                <span>${t("contacts.editor.username")}</span>
                <input class="input" part="input" autocomplete="name" maxlength=${USERNAME_MAX} required .value=${live(this.username)}
                    aria-invalid=${fe.username ? "true" : "false"} @input=${(e: Event) => (this.username = (e.target as HTMLInputElement).value)} />
                ${fe.username ? html`<span class="field-error">${fe.username}</span>` : nothing}
            </label>
            <label class="field">
                <span>${t("contacts.editor.bio")}</span>
                <textarea class="input" part="bio" maxlength=${BIO_MAX} .value=${live(this.bio)} aria-invalid=${fe.bio ? "true" : "false"}
                    @input=${(e: Event) => (this.bio = (e.target as HTMLTextAreaElement).value)}></textarea>
                <span class="count" aria-live="polite">${t("contacts.editor.bioCount", { n: this.bio.length, max: BIO_MAX })}</span>
                ${fe.bio ? html`<span class="field-error">${fe.bio}</span>` : nothing}
            </label>
            ${this.personal && !this.noDiscoverable
                ? html`<label class="check" part="discoverable">
                      <input type="checkbox" .checked=${live(this.discoverable)} @change=${(e: Event) => (this.discoverable = (e.target as HTMLInputElement).checked)} />
                      <span>${t("contacts.editor.discoverable")}</span>
                  </label>`
                : nothing}
            ${this.error ? errorBanner(this.error, "profile:write") : nothing}
            ${this.notice ? html`<p class="note" role="status">${this.notice}</p>` : nothing}
            <div class="actions">
                <button class="btn primary" part="save" type="submit" ?disabled=${this.saving}>${this.saving ? t("contacts.editor.saving") : t("contacts.editor.save")}</button>
                <button class="btn" part="cancel" type="button" @click=${() => (this.profile && this.fill(this.profile), this.fire("spreewe-cancel"))}>${t("common.cancel")}</button>
                <slot name="actions"></slot>
            </div>
        </form>`;
    }
}
