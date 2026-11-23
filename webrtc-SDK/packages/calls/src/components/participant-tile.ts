import { css, html, nothing, type PropertyValues } from "lit";
import { SpreeWeElement, baseStyles, icon, t } from "@spreewe/ui";
import "../strings.js";

/**
 * <spreewe-participant-tile> — one video tile: video when there is one, otherwise the avatar.
 * Properties: stream (MediaStream), name, avatar, muted (show muted icon), mirror (local camera),
 * speaking (0..1 level), hand, reaction, screen (contain instead of cover).
 * Video is always element-muted; play audio with separate <audio> elements (the call view does).
 * CSS parts: video, avatar, label, badge.
 */
export class SpreeWeParticipantTile extends SpreeWeElement {
    static override properties = {
        stream: { attribute: false },
        name: {},
        avatar: {},
        muted: { type: Boolean, reflect: true },
        mirror: { type: Boolean, reflect: true },
        speaking: { type: Number },
        hand: { type: Boolean, reflect: true },
        reaction: {},
        screen: { type: Boolean, reflect: true },
    };

    static override styles = [
        baseStyles,
        css`
            :host {
                position: relative;
                display: block;
                overflow: hidden;
                border-radius: var(--_r);
                background: var(--_call-tile);
                color: var(--_call-text);
                aspect-ratio: 16 / 9;
                min-height: 0;
                min-width: 0;
                box-shadow: inset 0 0 0 2px transparent;
                transition: box-shadow var(--_t);
            }
            :host([data-speaking]) {
                box-shadow: inset 0 0 0 3px var(--sw-call-speaking, #4cb987);
            }
            video {
                width: 100%;
                height: 100%;
                object-fit: cover;
                display: block;
                background: #000;
            }
            :host([screen]) video {
                object-fit: contain;
            }
            :host([mirror]) video {
                transform: scaleX(-1);
            }
            .placeholder {
                position: absolute;
                inset: 0;
                display: grid;
                place-items: center;
            }
            .label {
                position: absolute;
                left: var(--_s2);
                bottom: var(--_s2);
                display: inline-flex;
                align-items: center;
                gap: 4px;
                max-width: calc(100% - 2 * var(--_s2));
                padding: 2px var(--_s2);
                border-radius: var(--_r-sm);
                background: rgba(0, 0, 0, 0.55);
                font-size: var(--_fs-sm);
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .badges {
                position: absolute;
                top: var(--_s2);
                right: var(--_s2);
                display: flex;
                gap: 4px;
            }
            .badge {
                display: grid;
                place-items: center;
                min-width: 28px;
                height: 28px;
                padding: 0 4px;
                border-radius: var(--_r-pill);
                background: rgba(0, 0, 0, 0.55);
                font-size: 16px;
            }
            .reaction {
                position: absolute;
                left: 50%;
                bottom: 20%;
                transform: translateX(-50%);
                font-size: 42px;
                animation: rise 4s ease-out forwards;
                pointer-events: none;
            }
            @keyframes rise {
                0% {
                    opacity: 0;
                    transform: translate(-50%, 20px);
                }
                15% {
                    opacity: 1;
                    transform: translate(-50%, 0);
                }
                80% {
                    opacity: 1;
                }
                100% {
                    opacity: 0;
                    transform: translate(-50%, -30px);
                }
            }
            @media (prefers-reduced-motion: reduce) {
                .reaction {
                    animation: none;
                }
            }
        `,
    ];

    declare stream: MediaStream | null;
    declare name: string;
    declare avatar: string;
    declare muted: boolean;
    declare mirror: boolean;
    declare speaking: number;
    declare hand: boolean;
    declare reaction: string;
    declare screen: boolean;

    constructor() {
        super();
        this.stream = null;
        this.name = "";
        this.avatar = "";
        this.muted = false;
        this.mirror = false;
        this.speaking = 0;
        this.hand = false;
        this.reaction = "";
        this.screen = false;
    }

    private get hasVideo(): boolean {
        return !!this.stream?.getVideoTracks().some((t) => t.readyState !== "ended");
    }

    protected override updated(changed: PropertyValues): void {
        const video = this.renderRoot.querySelector("video");
        if (video && video.srcObject !== this.stream) {
            video.srcObject = this.stream;
            void video.play().catch(() => undefined);
        }
        if (changed.has("speaking")) this.toggleAttribute("data-speaking", this.speaking > 0.15);
    }

    protected override render() {
        const label = this.name || t("calls.someone");
        return html`
            ${this.hasVideo
                ? html`<video part="video" autoplay playsinline muted></video>`
                : html`<div class="placeholder"><spreewe-avatar part="avatar" .client=${this.sw} size="72" name=${label} src=${this.avatar || ""}></spreewe-avatar></div>`}
            <span class="label" part="label">${this.muted ? html`${icon("mic-off", 14)}<span class="sr-only">${t("calls.tile.muted")}</span>` : nothing}${label}</span>
            <span class="badges">${this.hand ? html`<span class="badge" part="badge" title=${t("calls.controls.hand")}>✋</span>` : nothing}</span>
            ${this.reaction ? html`<span class="reaction" aria-hidden="true">${this.reaction}</span>` : nothing}
        `;
    }
}
