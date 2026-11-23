import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { verifyToken } from "@clerk/backend";
import { clockLevel, measureClockOffset } from "../src/config/clock";

/**
 * Phase 5C: what the REAL Clerk verifier (@clerk/backend, the library @clerk/express uses; not the
 * test double) accepts, with the production tolerance (5 s, src/config/auth.ts). Tokens are signed
 * with a locally generated RSA key and verified networklessly (jwtKey), like CLERK_JWT_KEY in prod.
 */
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwtKey = publicKey.export({ type: "spki", format: "pem" }).toString();
const SKEW = 5_000; // production value
const b64 = (v: unknown) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

function jwt(claims: Record<string, unknown>, opts: { key?: crypto.KeyObject; header?: Record<string, unknown>; hmacKey?: string } = {}) {
    const header = opts.header ?? { alg: "RS256", typ: "JWT", kid: "ins_test" };
    const body = { sub: "user_test", sid: "sess_test", iss: "https://clerk.example.com", v: 2, sts: "active", iat: now(), nbf: now() - 5, exp: now() + 60, ...claims };
    const input = `${b64(header)}.${b64(body)}`;
    const sig = opts.hmacKey
        ? crypto.createHmac("sha256", opts.hmacKey).update(input).digest("base64url")
        : header.alg === "none" ? "" : crypto.sign("RSA-SHA256", Buffer.from(input), opts.key ?? privateKey).toString("base64url");
    return `${input}.${sig}`;
}

const verify = (token: string) => verifyToken(token, { jwtKey, clockSkewInMs: SKEW });
const accepted = async (token: string) => verify(token).then(() => true, () => false);
const reason = async (token: string) => verify(token).then(() => "accepted", (e: any) => String(e?.reason || e?.message || e));

describe("Clerk session-token validation (real @clerk/backend, production tolerance)", () => {
    it("accepts a valid token", async () => {
        expect(await accepted(jwt({}))).toBe(true);
    });

    it("rejects a token issued in the future beyond the tolerance (the host-clock-slow failure)", async () => {
        // As seen on a host 16 s slow: Clerk issues nbf = iat − 10, so nbf is 6 s ahead → refused
        expect(await reason(jwt({ iat: now() + 16, nbf: now() + 6 }))).toBe("token-not-active-yet");
        // iat alone in the future (nbf in the past) is refused too
        expect(await reason(jwt({ iat: now() + 16, nbf: now() - 5 }))).toBe("token-iat-in-the-future");
        expect(await accepted(jwt({ iat: now() + 3 }))).toBe(true); // within 5 s
    });

    it("rejects an expired token beyond the tolerance (the host-clock-fast failure)", async () => {
        expect(await reason(jwt({ iat: now() - 120, exp: now() - 10 }))).toMatch(/expir/i);
        expect(await accepted(jwt({ iat: now() - 120, exp: now() - 2 }))).toBe(true); // within 5 s
    });

    it("rejects a not-yet-valid token (nbf in the future)", async () => {
        expect(await accepted(jwt({ nbf: now() + 30 }))).toBe(false);
    });

    it("rejects forged, tampered, unsigned and algorithm-confusion tokens", async () => {
        expect(await accepted(jwt({}, { key: other.privateKey }))).toBe(false);
        const [h, , s] = jwt({}).split(".");
        expect(await accepted(`${h}.${b64({ sub: "user_attacker", iat: now(), nbf: now() - 5, exp: now() + 60 })}.${s}`)).toBe(false);
        expect(await accepted(jwt({}, { header: { alg: "none", typ: "JWT" } }))).toBe(false);
        expect(await accepted(jwt({}, { header: { alg: "HS256", typ: "JWT" }, hmacKey: jwtKey }))).toBe(false);
    });
});

describe("clock offset diagnostic", () => {
    const fakeFetch = (dateHeader: string | null) => (async () => ({ headers: new Headers(dateHeader ? { date: dateHeader } : {}) })) as unknown as typeof fetch;

    it("measures the offset from the reference Date header and grades it", async () => {
        const ref = Date.parse("2026-10-26T10:00:00Z");
        const slow16 = await measureClockOffset("https://ref.example", fakeFetch(new Date(ref).toUTCString()), () => ref - 16_000 + 500);
        expect(slow16.offsetMs).toBe(-16_000);
        expect(clockLevel(slow16)).toBe("FAIL");
        const ok = await measureClockOffset("https://ref.example", fakeFetch(new Date(ref).toUTCString()), () => ref + 500);
        expect(Math.abs(ok.offsetMs)).toBeLessThan(10);
        expect(clockLevel(ok)).toBe("PASS");
    });

    it("refuses non-https references and missing Date headers", async () => {
        await expect(measureClockOffset("http://ref.example", fakeFetch("x"))).rejects.toThrow(/https/);
        await expect(measureClockOffset("https://ref.example", fakeFetch(null))).rejects.toThrow(/Date/);
    });
});

describe("transcription timeout", () => {
    it("scales with the audio length so long meetings are not killed (was a fixed 8 h)", async () => {
        const { transcriptionTimeoutMs } = await import("../src/recording/transcription");
        expect(transcriptionTimeoutMs(60)).toBe(30 * 60_000); // floor
        expect(transcriptionTimeoutMs(4 * 3600)).toBe(4 * 3600 * 12 * 1000); // 4 h meeting → 48 h cap
        expect(transcriptionTimeoutMs(4 * 3600, { TRANSCRIPTION_TIMEOUT_FACTOR: "6" } as any)).toBe(4 * 3600 * 6 * 1000);
    });
});
