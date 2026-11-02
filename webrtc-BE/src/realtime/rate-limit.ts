/**
 * Per-socket token bucket. Generous enough for call setup bursts (mediasoup signalling sends a
 * few dozen events when joining), strict enough to stop event floods from one connection.
 *
 *   SOCKET_RATE_PER_SEC   refill rate (default 30 events/second)
 *   SOCKET_RATE_BURST     bucket size (default 120 events)
 */
const num = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function socketRateLimiter(
    perSecond = num(process.env.SOCKET_RATE_PER_SEC, 30),
    burst = num(process.env.SOCKET_RATE_BURST, 120),
    now: () => number = Date.now,
): () => boolean {
    let tokens = burst;
    let last = now();
    return () => {
        const t = now();
        tokens = Math.min(burst, tokens + ((t - last) / 1000) * perSecond);
        last = t;
        if (tokens < 1) {
            return false;
        }
        tokens -= 1;
        return true;
    };
}

/**
 * Event budgets shared by every connection with the same key (user, or app + user), so opening
 * more sockets does not buy more events. Per process (see docs: not a global limit across instances).
 */
const shared = new Map<string, { allow: () => boolean; lastUsed: number }>();

export function sharedSocketLimiter(key: string): () => boolean {
    let entry = shared.get(key);
    if (!entry) {
        entry = { allow: socketRateLimiter(), lastUsed: Date.now() };
        shared.set(key, entry);
        if (shared.size > 50_000) {
            // Drop idle buckets (a fresh bucket is full, so this can only be more generous to idle keys)
            const cutoff = Date.now() - 10 * 60_000;
            for (const [k, v] of shared) if (v.lastUsed < cutoff) shared.delete(k);
        }
    }
    const e = entry;
    return () => {
        e.lastUsed = Date.now();
        return e.allow();
    };
}
