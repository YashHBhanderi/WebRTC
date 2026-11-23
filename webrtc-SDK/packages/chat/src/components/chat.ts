import { css, html } from "lit";
import { SpreeWeElement, baseStyles } from "@spreewe/ui";
import type { ConversationSelectDetail } from "./conversation-list.js";
import "../strings.js";

/**
 * <spreewe-chat> — conversation list and chat window side by side; on narrow containers (below
 * `--sw-chat-split`, default 720px) it shows one at a time with a back button. A convenience layout:
 * use <spreewe-conversation-list> and <spreewe-chat-window> directly for your own layout.
 *
 * Attributes: conversation-id (selected conversation), filter (passed to the list).
 * Events: spreewe-conversation-select (from the list).
 * Slots: list-header, header-actions, empty.
 * CSS parts: list, window. CSS custom property --sw-chat-list-width (default 340px).
 */
export class SpreeWeChat extends SpreeWeElement {
    static override properties = {
        conversationId: { attribute: "conversation-id", reflect: true },
        filter: {},
    };

    static override styles = [
        baseStyles,
        css`
            :host {
                display: block;
                height: 100%;
                min-height: 360px;
                container-type: inline-size;
                container-name: sw-chat;
                border: var(--_bw) solid var(--_border);
                border-radius: var(--sw-chat-radius, var(--_r));
                overflow: hidden;
                background: var(--_surface);
            }
            .layout {
                display: grid;
                grid-template-columns: var(--sw-chat-list-width, 340px) 1fr;
                height: 100%;
                min-height: 0;
            }
            spreewe-conversation-list {
                border-right: var(--_bw) solid var(--_border);
                min-width: 0;
            }
            spreewe-chat-window {
                min-width: 0;
            }
            @container sw-chat (max-width: 720px) {
                .layout {
                    grid-template-columns: 1fr;
                }
                .layout.open spreewe-conversation-list,
                .layout:not(.open) spreewe-chat-window {
                    display: none;
                }
                spreewe-conversation-list {
                    border-right: 0;
                }
            }
        `,
    ];

    declare conversationId: string;
    declare filter: "all" | "direct" | "groups";

    constructor() {
        super();
        this.conversationId = "";
        this.filter = "all";
    }

    protected override render() {
        return html`<div class="layout ${this.conversationId ? "open" : ""}">
            <spreewe-conversation-list part="list" .client=${this.sw} selected=${this.conversationId} filter=${this.filter}
                @spreewe-conversation-select=${(e: CustomEvent<ConversationSelectDetail>) => (this.conversationId = e.detail.conversationId)}>
                <slot name="list-header" slot="header"></slot>
            </spreewe-conversation-list>
            <spreewe-chat-window part="window" .client=${this.sw} conversation-id=${this.conversationId} show-back @spreewe-back=${() => (this.conversationId = "")}>
                <slot name="header-actions" slot="header-actions"></slot>
                <slot name="empty" slot="empty"></slot>
            </spreewe-chat-window>
        </div>`;
    }
}
