import { describe, expect, it } from "vitest";
import request from "supertest";
import { assertProductionSecrets, resolveCorsOrigins } from "../src/config/security";
import { legacyDirProblems } from "../src/services/legacy-files.service";
import { checkConfig } from "../src/config/check";
import fs from "fs";
import os from "os";
import path from "path";
import { socketRateLimiter } from "../src/realtime/rate-limit";
import { makeUser } from "./helpers";

// Requirement 10: rate limits, CORS restrictions and security configuration
describe("CORS configuration", () => {
    it("refuses to run in production without explicit origins", () => {
        expect(() => resolveCorsOrigins({ NODE_ENV: "production" } as any)).toThrow(/CORS_ORIGINS must be set/);
    });
    it("rejects wildcards and malformed origins", () => {
        expect(() => resolveCorsOrigins({ NODE_ENV: "production", CORS_ORIGINS: "*" } as any)).toThrow(/invalid/);
        expect(() => resolveCorsOrigins({ CORS_ORIGINS: "https://a.example.com/path" } as any)).toThrow(/invalid/);
        expect(() => resolveCorsOrigins({ CORS_ORIGINS: "a.example.com" } as any)).toThrow(/invalid/);
    });
    it("accepts a clean allow-list; allows any origin only outside production", () => {
        expect(resolveCorsOrigins({ NODE_ENV: "production", CORS_ORIGINS: "https://a.example.com, https://b.example.com" } as any))
            .toEqual(["https://a.example.com", "https://b.example.com"]);
        expect(resolveCorsOrigins({ NODE_ENV: "development" } as any)).toBe("*");
    });
    it("answers preflight only for allowed origins", async () => {
        const { createApp } = await import("../src/app");
        const app = createApp(["https://app.example.com"]);
        const allowed = await request(app).options("/conversations").set("Origin", "https://app.example.com").set("Access-Control-Request-Method", "GET");
        expect(allowed.headers["access-control-allow-origin"]).toBe("https://app.example.com");
        const other = await request(app).options("/conversations").set("Origin", "https://evil.example.com").set("Access-Control-Request-Method", "GET");
        expect(other.headers["access-control-allow-origin"]).toBeUndefined();
    });
});

describe("HTTP hardening", () => {
    it("sends security headers and hides the framework", async () => {
        const { createApp } = await import("../src/app");
        const res = await request(createApp("*")).get("/config");
        expect(res.headers["x-content-type-options"]).toBe("nosniff");
        expect(res.headers["x-frame-options"]).toBeDefined();
        expect(res.headers["strict-transport-security"]).toBeDefined();
        expect(res.headers["x-powered-by"]).toBeUndefined();
    });

    it("rejects oversized JSON bodies", async () => {
        const { createApp } = await import("../src/app");
        const big = JSON.stringify({ text: "x".repeat(3 * 1024 * 1024) });
        const res = await request(createApp("*")).post("/conversations").set("Content-Type", "application/json").send(big);
        expect(res.status).toBe(413);
    });

    it("rate-limits sensitive endpoints per client", async () => {
        process.env.RATE_LIMIT_SENSITIVE_MAX = "3";
        const { createApp } = await import("../src/app");
        const app = createApp("*");
        const u = await makeUser();
        const auth = { "x-test-auth": JSON.stringify({ sub: u.clerkId }) };
        const statuses: number[] = [];
        for (let i = 0; i < 5; i++) {
            statuses.push((await request(app).get("/search?q=abc").set(auth)).status);
        }
        expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
        expect(statuses.slice(3)).toEqual([429, 429]);
        process.env.RATE_LIMIT_SENSITIVE_MAX = "100000";
    });
});

const PROD_OK = {
    NODE_ENV: "production", PLATFORM_TOKEN_SECRET: "y".repeat(40), LEGACY_FILES_SECRET: "x".repeat(40), WEBHOOK_SECRET_KEY: "z".repeat(40),
    APP_PUBLIC_URL: "https://app.example.com", CLERK_SECRET_KEY: "sk_live_example", CLERK_WEBHOOK_SIGNING_SECRET: "whsec_example",
    CLERK_AUTHORIZED_PARTIES: "https://app.example.com",
} as any;

describe("production secrets", () => {
    it("Phase 5B: refuses reused secrets, a missing / non-https APP_PUBLIC_URL, missing Clerk keys; never prints values", () => {
        const reuse = { ...PROD_OK, LEGACY_FILES_SECRET: PROD_OK.PLATFORM_TOKEN_SECRET };
        expect(() => assertProductionSecrets(reuse)).toThrow(/must be different values/);
        try { assertProductionSecrets(reuse); } catch (e) { expect(String(e)).not.toContain("y".repeat(40)); }
        expect(() => assertProductionSecrets({ ...PROD_OK, APP_PUBLIC_URL: undefined })).toThrow(/APP_PUBLIC_URL/);
        expect(() => assertProductionSecrets({ ...PROD_OK, APP_PUBLIC_URL: "http://app.example.com" })).toThrow(/APP_PUBLIC_URL/);
        expect(() => assertProductionSecrets({ ...PROD_OK, APP_PUBLIC_URL: "not a url" })).toThrow(/APP_PUBLIC_URL/);
        expect(() => assertProductionSecrets({ ...PROD_OK, CLERK_WEBHOOK_SIGNING_SECRET: "" })).toThrow(/CLERK_WEBHOOK_SIGNING_SECRET/);
        expect(() => assertProductionSecrets({ ...PROD_OK, CLERK_SECRET_KEY: "" })).toThrow(/CLERK_SECRET_KEY/);
    });
    it("SEC-015: production requires CLERK_AUTHORIZED_PARTIES as exact https origins", () => {
        for (const missing of [undefined, "", " , "]) {
            expect(() => assertProductionSecrets({ ...PROD_OK, CLERK_AUTHORIZED_PARTIES: missing })).toThrow(/CLERK_AUTHORIZED_PARTIES must be set/);
        }
        for (const bad of [
            "*", "https://*.example.com", "http://app.example.com", "https://app.example.com/path",
            "app.example.com", "https://user:pw@app.example.com", "https://app.example.com?x=1",
            "https://app.example.com, http://other.example.com",
        ]) {
            expect(() => assertProductionSecrets({ ...PROD_OK, CLERK_AUTHORIZED_PARTIES: bad }), bad).toThrow(/CLERK_AUTHORIZED_PARTIES must contain only exact https origins/);
        }
        // Accepted: several origins, a port, and a trailing slash (auth.ts strips it the same way)
        expect(() => assertProductionSecrets({ ...PROD_OK, CLERK_AUTHORIZED_PARTIES: "https://app.example.com, https://admin.example.com:8443/" })).not.toThrow();
        // Names only: the configured value is never echoed
        try { assertProductionSecrets({ ...PROD_OK, CLERK_AUTHORIZED_PARTIES: "http://leak.example.com" }); } catch (e) { expect(String(e)).not.toContain("leak.example.com"); }
        // Development is unaffected
        expect(() => assertProductionSecrets({ NODE_ENV: "development" } as any)).not.toThrow();
        // check:config reports it as a FAIL in production
        const results = checkConfig({ ...PROD_OK, CLERK_AUTHORIZED_PARTIES: undefined, LEGACY_UPLOADS_DIR: os.tmpdir(), S3_BUCKET: "b", CORS_ORIGINS: "https://app.example.com" });
        expect(results.some((r) => r.level === "FAIL" && /CLERK_AUTHORIZED_PARTIES/.test(r.detail || ""))).toBe(true);
    });
    it("Phase 5B: production CORS origins must be https", () => {
        expect(() => resolveCorsOrigins({ NODE_ENV: "production", CORS_ORIGINS: "http://app.example.com" } as any)).toThrow(/https/);
        expect(resolveCorsOrigins({ NODE_ENV: "development", CORS_ORIGINS: "http://localhost:4200" } as any)).toEqual(["http://localhost:4200"]);
    });
    it("Phase 5B: LEGACY_UPLOADS_DIR is validated without reading its contents", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-"));
        const file = path.join(dir, "f.txt");
        fs.writeFileSync(file, "x");
        const readdir = fs.readdirSync;
        let listed = 0;
        (fs as any).readdirSync = (...a: any[]) => { listed++; return (readdir as any)(...a); };
        try {
            expect(legacyDirProblems({ LEGACY_UPLOADS_DIR: dir } as any)).toEqual([]);
            expect(legacyDirProblems({ LEGACY_UPLOADS_DIR: path.join(dir, "missing") } as any)[0]).toMatch(/does not exist/);
            expect(legacyDirProblems({ LEGACY_UPLOADS_DIR: file } as any)[0]).toMatch(/not a directory/);
            expect(legacyDirProblems({ LEGACY_UPLOADS_DIR: path.parse(dir).root } as any)[0]).toMatch(/root/);
            expect(legacyDirProblems({ NODE_ENV: "production" } as any)[0]).toMatch(/not set/);
            expect(listed).toBe(0);
        } finally {
            (fs as any).readdirSync = readdir;
            fs.rmSync(dir, { recursive: true });
        }
    });
    it("Phase 5B: check:config reports by name only", () => {
        const out = JSON.stringify(checkConfig({ ...PROD_OK, LEGACY_UPLOADS_DIR: os.tmpdir(), S3_BUCKET: "b", CORS_ORIGINS: "https://app.example.com" }));
        expect(out).not.toContain("y".repeat(40));
        expect(out).not.toContain(JSON.stringify(os.tmpdir()).slice(1, -1));
        expect(checkConfig({ ...PROD_OK, LEGACY_UPLOADS_DIR: os.tmpdir(), S3_BUCKET: "b", CORS_ORIGINS: "https://app.example.com" }).every((r) => r.level !== "FAIL")).toBe(true);
        expect(checkConfig({ NODE_ENV: "production" } as any).filter((r) => r.level === "FAIL").length).toBeGreaterThan(2);
    });
    it("production refuses to start without the signing secrets", () => {
        expect(() => assertProductionSecrets({ NODE_ENV: "production" } as any)).toThrow(/PLATFORM_TOKEN_SECRET, LEGACY_FILES_SECRET, WEBHOOK_SECRET_KEY/);
        expect(() => assertProductionSecrets({ NODE_ENV: "production", PLATFORM_TOKEN_SECRET: "short", LEGACY_FILES_SECRET: "x".repeat(40), WEBHOOK_SECRET_KEY: "z".repeat(40) } as any)).toThrow(/PLATFORM_TOKEN_SECRET/);
        expect(() => assertProductionSecrets(PROD_OK)).not.toThrow();
        expect(() => assertProductionSecrets({ NODE_ENV: "development" } as any)).not.toThrow();
    });
});

describe("socket rate limiter", () => {
    it("allows a burst, then refills at the configured rate", () => {
        let t = 0;
        const allow = socketRateLimiter(10, 5, () => t);
        expect([1, 2, 3, 4, 5].map(() => allow())).toEqual([true, true, true, true, true]);
        expect(allow()).toBe(false);
        t += 100; // 0.1 s × 10/s = 1 token
        expect(allow()).toBe(true);
        expect(allow()).toBe(false);
    });
});

describe("Phase 5B: Clerk clock skew", () => {
    it("the 3-minute development skew never applies in production, even with a test-instance key", async () => {
        const { resolveClockSkewMs } = await import("../src/config/auth");
        const saved = { ...process.env };
        try {
            Object.assign(process.env, { CLERK_PUBLISHABLE_KEY: "pk_test_x", NODE_ENV: "production" });
            delete process.env.CLERK_CLOCK_SKEW_MS;
            expect(resolveClockSkewMs()).toBe(5_000);
            process.env.NODE_ENV = "development";
            expect(resolveClockSkewMs()).toBe(180_000);
        } finally {
            process.env = saved;
        }
    });
});
