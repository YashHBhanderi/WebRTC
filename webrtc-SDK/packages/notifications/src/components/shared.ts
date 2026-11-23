import { html, type TemplateResult } from "lit";
import { isSpreeWeError } from "@spreewe/core";
import { t } from "@spreewe/ui";
import type { SpreeWeNotification } from "../types.js";

/** The scope a refused request needed, when the server said so ("The token lacks the x:y scope"). */
export function missingScope(e: unknown): string | null {
    if (!isSpreeWeError(e)) return null;
    if (e.status !== 403 && e.code !== "MISSING_SCOPE") return null;
    return /lacks the ([a-z]+:[a-z]+) scope/i.exec(e.message)?.[1] || (e.code === "MISSING_SCOPE" ? "" : null);
}

/** Human-readable error for a feed or action failure */
export function errorText(e: unknown, action: "read" | "write"): string {
    const scope = missingScope(e);
    if (scope !== null) return t("notifications.missingScope", { action: t(`notifications.action.${action}`), scope: scope || (action === "read" ? "notifications:read" : "notifications:write") });
    return e instanceof Error && e.message ? e.message : t("common.error");
}

/** The actor's name, or "Someone" for system entries */
export function actorName(n: SpreeWeNotification): string {
    return n.actor?.username || t("notifications.someone");
}

const KNOWN = new Set(["mention", "reply", "reaction", "missed-call", "meeting-invite", "meeting-reminder", "recording"]);

/** Headline for a notification as plain text (for aria labels and custom renderers). */
export function notificationTitle(n: SpreeWeNotification): string {
    const key = KNOWN.has(n.type) ? `notifications.type.${n.type}` : "notifications.type.other";
    return t(key, { name: actorName(n), emoji: n.type === "reaction" ? n.text : "" }).replace(/\s{2,}/g, " ");
}

/** Secondary line: the server's preview, except where the headline already shows it (reaction emoji). */
export function notificationPreview(n: SpreeWeNotification): string {
    return n.type === "reaction" ? "" : n.text;
}

/** Headline with the actor's name emphasised, keeping the translated word order. */
export function notificationHeadline(n: SpreeWeNotification): TemplateResult {
    const key = KNOWN.has(n.type) ? `notifications.type.${n.type}` : "notifications.type.other";
    // Fill every placeholder except {name}, then split around it
    const template = t(key, { emoji: n.type === "reaction" ? n.text : "" });
    const parts = template.split("{name}");
    const name = actorName(n);
    return html`${parts.map((p, i) => (i === 0 ? html`${p}` : html`<strong part="actor">${name}</strong>${p}`))}`;
}

/** Icon shown instead of an avatar for entries without an actor */
export function typeIcon(type: string): string {
    switch (type) {
        case "missed-call":
            return "phone";
        case "meeting-invite":
        case "meeting-reminder":
            return "calendar";
        case "recording":
            return "record";
        case "reaction":
            return "smile";
        case "reply":
            return "reply";
        default:
            return "bell";
    }
}

export function spinner(): TemplateResult {
    return html`<span class="spinner" role="status" aria-label=${t("common.loading")}></span>`;
}
