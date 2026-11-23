/**
 * UI strings. Every visible string has a key with an English default registered by its module.
 * Override any of them (before components render) to translate or reword:
 *
 *   setStrings({ "chat.composer.placeholder": "Écrire un message…" });
 *   setLocale("fr");   // dates, times and numbers
 *
 * Placeholders use {name}: t("chat.typing.one", { name: "Ana" }).
 */
const defaults = new Map<string, string>();
const overrides = new Map<string, string>();
const listeners = new Set<() => void>();
let locale: string | undefined;

export function registerStrings(strings: Record<string, string>): void {
    for (const [k, v] of Object.entries(strings)) if (!defaults.has(k)) defaults.set(k, v);
}

export function setStrings(strings: Record<string, string>): void {
    for (const [k, v] of Object.entries(strings)) overrides.set(k, v);
    for (const l of [...listeners]) l();
}

/** Every registered key with its current text (useful for building a translation file). */
export function allStrings(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of defaults) out[k] = overrides.get(k) ?? v;
    for (const [k, v] of overrides) out[k] = v;
    return out;
}

export function t(key: string, vars?: Record<string, string | number>): string {
    const text = overrides.get(key) ?? defaults.get(key) ?? key;
    return vars ? text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m)) : text;
}

export function setLocale(next: string | undefined): void {
    locale = next;
    for (const l of [...listeners]) l();
}

export function getLocale(): string | undefined {
    return locale;
}

/** Re-render when strings or the locale change */
export function onStringsChanged(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

registerStrings({
    "common.loading": "Loading…",
    "common.retry": "Try again",
    "common.cancel": "Cancel",
    "common.close": "Close",
    "common.save": "Save",
    "common.done": "Done",
    "common.today": "Today",
    "common.yesterday": "Yesterday",
    "common.you": "You",
    "common.error": "Something went wrong.",
    "common.offline": "Reconnecting…",
    "common.noClient": "Not connected to SpreeWe.",
    "common.missingScope": "This app wasn't given permission for this.",
    "presence.online": "Available",
    "presence.busy": "Busy",
    "presence.away": "Away",
    "presence.offline": "Offline",
});
