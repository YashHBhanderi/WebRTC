import { css, html, nothing, type PropertyValues } from "lit";
import type { E2eeStatus, SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, inputStyles, stateStyles, t } from "@spreewe/ui";
import { UPLOAD_ACCEPT, getChat, validateUpload, type ChatService, type ConversationSession } from "../service.js";
import type { ChatMessage } from "../types.js";
import { EMOJI_SET } from "./shared.js";
import "../strings.js";

const MAX_FILES = 10;

/**
 * <spreewe-message-composer conversation-id="…"> — text input with attachments, emoji, reply and
 * edit modes. Everything is end-to-end encrypted on this device before it's sent; without an
 * encryption device (or the scopes to send) the composer explains why it's disabled.
 *
 * Attributes: conversation-id, placeholder, no-attachments, no-emoji, disabled.
 * Methods: replyTo(message), editMessage(message), focus(), addFiles(files).
 * Events: spreewe-message-sent { conversationId }, spreewe-error { error }.
 * Slots: before-input, after-input (extra buttons). CSS parts: bar, input, send, attach, emoji, notice, context.
 */
export class SpreeWeMessageComposer extends SpreeWeElement {
    static override properties = {
        conversationId: { attribute: "conversation-id", reflect: true },
        placeholder: {},
        noAttachments: { type: Boolean, attribute: "no-attachments" },
        noEmoji: { type: Boolean, attribute: "no-emoji" },
        disabled: { type: Boolean, reflect: true },
        text: { state: true },
        reply: { state: true },
        editing: { state: true },
        emojiOpen: { state: true },
        error: { state: true },
        uploads: { state: true },
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
                border-top: var(--_bw) solid var(--_border);
                padding: var(--_s2) var(--_s3) var(--_s3);
                position: relative;
            }
            .context {
                display: flex;
                align-items: center;
                gap: var(--_s2);
                padding: var(--_s1) var(--_s2);
                margin-bottom: var(--_s2);
                border-left: 3px solid var(--_brand);
                background: var(--_surface-2);
                border-radius: var(--_r-sm);
                font-size: var(--_fs-sm);
            }
            .context .grow {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: var(--_muted);
            }
            .context strong {
                color: var(--_text);
                display: block;
            }
            .bar {
                display: flex;
                align-items: flex-end;
                gap: var(--_s1);
                background: var(--_input);
                border: var(--_bw) solid var(--_border);
                border-radius: var(--_r-lg);
                padding: var(--_s1);
            }
            .bar:focus-within {
                border-color: var(--_brand);
                box-shadow: var(--_focus);
            }
            textarea {
                flex: 1;
                resize: none;
                border: 0;
                background: transparent;
                color: var(--_text);
                font: inherit;
                line-height: var(--_lh);
                padding: 6px var(--_s2);
                max-height: 160px;
                min-height: 24px;
                outline: none;
            }
            textarea::placeholder {
                color: var(--_muted);
            }
            .send {
                width: var(--_control-h);
                height: var(--_control-h);
                border-radius: 50%;
                padding: 0;
            }
            .notice {
                display: flex;
                align-items: center;
                gap: var(--_s2);
                color: var(--_muted);
                font-size: var(--_fs-sm);
                padding: var(--_s2);
            }
            .hint {
                display: flex;
                align-items: center;
                gap: 4px;
                margin-top: var(--_s1);
                font-size: 11px;
                color: var(--_muted);
            }
            .emoji {
                position: absolute;
                bottom: calc(100% - 4px);
                left: var(--_s3);
                z-index: 5;
                display: grid;
                grid-template-columns: repeat(8, 36px);
                gap: 2px;
                padding: var(--_s2);
                background: var(--_surface);
                border: var(--_bw) solid var(--_border);
                border-radius: var(--_r);
                box-shadow: var(--_shadow);
            }
            .emoji button {
                font-size: 20px;
                width: 36px;
                height: 36px;
                border: 0;
                border-radius: var(--_r-sm);
                background: none;
                cursor: pointer;
            }
            .emoji button:hover {
                background: var(--_hover);
            }
            .uploads {
                display: grid;
                gap: 4px;
                margin-bottom: var(--_s2);
                font-size: var(--_fs-sm);
                color: var(--_muted);
            }
            .error-banner {
                margin: 0 0 var(--_s2);
            }
            @media (max-width: 420px) {
                .emoji {
                    grid-template-columns: repeat(6, 36px);
                }
            }
        `,
    ];

    declare conversationId: string;
    declare placeholder: string;
    declare noAttachments: boolean;
    declare noEmoji: boolean;
    declare disabled: boolean;
    declare text: string;
    declare reply: ChatMessage | null;
    declare editing: ChatMessage | null;
    declare emojiOpen: boolean;
    declare error: string;
    declare uploads: { id: number; name: string; pct: number }[];

    private chat: ChatService | null = null;
    private session: ConversationSession | null = null;
    private e2eeStatus: E2eeStatus | "none" = "none";
    private canSend: boolean | null = null;
    private uploadSeq = 0;

    constructor() {
        super();
        this.conversationId = "";
        this.placeholder = "";
        this.noAttachments = false;
        this.noEmoji = false;
        this.disabled = false;
        this.text = "";
        this.reply = null;
        this.editing = null;
        this.emojiOpen = false;
        this.error = "";
        this.uploads = [];
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        this.session?.stopTyping();
        this.session?.release();
        this.session = null;
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.chat = client ? getChat(client) : null;
        this.canSend = null;
        if (client && this.chat) {
            void client.hasScopes("messages:write").then((ok) => {
                this.canSend = ok;
                this.requestUpdate();
            }, () => undefined);
            void this.chat.start().catch(() => undefined).then(() => {
                const e2ee = this.chat?.e2ee;
                if (e2ee) this.observe(e2ee.status, (s) => (this.e2eeStatus = s));
                this.requestUpdate();
            });
        }
        this.openSession();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("conversationId") && changed.get("conversationId") !== undefined) {
            this.openSession();
            this.reply = null;
            this.editing = null;
            this.text = "";
        }
    }

    private openSession(): void {
        this.session?.stopTyping();
        this.session?.release();
        this.session = this.chat && this.conversationId ? this.chat.open(this.conversationId) : null;
    }

    /** Quote a message in the next send */
    replyTo(message: ChatMessage | null): void {
        this.editing = null;
        this.reply = message;
        this.focus();
    }

    /** Edit one of my messages */
    editMessage(message: ChatMessage | null): void {
        this.reply = null;
        this.editing = message;
        this.text = message?.text || "";
        this.focus();
    }

    override focus(): void {
        void this.updateComplete.then(() => this.renderRoot.querySelector("textarea")?.focus());
    }

    private get blocker(): string {
        if (this.disabled) return "";
        if (this.canSend === false) return t("chat.composer.noE2ee");
        const b = this.chat?.sendBlocker();
        return b && b.reason !== "e2ee-starting" ? (b.reason === "no-e2ee" ? t("chat.composer.noE2ee") : b.message) : "";
    }

    private get busy(): boolean {
        return this.e2eeStatus === "starting" || this.e2eeStatus === "idle";
    }

    private onInput(e: Event): void {
        const ta = e.target as HTMLTextAreaElement;
        this.text = ta.value;
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
        if (this.text && !this.editing) this.session?.typingStarted();
        else this.session?.stopTyping();
    }

    private onKey(e: KeyboardEvent): void {
        if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
            e.preventDefault();
            void this.submit();
        } else if (e.key === "Escape") {
            if (this.emojiOpen) this.emojiOpen = false;
            else if (this.editing) this.editMessage(null);
            else if (this.reply) this.reply = null;
        } else if (e.key === "ArrowUp" && !this.text && this.session) {
            // Edit my last message, like most chat apps
            const me = this.chat?.myUserId;
            const last = [...this.session.messages.value.items].reverse().find((m) => m.userId === me && !m.local && !m.isDeleted && m.bodyState === "ok" && !m.attachment);
            if (last) {
                e.preventDefault();
                this.editMessage(last);
            }
        }
    }

    private async submit(): Promise<void> {
        const s = this.session;
        const text = this.text.trim();
        if (!s || !text || this.blocker || this.disabled) return;
        this.error = "";
        const editing = this.editing;
        const reply = this.reply;
        this.text = "";
        this.reply = null;
        this.editing = null;
        const ta = this.renderRoot.querySelector("textarea");
        if (ta) ta.style.height = "auto";
        try {
            if (editing) await s.edit(editing._id, text);
            else await s.send(text, { replyTo: reply?._id || null });
            this.fire("spreewe-message-sent", { conversationId: this.conversationId });
        } catch (error) {
            if (editing) this.text = text;
            this.error = error instanceof Error ? error.message : t("common.error");
            this.fire("spreewe-error", { error, action: editing ? "edit" : "send" });
        }
    }

    /** Send files (one message each; the typed text goes with the first as its caption). */
    async addFiles(files: FileList | File[]): Promise<void> {
        const s = this.session;
        if (!s || this.blocker) return;
        const list = [...files].slice(0, MAX_FILES);
        const problems: string[] = [];
        const valid = list.filter((f) => {
            const v = validateUpload(f);
            if (v) problems.push(t(v.code === "type" ? "chat.composer.fileType" : v.code === "empty" ? "chat.composer.fileEmpty" : "chat.composer.fileSize", { name: f.name, max: v.maxMb ?? "" }));
            return !v;
        });
        this.error = problems.join(" ");
        const caption = this.text.trim();
        if (valid.length && caption) this.text = "";
        await Promise.all(
            valid.map(async (file, i) => {
                const id = ++this.uploadSeq;
                this.uploads = [...this.uploads, { id, name: file.name, pct: 0 }];
                try {
                    await s.sendFile(file, {
                        caption: i === 0 ? caption : "",
                        replyTo: i === 0 ? this.reply?._id || null : null,
                        onProgress: (f) => (this.uploads = this.uploads.map((u) => (u.id === id ? { ...u, pct: Math.round(f * 100) } : u))),
                    });
                    this.fire("spreewe-message-sent", { conversationId: this.conversationId });
                } catch (error) {
                    this.error = error instanceof Error ? error.message : t("common.error");
                    this.fire("spreewe-error", { error, action: "upload" });
                } finally {
                    this.uploads = this.uploads.filter((u) => u.id !== id);
                }
            }),
        );
        this.reply = null;
    }

    private pickFiles(): void {
        const input = this.renderRoot.querySelector<HTMLInputElement>("input[type=file]");
        input?.click();
    }

    private insertEmoji(e: string): void {
        const ta = this.renderRoot.querySelector("textarea");
        if (!ta) return;
        const start = ta.selectionStart ?? this.text.length;
        const end = ta.selectionEnd ?? this.text.length;
        this.text = this.text.slice(0, start) + e + this.text.slice(end);
        this.emojiOpen = false;
        void this.updateComplete.then(() => {
            ta.focus();
            ta.setSelectionRange(start + e.length, start + e.length);
        });
    }

    private onPaste(e: ClipboardEvent): void {
        const files = [...(e.clipboardData?.files || [])];
        if (files.length && !this.noAttachments) {
            e.preventDefault();
            void this.addFiles(files);
        }
    }

    protected override render() {
        if (!this.sw) return html`<div class="notice">${t("common.noClient")}</div>`;
        const blocker = this.blocker;
        if (blocker) return html`<div class="notice" part="notice">${icon("lock", 16)} ${blocker}</div>`;
        const ctx = this.editing || this.reply;
        const members = this.session?.members || [];
        const replyName = this.reply
            ? this.reply.userId === this.chat?.myUserId
                ? t("common.you")
                : members.find((m) => String(m._id) === this.reply!.userId)?.username || this.reply.user?.username || ""
            : "";
        return html`
            ${this.error ? html`<div class="error-banner" role="alert">${icon("alert", 16)} ${this.error}</div>` : nothing}
            ${this.uploads.length
                ? html`<div class="uploads" aria-live="polite">${this.uploads.map((u) => html`<span>${t("chat.composer.uploading", { name: u.name, pct: u.pct })}</span>`)}</div>`
                : nothing}
            ${ctx
                ? html`<div class="context" part="context">
                      ${icon(this.editing ? "edit" : "reply", 16)}
                      <span class="grow"><strong>${this.editing ? t("chat.composer.editing") : t("chat.composer.replyingTo", { name: replyName })}</strong>${ctx.text}</span>
                      <button class="icon-btn" aria-label=${t("chat.composer.cancel")} @click=${() => (this.editing ? this.editMessage(null) : (this.reply = null))}>${icon("x", 16)}</button>
                  </div>`
                : nothing}
            ${this.emojiOpen
                ? html`<div class="emoji" role="menu" aria-label=${t("chat.composer.emoji")}>${EMOJI_SET.map((e) => html`<button role="menuitem" aria-label=${e} @click=${() => this.insertEmoji(e)}>${e}</button>`)}</div>`
                : nothing}
            <div class="bar" part="bar">
                <slot name="before-input"></slot>
                ${this.noAttachments || this.editing
                    ? nothing
                    : html`<button class="icon-btn" part="attach" aria-label=${t("chat.composer.attach")} title=${t("chat.composer.attach")} ?disabled=${this.disabled || this.busy} @click=${this.pickFiles}>${icon("paperclip")}</button>
                          <input type="file" multiple hidden accept=${UPLOAD_ACCEPT} @change=${(e: Event) => {
                              const input = e.target as HTMLInputElement;
                              if (input.files?.length) void this.addFiles(input.files);
                              input.value = "";
                          }} />`}
                ${this.noEmoji
                    ? nothing
                    : html`<button class="icon-btn" part="emoji" aria-label=${t("chat.composer.emoji")} aria-expanded=${this.emojiOpen ? "true" : "false"} ?disabled=${this.disabled} @click=${() => (this.emojiOpen = !this.emojiOpen)}>${icon("smile")}</button>`}
                <textarea part="input" rows="1" .value=${this.text} placeholder=${this.placeholder || t("chat.composer.placeholder")} aria-label=${this.placeholder || t("chat.composer.placeholder")}
                    ?disabled=${this.disabled} @input=${this.onInput} @keydown=${this.onKey} @paste=${this.onPaste} @blur=${() => this.session?.stopTyping()}></textarea>
                <slot name="after-input"></slot>
                <button class="btn primary send" part="send" aria-label=${t("chat.composer.send")} title=${t("chat.composer.send")} ?disabled=${!this.text.trim() || this.disabled || this.busy} @click=${() => this.submit()}>
                    ${this.editing ? icon("check") : icon("send", 18)}
                </button>
            </div>
            <div class="hint">${icon("lock", 11)} ${this.busy ? t("common.loading") : t("chat.composer.encrypted")}</div>
        `;
    }
}
