import dotenv from "dotenv";
dotenv.config();

import { productionConfigProblems, resolveCorsOrigins } from "./security";
import { legacyDirProblems } from "../services/legacy-files.service";

/**
 * Read-only configuration check: `npm run check:config` (use NODE_ENV=production to apply the
 * production rules). No network, no database, no file listing; prints variable names and
 * PASS / WARN / FAIL only — never values. Exit code 1 on any FAIL.
 */
type Result = { level: "PASS" | "WARN" | "FAIL"; check: string; detail?: string };

export function checkConfig(env: NodeJS.ProcessEnv = process.env): Result[] {
    const results: Result[] = [];
    const prod = env.NODE_ENV === "production";
    try {
        const origins = resolveCorsOrigins(env);
        results.push(origins === "*" ? { level: "WARN", check: "CORS_ORIGINS", detail: "unset: any origin allowed (development only)" } : { level: "PASS", check: "CORS_ORIGINS", detail: `${origins.length} origin(s)` });
    } catch (error) {
        results.push({ level: "FAIL", check: "CORS_ORIGINS", detail: (error as Error).message.replace(/:.*$/, "") });
    }
    const problems = productionConfigProblems(env);
    if (prod) {
        results.push(...(problems.length ? problems.map((p) => ({ level: "FAIL" as const, check: "production security", detail: p })) : [{ level: "PASS" as const, check: "production security", detail: "secrets, APP_PUBLIC_URL, Clerk keys and authorized parties" }]));
    } else {
        results.push({ level: "WARN", check: "production security", detail: "NODE_ENV is not production; production rules not applied" });
    }
    const legacy = legacyDirProblems(env);
    results.push(legacy.length ? { level: prod ? "FAIL" : "WARN", check: "LEGACY_UPLOADS_DIR", detail: legacy.join("; ") } : { level: "PASS", check: "LEGACY_UPLOADS_DIR", detail: "exists, directory, readable (contents not inspected)" });
    const sk = String(env.CLERK_SECRET_KEY || "");
    if (prod && sk.startsWith("sk_test_")) results.push({ level: "WARN", check: "CLERK_SECRET_KEY", detail: "a test-instance key with NODE_ENV=production (acceptable for staging only)" });
    const skew = Number(env.CLERK_CLOCK_SKEW_MS);
    if (prod && env.CLERK_CLOCK_SKEW_MS && Number.isFinite(skew) && skew > 30_000) results.push({ level: "FAIL", check: "CLERK_CLOCK_SKEW_MS", detail: "over 30 s in production (expired tokens would be accepted)" });
    if (!env.S3_BUCKET) results.push({ level: prod ? "FAIL" : "WARN", check: "S3_BUCKET", detail: "not set" });
    return results;
}

if (require.main === module) {
    const results = checkConfig();
    for (const r of results) console.log(`${r.level.padEnd(4)}  ${r.check}${r.detail ? ` — ${r.detail}` : ""}`);
    process.exit(results.some((r) => r.level === "FAIL") ? 1 : 0);
}
