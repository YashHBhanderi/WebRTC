import { html, nothing, type TemplateResult } from "lit";
import { isSpreeWeError, type PresenceUpdate } from "@spreewe/core";
import { presenceKind, presenceLabel, t } from "@spreewe/ui";

/**
 * True for "this token lacks a scope": app tokens get 403 "The token lacks the <scope> scope" from
 * session routes (webrtc-BE middleware/authMiddleware.ts requireUser) and /v1 routes, MISSING_SCOPE
 * from the SDK (socket events are checked before sending, the server never acks refused ones).
 */
export function isMissingScope(e: unknown): boolean {
    return isSpreeWeError(e) && (e.code === "MISSING_SCOPE" || (e.status === 403 && /lacks the [\w:]+ scope/i.test(e.message)));
}

export function missingScopeName(e: unknown): string {
    return (e instanceof Error && /lacks the ([\w:]+) scope/i.exec(e.message)?.[1]) || "";
}

/** Failures worth retrying as they are (network, timeout, server, rate limit) */
export function isRetryable(e: unknown): boolean {
    if (!isSpreeWeError(e)) return true;
    return ["NETWORK_ERROR", "TIMEOUT", "SERVER_ERROR", "RATE_LIMITED", "ACK_TIMEOUT", "SOCKET_UNAVAILABLE"].includes(e.code) || (e.status ?? 0) >= 500;
}

export function errorText(e: unknown, fallbackScope = ""): string {
    if (isMissingScope(e)) return t("contacts.missingScope", { scope: missingScopeName(e) || fallbackScope });
    if (e instanceof Error && e.message) return e.message;
    return t("common.error");
}

export function errorState(e: unknown, retry: (() => void) | null, fallbackScope = ""): TemplateResult {
    return html`<div class="state" part="error" role="alert">
        <span>${errorText(e, fallbackScope)}</span>
        ${retry && isRetryable(e) ? html`<button class="btn" type="button" @click=${retry}>${t("common.retry")}</button>` : nothing}
    </div>`;
}

export function errorBanner(e: unknown, fallbackScope = ""): TemplateResult {
    return html`<div class="error-banner" part="error" role="alert"><span>${errorText(e, fallbackScope)}</span></div>`;
}

export function spinner(): TemplateResult {
    return html`<span class="spinner" role="status" aria-label=${t("common.loading")}></span>`;
}

/** What to show under a name: "In a call", the chosen status, or presence */
export function presenceText(p: Pick<PresenceUpdate, "isOnline" | "status" | "autoAway" | "inCall"> | null | undefined): string {
    const kind = presenceKind(p);
    if (kind === "offline") return presenceLabel("offline");
    if (p?.inCall && p.status !== "Do not disturb") return t("contacts.status.inCall");
    // "Busy" and "Do not disturb" share a colour but keep their own label
    if (kind === "busy" && p?.status) return t(`contacts.status.${p.status}`);
    return presenceLabel(kind);
}
