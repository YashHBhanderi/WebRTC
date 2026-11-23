import { TOKENS, type TokenName } from "./tokens.js";

/**
 * Friendly theme keys → CSS custom properties. A theme is any subset; values are CSS values
 * (colors may use light-dark(a, b) to give separate light and dark values).
 */
export interface Theme {
    brand?: string;
    brandStrong?: string;
    brandSoft?: string;
    onBrand?: string;
    accent?: string;
    background?: string;
    surface?: string;
    surface2?: string;
    input?: string;
    hover?: string;
    active?: string;
    border?: string;
    text?: string;
    text2?: string;
    muted?: string;
    success?: string;
    danger?: string;
    warning?: string;
    chatBackground?: string;
    bubbleIn?: string;
    bubbleInText?: string;
    bubbleOut?: string;
    bubbleOutText?: string;
    callBackground?: string;
    callTile?: string;
    callControl?: string;
    fontFamily?: string;
    fontSize?: string;
    radiusSm?: string;
    radius?: string;
    radiusLg?: string;
    bubbleRadius?: string;
    avatarSize?: string;
    controlHeight?: string;
    shadow?: string;
    focusRing?: string;
    /** Any raw token, e.g. { "--sw-space-3": "10px" } */
    tokens?: Partial<Record<TokenName, string>>;
}

const MAP: Record<Exclude<keyof Theme, "tokens">, TokenName> = {
    brand: "--sw-color-brand",
    brandStrong: "--sw-color-brand-strong",
    brandSoft: "--sw-color-brand-soft",
    onBrand: "--sw-color-on-brand",
    accent: "--sw-color-accent",
    background: "--sw-color-bg",
    surface: "--sw-color-surface",
    surface2: "--sw-color-surface-2",
    input: "--sw-color-input",
    hover: "--sw-color-hover",
    active: "--sw-color-active",
    border: "--sw-color-border",
    text: "--sw-color-text",
    text2: "--sw-color-text-2",
    muted: "--sw-color-muted",
    success: "--sw-color-success",
    danger: "--sw-color-danger",
    warning: "--sw-color-warning",
    chatBackground: "--sw-chat-bg",
    bubbleIn: "--sw-bubble-in",
    bubbleInText: "--sw-bubble-in-text",
    bubbleOut: "--sw-bubble-out",
    bubbleOutText: "--sw-bubble-out-text",
    callBackground: "--sw-call-bg",
    callTile: "--sw-call-tile",
    callControl: "--sw-call-control",
    fontFamily: "--sw-font-family",
    fontSize: "--sw-font-size",
    radiusSm: "--sw-radius-sm",
    radius: "--sw-radius",
    radiusLg: "--sw-radius-lg",
    bubbleRadius: "--sw-bubble-radius",
    avatarSize: "--sw-avatar-size",
    controlHeight: "--sw-control-height",
    shadow: "--sw-shadow",
    focusRing: "--sw-focus-ring",
};

/** Theme → `{ "--sw-…": value }` */
export function themeToCssVariables(theme: Theme): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(theme)) {
        if (k === "tokens" || v === undefined || v === null || v === "") continue;
        const name = MAP[k as keyof typeof MAP];
        if (name) out[name] = String(v);
    }
    for (const [k, v] of Object.entries(theme.tokens || {})) if (k in TOKENS && v) out[k] = v;
    return out;
}

/** Apply a theme to an element (and everything inside it). Returns a function that removes it. */
export function applyTheme(target: HTMLElement, theme: Theme): () => void {
    const vars = themeToCssVariables(theme);
    for (const [k, v] of Object.entries(vars)) target.style.setProperty(k, v);
    return () => {
        for (const k of Object.keys(vars)) target.style.removeProperty(k);
    };
}

/** Theme → a CSS rule text, for a stylesheet: `cssForTheme(".my-app", theme)` */
export function cssForTheme(selector: string, theme: Theme): string {
    const body = Object.entries(themeToCssVariables(theme))
        .map(([k, v]) => `  ${k}: ${v};`)
        .join("\n");
    return `${selector} {\n${body}\n}`;
}

/** Built-in starting points. Extend them: `{ ...themes.spreewe, brand: "#0a66c2" }` */
export const themes = {
    /** SpreeWe's slate palette (the defaults) */
    spreewe: {} as Theme,
    /** Neutral greys that sit well next to most design systems */
    neutral: {
        brand: "light-dark(#111827, #e5e7eb)",
        brandStrong: "light-dark(#030712, #f9fafb)",
        brandSoft: "light-dark(#f3f4f6, #1f2937)",
        onBrand: "light-dark(#ffffff, #111827)",
        background: "light-dark(#f9fafb, #0b0f14)",
        surface: "light-dark(#ffffff, #111827)",
        border: "light-dark(#e5e7eb, #1f2937)",
        text: "light-dark(#111827, #f3f4f6)",
        muted: "light-dark(#6b7280, #9ca3af)",
        bubbleOut: "light-dark(#111827, #374151)",
    } as Theme,
    /** Tighter spacing and smaller controls for dense layouts */
    compact: {
        fontSize: "13px",
        avatarSize: "30px",
        controlHeight: "30px",
        radius: "8px",
        tokens: { "--sw-space-3": "8px", "--sw-space-4": "12px" },
    } as Theme,
} satisfies Record<string, Theme>;
