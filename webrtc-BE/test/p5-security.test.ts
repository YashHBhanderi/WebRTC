import fs from "fs";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { redact, sanitizeArgs } from "../src/utils/safe-log";
import { AppCredential, ConsentRequest } from "../src/developer/models";
import { runAsSystem } from "../src/tenancy/context";
import { api, enter, makeUser, newOrg, Session, testApp, uniq, legacyGlobal } from "./helpers";

const http = () => request(testApp());
const basic = (keyId: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` });
const CB = "https://example.com/cb";

async function registerApp(owner: Session, body: Record<string, unknown> = {}) {
    const name = uniq("App");
    const created = await api(owner).post("/v1/apps").send({ name, environment: "development", callbackUrls: [CB], scopes: ["profile:read", "messages:read"], ...body });
    await legacyGlobal(created.body?.data?._id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.data;
    const cred = await api(owner).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name });
    return { app, keyId: cred.body.data.credential.keyId as string, credentialId: cred.body.data.credential._id as string, secret: cred.body.data.secret as string };
}

const startConsent = (reg: { keyId: string; secret: string }, body: Record<string, unknown>) =>
    http().post("/v1/consent-requests").set(basic(reg.keyId, reg.secret)).send({ redirectUri: CB, scopes: ["profile:read"], state: "state-123456", ...body });

// ---------------------------------------------------------------- F1: log redaction
describe("F1 — logs never carry message content, emails, tokens, secrets or query strings", () => {
    it("redacts Mongoose / driver echoes, URLs, tokens and secrets", () => {
        const dup = new Error('E11000 duplicate key error collection: users index: email_1 dup key: { email: "alice@example.com" }');
        const validation = new Error('Message validation failed: type: `my private secret text` is not a valid enum value for path `type`.');
        const cast = new Error('Cast to ObjectId failed for value "private payload here" (type string) at path "_id"');
        const out = sanitizeArgs([dup, validation, cast]).join(" ");
        expect(out).not.toContain("alice@example.com");
        expect(out).not.toContain("my private secret text");
        expect(out).not.toContain("private payload here");
        expect(redact("GET /messages/abc/search?q=salary+review 500")).toBe("GET /messages/abc/search?[query] 500");
        expect(redact("https://x.example.com/uploads/a.pdf?exp=1&sig=abc")).toBe("https://x.example.com/uploads/a.pdf?[query]");
        expect(redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl")).not.toContain("eyJ");
        expect(redact("Authorization: Bearer opaque0123456789token")).toBe("Authorization: Bearer [redacted]");
        expect(redact("secret sws_abcdefghijklmnopqrstuvwxyz0123456789")).not.toContain("sws_abc");
        expect(redact("whsec_abcdefghijklmnop and swh_abcdefghijklmnop")).toBe("[secret] and [secret]");
        expect(redact("x".repeat(5000)).length).toBeLessThan(2100);
    });

    it("is installed before anything else in the server entrypoint", () => {
        const server = fs.readFileSync(path.join(__dirname, "..", "src", "server.ts"), "utf8");
        const install = server.indexOf("installSafeConsole();");
        expect(install).toBeGreaterThan(0);
        expect(install).toBeLessThan(server.indexOf('from "./app"'));
    });
});

// ---------------------------------------------------------------- F2: account-linking injection + consent flow
describe("F2 — externalUserRef can only be linked through an app-initiated consent request", () => {
    let owner: any, alice: any, mallory: any;
    let reg: Awaited<ReturnType<typeof registerApp>>;
    beforeAll(async () => {
        [owner, alice, mallory] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        reg = await registerApp({ user: owner });
    });

    it("a user can no longer attach an arbitrary externalUserRef to their own grant (was: hijack of another person's link)", async () => {
        const res = await api({ user: mallory }).post(`/v1/apps/${reg.app._id}/grants`).send({ scopes: ["profile:read"], externalUserRef: `yourapp-user-${alice._id}` });
        expect(res.status).toBe(400);
        // so the app server can't be tricked into minting mallory's token for alice's reference
        expect((await http().post("/v1/app-tokens").set(basic(reg.keyId, reg.secret)).send({ externalUserRef: `yourapp-user-${alice._id}` })).status).toBe(403);
    });

    it("consent requests need the app credential, an exactly registered redirect, and requested scopes within the app", async () => {
        expect((await http().post("/v1/consent-requests").send({ redirectUri: CB, scopes: ["profile:read"], state: "state-123456" })).status).toBe(401);
        for (const redirectUri of ["https://example.com/cb/../evil", "https://example.com/cbx", "https://evil.example.com/cb", "http://example.com/cb", "javascript:alert(1)"]) {
            expect((await startConsent(reg, { redirectUri })).status, redirectUri).toBe(400);
        }
        expect((await startConsent(reg, { scopes: ["calls:read"] })).status).toBe(403);
        expect((await startConsent(reg, { scopes: [] })).status).toBe(400);
        expect((await startConsent(reg, { state: "short" })).status).toBe(400);
    });

    it("approval is by the signed-in user, for a subset of the request, once; denial redirects with error and state", async () => {
        const created = (await startConsent(reg, { scopes: ["profile:read", "messages:read"], externalUserRef: `yourapp-user-${alice._id}` })).body.data;
        const id = created.requestId;
        expect(created.consentUrl).toContain(`/consent?request=${id}`);
        const view = (await api({ user: alice }).get(`/v1/consent-requests/${id}`)).body.data;
        expect(view.app.name).toBe(reg.app.name);
        expect(view.scopes.map((s: any) => s.scope)).toEqual(["profile:read", "messages:read"]);
        expect(view.scopes.find((s: any) => s.scope === "messages:read").sensitive).toBe(true);
        expect(view.contextMatches).toBe(true);
        expect((await api({ user: alice }).post(`/v1/consent-requests/${id}/approve`).send({ scopes: ["calls:read"] })).status).toBe(403);
        expect((await api({ user: alice }).post(`/v1/consent-requests/${id}/approve`).send({ scopes: [] })).status).toBe(400);
        const ok = await api({ user: alice }).post(`/v1/consent-requests/${id}/approve`).send({ scopes: ["profile:read"] });
        expect(ok.status).toBe(201);
        expect(ok.body.data.redirectUrl).toMatch(/^https:\/\/example\.com\/cb\?state=state-123456&result=approved&grant=/);
        // One-time
        expect((await api({ user: alice }).post(`/v1/consent-requests/${id}/approve`).send({ scopes: ["profile:read"] })).status).toBe(404);
        expect((await api({ user: mallory }).get(`/v1/consent-requests/${id}`)).status).toBe(404);
        // One-time under concurrency: of parallel approvals exactly one wins (atomic claim, not the pre-check)
        const race = (await startConsent(reg, { scopes: ["profile:read"], externalUserRef: `yourapp-user-${alice._id}` })).body.data.requestId;
        const results = await Promise.all(Array.from({ length: 6 }, () => api({ user: alice }).post(`/v1/consent-requests/${race}/approve`).send({ scopes: ["profile:read"] })));
        expect(results.filter((r) => r.status === 201).length).toBe(1);
        // Only the approved subset is usable
        expect((await http().post("/v1/app-tokens").set(basic(reg.keyId, reg.secret)).send({ externalUserRef: `yourapp-user-${alice._id}`, scopes: ["messages:read"] })).status).toBe(403);
        expect((await http().post("/v1/app-tokens").set(basic(reg.keyId, reg.secret)).send({ externalUserRef: `yourapp-user-${alice._id}` })).status).toBe(201);

        const denied = (await startConsent(reg, {})).body.data.requestId;
        const d = await api({ user: alice }).post(`/v1/consent-requests/${denied}/deny`).send({});
        expect(d.body.data.redirectUrl).toBe(`${CB}?state=state-123456&error=access_denied`);
    });

    it("a linked reference can't be taken over by a second account; expired requests are dead", async () => {
        const ref = `yourapp-user-${uniq("r")}`;
        const r1 = (await startConsent(reg, { externalUserRef: ref })).body.data.requestId;
        expect((await api({ user: alice }).post(`/v1/consent-requests/${r1}/approve`).send({ scopes: ["profile:read"] })).status).toBe(201);
        const r2 = (await startConsent(reg, { externalUserRef: ref })).body.data.requestId;
        expect((await api({ user: mallory }).post(`/v1/consent-requests/${r2}/approve`).send({ scopes: ["profile:read"] })).status).toBe(409);
        const t = await http().post("/v1/app-tokens").set(basic(reg.keyId, reg.secret)).send({ externalUserRef: ref });
        const me = await http().get("/v1/me").set("Authorization", `Bearer ${t.body.data.accessToken}`);
        expect(me.body.data.user._id).toBe(String(alice._id));

        const r3 = (await startConsent(reg, {})).body.data.requestId;
        await runAsSystem(() => ConsentRequest.updateOne({ _id: r3 }, { $set: { expiresAt: new Date(Date.now() - 1000) } }), "test-fixture");
        expect((await api({ user: alice }).get(`/v1/consent-requests/${r3}`)).status).toBe(404);
        expect((await api({ user: alice }).post(`/v1/consent-requests/${r3}/approve`).send({ scopes: ["profile:read"] })).status).toBe(404);
    });

    it("workspace apps can only be approved from inside that workspace by an active member", async () => {
        const org = newOrg();
        const [admin, member] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: admin, org, role: "org:admin" });
        await enter({ user: member, org });
        const ws = await registerApp({ user: admin, org, role: "org:admin" }, { tenantBound: true });
        const id = (await startConsent(ws, {})).body.data.requestId;
        expect((await api({ user: member }).get(`/v1/consent-requests/${id}`)).body.data.contextMatches).toBe(false);
        expect((await api({ user: member }).post(`/v1/consent-requests/${id}/approve`).send({ scopes: ["profile:read"] })).status).toBe(403);
        expect((await api({ user: mallory }).post(`/v1/consent-requests/${id}/approve`).send({ scopes: ["profile:read"] })).status).toBe(403);
        expect((await api({ user: member, org }).post(`/v1/consent-requests/${id}/approve`).send({ scopes: ["profile:read"] })).status).toBe(201);
    });
});

// ---------------------------------------------------------------- F3: rotation race, F5: caps
describe("F3/F5 — concurrent rotation and resource caps", () => {
    it("two concurrent rotations of one credential: exactly one succeeds", async () => {
        const owner = await makeUser();
        const reg = await registerApp({ user: owner });
        const rotate = () => api({ user: owner }).post(`/v1/apps/${reg.app._id}/credentials/${reg.credentialId}/rotate`).send({ confirm: reg.app.name });
        const results = await Promise.all([rotate(), rotate(), rotate()]);
        expect(results.map((r) => r.status).sort()).toEqual([201, 404, 404]);
        const active = await runAsSystem(() => AppCredential.countDocuments({ appId: new mongoose.Types.ObjectId(reg.app._id), status: "active" }), "test-inspection");
        expect(active).toBe(1);
    });

    it("caps active credentials per app and apps per owner", async () => {
        const owner = await makeUser();
        const reg = await registerApp({ user: owner });
        for (let i = 0; i < 4; i++) expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/credentials`).send({ confirm: reg.app.name })).status).toBe(201);
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/credentials`).send({ confirm: reg.app.name })).status).toBe(409);
        for (let i = 0; i < 24; i++) expect((await api({ user: owner }).post("/v1/apps").send({ name: uniq("Cap"), environment: "development" })).status).toBe(201);
        expect((await api({ user: owner }).post("/v1/apps").send({ name: "One too many", environment: "development" })).status).toBe(409);
    });
});

// ---------------------------------------------------------------- F4: CORS for app origins
// Since phase 1 of the third-party API, session routes accept app tokens (by scope), so browser apps need
// CORS there too. Still: only registered origins of ACTIVE apps, never credentialed; app tokens are bound to
// their own app's origins and SpreeWe session tokens to CLERK_AUTHORIZED_PARTIES (SEC-015).
describe("F4 — CORS: registered app origins on API routes, only while the app is active, never credentialed", () => {
    it("allows a registered app origin on /v1 and session routes, not unknown origins, not after suspension", async () => {
        const owner = await makeUser();
        const origin = `https://${uniq("app")}.example.com`;
        const reg = await registerApp({ user: owner }, { environment: "production", allowedOrigins: [origin], callbackUrls: [] });
        const { createApp } = await import("../src/app");
        const app = createApp(["https://spreewe.example.com"]);
        const pre = (p: string, o = origin) => request(app).options(p).set("Origin", o).set("Access-Control-Request-Method", "GET").set("Access-Control-Request-Headers", "authorization");
        const ok = await pre("/api/v1/me");
        expect(ok.headers["access-control-allow-origin"]).toBe(origin);
        expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();
        expect((await pre("/conversations")).headers["access-control-allow-origin"]).toBe(origin);
        expect((await pre("/conversations")).headers["access-control-allow-credentials"]).toBeUndefined();
        expect((await pre("/conversations", "https://evil.example.com")).headers["access-control-allow-origin"]).toBeUndefined();
        expect((await pre("/api/v1/me", "https://evil.example.com")).headers["access-control-allow-origin"]).toBeUndefined();
        await api({ user: owner }).post(`/v1/apps/${reg.app._id}/suspend`).send({});
        expect((await pre("/api/v1/me")).headers["access-control-allow-origin"]).toBeUndefined();
        expect((await pre("/conversations")).headers["access-control-allow-origin"]).toBeUndefined();
        // First-party origin still works everywhere
        expect((await pre("/conversations", "https://spreewe.example.com")).headers["access-control-allow-origin"]).toBe("https://spreewe.example.com");
    });
});

describe("workspace admins control their workspace's apps", () => {
    it("a workspace admin (not the owner) can suspend a workspace app; a member can't", async () => {
        const org = newOrg();
        const [ownerAdmin, otherAdmin, member] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        await enter({ user: ownerAdmin, org, role: "org:admin" });
        await enter({ user: otherAdmin, org, role: "org:admin" });
        await enter({ user: member, org });
        const reg = await registerApp({ user: ownerAdmin, org, role: "org:admin" }, { tenantBound: true });
        expect((await api({ user: member, org }).post(`/v1/apps/${reg.app._id}/suspend`).send({})).status).toBe(404);
        expect((await api({ user: otherAdmin, org, role: "org:admin" }).post(`/v1/apps/${reg.app._id}/suspend`).send({})).status).toBe(201);
        // …but can't read its credentials (owner only)
        expect((await api({ user: otherAdmin, org, role: "org:admin" }).get(`/v1/apps/${reg.app._id}/credentials`)).status).toBe(404);
    });
});

describe("workspace administration endpoints", () => {
    it("members list for members; apps + grant revocation for owners/admins only; external chats are labelled in lists", async () => {
        const org = newOrg();
        const [admin, member, guest] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        await enter({ user: admin, org, role: "org:admin" });
        await enter({ user: member, org });
        const m = (await api({ user: member, org }).get("/v1/workspace/members")).body.data.map((x: any) => x.userId).sort();
        expect(m).toEqual([String(admin._id), String(member._id)].sort());
        expect((await api({ user: member }).get("/v1/workspace/members")).status).toBe(400);
        expect((await api({ user: member, org }).get("/v1/workspace/apps")).status).toBe(403);
        const reg = await registerApp({ user: admin, org, role: "org:admin" }, { tenantBound: true });
        await api({ user: member, org }).post(`/v1/apps/${reg.app._id}/grants`).send({ scopes: ["profile:read"] });
        const apps = (await api({ user: admin, org, role: "org:admin" }).get("/v1/workspace/apps")).body.data;
        expect(apps.find((a: any) => a._id === reg.app._id).grants).toBe(1);
        expect((await api({ user: member, org }).post(`/v1/workspace/apps/${reg.app._id}/revoke-grants`).send({ confirm: reg.app.name })).status).toBe(403);
        expect((await api({ user: admin, org, role: "org:admin" }).post(`/v1/workspace/apps/${reg.app._id}/revoke-grants`).send({ confirm: reg.app.name })).body.data.revoked).toBe(1);
        expect((await http().post("/v1/app-tokens").set(basic(reg.keyId, reg.secret)).send({ userId: String(member._id) })).status).toBe(403);
        // Another workspace's admin can't touch it
        const other = newOrg();
        const otherAdmin = await makeUser();
        await enter({ user: otherAdmin, org: other, role: "org:admin" });
        expect((await api({ user: otherAdmin, org: other, role: "org:admin" }).post(`/v1/workspace/apps/${reg.app._id}/revoke-grants`).send({ confirm: reg.app.name })).status).toBe(404);
        // External label in the chat list
        await api({ user: admin, org, role: "org:admin" }).patch("/tenant/current/policies").send({ allowExternalChat: true });
        const ext = (await api({ user: admin, org, role: "org:admin" }).post("/tenant/external-conversations").send({ userId: String(guest._id) })).body.data.conversationId;
        const { addMessage } = await import("./helpers");
        await addMessage(ext, admin);
        const list = (await api({ user: guest }).get("/conversations")).body.data;
        const row = list.find((c: any) => String(c._id) === ext);
        expect(row.scope).toBe("external");
        expect(row.externalParticipants.map(String)).toEqual([String(guest._id)]);
    });
});
