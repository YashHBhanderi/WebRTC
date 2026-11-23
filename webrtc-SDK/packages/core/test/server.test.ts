// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import * as core from "@spreewe/core";
import { SpreeWeServerClient, createServerClient, type AppUser } from "@spreewe/core/server";

/** Server client: app-user management and token exchange with the app credential (never in a browser). */
const KEY = "swk_test_abcdefgh1234";
const SECRET = "sws_secret-value-that-must-not-leak";

interface Call { method: string; url: string; headers: Record<string, string>; body: any }

function fake(handler: (call: Call) => { status: number; body: unknown; headers?: Record<string, string> }) {
    const calls: Call[] = [];
    const fetchImpl = (async (url: any, init: any = {}) => {
        const call: Call = { method: init.method, url: String(url), headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined };
        calls.push(call);
        const r = handler(call);
        return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json", ...(r.headers || {}) } });
    }) as unknown as typeof fetch;
    return { calls, client: createServerClient({ baseUrl: "https://api.example.com/api/", keyId: KEY, secret: SECRET, fetch: fetchImpl }) };
}

const user = (over: Partial<AppUser> = {}): AppUser => ({
    _id: "6b01aa", externalUserId: "u-1", name: "Asha Rao", email: null, avatarUrl: "", status: "active", tenantId: "6ad9", createdAt: "2026-11-16T00:00:00.000Z", deactivatedAt: null, ...over,
});
const token = (over: Record<string, unknown> = {}) => ({
    accessToken: "tok-1", tokenType: "Bearer", expiresIn: 600, expiresAt: new Date(Date.now() + 600_000).toISOString(), scopes: ["profile:read"], tokenId: "j1", tenantId: "6ad9", ...over,
});

describe("SpreeWeServerClient", () => {
    afterEach(() => { delete (globalThis as any).document; });

    it("is not part of the browser entry point and refuses to run where a DOM exists", () => {
        expect((core as any).SpreeWeServerClient).toBeUndefined();
        expect((core as any).createServerClient).toBeUndefined();
        (globalThis as any).document = {};
        expect(() => new SpreeWeServerClient({ baseUrl: "https://x.test", keyId: KEY, secret: SECRET })).toThrow(/never in a browser/);
    });

    it("validates its options and never exposes the secret", () => {
        expect(() => createServerClient({ baseUrl: "", keyId: KEY, secret: SECRET })).toThrow(/baseUrl/);
        expect(() => createServerClient({ baseUrl: "https://x.test", keyId: "nope", secret: SECRET })).toThrow(/keyId/);
        expect(() => createServerClient({ baseUrl: "https://x.test", keyId: KEY, secret: "nope" })).toThrow(/secret/);
        const { client } = fake(() => ({ status: 200, body: {} }));
        expect(JSON.stringify(client)).not.toContain(SECRET);
        expect(Object.values(client as any).some((v) => typeof v === "string" && v.includes(SECRET))).toBe(false);
    });

    it("registers a user with HTTP Basic credentials and sends no tenant", async () => {
        const { client, calls } = fake(() => ({ status: 201, body: { data: user() } }));
        const created = await client.users.register({ externalUserId: "u-1", name: "Asha Rao", email: "asha@example.com" });
        expect(created).toMatchObject({ _id: "6b01aa", externalUserId: "u-1", tenantId: "6ad9" });
        expect(calls).toHaveLength(1);
        expect(calls[0].method).toBe("POST");
        expect(calls[0].url).toBe("https://api.example.com/api/v1/app-users");
        expect(calls[0].headers.Authorization).toBe(`Basic ${btoa(`${KEY}:${SECRET}`)}`);
        expect(calls[0].body).toEqual({ externalUserId: "u-1", name: "Asha Rao", email: "asha@example.com" });
        expect(calls[0].body).not.toHaveProperty("tenantId");
    });

    it("rejects malformed external ids before any request (no path injection)", async () => {
        const { client, calls } = fake(() => ({ status: 200, body: { data: user() } }));
        for (const bad of ["", "a b", "../apps", "u/1", "x".repeat(201), undefined as any]) {
            await expect(client.users.get(bad)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
            await expect(client.users.register({ externalUserId: bad, name: "Some One" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
            await expect(client.userToken(bad)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        }
        expect(calls).toHaveLength(0);
        await client.users.get("org|user:42@x.y");
        expect(calls[0].url).toBe("https://api.example.com/api/v1/app-users/org%7Cuser%3A42%40x.y");
    });

    it("maps server errors: 409 duplicate, 404 unknown (or another app's) user, 403 app without a tenant", async () => {
        const { client } = fake((c) => c.method === "POST"
            ? { status: 409, body: { error: { code: "CONFLICT_ERROR", message: "A user with this externalUserId is already registered" } } }
            : c.url.endsWith("/theirs")
                ? { status: 404, body: { error: { code: "NOT_FOUND_ERROR", message: "User not found" } } }
                : { status: 403, body: { error: { code: "PERMISSION_ERROR", message: "This app has no tenant of its own" } } });
        await expect(client.users.register({ externalUserId: "u-1", name: "Asha Rao" })).rejects.toMatchObject({ status: 409, code: "CONFLICT_ERROR" });
        await expect(client.users.get("theirs")).rejects.toMatchObject({ status: 404, code: "NOT_FOUND_ERROR" });
        await expect(client.users.get("mine")).rejects.toMatchObject({ status: 403, code: "PERMISSION_ERROR" });
        const err = await client.users.get("theirs").catch((e) => e);
        expect(core.isSpreeWeError(err)).toBe(true);
        expect(`${err.message} ${JSON.stringify(err)}`).not.toContain(SECRET);
    });

    it("ensure() returns the existing user on 409 and passes other errors through", async () => {
        const a = fake((c) => c.method === "POST" ? { status: 409, body: { error: { code: "CONFLICT_ERROR", message: "exists" } } } : { status: 200, body: { data: user({ name: "Stored Name" }) } });
        expect((await a.client.users.ensure({ externalUserId: "u-1", name: "New Name" })).name).toBe("Stored Name");
        expect(a.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
        const b = fake(() => ({ status: 400, body: { error: { code: "VALIDATION_ERROR", message: "bad" } } }));
        await expect(b.client.users.ensure({ externalUserId: "u-1", name: "x" })).rejects.toMatchObject({ status: 400 });
        expect(b.calls).toHaveLength(1);
    });

    it("lists a page, and all() follows cursors to the end", async () => {
        const { client, calls } = fake((c) => {
            const cursor = new URL(c.url).searchParams.get("cursor");
            return cursor === "c2"
                ? { status: 200, body: { data: [user({ externalUserId: "u-3" })], page: { nextCursor: null } } }
                : { status: 200, body: { data: [user({ externalUserId: "u-1" }), user({ externalUserId: "u-2" })], page: { nextCursor: "c2" } } };
        });
        const page = await client.users.list({ limit: 2, status: "active" });
        expect(page.items.map((u) => u.externalUserId)).toEqual(["u-1", "u-2"]);
        expect(page.nextCursor).toBe("c2");
        expect(calls[0].url).toBe("https://api.example.com/api/v1/app-users?limit=2&status=active");
        const seen: string[] = [];
        for await (const u of client.users.all({ status: "active" })) seen.push(u.externalUserId);
        expect(seen).toEqual(["u-1", "u-2", "u-3"]);
        expect(calls[calls.length - 1].url).toContain("cursor=c2");
    });

    it("updates, clears fields with null, deactivates and reactivates", async () => {
        const { client, calls } = fake((c) => c.method === "DELETE" ? { status: 200, body: { data: { deactivated: true } } } : { status: 200, body: { data: user() } });
        await client.users.update("u-1", { name: "New Name", email: null, avatarUrl: null });
        expect(calls[0]).toMatchObject({ method: "PATCH", url: "https://api.example.com/api/v1/app-users/u-1", body: { name: "New Name", email: "", avatarUrl: "" } });
        await client.users.deactivate("u-1");
        expect(calls[1]).toMatchObject({ method: "DELETE", url: "https://api.example.com/api/v1/app-users/u-1" });
        await client.users.reactivate("u-1");
        expect(calls[2]).toMatchObject({ method: "PATCH", body: { active: true } });
    });

    it("exchanges the credential for a user token, caches it per user and scopes, and shares concurrent requests", async () => {
        let n = 0;
        const { client, calls } = fake(() => ({ status: 201, body: { data: token({ accessToken: `tok-${++n}` }) } }));
        const [a, b] = await Promise.all([client.userToken("u-1"), client.userToken("u-1")]);
        expect(a.accessToken).toBe("tok-1");
        expect(b).toBe(a);
        expect((await client.userToken("u-1")).accessToken).toBe("tok-1");
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ method: "POST", url: "https://api.example.com/api/v1/app-tokens", body: { externalUserRef: "u-1" } });
        // Another user, other scopes and forceRefresh each ask again; one user's token is never returned for another
        expect((await client.userToken("u-2")).accessToken).toBe("tok-2");
        expect((await client.userToken("u-1", { scopes: ["profile:read"] })).accessToken).toBe("tok-3");
        expect(calls[2].body).toEqual({ externalUserRef: "u-1", scopes: ["profile:read"] });
        expect((await client.userToken("u-1", { forceRefresh: true })).accessToken).toBe("tok-4");
        expect((await client.userToken("u-1", { ttlSeconds: 120 })).accessToken).toBe("tok-5");
        expect(calls[4].body).toEqual({ externalUserRef: "u-1", ttlSeconds: 120 });
    });

    it("refreshes a token that is about to expire, and drops cached tokens on deactivate and revoke", async () => {
        let n = 0;
        const { client, calls } = fake((c) => c.url.endsWith("/app-tokens")
            ? { status: 201, body: { data: token({ accessToken: `tok-${++n}`, expiresAt: new Date(Date.now() + (n === 1 ? 30_000 : 600_000)).toISOString() }) } }
            : { status: 200, body: { data: {} } });
        expect((await client.userToken("u-1")).accessToken).toBe("tok-1"); // expires in 30 s: inside the margin
        expect((await client.userToken("u-1")).accessToken).toBe("tok-2");
        expect((await client.userToken("u-1")).accessToken).toBe("tok-2");
        await client.users.deactivate("u-1");
        expect((await client.userToken("u-1")).accessToken).toBe("tok-3");
        await client.revokeToken("tok-3");
        expect(calls[calls.length - 1]).toMatchObject({ url: "https://api.example.com/api/v1/app-tokens/revoke", body: { token: "tok-3" } });
        expect((await client.userToken("u-1")).accessToken).toBe("tok-4");
    });

    it("a refused token exchange (unknown or deactivated user) is not cached", async () => {
        let ok = false;
        const { client } = fake(() => ok ? { status: 201, body: { data: token() } } : { status: 403, body: { error: { code: "PERMISSION_ERROR", message: "This user has not authorised the app" } } });
        await expect(client.userToken("u-1")).rejects.toMatchObject({ status: 403 });
        ok = true;
        expect((await client.userToken("u-1")).accessToken).toBe("tok-1");
    });

    it("reports network failures and timeouts without leaking the credential", async () => {
        const down = createServerClient({ baseUrl: "https://x.test", keyId: KEY, secret: SECRET, fetch: (async () => { throw new TypeError(`fetch failed for Basic ${btoa(`${KEY}:${SECRET}`)}`); }) as any });
        const e1 = await down.users.get("u-1").catch((e) => e);
        expect(e1).toMatchObject({ code: "NETWORK_ERROR" });
        expect(e1.message).not.toContain("Basic");
        const slow = createServerClient({ baseUrl: "https://x.test", keyId: KEY, secret: SECRET, timeoutMs: 20, fetch: ((_u: any, init: any) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as any });
        await expect(slow.users.get("u-1")).rejects.toMatchObject({ code: "TIMEOUT" });
        const limited = fake(() => ({ status: 429, body: { error: { code: "RATE_LIMIT_ERROR", message: "Too many requests" } }, headers: { "Retry-After": "7" } }));
        await expect(limited.client.users.list()).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 });
    });
});
