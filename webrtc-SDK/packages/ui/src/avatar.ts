import { css, html, nothing, type PropertyValues } from "lit";
import { SpreeWeElement } from "./element.js";
import { hueFor, initials, presenceLabel, type PresenceKind } from "./format.js";
import { baseStyles } from "./tokens.js";

/**
 * <spreewe-avatar name="Ana Diaz" src="…" presence="online" size="40">
 * Picture with an initials fallback. `src` may be a storage key (resolved through the client) or a URL.
 * CSS parts: image, initials, presence.
 */
export class SpreeWeAvatar extends SpreeWeElement {
    static override properties = {
        name: {},
        src: {},
        size: { type: Number },
        presence: {},
        shape: { reflect: true },
        failed: { state: true },
    };
    static override styles = [
        baseStyles,
        css`
            :host {
                --_size: var(--sw-avatar-size-override, var(--_avatar));
                display: inline-block;
                position: relative;
                width: var(--_size);
                height: var(--_size);
                flex: none;
                vertical-align: middle;
            }
            .face {
                width: 100%;
                height: 100%;
                border-radius: var(--sw-avatar-radius, 50%);
                overflow: hidden;
                display: grid;
                place-items: center;
                font-weight: var(--_fw-bold);
                font-size: calc(var(--_size) * 0.38);
                letter-spacing: 0.02em;
                user-select: none;
            }
            :host([shape="square"]) .face {
                border-radius: var(--_r);
            }
            img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
            }
            .dot {
                position: absolute;
                right: -1px;
                bottom: -1px;
                width: max(9px, calc(var(--_size) * 0.28));
                height: max(9px, calc(var(--_size) * 0.28));
                border-radius: 50%;
                border: 2px solid var(--sw-avatar-ring, var(--_surface));
                background: var(--_p-offline);
            }
            .dot.online {
                background: var(--_p-online);
            }
            .dot.busy {
                background: var(--_p-busy);
            }
            .dot.away {
                background: var(--_p-away);
            }
        `,
    ];

    declare name: string;
    declare src: string;
    declare size: number | undefined;
    declare presence: PresenceKind | "" | undefined;
    declare shape: "circle" | "square";
    declare failed: boolean;

    constructor() {
        super();
        this.name = "";
        this.src = "";
        this.shape = "circle";
        this.failed = false;
    }

    protected override clientChanged(): void {
        // Storage keys resolve once /config has loaded
        if (this.sw) this.observe(this.sw.config);
    }

    protected override willUpdate(changed: PropertyValues): void {
        super.willUpdate(changed);
        if (changed.has("src")) this.failed = false;
        if (changed.has("size")) {
            if (this.size) this.style.setProperty("--sw-avatar-size-override", `${this.size}px`);
            else this.style.removeProperty("--sw-avatar-size-override");
        }
    }

    protected override render() {
        const url = this.src && !this.failed ? (this.sw ? this.sw.mediaUrl(this.src) : /^(https?:|data:|blob:)/.test(this.src) ? this.src : "") : "";
        const hue = hueFor(this.name || "?");
        return html`
            <div class="face" part="face" role="img" aria-label=${this.name || "?"}
                style=${url ? "" : `background: hsl(${hue} 30% 86% / 1); color: hsl(${hue} 35% 28%);`}>
                ${url
                    ? html`<img part="image" src=${url} alt="" loading="lazy" referrerpolicy="no-referrer" @error=${() => (this.failed = true)} />`
                    : html`<span part="initials">${initials(this.name)}</span>`}
            </div>
            ${this.presence ? html`<span class="dot ${this.presence}" part="presence" title=${presenceLabel(this.presence)}></span>` : nothing}
        `;
    }
}
