/**
 * HTTP / socket hardening settings (all optional; safe defaults).
 *
 *   TRUST_PROXY            Express "trust proxy" (default "loopback": trust X-Forwarded-For only
 *                          from nginx on the same host). Needed so rate limits see client IPs.
 *   RATE_LIMIT_WINDOW_MS   window for HTTP rate limits (default 60000)
 *   RATE_LIMIT_MAX         requests per IP per window, all API routes (default 600)
 *   RATE_LIMIT_SENSITIVE_MAX  per IP per window for expensive / abusable routes: uploads, search,
 *                          group / meeting / external-chat creation, policy changes (default 60)
 *   JSON_BODY_LIMIT        max JSON / form body (default "2mb"; files go through multipart upload)
 *   SOCKET_MAX_BUFFER_BYTES  max Socket.IO message size (default 5 MB)
 *   CORS_ORIGINS           comma-separated allowed browser origins; REQUIRED in production
 */
const num = (value: string | undefined, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

function trustProxy(value: string | undefined): boolean | number | string {
    if (value === undefined || value === "") return "loopback";
    if (value === "true") return true;
    if (value === "false") return false;
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
}

/** Read from the environment when used (app creation / socket server start), not at import. */
export const securityConfig = {
    get trustProxy() { return trustProxy(process.env.TRUST_PROXY); },
    get rateWindowMs() { return num(process.env.RATE_LIMIT_WINDOW_MS, 60_000); },
    get rateMax() { return num(process.env.RATE_LIMIT_MAX, 600); },
    get rateSensitiveMax() { return num(process.env.RATE_LIMIT_SENSITIVE_MAX, 60); },
    get jsonLimit() { return process.env.JSON_BODY_LIMIT || "2mb"; },
    get socketMaxBufferBytes() { return num(process.env.SOCKET_MAX_BUFFER_BYTES, 5 * 1024 * 1024); },
};

/**
 * Allowed browser origins. Unset is allowed only outside production (dev convenience); in
 * production the server refuses to start rather than silently accepting every origin.
 */
export function resolveCorsOrigins(env: NodeJS.ProcessEnv = process.env): string[] | "*" {
    const list = (env.CORS_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const invalid = list.filter((o) => o === "*" || !/^https?:\/\/[^\s/]+$/.test(o));
    if (invalid.length) {
        throw new Error(`CORS_ORIGINS contains invalid origins: ${invalid.join(", ")} (use full origins like https://app.example.com, no paths or *)`);
    }
    if (env.NODE_ENV === "production") {
        const plain = list.filter((o) => !o.startsWith("https://"));
        if (plain.length) throw new Error(`CORS_ORIGINS must use https in production: ${plain.join(", ")}`);
    }
    if (!list.length) {
        if (env.NODE_ENV === "production") {
            throw new Error("CORS_ORIGINS must be set in production (comma-separated browser origins)");
        }
        return "*";
    }
    return list;
}

/**
 * Production must have complete, safe security configuration. Checked at startup so a
 * misconfigured deployment refuses to start instead of failing (or failing open) on first use.
 * Messages name variables, never values.
 *   PLATFORM_TOKEN_SECRET  signs developer-app user tokens                 } 32+ chars, distinct,
 *   LEGACY_FILES_SECRET    signs links to legacy on-disk uploads           } identical on every
 *   WEBHOOK_SECRET_KEY     encrypts webhook signing secrets at rest        } instance
 *   APP_PUBLIC_URL         https origin of the web app (consent links)
 *   CLERK_SECRET_KEY, CLERK_WEBHOOK_SIGNING_SECRET  authentication and membership sync
 */
export function productionConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
    if (env.NODE_ENV !== "production") return [];
    const problems: string[] = [];
    const secrets = ["PLATFORM_TOKEN_SECRET", "LEGACY_FILES_SECRET", "WEBHOOK_SECRET_KEY"];
    const weak = secrets.filter((k) => !env[k] || String(env[k]).length < 32);
    if (weak.length) problems.push(`${weak.join(", ")} must be set (32+ characters) in production`);
    const set = secrets.filter((k) => env[k] && String(env[k]).length >= 32);
    if (new Set(set.map((k) => env[k])).size !== set.length) problems.push("PLATFORM_TOKEN_SECRET, LEGACY_FILES_SECRET and WEBHOOK_SECRET_KEY must be different values");
    let publicUrl: URL | null = null;
    try { publicUrl = env.APP_PUBLIC_URL ? new URL(env.APP_PUBLIC_URL) : null; } catch { publicUrl = null; }
    if (!publicUrl || publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password) problems.push("APP_PUBLIC_URL must be an https URL in production");
    for (const k of ["CLERK_SECRET_KEY", "CLERK_WEBHOOK_SIGNING_SECRET"]) if (!env[k]) problems.push(`${k} must be set in production`);
    return problems;
}

export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
    const problems = productionConfigProblems(env);
    if (problems.length) throw new Error(problems.join("; "));
}
