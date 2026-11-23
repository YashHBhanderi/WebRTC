import { html, nothing, type TemplateResult } from "lit";
import { isSpreeWeError } from "@spreewe/core";
import { getLocale, t } from "@spreewe/ui";

/**
 * True for "this token lacks a scope": app tokens get 403 "The token lacks the <scope> scope" from
 * session routes (webrtc-BE middleware/authMiddleware.ts requireUser), MISSING_SCOPE from the SDK.
 */
export function isMissingScope(e: unknown): boolean {
    return isSpreeWeError(e) && (e.code === "MISSING_SCOPE" || (e.status === 403 && /lacks the [\w:]+ scope/i.test(e.message)));
}

/** The scope named in a missing-scope error, if any */
export function missingScopeName(e: unknown): string {
    return (e instanceof Error && /lacks the ([\w:]+) scope/i.exec(e.message)?.[1]) || "";
}

/** Failures worth retrying as they are (network, timeout, server, rate limit) */
export function isRetryable(e: unknown): boolean {
    if (!isSpreeWeError(e)) return true;
    return ["NETWORK_ERROR", "TIMEOUT", "SERVER_ERROR", "RATE_LIMITED", "ACK_TIMEOUT", "SOCKET_UNAVAILABLE"].includes(e.code) || (e.status ?? 0) >= 500;
}

export function errorText(e: unknown, fallbackScope = ""): string {
    if (isMissingScope(e)) return t("meetings.missingScope", { scope: missingScopeName(e) || fallbackScope });
    if (e instanceof Error && e.message) return e.message;
    return t("common.error");
}

/** Error state with a retry button when retrying can help */
export function errorState(e: unknown, retry: (() => void) | null, fallbackScope = ""): TemplateResult {
    return html`<div class="state" part="error" role="alert">
        <span>${errorText(e, fallbackScope)}</span>
        ${retry && isRetryable(e) ? html`<button class="btn" type="button" @click=${retry}>${t("common.retry")}</button>` : nothing}
    </div>`;
}

export function spinner(): TemplateResult {
    return html`<span class="spinner" role="status" aria-label=${t("common.loading")}></span>`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local "YYYY-MM-DD" for <input type="date"> */
export function dateInputValue(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local "HH:MM" for <input type="time"> */
export function timeInputValue(d: Date): string {
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Local date + time inputs → Date (null when incomplete or invalid) */
export function fromInputs(date: string, time: string): Date | null {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const tm = /^(\d{2}):(\d{2})/.exec(time);
    if (!dm || !tm) return null;
    const d = new Date(+dm[1], +dm[2] - 1, +dm[3], +tm[1], +tm[2], 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
}

export function startOfDay(d: Date): Date {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** "Today", "Tomorrow", otherwise "Wednesday, 4 Nov" */
export function dayLabel(d: Date, now = new Date()): string {
    const days = Math.round((startOfDay(d).getTime() - startOfDay(now).getTime()) / 86_400_000);
    if (days === 0) return t("common.today");
    if (days === 1) return t("meetings.list.tomorrow");
    if (days === -1) return t("common.yesterday");
    return new Intl.DateTimeFormat(getLocale(), {
        weekday: "long",
        day: "numeric",
        month: "short",
        year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
    }).format(d);
}

/** Short weekday names, index 0 = Sunday (matches the server's byWeekday) */
export function weekdayNames(style: "short" | "narrow" = "short"): string[] {
    const fmt = new Intl.DateTimeFormat(getLocale(), { weekday: style });
    // 2023-01-01 was a Sunday
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
}
