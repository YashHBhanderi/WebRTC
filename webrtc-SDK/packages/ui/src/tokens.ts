import { css, unsafeCSS } from "lit";

/**
 * Design tokens. Every visual value a component uses comes from a public `--sw-*` custom property
 * with a SpreeWe default. Custom properties inherit through shadow DOM, so set them on any
 * ancestor (`:root`, `body`, `spreewe-provider`, a wrapper div) to restyle every component inside.
 *
 * Light / dark: defaults use CSS `light-dark()`, so they follow the `color-scheme` of the
 * surrounding page (set `color-scheme: dark` on your root, or `theme="dark"` on <spreewe-provider>).
 * Your own overrides can use light-dark() too.
 */
export const TOKENS = {
    // brand & accents
    "--sw-color-brand": "light-dark(#2c3a47, #a9bcc8)",
    "--sw-color-brand-strong": "light-dark(#19222b, #c3d1d9)",
    "--sw-color-brand-soft": "light-dark(#e4eaed, #26323d)",
    "--sw-color-on-brand": "light-dark(#ffffff, #121920)",
    "--sw-color-accent": "light-dark(#3f7fb4, #82b4dc)",
    // surfaces
    "--sw-color-bg": "light-dark(#f0f3f5, #10161c)",
    "--sw-color-surface": "light-dark(#ffffff, #171f27)",
    "--sw-color-surface-2": "light-dark(#f7f9fa, #1c252e)",
    "--sw-color-input": "light-dark(#f0f3f5, #212b35)",
    "--sw-color-hover": "light-dark(#f0f3f5, #222c36)",
    "--sw-color-active": "light-dark(#e6ecef, #283541)",
    "--sw-color-border": "light-dark(#dde4e8, #2a3540)",
    "--sw-color-overlay": "light-dark(rgba(18, 25, 32, 0.45), rgba(0, 0, 0, 0.6))",
    // text
    "--sw-color-text": "light-dark(#19222b, #e6ecef)",
    "--sw-color-text-2": "light-dark(#3c4e5e, #c7d2d8)",
    "--sw-color-muted": "light-dark(#667c8f, #8a9dac)",
    // status
    "--sw-color-success": "light-dark(#107c41, #4cb987)",
    "--sw-color-danger": "light-dark(#ba1a1a, #e86666)",
    "--sw-color-warning": "light-dark(#c4831f, #e0a03e)",
    "--sw-color-read": "light-dark(#3f7fb4, #7db3dc)",
    "--sw-color-highlight": "light-dark(#f6e3a1, #5e5224)",
    "--sw-color-presence-online": "light-dark(#107c41, #4cb987)",
    "--sw-color-presence-busy": "light-dark(#ba1a1a, #e86666)",
    "--sw-color-presence-away": "light-dark(#c4831f, #e0a03e)",
    "--sw-color-presence-offline": "light-dark(#a9b8c3, #4f6477)",
    // chat
    "--sw-chat-bg": "light-dark(#f8fafb, #131a21)",
    "--sw-bubble-in": "light-dark(#ffffff, #1f2933)",
    "--sw-bubble-in-text": "light-dark(#19222b, #e6ecef)",
    "--sw-bubble-in-border": "light-dark(#c7d2d8, #2a3540)",
    "--sw-bubble-out": "light-dark(#2c3a47, #34495c)",
    "--sw-bubble-out-text": "light-dark(#ffffff, #f0f3f5)",
    "--sw-bubble-out-border": "light-dark(#1e2933, #3c5266)",
    // calls (dark in both schemes, like most calling stages)
    "--sw-call-bg": "#121920",
    "--sw-call-surface": "#19222b",
    "--sw-call-tile": "#212c36",
    "--sw-call-control": "#344452",
    "--sw-call-control-hover": "#3c4e5e",
    "--sw-call-text": "#eef2f4",
    "--sw-call-muted": "#a9b8c3",
    "--sw-call-danger": "#d93636",
    // typography: inherits your app's font by default
    "--sw-font-family": "inherit",
    "--sw-font-size": "14px",
    "--sw-font-size-sm": "12px",
    "--sw-font-size-lg": "16px",
    "--sw-font-size-xl": "20px",
    "--sw-font-weight-medium": "500",
    "--sw-font-weight-bold": "600",
    "--sw-line-height": "1.45",
    // shape & spacing
    "--sw-radius-sm": "6px",
    "--sw-radius": "10px",
    "--sw-radius-lg": "14px",
    "--sw-radius-pill": "999px",
    "--sw-bubble-radius": "14px",
    "--sw-border-width": "1px",
    "--sw-space-1": "4px",
    "--sw-space-2": "8px",
    "--sw-space-3": "12px",
    "--sw-space-4": "16px",
    "--sw-space-5": "24px",
    "--sw-space-6": "32px",
    "--sw-avatar-size": "36px",
    "--sw-control-height": "36px",
    "--sw-shadow-sm": "0 1px 3px rgba(25, 34, 43, 0.08)",
    "--sw-shadow": "0 8px 28px rgba(25, 34, 43, 0.14)",
    "--sw-focus-ring": "0 0 0 3px light-dark(rgba(44, 58, 71, 0.25), rgba(169, 188, 200, 0.35))",
    "--sw-transition": "120ms ease",
} as const;

export type TokenName = keyof typeof TOKENS;

/** `var(--sw-x, <default>)` for use in component styles. */
export function token(name: TokenName): ReturnType<typeof unsafeCSS> {
    return unsafeCSS(`var(${name}, ${TOKENS[name]})`);
}

/**
 * Private aliases resolved once per component host, so component CSS stays short:
 * `var(--_surface)` instead of `var(--sw-color-surface, light-dark(...))`.
 */
const ALIASES: Record<string, TokenName> = {
    "--_brand": "--sw-color-brand",
    "--_brand-strong": "--sw-color-brand-strong",
    "--_brand-soft": "--sw-color-brand-soft",
    "--_on-brand": "--sw-color-on-brand",
    "--_accent": "--sw-color-accent",
    "--_bg": "--sw-color-bg",
    "--_surface": "--sw-color-surface",
    "--_surface-2": "--sw-color-surface-2",
    "--_input": "--sw-color-input",
    "--_hover": "--sw-color-hover",
    "--_active": "--sw-color-active",
    "--_border": "--sw-color-border",
    "--_overlay": "--sw-color-overlay",
    "--_text": "--sw-color-text",
    "--_text-2": "--sw-color-text-2",
    "--_muted": "--sw-color-muted",
    "--_success": "--sw-color-success",
    "--_danger": "--sw-color-danger",
    "--_warning": "--sw-color-warning",
    "--_read": "--sw-color-read",
    "--_highlight": "--sw-color-highlight",
    "--_p-online": "--sw-color-presence-online",
    "--_p-busy": "--sw-color-presence-busy",
    "--_p-away": "--sw-color-presence-away",
    "--_p-offline": "--sw-color-presence-offline",
    "--_chat-bg": "--sw-chat-bg",
    "--_bubble-in": "--sw-bubble-in",
    "--_bubble-in-text": "--sw-bubble-in-text",
    "--_bubble-in-border": "--sw-bubble-in-border",
    "--_bubble-out": "--sw-bubble-out",
    "--_bubble-out-text": "--sw-bubble-out-text",
    "--_bubble-out-border": "--sw-bubble-out-border",
    "--_call-bg": "--sw-call-bg",
    "--_call-surface": "--sw-call-surface",
    "--_call-tile": "--sw-call-tile",
    "--_call-control": "--sw-call-control",
    "--_call-control-hover": "--sw-call-control-hover",
    "--_call-text": "--sw-call-text",
    "--_call-muted": "--sw-call-muted",
    "--_call-danger": "--sw-call-danger",
    "--_font": "--sw-font-family",
    "--_fs": "--sw-font-size",
    "--_fs-sm": "--sw-font-size-sm",
    "--_fs-lg": "--sw-font-size-lg",
    "--_fs-xl": "--sw-font-size-xl",
    "--_fw-medium": "--sw-font-weight-medium",
    "--_fw-bold": "--sw-font-weight-bold",
    "--_lh": "--sw-line-height",
    "--_r-sm": "--sw-radius-sm",
    "--_r": "--sw-radius",
    "--_r-lg": "--sw-radius-lg",
    "--_r-pill": "--sw-radius-pill",
    "--_r-bubble": "--sw-bubble-radius",
    "--_bw": "--sw-border-width",
    "--_s1": "--sw-space-1",
    "--_s2": "--sw-space-2",
    "--_s3": "--sw-space-3",
    "--_s4": "--sw-space-4",
    "--_s5": "--sw-space-5",
    "--_s6": "--sw-space-6",
    "--_avatar": "--sw-avatar-size",
    "--_control-h": "--sw-control-height",
    "--_shadow-sm": "--sw-shadow-sm",
    "--_shadow": "--sw-shadow",
    "--_focus": "--sw-focus-ring",
    "--_t": "--sw-transition",
};

export const tokenAliases = unsafeCSS(
    `:host {\n${Object.entries(ALIASES)
        .map(([alias, name]) => `  ${alias}: var(${name}, ${TOKENS[name]});`)
        .join("\n")}\n}`,
);

/** Base host styles every component starts from. */
export const baseStyles = css`
    ${tokenAliases}
    :host {
        box-sizing: border-box;
        font-family: var(--_font);
        font-size: var(--_fs);
        line-height: var(--_lh);
        color: var(--_text);
        -webkit-font-smoothing: antialiased;
    }
    :host([hidden]) {
        display: none !important;
    }
    *,
    *::before,
    *::after {
        box-sizing: inherit;
    }
    [hidden] {
        display: none !important;
    }
    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }
    :focus-visible {
        outline: none;
        box-shadow: var(--_focus);
    }
`;

/** Buttons: `.btn`, `.btn.primary`, `.btn.danger`, `.btn.ghost`, `.icon-btn` */
export const buttonStyles = css`
    .btn,
    .icon-btn {
        font: inherit;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--_s2);
        border: var(--_bw) solid var(--_border);
        background: var(--_surface);
        color: var(--_text);
        border-radius: var(--_r-sm);
        cursor: pointer;
        transition: background var(--_t), border-color var(--_t), color var(--_t);
        -webkit-tap-highlight-color: transparent;
    }
    .btn {
        min-height: var(--_control-h);
        padding: 0 var(--_s3);
        font-weight: var(--_fw-medium);
        white-space: nowrap;
    }
    .btn:hover:not(:disabled),
    .icon-btn:hover:not(:disabled) {
        background: var(--_hover);
    }
    .btn.primary {
        background: var(--_brand);
        border-color: var(--_brand);
        color: var(--_on-brand);
    }
    .btn.primary:hover:not(:disabled) {
        background: var(--_brand-strong);
    }
    .btn.danger {
        background: var(--_danger);
        border-color: var(--_danger);
        color: #fff;
    }
    .btn.ghost,
    .icon-btn {
        background: transparent;
        border-color: transparent;
    }
    .icon-btn {
        width: var(--_control-h);
        height: var(--_control-h);
        padding: 0;
        color: var(--_muted);
        border-radius: var(--_r-pill);
        flex: none;
    }
    .icon-btn:hover:not(:disabled) {
        color: var(--_text);
    }
    .btn:disabled,
    .icon-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }
`;

export const inputStyles = css`
    .input {
        font: inherit;
        width: 100%;
        min-height: var(--_control-h);
        padding: var(--_s2) var(--_s3);
        border: var(--_bw) solid var(--_border);
        border-radius: var(--_r-sm);
        background: var(--_input);
        color: var(--_text);
        transition: border-color var(--_t), box-shadow var(--_t);
    }
    .input::placeholder {
        color: var(--_muted);
    }
    .input:focus {
        outline: none;
        border-color: var(--_brand);
        box-shadow: var(--_focus);
    }
    label.field {
        display: grid;
        gap: var(--_s1);
        font-size: var(--_fs-sm);
        color: var(--_text-2);
        font-weight: var(--_fw-medium);
    }
`;

export const scrollStyles = css`
    .scroll {
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        scrollbar-color: var(--_border) transparent;
    }
`;

/** Shared states: `.state` (empty / loading / error), `.error-banner`, `.spinner` */
export const stateStyles = css`
    .state {
        display: grid;
        place-items: center;
        align-content: center;
        gap: var(--_s2);
        padding: var(--_s5) var(--_s4);
        text-align: center;
        color: var(--_muted);
        min-height: 120px;
    }
    .state strong {
        color: var(--_text);
        font-weight: var(--_fw-bold);
    }
    .error-banner {
        display: flex;
        align-items: center;
        gap: var(--_s2);
        padding: var(--_s2) var(--_s3);
        margin: var(--_s2);
        border-radius: var(--_r-sm);
        background: color-mix(in srgb, var(--_danger) 12%, transparent);
        color: var(--_danger);
        font-size: var(--_fs-sm);
    }
    .spinner {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        border: 2px solid var(--_border);
        border-top-color: var(--_brand);
        animation: sw-spin 0.8s linear infinite;
    }
    @keyframes sw-spin {
        to {
            transform: rotate(360deg);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .spinner {
            animation-duration: 2s;
        }
    }
`;
