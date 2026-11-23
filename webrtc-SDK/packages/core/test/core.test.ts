import { describe, expect, it, vi } from "vitest";
import {
    HttpClient,
    RealtimeClient,
    SpreeWeError,
    Store,
    backendTokenProvider,
    codeChallengeS256,
    createOAuthClient,
    decodeJwt,
    derived,
    errorFromResponse,
    isAppToken,
    isSpreeWeError,
    scopesFor,
    type TokenProvider,
} from "@spreewe/core";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const b64u = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (claims: object, header: object = { alg: "HS256", kid: "spreewe-app-v1" }) => `${b64u(header)}.${b64u(claims)}.sig`;

describe("Store", () => {
    it("notifies subscribers and supports derived values", () => {
        const a = new Store(1);
        const b = new Store(2);
        const sum = derived([a, b] as const, (x, y) => x + y);
        const seen: number[] = [];
        const off = sum.subscribe((v) => seen.push(v));
        a.set(5);
        b.update((v) => v + 1);
        off();
        a.set(10);
        expect(seen).toEqual([3, 7, 8]);
    });
});

describe("errors and tokens", () => {
    it("maps the three backend error formats", () => {
        const v1 = errorFromResponse(400, { error: { code: "VALIDATION_ERROR", message: "bad", details: [{ path: "x" }] } });
        expect([v1.code, v1.status, v1.message]).toEqual(["VALIDATION_ERROR", 400, "bad"]);
        const legacy = errorFromResponse(403, { status: false, message: "No" });
        expect([legacy.code, legacy.message]).toEqual(["FORBIDDEN", "No"]);
        const oauth = errorFromResponse(400, { error: "invalid_grant", error_description: "used" });
        expect([oauth.code, oauth.message]).toEqual(["OAUTH_ERROR", "used"]);
        expect(errorFromResponse(502, null).code).toBe("SERVER_ERROR");
    });

    it("reads JWT claims and recognises app tokens", () => {
        const t = jwt({ sub: "u1", scp: ["profile:read"], exp: 2_000_000_000 });
        expect(decodeJwt(t)?.scp).toEqual(["profile:read"]);
        expect(isAppToken(t)).toBe(true);
        expect(isAppToken(jwt({ sub: "user_1" }, { alg: "RS256", kid: "ins_1" }))).toBe(false);
        expect(decodeJwt("not-a-jwt")).toBeNull();
    });

    it("lists the scopes features need", () => {
        const s = scopesFor(["chat"]);
        expect(s).toContain("messages:read");
        expect(s).not.toContain("e2ee:device");
        expect(scopesFor(["chat"], { includeOptional: true })).toContain("e2ee:device");
    });
});

describe("HttpClient", () => {
    const provider = (): TokenProvider & { calls: boolean[] } => {
        const calls: boolean[] = [];
        return { kind: "app", calls, getToken: async (o) => (calls.push(!!o?.forceRefresh), o?.forceRefresh ? "fresh" : "stale") };
    };

    it("unwraps { data } and cursor pages, and sends the bearer token", async () => {
        const fetch = vi.fn(async (url: string, init: RequestInit) => {
            expect((init.headers as Record<string, string>).Authorization).toBe("Bearer stale");
            return url.includes("/v1/directory") ? json(200, { data: [{ _id: "1" }], page: { nextCursor: "c2" } }) : json(200, { success: true, data: { ok: 1 } });
        });
        const http = new HttpClient({ baseUrl: "https://api.test/", auth: provider(), fetch: fetch as any });
        expect(await http.get("/x")).toEqual({ ok: 1 });
        expect(await http.page("/v1/directory", { query: { q: "a", cursor: undefined } })).toEqual({ items: [{ _id: "1" }], nextCursor: "c2" });
        expect(fetch.mock.calls[1][0]).toBe("https://api.test/v1/directory?q=a");
    });

    it("retries once with a refreshed token after 401", async () => {
        const auth = provider();
        const fetch = vi.fn(async (_u: string, init: RequestInit) =>
            (init.headers as Record<string, string>).Authorization === "Bearer fresh" ? json(200, { data: 1 }) : json(401, { error: { code: "UNAUTHENTICATED", message: "x" } }),
        );
        const http = new HttpClient({ baseUrl: "https://api.test", auth, fetch: fetch as any });
        expect(await http.get("/x")).toBe(1);
        expect(auth.calls).toEqual([false, true]);
    });

    it("downloads binary content with auth and maps errors", async () => {
        const auth = provider();
        const fetch = vi.fn(async (url: string, init: RequestInit) => {
            const h = init.headers as Record<string, string>;
            if (h.Authorization !== "Bearer fresh") return json(401, { error: { code: "UNAUTHENTICATED", message: "x" } });
            if (url.endsWith("/missing")) return json(404, { error: { code: "NOT_FOUND", message: "Attachment not found" } });
            expect(h.Accept).toBe("application/octet-stream");
            return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
        });
        const http = new HttpClient({ baseUrl: "https://api.test", auth, fetch: fetch as any });
        expect([...new Uint8Array(await http.binary("/v1/messages/m1/attachment"))]).toEqual([1, 2, 3]);
        expect(auth.calls).toEqual([false, true]);
        const err = await http.binary("/missing").catch((e) => e);
        expect(err).toBeInstanceOf(SpreeWeError);
        expect(err.status).toBe(404);
    });

    it("retries a rate-limited request after Retry-After, then reports RATE_LIMITED", async () => {
        let n = 0;
        const fetch = vi.fn(async () => (++n === 1 ? json(429, { success: false, message: "slow" }, { "Retry-After": "0" }) : json(200, { data: "ok" })));
        const http = new HttpClient({ baseUrl: "https://api.test", auth: provider(), fetch: fetch as any });
        expect(await http.post("/x", {})).toBe("ok");
        const always = new HttpClient({ baseUrl: "https://api.test", auth: provider(), fetch: (async () => json(429, { success: false, message: "slow" }, { "Retry-After": "0" })) as any });
        const err = await always.get("/x").catch((e) => e);
        expect(isSpreeWeError(err, "RATE_LIMITED")).toBe(true);
    });

    it("treats 200 { status: false } as a failure, and times out", async () => {
        const http = new HttpClient({ baseUrl: "https://api.test", auth: provider(), fetch: (async () => json(200, { status: false, message: "Nope" })) as any });
        expect(((await http.get("/x").catch((e) => e)) as SpreeWeError).message).toBe("Nope");
        const slow = new HttpClient({
            baseUrl: "https://api.test",
            auth: provider(),
            timeoutMs: 20,
            fetch: ((_u: string, init: RequestInit) => new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as any,
        });
        expect(isSpreeWeError(await slow.get("/x").catch((e) => e), "TIMEOUT")).toBe(true);
    });
});

describe("token providers", () => {
    it("backendTokenProvider caches until the refresh margin and shares in-flight fetches", async () => {
        let n = 0;
        const p = backendTokenProvider({ fetchToken: async () => ({ accessToken: `t${++n}`, expiresIn: 600 }) });
        const [a, b] = await Promise.all([p.getToken(), p.getToken()]);
        expect([a, b, n]).toEqual(["t1", "t1", 1]);
        expect(await p.getToken({ forceRefresh: true })).toBe("t2");
        const short = backendTokenProvider({ fetchToken: async () => ({ accessToken: `s${++n}`, expiresIn: 30 }) });
        await short.getToken();
        expect(await short.getToken()).not.toBe(`s${n - 1}`);
    });
});

describe("OAuthClient", () => {
    it("builds an S256 authorize URL and exchanges the callback code once", async () => {
        const fetch = vi.fn(async (url: string, init: RequestInit) => {
            const body = new URLSearchParams(String(init.body));
            expect(url).toBe("https://api.test/oauth/token");
            expect(body.get("grant_type")).toBe("authorization_code");
            expect(await codeChallengeS256(body.get("code_verifier")!)).toBe(challenge);
            return json(200, { access_token: "at", refresh_token: "swr_1", expires_in: 600, scope: "profile:read" });
        });
        const oauth = createOAuthClient({ baseUrl: "https://api.test", clientId: "app1", redirectUri: "https://app.test/cb", scopes: ["profile:read"], storage: "memory", fetch: fetch as any });
        const url = new URL(await oauth.createAuthorizeUrl());
        const challenge = url.searchParams.get("code_challenge")!;
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("scope")).toBe("profile:read");
        const state = url.searchParams.get("state")!;
        expect(state.length).toBeGreaterThanOrEqual(8);
        const tokens = await oauth.handleRedirectCallback(`https://app.test/cb?state=${state}&code=swc_1`, { replaceUrl: false });
        expect(tokens.accessToken).toBe("at");
        expect(await oauth.getToken()).toBe("at");
        // The pending authorization is consumed: replaying the callback fails
        const replay = await oauth.handleRedirectCallback(`https://app.test/cb?state=${state}&code=swc_1`, { replaceUrl: false }).catch((e) => e);
        expect(isSpreeWeError(replay, "OAUTH_STATE_MISMATCH")).toBe(true);
    });

    it("signs out when the refresh token is refused", async () => {
        let call = 0;
        const fetch = vi.fn(async () =>
            ++call === 1 ? json(200, { access_token: "at", refresh_token: "swr_1", expires_in: 1, scope: "" }) : json(400, { error: "invalid_grant", error_description: "revoked" }),
        );
        const oauth = createOAuthClient({ baseUrl: "https://api.test", clientId: "app1", redirectUri: "https://app.test/cb", scopes: [], storage: "memory", fetch: fetch as any });
        const state = new URL(await oauth.createAuthorizeUrl()).searchParams.get("state");
        await oauth.handleRedirectCallback(`https://app.test/cb?state=${state}&code=c`, { replaceUrl: false });
        const reasons: string[] = [];
        oauth.onSignedOut((r) => reasons.push(r));
        // expires_in 1 s is inside the refresh margin: getToken refreshes, the server refuses
        expect(isSpreeWeError(await oauth.getToken().catch((e) => e), "SIGNED_OUT")).toBe(true);
        expect(oauth.isSignedIn).toBe(false);
        expect(reasons).toEqual(["revoked"]);
    });
});

/** Minimal stand-in for a socket.io-client Socket (library double; the server side is covered by integration tests) */
class FakeSocket {
    connected = false;
    active = true;
    id = "s1";
    handlers = new Map<string, ((...a: any[]) => void)[]>();
    emitted: unknown[][] = [];
    auths: object[] = [];
    acks = new Map<string, (payload: unknown) => unknown>();
    constructor(private readonly opts: any) {}
    on(e: string, h: (...a: any[]) => void) {
        this.handlers.set(e, [...(this.handlers.get(e) || []), h]);
        return this;
    }
    trigger(e: string, ...a: unknown[]) {
        for (const h of this.handlers.get(e) || []) h(...a);
    }
    connect() {
        this.opts.auth((data: object) => {
            this.auths.push(data);
            queueMicrotask(() => this.onHandshake?.(data));
        });
        return this;
    }
    onHandshake?: (data: any) => void;
    disconnect() {
        this.connected = false;
        return this;
    }
    emit(...a: unknown[]) {
        this.emitted.push(a);
        return this;
    }
    timeout(ms: number) {
        return {
            emit: (event: string, payload: unknown, cb: (err: Error | null, res?: unknown) => void) => {
                const ack = this.acks.get(event);
                if (ack) queueMicrotask(() => cb(null, ack(payload)));
                else setTimeout(() => cb(new Error("operation has timed out")), ms);
            },
        };
    }
}

describe("RealtimeClient", () => {
    function setup(handshake: (data: any, s: FakeSocket) => void) {
        let socket!: FakeSocket;
        const forces: boolean[] = [];
        const auth: TokenProvider = { kind: "app", getToken: async (o) => (forces.push(!!o?.forceRefresh), "tok") };
        const rt = new RealtimeClient({ url: "https://api.test", auth, socketFactory: ((_u: string, o: any) => (socket = new FakeSocket(o))) as any });
        const ready = rt.connect();
        const wait = async () => {
            while (!socket) await new Promise((r) => setTimeout(r, 1));
            return socket;
        };
        void wait().then((s) => (s.onHandshake = (d) => handshake(d, s)));
        return { rt, ready, forces, socket: wait };
    }

    const accept = (_d: unknown, s: FakeSocket) => {
        s.connected = true;
        s.trigger("connect");
    };

    it("sends a fresh token, re-joins rooms on every connect and reconnects after a server-side close", async () => {
        const { rt, ready, forces, socket } = setup(accept);
        await ready;
        const s = await socket();
        rt.joinConversation("c1");
        expect(s.emitted).toContainEqual(["joinConversation", "c1"]);
        s.emitted.length = 0;
        // Server closed the socket (token expired): reconnect with a forced refresh, re-join
        vi.useFakeTimers();
        s.connected = false;
        s.trigger("disconnect", "io server disconnect");
        expect(rt.state.value).toBe("offline");
        await vi.advanceTimersByTimeAsync(2000);
        vi.useRealTimers();
        await new Promise((r) => setTimeout(r, 5));
        expect(rt.state.value).toBe("connected");
        expect(forces.at(-1)).toBe(true);
        expect(s.emitted).toContainEqual(["joinConversation", "c1"]);
    });

    it("fails fast without the realtime:connect scope", async () => {
        const { ready, rt } = setup((_d, s) => {
            s.active = false;
            s.trigger("connect_error", new Error("The token lacks the realtime:connect scope"));
        });
        expect(isSpreeWeError(await ready.catch((e) => e), "MISSING_SCOPE")).toBe(true);
        expect(rt.state.value).toBe("failed");
    });

    it("rejects { error } acks and times out unanswered requests", async () => {
        const { rt, ready, socket } = setup(accept);
        await ready;
        const s = await socket();
        s.acks.set("chat:archive", () => ({ error: "Conversation not found" }));
        s.acks.set("call:session", () => ({ elsewhere: false }));
        expect(await rt.request("call:session")).toEqual({ elsewhere: false });
        const refused = await rt.request("chat:archive", { conversationId: "x" }).catch((e) => e);
        expect(isSpreeWeError(refused, "SOCKET_REFUSED")).toBe(true);
        const raw = await rt.request("chat:archive", {}, { raw: true });
        expect(raw).toEqual({ error: "Conversation not found" });
        expect(isSpreeWeError(await rt.request("message:edit", {}, { timeoutMs: 10 }).catch((e) => e), "ACK_TIMEOUT")).toBe(true);
    });
});
