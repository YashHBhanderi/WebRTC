import type { PresenceUpdate } from "@spreewe/core";
import { getLocale, t } from "./i18n.js";

export function initials(name: string | null | undefined): string {
    const parts = (name || "").trim().split(/[\s._-]+/).filter(Boolean);
    if (!parts.length) return "?";
    const letters = parts.length === 1 ? [...parts[0]].slice(0, 2) : [[...parts[0]][0], [...parts[parts.length - 1]][0]];
    return letters.join("").toUpperCase();
}

/** A stable hue per name, for initials avatars */
export function hueFor(seed: string): number {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return h % 360;
}

const toDate = (v: string | number | Date) => (v instanceof Date ? v : new Date(v));

export function formatTime(v: string | number | Date): string {
    const d = toDate(v);
    return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat(getLocale(), { hour: "numeric", minute: "2-digit" }).format(d);
}

function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "Today", "Yesterday", weekday within a week, otherwise a date */
export function formatDay(v: string | number | Date, now = new Date()): string {
    const d = toDate(v);
    if (Number.isNaN(d.getTime())) return "";
    if (sameDay(d, now)) return t("common.today");
    const y = new Date(now);
    y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return t("common.yesterday");
    const days = (now.getTime() - d.getTime()) / 86_400_000;
    if (days < 7 && days > 0) return new Intl.DateTimeFormat(getLocale(), { weekday: "long" }).format(d);
    return new Intl.DateTimeFormat(getLocale(), { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" }).format(d);
}

/** Compact timestamp for lists: time today, weekday this week, else date */
export function formatListTime(v: string | number | Date | undefined | null, now = new Date()): string {
    if (!v) return "";
    const d = toDate(v);
    if (Number.isNaN(d.getTime())) return "";
    if (sameDay(d, now)) return formatTime(d);
    const days = (now.getTime() - d.getTime()) / 86_400_000;
    if (days < 7 && days > 0) return new Intl.DateTimeFormat(getLocale(), { weekday: "short" }).format(d);
    return new Intl.DateTimeFormat(getLocale(), { day: "numeric", month: "short" }).format(d);
}

export function formatDateTime(v: string | number | Date): string {
    const d = toDate(v);
    return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat(getLocale(), { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/** 65_000 → "1:05", 3_700_000 → "1:01:40" */
export function formatDuration(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatBytes(bytes: number | undefined | null): string {
    if (!bytes && bytes !== 0) return "";
    const units = ["B", "KB", "MB", "GB"];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${new Intl.NumberFormat(getLocale(), { maximumFractionDigits: i ? 1 : 0 }).format(n)} ${units[i]}`;
}

export type PresenceKind = "online" | "busy" | "away" | "offline";

/** Same mapping as the SpreeWe apps: "Appear offline" shows as offline to others */
export function presenceKind(p: Pick<PresenceUpdate, "isOnline" | "status" | "autoAway"> | null | undefined): PresenceKind {
    if (!p || !p.isOnline || p.status === "Appear offline") return "offline";
    if (p.status === "Busy" || p.status === "Do not disturb") return "busy";
    if (p.status === "Away" || p.autoAway) return "away";
    return "online";
}

export function presenceLabel(kind: PresenceKind): string {
    return t(`presence.${kind}`);
}
