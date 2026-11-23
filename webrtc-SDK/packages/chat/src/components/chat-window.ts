import { css, html, nothing, type PropertyValues } from "lit";
import type { PresenceUpdate, SpreeWeClient } from "@spreewe/core";
import { SpreeWeElement, baseStyles, buttonStyles, icon, presenceKind, presenceLabel, stateStyles, t } from "@spreewe/ui";
import { getChat, type ChatService, type ConversationSession } from "../service.js";
import type { ConversationSummary } from "../types.js";
import type { SpreeWeMessageComposer } from "./composer.js";
import type { MessageActionDetail } from "./message-list.js";
import "../strings.js";

/**
 * <spreewe-chat-window conversation-id="…"> — one conversation: header, messages and composer.
 *
 * Attributes: conversation-id, show-back (back button for narrow layouts), no-header, readonly.
 * Events: spreewe-back, plus everything from the message list and composer.
 * Slots: header (replaces the default header), header-actions (e.g. <spreewe-call-button>),
 *        empty (shown without a conversation-id), composer-before, composer-after.
 * CSS parts: header, title, subtitle, back, messages, composer.
 */
export class SpreeWeChatWindow extends SpreeWeElement {
    static override properties = {
        conversationId: { attribute: "conversation-id", reflect: true },
        showBack: { type: Boolean, attribute: "show-back", reflect: true },
        noHeader: { type: Boolean, attribute: "no-header" },
        readonly: { type: Boolean, reflect: true },
        dragging: { state: true },
    };

    static override styles = [
        baseStyles,
        buttonStyles,
        stateStyles,
        css`
            :host {
                display: flex;
                flex-direction: column;
                min-height: 0;
                min-width: 0;
                height: 100%;
                background: var(--_chat-bg);
                position: relative;
            }
            header {
                display: flex;
                align-items: center;
                gap: var(--_s3);
                padding: var(--_s2) var(--_s3);
                min-height: 56px;
                background: var(--_surface);
                border-bottom: var(--_bw) solid var(--_border);
            }
            .titles {
                flex: 1;
                min-width: 0;
                display: grid;
            }
            .title {
                font-weight: var(--_fw-bold);
                font-size: var(--_fs-lg);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .subtitle {
                font-size: var(--_fs-sm);
                color: var(--_muted);
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
            }
            .subtitle.typing {
                color: var(--_success);
            }
            .actions {
                display: flex;
                gap: var(--_s1);
                align-items: center;
            }
            spreewe-message-list {
                flex: 1;
            }
            .removed {
                padding: var(--_s3);
                text-align: center;
                color: var(--_muted);
                background: var(--_surface);
                border-top: var(--_bw) solid var(--_border);
            }
            .drop {
                position: absolute;
                inset: 0;
                z-index: 10;
                display: grid;
                place-items: center;
                background: color-mix(in srgb, var(--_surface) 85%, transparent);
                border: 2px dashed var(--_brand);
                border-radius: var(--_r);
                font-weight: var(--_fw-bold);
                pointer-events: none;
            }
            .empty {
                flex: 1;
            }
        `,
    ];

    declare conversationId: string;
    declare showBack: boolean;
    declare noHeader: boolean;
    declare readonly: boolean;
    declare dragging: boolean;

    private chat: ChatService | null = null;
    private session: ConversationSession | null = null;
    private presence: ReadonlyMap<string, PresenceUpdate> = new Map();
    private dragDepth = 0;

    constructor() {
        super();
        this.conversationId = "";
        this.showBack = false;
        this.noHeader = false;
        this.readonly = false;
        this.dragging = false;
        this.addEventListener("spreewe-reply", (e) => this.composer?.replyTo((e as CustomEvent<MessageActionDetail>).detail.message));
        this.addEventListener("spreewe-edit", (e) => this.composer?.editMessage((e as CustomEvent<MessageActionDetail>).detail.message));
    }

    private get composer(): SpreeWeMessageComposer | null {
        return this.renderRoot.querySelector("spreewe-message-composer");
    }

    override disconnectedCallback(): void {
        super.disconnectedCallback();
        this.closeSession();
    }

    protected override clientChanged(client: SpreeWeClient | null): void {
        this.chat = client ? getChat(client) : null;
        if (client && this.chat) {
            this.observe(this.chat.conversations);
            this.observe(client.people.presence, (p) => (this.presence = p));
            if (!this.chat.conversations.value.loaded) void this.chat.loadConversations().catch(() => undefined);
        }
        this.openSession();
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("conversationId") && changed.get("conversationId") !== undefined) this.openSession();
    }

    private openSession(): void {
        this.closeSession();
        if (!this.chat || !this.conversationId) return;
        this.session = this.chat.open(this.conversationId);
        this.watch(this.session.typing);
        this.watch(this.session.removed);
    }

    private closeSession(): void {
        if (!this.session) return;
        this.unwatch(this.session.typing);
        this.unwatch(this.session.removed);
        this.session.release();
        this.session = null;
    }

    private get summary(): ConversationSummary | undefined {
        return this.chat?.findConversation(this.conversationId);
    }

    private subtitle(c: ConversationSummary | undefined): { text: string; typing: boolean } {
        const typing = this.session?.typing.value || [];
        if (typing.length) {
            if (typing.length > 1) return { text: t("chat.window.typing.many"), typing: true };
            const who = c?.members?.find((m) => String(m._id) === typing[0])?.username || c?.peer?.username || t("chat.messages.unknownUser");
            return { text: t("chat.window.typing.one", { name: who }), typing: true };
        }
        if (!c) return { text: "", typing: false };
        if (c.isGroup) return { text: t("chat.window.members", { n: c.members?.length || 0 }), typing: false };
        const p = c.peer ? this.presence.get(String(c.peer._id)) : undefined;
        return { text: p || c.peer?.isOnline !== undefined ? presenceLabel(presenceKind(p ?? { isOnline: !!c.peer?.isOnline, status: c.peer?.status })) : "", typing: false };
    }

    private onDrag(e: DragEvent, kind: "enter" | "leave" | "over" | "drop"): void {
        if (this.readonly || !e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        if (kind === "enter") this.dragDepth++;
        if (kind === "leave") this.dragDepth--;
        if (kind === "drop") {
            this.dragDepth = 0;
            if (e.dataTransfer.files.length) void this.composer?.addFiles(e.dataTransfer.files);
        }
        this.dragging = this.dragDepth > 0;
    }

    protected override render() {
        if (!this.sw) return html`<div class="state">${t("common.noClient")}</div>`;
        if (!this.conversationId) {
            return html`<slot name="empty"><div class="state empty"><strong>${t("chat.window.select")}</strong><span>${t("chat.window.selectText")}</span></div></slot>`;
        }
        const c = this.summary;
        const sub = this.subtitle(c);
        const presence = c && !c.isGroup && c.peer ? presenceKind(this.presence.get(String(c.peer._id)) ?? { isOnline: !!c.peer.isOnline, status: c.peer.status }) : "";
        const removed = !!this.session?.removed.value;
        return html`
            <div style="display:contents"
                @dragenter=${(e: DragEvent) => this.onDrag(e, "enter")}
                @dragleave=${(e: DragEvent) => this.onDrag(e, "leave")}
                @dragover=${(e: DragEvent) => this.onDrag(e, "over")}
                @drop=${(e: DragEvent) => this.onDrag(e, "drop")}>
                ${this.noHeader
                    ? nothing
                    : html`<slot name="header">
                          <header part="header">
                              ${this.showBack
                                  ? html`<button class="icon-btn" part="back" aria-label=${t("chat.window.back")} @click=${() => this.fire("spreewe-back")}>${icon("chevron-left")}</button>`
                                  : nothing}
                              <spreewe-avatar .client=${this.sw} name=${c?.title || ""} src=${c?.avatar || ""} presence=${presence} shape=${c?.isGroup ? "square" : "circle"}></spreewe-avatar>
                              <div class="titles">
                                  <span class="title" part="title">${c?.title || ""}</span>
                                  <span class="subtitle ${sub.typing ? "typing" : ""}" part="subtitle" aria-live="polite">${sub.text}</span>
                              </div>
                              <div class="actions"><slot name="header-actions"></slot></div>
                          </header>
                      </slot>`}
                <spreewe-message-list part="messages" .client=${this.sw} conversation-id=${this.conversationId} ?readonly=${this.readonly || removed}></spreewe-message-list>
                ${removed
                    ? html`<div class="removed" role="status">${t("chat.window.removed")}</div>`
                    : this.readonly
                      ? nothing
                      : html`<spreewe-message-composer part="composer" .client=${this.sw} conversation-id=${this.conversationId}>
                            <slot name="composer-before" slot="before-input"></slot>
                            <slot name="composer-after" slot="after-input"></slot>
                        </spreewe-message-composer>`}
                ${this.dragging ? html`<div class="drop">${icon("paperclip")} ${t("chat.window.dropFiles")}</div>` : nothing}
            </div>
        `;
    }
}
