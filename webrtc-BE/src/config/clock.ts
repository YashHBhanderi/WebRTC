import { safeError } from "../utils/safe-log";

/**
 * Clock-offset diagnostics. Clerk session tokens are verified locally against this host's clock
 * (5 s tolerance in production), so a host that is a few seconds off rejects every valid sign-in
 * ("issued in the future") or keeps expired tokens alive. Hosts must be NTP-synchronised; this only
 * MEASURES and REPORTS the offset — it never changes token validation.
 *
 * Measurement: HTTPS HEAD to a reference (default Clerk's API, i.e. the issuer's clock), using the
 * Date header (1 s resolution) and the request midpoint. Accuracy is about ±(0.5 s + RTT/2).
 *   CLOCK_REFERENCE_URL   override the reference (https only)
 *   CLOCK_CHECK_INTERVAL_MS  runtime check interval (default 900000 = 15 min; 0 = off)
 */
export interface ClockReading {
    offsetMs: number; // local − reference (negative = local clock is slow)
    uncertaintyMs: number;
    reference: string;
}

export type ClockLevel = "PASS" | "WARN" | "FAIL";

const DEFAULT_REFERENCE = "https://api.clerk.com/v1/jwks";

export async function measureClockOffset(reference = process.env.CLOCK_REFERENCE_URL || DEFAULT_REFERENCE, fetchImpl: typeof fetch = fetch, now: () => number = Date.now): Promise<ClockReading> {
    const url = new URL(reference);
    if (url.protocol !== "https:") throw new Error("CLOCK_REFERENCE_URL must be https");
    const t0 = now();
    const res = await fetchImpl(url.toString(), { method: "HEAD", signal: AbortSignal.timeout(5000) });
    const t1 = now();
    const date = res.headers.get("date");
    const remote = date ? Date.parse(date) : NaN;
    if (!Number.isFinite(remote)) throw new Error("reference sent no usable Date header");
    // Date is truncated to the second: the true remote time is in [remote, remote + 1000)
    const offsetMs = Math.round((t0 + t1) / 2 - (remote + 500));
    return { offsetMs, uncertaintyMs: Math.round(500 + (t1 - t0) / 2), reference: url.host };
}

/** PASS within 1 s, WARN up to 3 s, FAIL beyond (production token tolerance is 5 s). */
export function clockLevel(r: ClockReading): ClockLevel {
    const worst = Math.abs(r.offsetMs) + r.uncertaintyMs;
    if (Math.abs(r.offsetMs) > 3000) return "FAIL";
    return worst > 1500 ? "WARN" : "PASS";
}

let last: (ClockReading & { level: ClockLevel; at: string }) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

export const lastClockReading = () => last;

async function check(): Promise<void> {
    try {
        const r = await measureClockOffset();
        const level = clockLevel(r);
        last = { ...r, level, at: new Date().toISOString() };
        const msg = `[clock] offset ${(r.offsetMs / 1000).toFixed(1)} s (±${(r.uncertaintyMs / 1000).toFixed(1)} s) vs ${r.reference}`;
        if (level === "FAIL") console.error(`${msg} — host clock is off: Clerk sign-ins will fail or expired tokens will be accepted. Fix NTP (docs/operations/time-synchronization.md).`);
        else if (level === "WARN") console.warn(msg);
    } catch (error) {
        console.warn("[clock] offset check failed:", safeError(error));
    }
}

export function startClockMonitor(): void {
    const ms = process.env.CLOCK_CHECK_INTERVAL_MS === undefined ? 900_000 : Number(process.env.CLOCK_CHECK_INTERVAL_MS);
    if (!Number.isFinite(ms) || ms <= 0 || timer || process.env.NODE_ENV === "test") return;
    void check();
    timer = setInterval(() => void check(), Math.max(60_000, ms));
    timer.unref();
}

export function stopClockMonitor(): void {
    if (timer) clearInterval(timer);
    timer = null;
}

if (require.main === module) {
    // `npm run check:clock`: read-only, no credentials
    measureClockOffset().then((r) => {
        const level = clockLevel(r);
        console.log(`${level.padEnd(4)}  clock offset ${(r.offsetMs / 1000).toFixed(1)} s (±${(r.uncertaintyMs / 1000).toFixed(1)} s) vs ${r.reference}`);
        process.exitCode = level === "FAIL" ? 1 : 0;
    }, (error) => {
        console.log(`FAIL  clock check could not run: ${(error as Error).message}`);
        process.exitCode = 1;
    });
}
