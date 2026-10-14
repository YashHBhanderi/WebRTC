import { IRecurrence } from "../models/meetingModel";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Safety cap on generated occurrences per query. */
const MAX_OCCURRENCES = 1000;

/**
 * Wall-clock parts of an instant in a time zone (Intl only; no date library).
 * Recurrences repeat at the same local time, so DST changes don't shift a 9:00 meeting to 8:00.
 */
function partsIn(date: Date, timeZone: string) {
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
    return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second };
}

/** UTC instant of a wall-clock time in a time zone (two passes handle DST edges). */
function zonedToUtc(y: number, m: number, d: number, h: number, min: number, timeZone: string): Date {
    let guess = Date.UTC(y, m - 1, d, h, min);
    for (let i = 0; i < 2; i++) {
        const p = partsIn(new Date(guess), timeZone);
        const asIfUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
        guess += Date.UTC(y, m - 1, d, h, min) - asIfUtc;
    }
    return new Date(guess);
}

export function isValidTimeZone(tz: unknown): tz is string {
    if (typeof tz !== "string" || !tz) {
        return false;
    }
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

/**
 * Start times of a series that overlap [from, to). Non-recurring meetings yield their single start.
 * `cancelled` occurrences are skipped.
 */
export function occurrencesBetween(
    startAt: Date,
    endAt: Date,
    recurrence: IRecurrence | null | undefined,
    timeZone: string,
    from: Date,
    to: Date,
    cancelled: Date[] = [],
): Date[] {
    const duration = endAt.getTime() - startAt.getTime();
    const skip = new Set(cancelled.map((d) => new Date(d).getTime()));
    const overlaps = (start: Date) => start.getTime() < to.getTime() && start.getTime() + duration > from.getTime();
    if (!recurrence) {
        return overlaps(startAt) && !skip.has(startAt.getTime()) ? [startAt] : [];
    }

    const tz = isValidTimeZone(timeZone) ? timeZone : "UTC";
    const base = partsIn(startAt, tz);
    const interval = Math.max(1, recurrence.interval || 1);
    const until = recurrence.until ? new Date(recurrence.until).getTime() : Infinity;
    const maxCount = recurrence.count || Infinity;
    const out: Date[] = [];
    let generated = 0;

    // Walk calendar days from the series start; cheap enough for the ranges a calendar asks for
    const startDay = Date.UTC(base.y, base.m - 1, base.d);
    const lastDay = Math.min(to.getTime() + DAY_MS, until + DAY_MS);
    const baseWeekStart = startDay - new Date(startDay).getUTCDay() * DAY_MS;
    const weekdays = recurrence.byWeekday?.length ? recurrence.byWeekday : [new Date(startDay).getUTCDay()];

    for (let day = startDay; day <= lastDay && generated < maxCount && out.length < MAX_OCCURRENCES; day += DAY_MS) {
        const d = new Date(day);
        const dow = d.getUTCDay();
        const daysFromStart = Math.round((day - startDay) / DAY_MS);
        let match = false;
        switch (recurrence.freq) {
            case "daily":
                match = daysFromStart % interval === 0;
                break;
            case "weekdays":
                match = dow >= 1 && dow <= 5;
                break;
            case "weekly": {
                const weeks = Math.floor((day - baseWeekStart) / (7 * DAY_MS));
                match = weeks % interval === 0 && weekdays.includes(dow);
                break;
            }
            case "monthly": {
                const months = (d.getUTCFullYear() - base.y) * 12 + (d.getUTCMonth() + 1 - base.m);
                match = d.getUTCDate() === base.d && months % interval === 0;
                break;
            }
        }
        if (!match) {
            continue;
        }
        const start = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), base.h, base.min, tz);
        if (start.getTime() < startAt.getTime() || start.getTime() > until) {
            continue;
        }
        generated++;
        if (overlaps(start) && !skip.has(start.getTime())) {
            out.push(start);
        }
    }
    return out;
}

/** Human summary for invitations ("Weekly on Mon, Wed"). */
export function describeRecurrence(r: IRecurrence | null | undefined): string {
    if (!r) {
        return "";
    }
    const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const every = (unit: string) => (r.interval > 1 ? `Every ${r.interval} ${unit}s` : unit === "day" ? "Daily" : unit === "week" ? "Weekly" : "Monthly");
    switch (r.freq) {
        case "daily": return every("day");
        case "weekdays": return "Every weekday";
        case "weekly": return `${every("week")}${r.byWeekday?.length ? " on " + r.byWeekday.map((d) => names[d]).join(", ") : ""}`;
        case "monthly": return every("month");
    }
}
