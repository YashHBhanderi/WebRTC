import crypto from "crypto";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { api, makeUser, Session, testApp, uniq, legacyGlobal } from "./helpers";
import { createApp } from "../src/app";

/**
 * Phase 4 of the third-party API: OAuth 2.0 authorization code + PKCE (S256) with rotating refresh
 * tokens, built on the SpreeWe consent page. For apps without a backend (mobile, single-page).
 */
const http = () => request(testApp());
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const basic = (keyId: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` });
const REDIRECT = "https://app.example.com/oauth/callback";
const pkce = () => {
    const verifier = crypto.randomBytes(48).toString("base64url");
    return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};

async function registerApp(scopes = ["profile:read", "conversations:read"]) {
    const owner: Session = { user: await makeUser() };
    const app = (await api(owner).post("/v1/apps").send({ name: uniq("OAuth"), environment: "development", callbackUrls: [REDIRECT], allowedOrigins: ["https://app.example.com"], scopes })).body.data;
    await legacyGlobal(app?._id);
    expect(app?._id, "app registration").toBeTruthy();
    return { owner, app };
}

/** The browser leg: authorize → consent page → the user approves → back at the app with a code. */
async function authorizeAndApprove(appId: string, user: Session, scopes: string[], challenge: string, state = "state-123456") {
    const res = await http().get("/oauth/authorize").query({
        response_type: "code", client_id: appId, redirect_uri: REDIRECT, scope: scopes.join(" "), state, code_challenge: challenge, code_challenge_method: "S256",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(302);
    const requestId = new URL(res.headers.location, "https://spreewe.example").searchParams.get("request");
    expect(requestId, res.headers.location).toBeTruthy();
    const approved = await api(user).post(`/v1/consent-requests/${requestId}/approve`).send({ scopes });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const back = new URL(approved.body.data.redirectUrl);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe(state);
    expect(back.searchParams.get("grant")).toBeNull(); // OAuth gets a code, not the grant id
    return back.searchParams.get("code")!;
}

const exchange = (appId: string, code: string, verifier: string, extra: Record<string, unknown> = {}) =>
    http().post("/oauth/token").send({ grant_type: "authorization_code", client_id: appId, code, redirect_uri: REDIRECT, code_verifier: verifier, ...extra });
const refresh = (appId: string, token: string) => http().post("/oauth/token").send({ grant_type: "refresh_token", client_id: appId, refresh_token: token });

describe("OAuth 2.0 authorization code + PKCE", () => {
    it("full flow: authorize, consent, code exchange, API call, refresh rotation", async () => {
        const { app } = await registerApp();
        const user: Session = { user: await makeUser() };
        const { verifier, challenge } = pkce();
        const code = await authorizeAndApprove(app._id, user, ["profile:read"], challenge);
        expect(code).toMatch(/^swc_/);

        const tok = await exchange(app._id, code, verifier);
        expect(tok.status, JSON.stringify(tok.body)).toBe(200);
        expect(tok.headers["cache-control"]).toContain("no-store");
        expect(tok.body).toMatchObject({ token_type: "Bearer", scope: "profile:read" });
        expect(tok.body.refresh_token).toMatch(/^swr_/);
        expect(tok.body.expires_in).toBeGreaterThan(0);
        expect((await http().get("/v1/me").set(bearer(tok.body.access_token))).body.data.user._id).toBe(String(user.user._id));
        // Only the approved scope
        expect((await http().get("/v1/conversations").set(bearer(tok.body.access_token))).status).toBe(403);

        const r1 = await refresh(app._id, tok.body.refresh_token);
        expect(r1.status, JSON.stringify(r1.body)).toBe(200);
        expect(r1.body.refresh_token).not.toBe(tok.body.refresh_token);
        expect((await http().get("/v1/me").set(bearer(r1.body.access_token))).status).toBe(200);
    });

    it("rejects a wrong code_verifier, a reused code, a different redirect_uri and another client's code", async () => {
        const { app } = await registerApp();
        const { app: other } = await registerApp();
        const user: Session = { user: await makeUser() };

        const a = pkce();
        const code1 = await authorizeAndApprove(app._id, user, ["profile:read"], a.challenge);
        expect((await exchange(app._id, code1, pkce().verifier)).body.error).toBe("invalid_grant");
        // The code was consumed by that attempt: even the right verifier can't use it now
        expect((await exchange(app._id, code1, a.verifier)).body.error).toBe("invalid_grant");

        const b = pkce();
        const code2 = await authorizeAndApprove(app._id, user, ["profile:read"], b.challenge);
        expect((await exchange(app._id, code2, b.verifier, { redirect_uri: "https://app.example.com/other" })).body.error).toBe("invalid_grant");

        const c = pkce();
        const code3 = await authorizeAndApprove(app._id, user, ["profile:read"], c.challenge);
        expect((await exchange(other._id, code3, c.verifier)).body.error).toBe("invalid_grant");
        expect((await exchange(app._id, code3, c.verifier)).status).toBe(200); // not consumed by the other client
        expect((await exchange(app._id, code3, c.verifier)).body.error).toBe("invalid_grant"); // one use
    });

    it("refresh-token reuse revokes the whole family", async () => {
        const { app } = await registerApp();
        const user: Session = { user: await makeUser() };
        const { verifier, challenge } = pkce();
        const first = (await exchange(app._id, await authorizeAndApprove(app._id, user, ["profile:read"], challenge), verifier)).body;
        const second = (await refresh(app._id, first.refresh_token)).body;
        expect(second.refresh_token).toBeTruthy();
        // An attacker replays the first (already used) refresh token
        expect((await refresh(app._id, first.refresh_token)).body.error).toBe("invalid_grant");
        // …and the legitimate client's newer token is dead too
        expect((await refresh(app._id, second.refresh_token)).body.error).toBe("invalid_grant");
    });

    it("refresh stops working when the user withdraws the grant, on revocation, and on revoke-all", async () => {
        const user: Session = { user: await makeUser() };
        const start = async () => {
            const reg = await registerApp();
            const { verifier, challenge } = pkce();
            const t = (await exchange(reg.app._id, await authorizeAndApprove(reg.app._id, user, ["profile:read"], challenge), verifier)).body;
            return { ...reg, t };
        };

        const a = await start();
        const grants = (await api(user).get("/v1/me/app-grants")).body.data;
        const g = grants.find((x: any) => String(x.appId ?? x.app?._id) === a.app._id);
        expect((await api(user).delete(`/v1/me/app-grants/${g._id ?? g.grantId}`)).status).toBe(200);
        expect((await refresh(a.app._id, a.t.refresh_token)).body.error).toBe("invalid_grant");

        const b = await start();
        expect((await http().post("/oauth/revoke").send({ client_id: b.app._id, token: b.t.refresh_token })).status).toBe(200);
        expect((await refresh(b.app._id, b.t.refresh_token)).body.error).toBe("invalid_grant");
        // Unknown tokens are not an error (RFC 7009)
        expect((await http().post("/oauth/revoke").send({ client_id: b.app._id, token: "swr_unknown" })).status).toBe(200);

        const c = await start();
        expect((await api(c.owner).post(`/v1/apps/${c.app._id}/tokens/revoke-all`).send({ confirm: c.app.name })).status).toBe(201);
        expect((await refresh(c.app._id, c.t.refresh_token)).body.error).toBe("invalid_grant");
        expect((await http().get("/v1/me").set(bearer(c.t.access_token))).status).toBe(401);
    });

    it("authorize validates client, redirect, PKCE and scopes; denial returns access_denied", async () => {
        const { app } = await registerApp(["profile:read"]);
        const { challenge } = pkce();
        const q = { response_type: "code", client_id: app._id, redirect_uri: REDIRECT, scope: "profile:read", state: "state-123456", code_challenge: challenge, code_challenge_method: "S256" };
        // Unknown client / unregistered redirect: answered directly, never redirected
        expect((await http().get("/oauth/authorize").query({ ...q, client_id: "000000000000000000000000" })).status).toBe(401);
        const badRedirect = await http().get("/oauth/authorize").query({ ...q, redirect_uri: "https://evil.example/cb" });
        expect(badRedirect.status).toBe(400);
        expect(badRedirect.headers.location).toBeUndefined();
        // Other problems go back to the registered redirect_uri
        const errorOf = (res: request.Response) => new URL(res.headers.location).searchParams.get("error");
        expect(errorOf(await http().get("/oauth/authorize").query({ ...q, code_challenge_method: "plain" }))).toBe("invalid_request");
        expect(errorOf(await http().get("/oauth/authorize").query({ ...q, code_challenge: undefined }))).toBe("invalid_request");
        expect(errorOf(await http().get("/oauth/authorize").query({ ...q, scope: "messages:read" }))).toBe("invalid_scope");
        expect(errorOf(await http().get("/oauth/authorize").query({ ...q, response_type: "token" }))).toBe("unsupported_response_type");

        const res = await http().get("/oauth/authorize").query(q);
        const requestId = new URL(res.headers.location, "https://spreewe.example").searchParams.get("request");
        const denied = await api({ user: await makeUser() }).post(`/v1/consent-requests/${requestId}/deny`).send({});
        expect(new URL(denied.body.data.redirectUrl).searchParams.get("error")).toBe("access_denied");
    });

    it("client credentials, when sent, must belong to client_id; unsupported grants are refused", async () => {
        const { owner, app } = await registerApp();
        const { app: other } = await registerApp();
        const cred = (await api(owner).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name })).body.data;
        const user: Session = { user: await makeUser() };
        const { verifier, challenge } = pkce();
        const code = await authorizeAndApprove(app._id, user, ["profile:read"], challenge);
        const wrong = await http().post("/oauth/token").set(basic(cred.credential.keyId, cred.secret))
            .send({ grant_type: "authorization_code", client_id: other._id, code, redirect_uri: REDIRECT, code_verifier: verifier });
        expect(wrong.body.error).toBe("invalid_client");
        const ok = await http().post("/oauth/token").set(basic(cred.credential.keyId, cred.secret))
            .send({ grant_type: "authorization_code", client_id: app._id, code, redirect_uri: REDIRECT, code_verifier: verifier });
        expect(ok.status, JSON.stringify(ok.body)).toBe(200);
        expect((await http().post("/oauth/token").send({ grant_type: "password", client_id: app._id })).body.error).toBe("unsupported_grant_type");
        // Form-encoded bodies work too (RFC 6749)
        const form = await http().post("/oauth/token").type("form").send({ grant_type: "refresh_token", client_id: app._id, refresh_token: ok.body.refresh_token });
        expect(form.status, JSON.stringify(form.body)).toBe(200);
    });
});

describe("CORS for registered app origins", () => {
    it("allows a registered app origin on session routes too (not only /v1); unknown origins are not allowed", async () => {
        await registerApp();
        // A server configured like production: an explicit first-party origin list (the shared test app allows *)
        const strict = createApp(["https://spreewe.example"]);
        const pre = await request(strict).options("/conversations").set("Origin", "https://app.example.com").set("Access-Control-Request-Method", "GET");
        expect(pre.headers["access-control-allow-origin"]).toBe("https://app.example.com");
        const evil = await request(strict).options("/conversations").set("Origin", "https://evil.example").set("Access-Control-Request-Method", "GET");
        expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    });
});
