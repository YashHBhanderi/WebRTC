import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import { AppCredential, AppAuditEvent, DeveloperApp } from "../src/developer/models";
import { signAppToken } from "../src/developer/tokens";
import { runAsSystem } from "../src/tenancy/context";
import { S, validate } from "../src/api/v1/schema";
import { buildOpenApi } from "../src/api/v1/openapi";
import { addMessage, api, ack, connect, enter, makeUser, newOrg, nextEvent, Session, sleep, startSocketServer, testApp, uniq, enc, plainOf, legacyGlobal } from "./helpers";

const idOf = (b: any) => String(b?.data?._id ?? b?.conversation?._id ?? b?._id ?? b?.conversationId);
const basic = (keyId: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const http = () => request(testApp());

/** Owner registers an app and creates a credential; returns ids + the one-time secret. */
async function registerApp(owner: Session, body: Record<string, unknown>) {
    const created = await api(owner).post("/v1/apps").send({ environment: "development", callbackUrls: ["https://example.com/cb"], ...body });
    await legacyGlobal(created.body?.data?._id);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.data;
    const cred = await api(owner).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name });
    expect(cred.status, JSON.stringify(cred.body)).toBe(201);
    return { app, keyId: cred.body.data.credential.keyId as string, credentialId: cred.body.data.credential._id as string, secret: cred.body.data.secret as string };
}

async function grant(user: Session, appId: string, scopes: string[]) {
    const res = await api(user).post(`/v1/apps/${appId}/grants`).send({ scopes });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data;
}

/** App-initiated consent (the only way to link an externalUserRef): app server creates, user approves. */
async function consent(user: Session, reg: { keyId: string; secret: string }, scopes: string[], externalUserRef?: string) {
    const created = await http().post("/v1/consent-requests").set(basic(reg.keyId, reg.secret))
        .send({ redirectUri: "https://example.com/cb", scopes, state: "state-12345", ...(externalUserRef ? { externalUserRef } : {}) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approved = await api(user).post(`/v1/consent-requests/${created.body.data.requestId}/approve`).send({ scopes });
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    return approved.body.data;
}

async function token(keyId: string, secret: string, body: Record<string, unknown>) {
    return http().post("/v1/app-tokens").set(basic(keyId, secret)).send(body);
}

describe("developer apps: registration, ownership, credentials (req. 1, 6, 7)", () => {
    let owner: any, other: any, user: any;
    beforeAll(async () => {
        [owner, other, user] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    });

    it("secrets are shown once, stored only as hashes, never listed, and audited without secrets", async () => {
        const { app, keyId, secret } = await registerApp({ user: owner }, { name: uniq("App"), scopes: ["profile:read"] });
        expect(secret).toMatch(/^sws_/);
        const list = await api({ user: owner }).get(`/v1/apps/${app._id}/credentials`);
        expect(JSON.stringify(list.body)).not.toContain(secret);
        expect(JSON.stringify(list.body)).not.toContain("secretHash");
        const stored = await runAsSystem(() => AppCredential.findOne({ keyId }).lean(), "test-inspection");
        expect(stored?.secretHash).toBeTruthy();
        expect(stored?.secretHash).not.toContain(secret);
        const audit = await runAsSystem(() => AppAuditEvent.find({ appId: app._id }).lean(), "test-inspection");
        expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["app.created", "credential.created"]));
        expect(JSON.stringify(audit)).not.toContain(secret);
    });

    it("only the owner (in the app's context) can see or manage an app; others get 404", async () => {
        const { app } = await registerApp({ user: owner }, { name: uniq("App") });
        expect((await api({ user: other }).get(`/v1/apps/${app._id}`)).status).toBe(404);
        expect((await api({ user: other }).patch(`/v1/apps/${app._id}`).send({ name: "Mine now" })).status).toBe(404);
        expect((await api({ user: other }).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name })).status).toBe(404);
        expect(JSON.stringify((await api({ user: other }).get("/v1/apps")).body)).not.toContain(app._id);
        // Same owner but from a workspace context: a global app isn't managed from there
        const org = newOrg();
        await enter({ user: owner, org, role: "org:admin" });
        expect((await api({ user: owner, org, role: "org:admin" }).get(`/v1/apps/${app._id}`)).status).toBe(404);
    });

    it("high-impact actions need confirmation and a recent sign-in; cookie-only writes are refused (CSRF)", async () => {
        const name = uniq("App");
        const app = (await api({ user: owner }).post("/v1/apps").send({ name, environment: "development" })).body.data;
        await legacyGlobal(app?._id);
        expect((await api({ user: owner }).post(`/v1/apps/${app._id}/credentials`).send({ confirm: "wrong" })).status).toBe(400);
        expect((await api({ user: owner, fva: [45, -1] }).post(`/v1/apps/${app._id}/credentials`).send({ confirm: name })).status).toBe(403);
        expect((await api({ user: owner, fva: [2, -1] }).post(`/v1/apps/${app._id}/credentials`).send({ confirm: name })).status).toBe(201);
        const csrf = await http().post(`/v1/apps/${app._id}/suspend`)
            .set("x-test-auth", JSON.stringify({ sub: owner.clerkId })).set("Cookie", "__session=abc").send({});
        expect(csrf.status).toBe(403);
    });

    it("credentials of one app can't act for another app's users or manage anything", async () => {
        const a = await registerApp({ user: owner }, { name: uniq("A"), scopes: ["profile:read"] });
        const b = await registerApp({ user: other }, { name: uniq("B"), scopes: ["profile:read"] });
        await grant({ user }, b.app._id, ["profile:read"]);
        // user authorised B only → A can't get a token for them
        expect((await token(a.keyId, a.secret, { userId: String(user._id) })).status).toBe(403);
        // A's credential is not a session: management endpoints refuse it
        expect((await http().get(`/v1/apps/${b.app._id}`).set(basic(a.keyId, a.secret))).status).toBe(401);
        // A wrong secret / unknown key: identical 401
        expect((await token(a.keyId, "sws_" + "x".repeat(43), { userId: String(user._id) })).status).toBe(401);
        expect((await token("swk_test_doesnotexist000", a.secret, { userId: String(user._id) })).status).toBe(401);
    });

    it("rotation keeps the old secret only for the grace period; revocation is immediate (req. 7)", async () => {
        const reg = await registerApp({ user: owner }, { name: uniq("Rot"), scopes: ["profile:read"] });
        await grant({ user }, reg.app._id, ["profile:read"]);
        const rotated = await api({ user: owner }).post(`/v1/apps/${reg.app._id}/credentials/${reg.credentialId}/rotate`).send({ confirm: reg.app.name });
        expect(rotated.status).toBe(201);
        const fresh = { keyId: rotated.body.data.credential.keyId, secret: rotated.body.data.secret };
        // Default grace (1 h): old still works for now
        expect((await token(reg.keyId, reg.secret, { userId: String(user._id) })).status).toBe(201);
        // Grace over (simulated) → old refused, new works
        await runAsSystem(() => AppCredential.updateOne({ keyId: reg.keyId }, { $set: { graceUntil: new Date(Date.now() - 1000) } }), "test-fixture");
        expect((await token(reg.keyId, reg.secret, { userId: String(user._id) })).status).toBe(401);
        expect((await token(fresh.keyId, fresh.secret, { userId: String(user._id) })).status).toBe(201);
        // Explicit revoke: immediate
        const freshId = rotated.body.data.credential._id;
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/credentials/${freshId}/revoke`).send({ confirm: reg.app.name })).status).toBe(201);
        expect((await token(fresh.keyId, fresh.secret, { userId: String(user._id) })).status).toBe(401);
        // With APP_CREDENTIAL_ROTATION_GRACE_SECONDS=0 the old credential dies at once
        const zero = await registerApp({ user: owner }, { name: uniq("Rot0"), scopes: ["profile:read"] });
        await grant({ user }, zero.app._id, ["profile:read"]);
        process.env.APP_CREDENTIAL_ROTATION_GRACE_SECONDS = "0";
        try {
            await api({ user: owner }).post(`/v1/apps/${zero.app._id}/credentials/${zero.credentialId}/rotate`).send({ confirm: zero.app.name });
            expect((await token(zero.keyId, zero.secret, { userId: String(user._id) })).status).toBe(401);
        } finally {
            delete process.env.APP_CREDENTIAL_ROTATION_GRACE_SECONDS;
        }
    });

    it("suspension blocks credentials and existing tokens; reactivation restores; revocation is permanent (req. 6)", async () => {
        const reg = await registerApp({ user: owner }, { name: uniq("Sus"), scopes: ["profile:read"] });
        await grant({ user }, reg.app._id, ["profile:read"]);
        const t = (await token(reg.keyId, reg.secret, { userId: String(user._id) })).body.data.accessToken;
        expect((await http().get("/v1/me").set(bearer(t))).status).toBe(200);
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/suspend`).send({})).status).toBe(201);
        expect((await http().get("/v1/me").set(bearer(t))).status).toBe(401);
        expect((await token(reg.keyId, reg.secret, { userId: String(user._id) })).status).toBe(403);
        await api({ user: owner }).post(`/v1/apps/${reg.app._id}/reactivate`).send({});
        expect((await http().get("/v1/me").set(bearer(t))).status).toBe(200);
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/revoke`).send({ confirm: reg.app.name })).status).toBe(201);
        expect((await http().get("/v1/me").set(bearer(t))).status).toBe(401);
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/reactivate`).send({})).status).toBe(409);
    });

    it("platform admins can list and suspend apps but get no content access", async () => {
        const admin = await makeUser();
        process.env.PLATFORM_ADMIN_CLERK_IDS = admin.clerkId;
        try {
            const reg = await registerApp({ user: owner }, { name: uniq("Adm"), scopes: ["profile:read"] });
            expect(JSON.stringify((await api({ user: admin }).get("/v1/admin/apps")).body)).toContain(reg.app._id);
            expect((await api({ user: admin }).post(`/v1/apps/${reg.app._id}/suspend`).send({})).status).toBe(201);
            expect((await api({ user: admin }).get(`/v1/apps/${reg.app._id}/credentials`)).status).toBe(404);
            expect((await api({ user: owner }).get("/v1/admin/apps")).status).toBe(404);
        } finally {
            delete process.env.PLATFORM_ADMIN_CLERK_IDS;
        }
    });
});

describe("scoped user tokens (req. 2, 4, 5)", () => {
    let owner: any, alice: any, mallory: any;
    let reg: Awaited<ReturnType<typeof registerApp>>;
    beforeAll(async () => {
        [owner, alice, mallory] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        reg = await registerApp({ user: owner }, { name: uniq("Tok"), scopes: ["profile:read", "conversations:read", "messages:read"] });
        await consent({ user: alice }, reg, ["profile:read", "conversations:read"], `ext-${alice._id}`);
    });

    it("issues tokens only for users who authorised the app, within their grant (no impersonation)", async () => {
        expect((await token(reg.keyId, reg.secret, { userId: String(mallory._id) })).status).toBe(403);
        expect((await token(reg.keyId, reg.secret, { externalUserRef: "someone-else" })).status).toBe(403);
        expect((await token(reg.keyId, reg.secret, { userId: String(alice._id), externalUserRef: "x" })).status).toBe(400);
        const ok = await token(reg.keyId, reg.secret, { externalUserRef: `ext-${alice._id}` });
        expect(ok.status).toBe(201);
        expect(ok.body.data.scopes).toEqual(["profile:read", "conversations:read"]);
        // Elevation: a scope the user didn't grant (even though the app has it)
        expect((await token(reg.keyId, reg.secret, { userId: String(alice._id), scopes: ["messages:read"] })).status).toBe(403);
        // Lifetime is bounded
        expect((await token(reg.keyId, reg.secret, { userId: String(alice._id), ttlSeconds: 86400 })).status).toBe(400);
        // Users can only grant for themselves: there is no field to name another user
        expect((await api({ user: mallory }).post(`/v1/apps/${reg.app._id}/grants`).send({ scopes: ["profile:read"], userId: String(alice._id) })).status).toBe(400);
    });

    it("rejects expired, tampered, alg-none, foreign-signed, revoked and wrongly-scoped tokens", async () => {
        const good = (await token(reg.keyId, reg.secret, { userId: String(alice._id) })).body.data.accessToken as string;
        expect((await http().get("/v1/me").set(bearer(good))).body.data.user._id).toBe(String(alice._id));
        // Wrong scope for the route
        expect((await http().get("/v1/directory").set(bearer(good))).status).toBe(403);
        // First-party-only routes refuse app tokens; other routes need the matching scope
        expect((await http().get("/v1/apps").set(bearer(good))).status).toBe(403);
        expect((await http().get("/v1/workspaces").set(bearer(good))).status).toBe(403); // organizations:read not granted
        expect((await http().delete(`/web/deleteUser/${alice._id}`).set(bearer(good))).status).toBe(403); // SpreeWe sessions only
        // Session routes accept app tokens with the route's scope (conversations:read) …
        expect((await http().get("/conversations").set(bearer(good))).status).toBe(200);
        // … and refuse them without it (groups:read, notifications:read)
        expect((await http().get("/groupConversations").set(bearer(good))).status).toBe(403);
        expect((await http().get("/notifications").set(bearer(good))).status).toBe(403);

        const [h, p] = good.split(".");
        const claims = JSON.parse(Buffer.from(p, "base64url").toString());
        const forge = (c: object, head = h, sig = good.split(".")[2]) => `${head}.${Buffer.from(JSON.stringify(c)).toString("base64url")}.${sig}`;
        const reject = async (t: string) => expect((await http().get("/v1/me").set(bearer(t))).status).toBe(401);
        await reject(forge({ ...claims, sub: String(mallory._id) }));                     // impersonation by editing
        await reject(forge({ ...claims, scp: [...claims.scp, "messages:read"] }));         // scope elevation by editing
        await reject(forge({ ...claims, tid: "0123456789abcdef01234567" }));               // tenant switch by editing
        const none = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: "spreewe-app-v1" })).toString("base64url");
        await reject(`${none}.${p}.`);
        await reject("not.a.token");
        await reject(good.slice(0, -2) + "xx");
        const expired = signAppToken({ ...claims, iss: undefined, aud: undefined } as any, 60, Date.now() - 3600_000).token;
        await reject(expired);
        // Revoked by the app (e.g. user signed out)
        expect((await http().post("/v1/app-tokens/revoke").set(basic(reg.keyId, reg.secret)).send({ token: good })).status).toBe(201);
        await reject(good);
    });

    it("withdrawing consent, removing scopes from the app, or revoke-all invalidate tokens", async () => {
        const t1 = (await token(reg.keyId, reg.secret, { userId: String(alice._id) })).body.data.accessToken;
        expect((await http().get("/v1/conversations").set(bearer(t1))).status).toBe(200);
        // App owner drops conversations:read → effective scope shrinks immediately
        await api({ user: owner }).patch(`/v1/apps/${reg.app._id}`).send({ scopes: ["profile:read", "messages:read"] });
        expect((await http().get("/v1/conversations").set(bearer(t1))).status).toBe(403);
        expect((await http().get("/v1/me").set(bearer(t1))).status).toBe(200);
        // revoke-all
        await api({ user: owner }).post(`/v1/apps/${reg.app._id}/tokens/revoke-all`).send({ confirm: reg.app.name });
        expect((await http().get("/v1/me").set(bearer(t1))).status).toBe(401);
        // User withdraws consent
        const t2 = (await token(reg.keyId, reg.secret, { userId: String(alice._id) })).body.data.accessToken;
        const grants = (await api({ user: alice }).get("/v1/me/app-grants")).body.data;
        const g = grants.find((x: any) => x.appId === reg.app._id);
        expect((await api({ user: alice }).delete(`/v1/me/app-grants/${g._id}`)).status).toBe(200);
        expect((await http().get("/v1/me").set(bearer(t2))).status).toBe(401);
        expect((await token(reg.keyId, reg.secret, { userId: String(alice._id) })).status).toBe(403);
    });

    it("browser origins must be on the app's allow-list", async () => {
        const r = await registerApp({ user: owner }, { name: uniq("Orig"), scopes: ["profile:read"], allowedOrigins: ["http://localhost:4200"] });
        await grant({ user: alice }, r.app._id, ["profile:read"]);
        const t = (await token(r.keyId, r.secret, { userId: String(alice._id) })).body.data.accessToken;
        expect((await http().get("/v1/me").set(bearer(t)).set("Origin", "http://localhost:4200")).status).toBe(200);
        // Origin not on the list: 403 that says what to change (refreshing the token can't fix it)
        const wrongOrigin = await http().get("/v1/me").set(bearer(t)).set("Origin", "https://evil.example.com");
        expect(wrongOrigin.status).toBe(403);
        expect(wrongOrigin.body.error.message).toBe("This app doesn't allow requests from https://evil.example.com. Add it to the app's allowed origins in the Developer portal.");
        // …on session routes too
        const legacyRoute = await http().get("/conversations").set(bearer(t)).set("Origin", "https://evil.example.com");
        expect(legacyRoute.status).toBe(403);
        expect(JSON.stringify(legacyRoute.body)).toContain("allowed origins");
        // Every other failure keeps the one generic answer, whatever the origin
        expect((await http().get("/v1/me").set(bearer(`${t.slice(0, -4)}AAAA`)).set("Origin", "http://localhost:4200")).body.error.message).toBe("Invalid or expired token");
        expect((await api({ user: owner }).post("/v1/apps").send({ name: "Bad", environment: "production", allowedOrigins: ["http://insecure.example.com"] })).status).toBe(400);
    });
});

describe("tenant-owned apps (req. 3, 5, 8)", () => {
    const orgA = newOrg();
    const orgB = newOrg();
    let admin: any, member: any, outsider: any, bMember: any;
    let convA: string, convGlobal: string, convB: string;
    let reg: Awaited<ReturnType<typeof registerApp>>;
    const A = (u: any, role = "org:member"): Session => ({ user: u, org: orgA, role });

    beforeAll(async () => {
        [admin, member, outsider, bMember] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);
        await enter(A(admin, "org:admin"));
        await enter(A(member));
        await enter({ user: bMember, org: orgB });
        await enter({ user: member, org: orgB });
        convA = idOf((await api(A(member)).post("/conversations").send({ receiverId: String(admin._id) })).body);
        convGlobal = idOf((await api({ user: member }).post("/conversations").send({ receiverId: String(outsider._id) })).body);
        convB = idOf((await api({ user: member, org: orgB }).post("/conversations").send({ receiverId: String(bMember._id) })).body);
        for (const c of [convA, convGlobal, convB]) await addMessage(c, member, "m");
        reg = await registerApp(A(admin, "org:admin"), { name: uniq("Ten"), tenantBound: true, scopes: ["conversations:read", "messages:read"] });
    });

    it("only workspace owners/admins create workspace apps, from inside the workspace", async () => {
        expect((await api(A(member)).post("/v1/apps").send({ name: "Nope", environment: "development", tenantBound: true })).status).toBe(403);
        expect((await api({ user: admin }).post("/v1/apps").send({ name: "Nope", environment: "development", tenantBound: true })).status).toBe(403);
        expect(reg.app.tenantId).toBeTruthy();
    });

    it("a workspace app's token sees only that workspace — not global, not other tenants", async () => {
        // Grant only from inside the workspace
        expect((await api({ user: member }).post(`/v1/apps/${reg.app._id}/grants`).send({ scopes: ["conversations:read"] })).status).toBe(404);
        expect((await api({ user: member, org: orgB }).post(`/v1/apps/${reg.app._id}/grants`).send({ scopes: ["conversations:read"] })).status).toBe(404);
        await grant(A(member), reg.app._id, ["conversations:read", "messages:read"]);
        const issued = await token(reg.keyId, reg.secret, { userId: String(member._id) });
        expect(issued.status, JSON.stringify(issued.body)).toBe(201);
        const t = issued.body.data;
        expect(t.tenantId).toBe(reg.app.tenantId);
        const list = JSON.stringify((await http().get("/v1/conversations").set(bearer(t.accessToken))).body);
        expect(list).toContain(convA);
        expect(list).not.toContain(convGlobal);
        expect(list).not.toContain(convB);
        expect((await http().get(`/v1/conversations/${convB}/messages`).set(bearer(t.accessToken))).status).toBe(404);
        expect((await http().get(`/v1/conversations/${convGlobal}/messages`).set(bearer(t.accessToken))).status).toBe(404);
        expect((await http().get(`/v1/conversations/${convA}/messages`).set(bearer(t.accessToken))).status).toBe(200);
        // No way to request another tenant: unknown body fields are refused
        expect((await token(reg.keyId, reg.secret, { userId: String(member._id), tenantId: "x" })).status).toBe(400);
        // Non-members of the workspace can't even grant
        expect((await api({ user: outsider }).post(`/v1/apps/${reg.app._id}/grants`).send({ scopes: ["conversations:read"] })).status).toBe(404);
    });

    it("removing the user from the workspace invalidates their workspace-app tokens", async () => {
        const leaver = await makeUser();
        await enter(A(leaver));
        await grant(A(leaver), reg.app._id, ["conversations:read"]);
        const t = (await token(reg.keyId, reg.secret, { userId: String(leaver._id) })).body.data.accessToken;
        expect((await http().get("/v1/conversations").set(bearer(t))).status).toBe(200);
        const Tenant = (await import("../src/models/tenantModel")).default;
        const TenantMembership = (await import("../src/models/tenantMembershipModel")).default;
        const { resetTenantCaches } = await import("../src/tenancy/tenant.service");
        await runAsSystem(async () => {
            const tn = await Tenant.findOne({ clerkOrgId: orgA }).lean();
            await TenantMembership.updateOne({ tenantId: tn!._id, userId: leaver._id }, { $set: { status: "removed", removedAt: new Date() } });
        }, "test-fixture");
        resetTenantCaches();
        expect((await http().get("/v1/conversations").set(bearer(t))).status).toBe(401);
        expect((await token(reg.keyId, reg.secret, { userId: String(leaver._id) })).status).toBe(403);
    });
});

describe("app sockets and connection limits (req. 11, 12, 13)", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    let owner: any, alice: any, bob: any;
    let reg: Awaited<ReturnType<typeof registerApp>>;
    const appSock = (t: string, origin?: string) => new Promise<Socket>((resolve, reject) => {
        const s = ioClient(`http://localhost:${server.port}`, { auth: { token: t }, transports: ["websocket"], forceNew: true, reconnection: false, ...(origin ? { extraHeaders: { Origin: origin } } : {}) });
        open.push(s);
        s.once("connect", () => resolve(s));
        s.once("connect_error", reject);
    });

    beforeAll(async () => {
        server = await startSocketServer();
        [owner, alice, bob] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        reg = await registerApp({ user: owner }, { name: uniq("Rt"), scopes: ["realtime:connect", "messages:read", "profile:read"], quotas: { messagesPerDay: 2 } });
        // An app registered before messages:write became unavailable still holds it (kept for continuity);
        // its sends must still be refused because the app has no encryption device
        await runAsSystem(() => DeveloperApp.updateOne({ _id: reg.app._id }, { $addToSet: { scopes: "messages:write" } }), "test-legacy-app");
        await grant({ user: alice }, reg.app._id, ["realtime:connect", "messages:read", "messages:write", "profile:read"]);
    });
    afterAll(async () => {
        open.forEach((s) => s.disconnect());
        await server.close();
    });

    const mint = async (scopes?: string[]) => (await token(reg.keyId, reg.secret, { userId: String(alice._id), ...(scopes ? { scopes } : {}) })).body.data.accessToken as string;

    it("a socket from an origin the app doesn't allow is refused with a message that says what to change", async () => {
        const error = await appSock(await mint(), "https://not-allowed.example.com").then(() => null, (e) => e);
        expect(error?.message).toBe("This app doesn't allow requests from https://not-allowed.example.com. Add it to the app's allowed origins in the Developer portal.");
        // Other token failures stay generic
        const forged = await appSock(`${(await mint()).slice(0, -4)}AAAA`).then(() => null, (e) => e);
        expect(forged?.message).toBe("Invalid token");
    });

    it("needs realtime:connect; refuses events outside its scopes; can't send messages (end-to-end encryption)", async () => {
        await expect(appSock(await mint(["profile:read"]))).rejects.toBeTruthy();
        const conv = idOf((await api({ user: alice }).post("/conversations").send({ receiverId: String(bob._id) })).body);
        const bobSock = await connect(server.port, { user: bob });
        open.push(bobSock);
        await sleep(150);
        const s = await appSock(await mint());
        // Not offered to apps: no call, media, group or archive events
        const noCall = nextEvent(s, "call:started", 600);
        s.emit("call:start", { groupId: conv, callType: "audio" });
        expect(await noCall).toBeNull();
        // Every message is end-to-end encrypted on the user's own devices: an app holds no device keys,
        // so its sends are refused — plaintext or not — and nothing reaches bob
        const rejected = nextEvent(s, "message:rejected", 2000, (p) => p?.reason === "e2ee");
        const nothing = nextEvent(bobSock, "receiveMessage", 1000);
        s.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, content: "from app", type: "text" });
        s.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, e2ee: enc("from app"), type: "text" });
        expect(await rejected).not.toBeNull();
        expect(await nothing).toBeNull();
    });

    it("app connections don't displace the user's own connection, and only get allow-listed events", async () => {
        const conv = idOf((await api({ user: alice }).post("/conversations").send({ receiverId: String(bob._id) })).body);
        const own = await connect(server.port, { user: alice });
        open.push(own);
        await sleep(150);
        const s = await appSock(await mint());
        await sleep(150);
        const bobSock = await connect(server.port, { user: bob });
        open.push(bobSock);
        await sleep(150);
        const toOwn = nextEvent(own, "receiveMessage", 2000, (m) => plainOf(m) === "hi alice");
        const toApp = nextEvent(s, "receiveMessage", 2000, (m) => m?.encrypted === true);
        bobSock.emit("sendMessage", { user: { _id: String(bob._id) }, conversationId: conv, e2ee: enc("hi alice"), type: "text" });
        expect(await toOwn).not.toBeNull();
        // The app learns a message arrived, never its ciphertext or content
        const appCopy = await toApp;
        expect(appCopy).not.toBeNull();
        expect(appCopy.e2ee).toBeUndefined();
        expect(appCopy.content).toBeNull();
        // Notifications, calls, groups, meetings… are withheld from app sockets
        const { emitToUser } = await import("../src/realtime/io");
        const withheld = nextEvent(s, "notification:new", 700);
        const delivered = nextEvent(own, "notification:new", 1500);
        emitToUser(String(alice._id), "notification:new", { _id: "n1" }, { unscoped: true });
        expect(await withheld).toBeNull();
        expect(await delivered).not.toBeNull();
    });

    it("caps connections per user of an app; extra connections don't add event budget (req. 12)", async () => {
        const t = await mint();
        const sockets: Socket[] = [];
        for (let i = 0; i < 5; i++) sockets.push(await appSock(t));
        const sixth = await appSock(t);
        const kicked = await new Promise<boolean>((resolve) => {
            if (sixth.disconnected) return resolve(true);
            sixth.once("disconnect", () => resolve(true));
            setTimeout(() => resolve(sixth.disconnected), 1500);
        });
        expect(kicked).toBe(true);
        sockets.forEach((s) => s.disconnect());

        // First-party: three sockets of one user share one event budget
        const u = await makeUser();
        const conns = [await connect(server.port, { user: u }), await connect(server.port, { user: u }), await connect(server.port, { user: u })];
        open.push(...conns);
        await sleep(200);
        let answered = 0;
        for (const c of conns) for (let i = 0; i < 150; i++) c.emit("ice:getServers", null, () => { answered++; });
        await sleep(1000);
        // One budget (120 burst + refill) — not three
        expect(answered).toBeLessThan(250);
        expect(answered).toBeGreaterThan(50);
    });

    it("suspending the app drops its live sockets on the next revalidation sweep", async () => {
        const s = await appSock(await mint());
        const gone = new Promise<boolean>((resolve) => {
            s.once("disconnect", () => resolve(true));
            setTimeout(() => resolve(false), 3000);
        });
        await runAsSystem(() => DeveloperApp.updateOne({ _id: reg.app._id }, { $set: { status: "suspended" } }), "test-fixture");
        const { revalidateWorkspaceSockets } = await import("../src/realtime/revalidate");
        await revalidateWorkspaceSockets();
        expect(await gone).toBe(true);
        await runAsSystem(() => DeveloperApp.updateOne({ _id: reg.app._id }, { $set: { status: "active" } }), "test-fixture");
    });
});

describe("quota enforcement under concurrency (req. 12)", () => {
    it("10 concurrent sends against a quota of 3 consume exactly 3", async () => {
        const { consumeMessageQuota } = await import("../src/developer/app.service");
        const { AppUsage } = await import("../src/developer/models");
        await AppUsage.createIndexes(); // as migration 2026-10-23 does
        const app = { appId: String(new (await import("mongoose")).default.Types.ObjectId()), environment: "development" as const, scopes: [], jti: "x", quotas: { rateLimitPerMinute: 60, maxConnections: 5, messagesPerDay: 3 } };
        const results = await Promise.all(Array.from({ length: 10 }, () => consumeMessageQuota(app)));
        expect(results.filter(Boolean).length).toBe(3);
    });
});

describe("validation defaults and OpenAPI security (req. 14)", () => {
    it("optional fields with defaults get their default when absent (regression)", () => {
        expect(validate(S.object({ limit: S.int({ optional: true, default: 20 }) }), {})).toEqual({ limit: 20 });
    });

    it("documents the three auth schemes and which routes accept app tokens", () => {
        const doc: any = buildOpenApi();
        expect(Object.keys(doc.components.securitySchemes).sort()).toEqual(["appCredential", "appUserToken", "clerkSession"]);
        expect(doc.paths["/v1/app-tokens"].post.security).toEqual([{ appCredential: [] }]);
        expect(doc.paths["/v1/me"].get.security).toEqual([{ clerkSession: [] }, { appUserToken: ["profile:read"] }]);
        expect(doc.paths["/v1/apps"].post.security).toEqual([{ clerkSession: [] }]);
        expect(doc.paths["/v1/workspace/policies"].patch.security).toEqual([{ clerkSession: [] }, { appUserToken: ["organizations:manage"] }]);
        expect(doc.paths["/v1/workspace/organization/delete"].post.security).toEqual([{ clerkSession: [] }]);
    });
});
