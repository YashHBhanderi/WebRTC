import { LitElement, css, html, type PropertyValues } from "lit";
import type { SpreeWeClient } from "@spreewe/core";
import { CLIENT_REQUEST_EVENT, type ClientRequestDetail } from "./element.js";
import { applyTheme, type Theme } from "./theme.js";
import { adoptOrphans } from "./orphans.js";


/**
 * <spreewe-provider> gives every SpreeWe component inside it a client and an optional theme. It
 * renders nothing of its own (display: contents), so it never changes your layout.
 *
 *   <spreewe-provider theme="auto">
 *     <spreewe-conversation-list></spreewe-conversation-list>
 *   </spreewe-provider>
 *   provider.client = createClient({ … });
 *
 * Attributes: theme = "light" | "dark" | "auto" (follow the OS) | "inherit" (default: your page's color-scheme).
 * Property: themeTokens (a Theme object, applied as --sw-* custom properties).
 */
export class SpreeWeProvider extends LitElement {
    static override properties = {
        client: { attribute: false },
        theme: { reflect: true },
        themeTokens: { attribute: false },
    };
    static override styles = css`
        :host {
            display: contents;
        }
        :host([theme="light"]) {
            color-scheme: light;
        }
        :host([theme="dark"]) {
            color-scheme: dark;
        }
        :host([theme="auto"]) {
            color-scheme: light dark;
        }
    `;

    declare client: SpreeWeClient | null;
    declare theme: "light" | "dark" | "auto" | "inherit";
    declare themeTokens: Theme | null;

    private readonly listeners = new Set<(c: SpreeWeClient | null) => void>();
    private removeTheme: (() => void) | null = null;

    constructor() {
        super();
        this.client = null;
        this.theme = "inherit";
        this.themeTokens = null;
        this.addEventListener(CLIENT_REQUEST_EVENT, (e: Event) => {
            const detail = (e as CustomEvent<ClientRequestDetail>).detail;
            if (!detail || detail.answered) return;
            e.stopPropagation();
            detail.answered = true;
            detail.subscribe = (listener) => {
                this.listeners.add(listener);
                listener(this.client);
                return () => this.listeners.delete(listener);
            };
        });
    }

    override connectedCallback(): void {
        super.connectedCallback();
        // Components inside that connected before this element was upgraded
        adoptOrphans(this);
    }

    protected override updated(changed: PropertyValues): void {
        if (changed.has("client")) for (const l of [...this.listeners]) l(this.client);
        if (changed.has("themeTokens")) {
            this.removeTheme?.();
            this.removeTheme = this.themeTokens ? applyTheme(this, this.themeTokens) : null;
        }
    }

    protected override render() {
        return html`<slot></slot>`;
    }
}
