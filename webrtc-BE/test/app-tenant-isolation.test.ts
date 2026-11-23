import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import User from "../src/models/userModel";
import Tenant from "../src/models/tenantModel";
import TenantMembership from "../src/models/tenantMembershipModel";
import Conversation from "../src/models/conversationModel";
import { AppCredential, AppGrant, DeveloperApp } from "../src/developer/models";
import { runAsSystem, runWithContext } from "../src/tenancy/context";
import { resolveContext } from "../src/tenancy/tenant.service";
import { addMessage, api, enter, legacyGlobal, makeUser, newOrg, Session, sleep, startSocketServer, testApp, uniq } from "./helpers";

/**
 * Every developer application is an independent workspace: its own tenant, its own users (registered
 * through the API with the app credential), and no way for those users to see or reach anything that
 * belongs to another application, to an organization, or to the personal SpreeWe app, and vice versa.
 */
const basic = (r: { keyId: string; secret: string }) => ({ Authorization: `Basic ${Buffer.from(`${r.keyId}:${r.secret}`).toString("base64")}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const http = () => request(testApp());
const sys = <T>(fn: () => T) => runAsSystem(fn, "test-inspection");
const idOf = (b: any) => String(b?.data?._id ?? b?.conversation?._id ?? b?._id ?? b?.conversationId);

const SCOPES = [
    "profile:read", "profile:write", "directory:read", "contacts:write", "conversations:read", "conversations:write", "groups:read", "groups:write",
    "groups:manage", "messages:read", "search:read", "calls:read", "calls:write", "meetings:read", "meetings:write", "notifications:read", "files:read",
    "organizations:read", "realtime:connect",
];

interface Reg { app: any; keyId: string; secret: string; owner: Session }

async function newApp(owner: Session, body: Record<string, unknown> = {}): Promise<Reg> {
    const created = await api(owner).post("/v1/apps").send({ name: uniq("Workspace app "), environment: "development", scopes: SCOPES, ...body });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const app = created.body.data;
    const cred = await api(owner).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name });
    expect(cred.status, JSON.stringify(cred.body)).toBe(201);
    return { app, keyId: cred.body.data.credential.keyId, secret: cred.body.data.secret, owner };
}

async function register(reg: Reg, externalUserId: string, extra: Record<string, unknown> = {}) {
    const res = await http().post("/v1/app-users").set(basic(reg)).send({ externalUserId, name: `User ${externalUserId}`.slice(0, 30), ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as { _id: string; externalUserId: string; tenantId: string; status: string; email: string | null };
}

async function tokenFor(reg: Reg, externalUserId: string): Promise<string> {
    const res = await http().post("/v1/app-tokens").set(basic(reg)).send({ externalUserRef: externalUserId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.tenantId).toBe(reg.app.tenantId);
    return res.body.data.accessToken;
}

const as = (token: string) => ({
    get: (url: string) => http().get(url).set(bearer(token)),
    post: (url: string) => http().post(url).set(bearer(token)),
    put: (url: string) => http().put(url).set(bearer(token)),
    patch: (url: string) => http().patch(url).set(bearer(token)),
    delete: (url: string) => http().delete(url).set(bearer(token)),
});

describe("application tenants", () => {
    let ownerA: Session, ownerB: Session, spree: any, spree2: any;
    let A: Reg, B: Reg;
    let a1: any, a2: any, a3: any, b1: any, b2: any;
    let tA1: string, tA2: string, tB1: string, tB2: string;
    let convA: string, convB: string;

    beforeAll(async () => {
        ownerA = { user: await makeUser() };
        ownerB = { user: await makeUser() };
        [spree, spree2] = await Promise.all([makeUser(), makeUser()]);
        A = await newApp(ownerA);
        B = await newApp(ownerB);
        // The same external id and email in both apps: two unrelated users
        a1 = await register(A, "user-1", { email: "same.person@example.test" });
        a2 = await register(A, "user-2");
        a3 = await register(A, "user-3");
        b1 = await register(B, "user-1", { email: "same.person@example.test" });
        b2 = await register(B, "user-2");
        [tA1, tA2, tB1, tB2] = await Promise.all([tokenFor(A, "user-1"), tokenFor(A, "user-2"), tokenFor(B, "user-1"), tokenFor(B, "user-2")]);
        const cA = await as(tA1).post("/conversations").send({ receiverId: a2._id });
        expect(cA.status, JSON.stringify(cA.body)).toBeLessThan(300);
        convA = idOf(cA.body);
        const cB = await as(tB1).post("/conversations").send({ receiverId: b2._id });
        expect(cB.status, JSON.stringify(cB.body)).toBeLessThan(300);
        convB = idOf(cB.body);
        await addMessage(convA, { _id: a1._id }, "secret of app A");
        await addMessage(convB, { _id: b1._id }, "secret of app B");
    });

    // ------------------------------------------------------------ 1. tenant per application

    it("creating an app creates its own tenant, and the app, credentials and tokens are bound to it", async () => {
        expect(A.app.dedicatedTenant).toBe(true);
        expect(A.app.tenantId).toMatch(/^[0-9a-f]{24}$/);
        expect(A.app.tenantId).not.toBe(B.app.tenantId);
        const tenant = await sys(() => Tenant.findById(A.app.tenantId).lean());
        expect(tenant).toMatchObject({ kind: "app", status: "active" });
        expect(String(tenant!.appId)).toBe(A.app._id);
        expect(tenant!.clerkOrgId).toBeUndefined();
        // Closed by default: nothing may cross its boundary, it is not listed and can't be joined
        expect(tenant!.policies).toMatchObject({ allowExternalChat: false, allowExternalCalls: false, allowExternalFiles: false, membersCanStartExternal: false });
        expect(tenant!.settings).toMatchObject({ discoverable: false, joinPolicy: "invite", guestAccess: false, joinCodeEnabled: false });
        const cred = await sys(() => AppCredential.findOne({ keyId: A.keyId }).lean());
        const app = await sys(() => DeveloperApp.findById(cred!.appId).lean());
        expect(String(app!.tenantId)).toBe(A.app.tenantId);
        // The owner manages it from the personal context and sees it in their list; another developer does not
        expect((await api(ownerA).get("/v1/apps")).body.data.map((x: any) => x._id)).toContain(A.app._id);
        expect((await api(ownerB).get("/v1/apps")).body.data.map((x: any) => x._id)).not.toContain(A.app._id);
        expect((await api(ownerB).get(`/v1/apps/${A.app._id}`)).status).toBe(404);
        // The developer is not a user of their app's workspace
        expect(await sys(() => TenantMembership.exists({ tenantId: A.app.tenantId, userId: ownerA.user._id }))).toBeNull();
    });

    it("a rejected app registration leaves no tenant behind; workspace apps stay bound to their organization", async () => {
        const before = await sys(() => Tenant.countDocuments({ kind: "app" }));
        expect((await api(ownerA).post("/v1/apps").send({ name: "Bad origin", environment: "production", allowedOrigins: ["http://insecure.example.com"] })).status).toBe(400);
        expect(await sys(() => Tenant.countDocuments({ kind: "app" }))).toBe(before);
        const org = newOrg();
        const admin: Session = { user: await makeUser(), org, role: "org:admin" };
        await enter(admin);
        const ws = await newApp(admin, { tenantBound: true });
        expect(ws.app.dedicatedTenant).toBe(false);
        const orgTenant = await sys(() => Tenant.findOne({ clerkOrgId: org }).lean());
        expect(ws.app.tenantId).toBe(String(orgTenant!._id));
        expect(await sys(() => Tenant.countDocuments({ kind: "app" }))).toBe(before);
        // Only apps with their own tenant register users
        expect((await http().post("/v1/app-users").set(basic(ws)).send({ externalUserId: "x-1", name: "Some One" })).status).toBe(403);
    });

    // ------------------------------------------------------------ 2 + 3. registering users

    it("registers users in the credential's tenant under a unique external id", async () => {
        expect(a1.tenantId).toBe(A.app.tenantId);
        expect(b1.tenantId).toBe(B.app.tenantId);
        expect(a1._id).not.toBe(b1._id);
        const stored = await sys(() => User.findById(a1._id).lean());
        expect(String(stored!.tenantId)).toBe(A.app.tenantId);
        expect(String(stored!.appId)).toBe(A.app._id);
        expect(stored!.externalUserId).toBe("user-1");
        // Not a SpreeWe account: no account email, no sign-in link, not in the global directory
        expect(stored!.email).toBeUndefined();
        expect(stored!.clerkId).toBeUndefined();
        expect(stored!.globalDiscoverable).toBe(false);
        expect(await sys(() => TenantMembership.findOne({ tenantId: A.app.tenantId, userId: a1._id }).lean())).toMatchObject({ status: "active", role: "member", source: "app" });
        expect(await sys(() => TenantMembership.countDocuments({ userId: a1._id }))).toBe(1);

        // Same external id again in the same app: refused. (The other app has its own "user-1".)
        const dup = await http().post("/v1/app-users").set(basic(A)).send({ externalUserId: "user-1", name: "Again Again" });
        expect(dup.status).toBe(409);
        expect(await sys(() => User.countDocuments({ tenantId: A.app.tenantId, externalUserId: "user-1" }))).toBe(1);
        // The database itself refuses a duplicate (unique per tenant)
        await expect(sys(() => User.collection.insertOne({ username: "Dup", tenantId: new mongoose.Types.ObjectId(A.app.tenantId), appId: new mongoose.Types.ObjectId(A.app._id), externalUserId: "user-1" } as any))).rejects.toMatchObject({ code: 11000 });
    });

    it("the tenant can never be chosen by the caller, and registration needs a valid app credential", async () => {
        for (const extra of [{ tenantId: B.app.tenantId }, { appId: B.app._id }, { clerkId: "user_x" }, { role: "owner" }]) {
            const res = await http().post("/v1/app-users").set(basic(A)).send({ externalUserId: uniq("x"), name: "Some One", ...extra });
            expect(res.status, JSON.stringify(extra)).toBe(400);
        }
        expect((await http().post("/v1/app-users").send({ externalUserId: "n-1", name: "Some One" })).status).toBe(401);
        expect((await http().post("/v1/app-users").set(basic({ keyId: A.keyId, secret: B.secret })).send({ externalUserId: "n-1", name: "Some One" })).status).toBe(401);
        // Neither a user token nor a SpreeWe session can register users
        expect((await http().post("/v1/app-users").set(bearer(tA1)).send({ externalUserId: "n-1", name: "Some One" })).status).toBe(401);
        expect((await api(ownerA).post("/v1/app-users").send({ externalUserId: "n-1", name: "Some One" })).status).toBe(401);
        for (const bad of [{ externalUserId: "has space", name: "Some One" }, { externalUserId: "ok-1", name: "x" }, { externalUserId: "ok-1", name: "Some One", email: "nope" }, { externalUserId: "ok-1", name: "Some One", avatarUrl: "javascript:alert(1)" }]) {
            expect((await http().post("/v1/app-users").set(basic(A)).send(bad)).status, JSON.stringify(bad)).toBe(400);
        }
    });

    it("an app manages only its own users: another app's credential finds nothing", async () => {
        const listA = await http().get("/v1/app-users?limit=100").set(basic(A));
        expect(listA.body.data.map((u: any) => u.externalUserId).sort()).toEqual(["user-1", "user-2", "user-3"]);
        expect(listA.body.data.every((u: any) => u.tenantId === A.app.tenantId)).toBe(true);
        const listB = await http().get("/v1/app-users?limit=100").set(basic(B));
        expect(listB.body.data.map((u: any) => u._id)).toEqual(expect.not.arrayContaining([a1._id, a2._id, a3._id]));
        expect((await http().get("/v1/app-users/user-3").set(basic(B))).status).toBe(404);
        expect((await http().patch("/v1/app-users/user-3").set(basic(B)).send({ name: "Hijacked" })).status).toBe(404);
        expect((await http().delete("/v1/app-users/user-3").set(basic(B))).status).toBe(404);
        expect((await sys(() => User.findById(a3._id).lean()))!.username).toBe("User user-3");
        // B's "user-1" is B's own record
        expect((await http().get("/v1/app-users/user-1").set(basic(B))).body.data._id).toBe(b1._id);
        // B can't get a token for A's user, by external id or by SpreeWe user id
        expect((await http().post("/v1/app-tokens").set(basic(B)).send({ externalUserRef: "user-3" })).status).toBe(403);
        expect((await http().post("/v1/app-tokens").set(basic(B)).send({ userId: a1._id })).status).toBe(403);
        // …nor for a SpreeWe account
        expect((await http().post("/v1/app-tokens").set(basic(A)).send({ userId: String(spree._id) })).status).toBe(403);
    });

    it("a user can't be used by another application even if records were tampered with", async () => {
        // A grant and a membership for A's user planted in B (not possible through the API)
        const planted = await sys(() => AppGrant.create({ appId: B.app._id, userId: a3._id, tenantId: B.app.tenantId, managed: true, externalUserRef: "planted", scopes: [], status: "active" }));
        await sys(() => TenantMembership.create({ tenantId: B.app.tenantId, userId: a3._id, role: "member", status: "active" }));
        try {
            expect((await http().post("/v1/app-tokens").set(basic(B)).send({ externalUserRef: "planted" })).status).toBe(403);
            expect((await http().post("/v1/app-tokens").set(basic(B)).send({ userId: a3._id })).status).toBe(403);
        } finally {
            await sys(() => AppGrant.deleteOne({ _id: planted._id }));
            await sys(() => TenantMembership.deleteOne({ tenantId: B.app.tenantId, userId: a3._id }));
        }
    });

    // ------------------------------------------------------------ 4. authentication

    it("tokens act only in the app's tenant, with no admin rights, and say so", async () => {
        const me = await as(tA1).get("/v1/me");
        expect(me.status).toBe(200);
        expect(me.body.data.user._id).toBe(a1._id);
        expect(me.body.data.context).toEqual({ tenantId: A.app.tenantId, role: "member" });
        // A request can't move the token into another tenant
        const moved = await as(tA1).get("/v1/me").set("x-tenant-id", B.app.tenantId).query({ tenantId: B.app.tenantId });
        expect(moved.body.data?.context?.tenantId ?? A.app.tenantId).toBe(A.app.tenantId);
        // Members can't change the workspace's (closed) policies
        expect((await as(tA1).patch("/tenant/current/policies").send({ allowExternalChat: true })).status).toBeGreaterThanOrEqual(400);
        expect((await sys(() => Tenant.findById(A.app.tenantId).lean()))!.policies.allowExternalChat).toBe(false);
    });

    it("a tampered token (another tenant, another user) is refused", async () => {
        const [h, p] = tA1.split(".");
        const claims = JSON.parse(Buffer.from(p, "base64url").toString());
        for (const change of [{ tid: B.app.tenantId }, { tid: null }, { sub: b1._id }, { app: B.app._id, aud: `spreewe:app:${B.app._id}` }]) {
            const forged = `${h}.${Buffer.from(JSON.stringify({ ...claims, ...change })).toString("base64url")}.${tA1.split(".")[2]}`;
            expect((await as(forged).get("/v1/me")).status, JSON.stringify(change)).toBe(401);
        }
    });

    it("no SpreeWe session can enter an application tenant, even with a matching organization claim", async () => {
        const tenant = await sys(() => Tenant.findById(A.app.tenantId).lean());
        expect(tenant!.clerkOrgId).toBeUndefined();
        // Defence in depth: if an application tenant ever carried an organization id, the session is still refused
        const org = newOrg();
        await sys(() => Tenant.collection.updateOne({ _id: tenant!._id }, { $set: { clerkOrgId: org } }));
        try {
            await expect(resolveContext(String(ownerA.user._id), ownerA.user.clerkId, { orgId: org, orgRole: "org:admin" })).rejects.toMatchObject({ status: 403 });
            expect((await api({ user: ownerA.user, org, role: "org:admin" }).get("/tenant/current")).status).toBe(403);
        } finally {
            await sys(() => Tenant.collection.updateOne({ _id: tenant!._id }, { $unset: { clerkOrgId: 1 } }));
        }
        expect(await sys(() => TenantMembership.exists({ tenantId: tenant!._id, userId: ownerA.user._id }))).toBeNull();
    });

    // ------------------------------------------------------------ 5. people

    it("the directory, people search and profiles show only users of the same application", async () => {
        const ids = (res: any) => (res.body.data ?? res.body.users ?? res.body).map((u: any) => String(u._id));
        const dirA = await as(tA1).get("/v1/directory?limit=100");
        expect(dirA.status).toBe(200);
        expect(ids(dirA).sort()).toEqual([a2._id, a3._id].sort());
        const dirB = await as(tB1).get("/v1/directory?limit=100");
        expect(ids(dirB)).toEqual([b2._id]);
        const legacy = await as(tA1).get("/web/users/except-current");
        expect(legacy.status).toBe(200);
        expect(JSON.stringify(legacy.body)).not.toContain(b1._id);
        expect(JSON.stringify(legacy.body)).not.toContain(String(spree._id));
        // Search by a name that exists in both apps and among SpreeWe accounts
        const search = await as(tA1).get("/search").query({ q: "User user" });
        expect(search.status).toBe(200);
        expect(JSON.stringify(search.body)).toContain(a2._id);
        expect(JSON.stringify(search.body)).not.toContain(b1._id);
        expect(JSON.stringify(search.body)).not.toContain(b2._id);
        // Profiles: same app yes; another app, the developer and SpreeWe accounts look like unknown ids
        expect((await as(tA1).get(`/web/user/${a2._id}`)).status).toBe(200);
        for (const foreign of [b1._id, b2._id, String(spree._id), String(ownerA.user._id), String(ownerB.user._id)]) {
            expect((await as(tA1).get(`/web/user/${foreign}`)).status, foreign).toBe(404);
        }
    });

    it("the users collection itself is filtered by realm inside a request (a forgotten check can't leak)", async () => {
        const ctxA = { kind: "user" as const, userId: a1._id, tenantId: A.app.tenantId, clerkOrgId: null, role: "member" as const, isPlatformAdmin: false, realm: A.app.tenantId };
        const ctxSpree = { kind: "user" as const, userId: String(spree._id), tenantId: null, clerkOrgId: null, role: null, isPlatformAdmin: false };
        const everyone = [a1._id, a2._id, b1._id, String(spree._id)];
        const seenByA = await runWithContext(ctxA, () => User.find({ _id: { $in: everyone } }).select("_id").lean());
        expect(seenByA.map((u) => String(u._id)).sort()).toEqual([a1._id, a2._id].sort());
        expect(await runWithContext(ctxA, () => User.findById(b1._id).lean())).toBeNull();
        expect(await runWithContext(ctxA, () => User.findById(String(spree._id)).lean())).toBeNull();
        expect(await runWithContext(ctxA, () => User.countDocuments({}))).toBe(3);
        expect((await runWithContext(ctxA, () => User.aggregate([{ $project: { _id: 1 } }]))).length).toBe(3);
        // Writes are confined too
        expect((await runWithContext(ctxA, () => User.updateOne({ _id: b1._id }, { $set: { bio: "defaced" } }))).matchedCount).toBe(0);
        // SpreeWe accounts never see application users
        const seenBySpree = await runWithContext(ctxSpree, () => User.find({ _id: { $in: everyone } }).select("_id").lean());
        expect(seenBySpree.map((u) => String(u._id))).toEqual([String(spree._id)]);
        // The home tenant can't be changed after creation
        await sys(() => User.updateOne({ _id: a3._id }, { $set: { tenantId: new mongoose.Types.ObjectId(B.app.tenantId) } }));
        expect(String((await sys(() => User.findById(a3._id).lean()))!.tenantId)).toBe(A.app.tenantId);
    });

    // ------------------------------------------------------------ 6. conversations, groups, meetings

    it("conversations can only be started with users of the same application", async () => {
        for (const foreign of [b1._id, String(spree._id), String(ownerA.user._id)]) {
            const res = await as(tA1).post("/conversations").send({ receiverId: foreign });
            expect(res.status, foreign).toBeGreaterThanOrEqual(400);
        }
        expect(await sys(() => Conversation.countDocuments({ members: { $all: [a1._id, b1._id] } }))).toBe(0);
        const stored = await sys(() => Conversation.findById(convA).lean());
        expect(String((stored as any).tenantId)).toBe(A.app.tenantId);
        expect((stored as any).scope).toBe("tenant");
        // External conversations don't exist in application tenants
        expect((await as(tA1).post("/v1/conversations/external").send({ userId: String(spree._id) })).status).toBeGreaterThanOrEqual(400);
        expect((await as(tA1).post("/tenant/external-conversations").send({ userId: b1._id })).status).toBeGreaterThanOrEqual(400);
        expect(await sys(() => Conversation.countDocuments({ tenantId: A.app.tenantId, scope: "external" }))).toBe(0);
    });

    it("another application's user can't list, read, search or join a conversation, even knowing its id", async () => {
        const listB = await as(tB1).get("/v1/conversations?limit=100");
        expect(listB.status).toBe(200);
        expect(JSON.stringify(listB.body)).not.toContain(convA);
        expect(JSON.stringify((await as(tB1).get("/conversations")).body)).not.toContain(convA);
        const read = await as(tB1).get(`/v1/conversations/${convA}/messages`);
        expect(read.status).toBeGreaterThanOrEqual(403);
        expect(JSON.stringify(read.body)).not.toContain("secret of app A");
        for (const url of [`/messages/${convA}`, `/messages/${convA}/search?q=secret`, `/conversations/${convA}/state`, `/conversations/${convA}/media`, `/conversations/${convA}/recordings`, `/conversations/${convA}/group`]) {
            const res = await as(tB1).get(url);
            expect(res.status, url).toBeGreaterThanOrEqual(400);
            expect(JSON.stringify(res.body), url).not.toContain("secret of app A");
        }
        expect(JSON.stringify((await as(tB1).get("/search").query({ q: "secret" })).body)).not.toContain("secret of app A");
        expect((await as(tB1).delete(`/conversations/${convA}`)).status).toBeGreaterThanOrEqual(400);
        expect(await sys(() => Conversation.exists({ _id: convA }))).toBeTruthy();
        // Its own conversation works
        expect((await as(tB1).get(`/v1/conversations/${convB}/messages`)).status).toBe(200);
        expect((await as(tA2).get(`/v1/conversations/${convA}/messages`)).status).toBe(200);
    });

    it("groups and meetings only take members of the same application", async () => {
        const make = (members: string[]) => as(tA1).post("/conversations/group").field("groupName", uniq("Team ")).field("groupMembers", JSON.stringify(members));
        for (const foreign of [b1._id, String(spree._id)]) {
            const res = await make([a2._id, foreign]);
            expect(res.status, foreign).toBeGreaterThanOrEqual(400);
        }
        const ok = await make([a2._id, a3._id]);
        expect(ok.status, JSON.stringify(ok.body)).toBeLessThan(300);
        const groupId = idOf(ok.body);
        const add = await as(tA1).put(`/conversations/group/${groupId}/add-member`).send({ userIds: [b1._id] });
        expect(add.status).toBeGreaterThanOrEqual(400);
        const group = await sys(() => Conversation.findById(groupId).lean());
        expect((group as any).members.map(String).sort()).toEqual([a1._id, a2._id, a3._id].sort());
        expect(String((group as any).tenantId)).toBe(A.app.tenantId);
        expect((await as(tB1).get(`/conversations/${groupId}/group`)).status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify((await as(tB1).get("/groupConversations")).body)).not.toContain(groupId);

        const start = new Date(Date.now() + 3600_000);
        const meeting = await as(tA1).post("/meetings").send({ title: "Planning", startAt: start.toISOString(), endAt: new Date(start.getTime() + 1800_000).toISOString(), invitees: [a2._id, b1._id, String(spree._id)] });
        expect(meeting.status, JSON.stringify(meeting.body)).toBeLessThan(300);
        const body = JSON.stringify(meeting.body);
        expect(body).toContain(a2._id);
        expect(body).not.toContain(b1._id);
        expect(body).not.toContain(String(spree._id));
        const meetingId = String(meeting.body.data?._id ?? meeting.body.meeting?._id ?? meeting.body._id);
        const code = meeting.body.data?.code ?? meeting.body.meeting?.code ?? meeting.body.code;
        // Another application's user can't open it by id or join it by code
        expect((await as(tB1).get(`/meetings/${meetingId}`)).status).toBeGreaterThanOrEqual(400);
        if (code) {
            expect((await as(tB1).get(`/meetings/code/${code}`)).status).toBeGreaterThanOrEqual(400);
            expect((await as(tB1).post(`/meetings/code/${code}/join`).send({})).status).toBeGreaterThanOrEqual(400);
        }
        expect(JSON.stringify((await as(tB1).get("/meetings").query({ from: new Date().toISOString(), to: new Date(Date.now() + 86_400_000).toISOString() })).body)).not.toContain(meetingId);
        expect(JSON.stringify((await as(tB1).get("/calls")).body)).not.toContain(convA);
        expect(JSON.stringify((await as(tB1).get("/notifications")).body)).not.toContain(a1._id);
    });

    // ------------------------------------------------------------ 7. personal app and organizations

    it("the personal SpreeWe app and organizations can't see or reach application users", async () => {
        const personal: Session = { user: spree };
        // No conversation by id, no profile, not found by email, not in search
        expect((await api(personal).post("/conversations").send({ receiverId: a1._id })).status).toBeGreaterThanOrEqual(400);
        expect((await api(personal).get(`/web/user/${a1._id}`)).status).toBe(404);
        const lookup = await api(personal).post("/v1/contacts/lookup").send({ email: "same.person@example.test" });
        expect(lookup.body?.data?.found ?? false).toBe(false);
        expect(JSON.stringify(lookup.body)).not.toContain(a1._id);
        expect(JSON.stringify((await api(personal).get("/search").query({ q: "User user" })).body)).not.toContain(a1._id);
        expect(JSON.stringify((await api(personal).get("/v1/directory?limit=100")).body)).not.toContain(a1._id);
        expect((await api(personal).get(`/v1/conversations/${convA}/messages`)).status).toBeGreaterThanOrEqual(403);
        expect(await sys(() => Conversation.countDocuments({ members: a1._id, tenantId: null }))).toBe(0);

        // An organization that allows external chat still can't pull an application user in
        const org = newOrg();
        const admin: Session = { user: await makeUser(), org, role: "org:admin" };
        await enter(admin);
        expect((await api(admin).patch("/tenant/current/policies").send({ allowExternalChat: true })).status).toBe(200);
        expect((await api(admin).post("/tenant/external-conversations").send({ userId: String(spree2._id) })).status).toBeLessThan(300);
        expect((await api(admin).post("/tenant/external-conversations").send({ userId: a1._id })).status).toBeGreaterThanOrEqual(400);
        expect((await api(admin).post("/conversations").send({ receiverId: a1._id })).status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify((await api(admin).get("/v1/directory?limit=100")).body)).not.toContain(a1._id);
        expect(await sys(() => TenantMembership.countDocuments({ userId: a1._id }))).toBe(1);

        // Groups and meetings in the personal app can't include an application user either
        const group = await api(personal).post("/conversations/group").field("groupName", uniq("Mixed ")).field("groupMembers", JSON.stringify([String(spree2._id), a1._id]));
        expect(group.status).toBeGreaterThanOrEqual(400);
        const start = new Date(Date.now() + 7200_000);
        const meeting = await api(personal).post("/meetings").send({ title: "Mixed", startAt: start.toISOString(), endAt: new Date(start.getTime() + 1800_000).toISOString(), invitees: [a1._id] });
        expect(JSON.stringify(meeting.body)).not.toContain(a1._id);
        expect(await sys(() => Conversation.countDocuments({ members: a1._id, tenantId: { $ne: new mongoose.Types.ObjectId(A.app.tenantId) } }))).toBe(0);

        // The personal app still works as before
        const chat = await api(personal).post("/conversations").send({ receiverId: String(spree2._id) });
        expect(chat.status, JSON.stringify(chat.body)).toBeLessThan(300);
        expect((await sys(() => Conversation.findById(idOf(chat.body)).lean()) as any).tenantId ?? null).toBeNull();
        expect((await api(personal).get("/v1/me")).body.data.context).toEqual({ tenantId: null, role: null });
    });

    it("signing in to SpreeWe with an application user's email creates a separate account, never a link", async () => {
        const clerkId = `user_${uniq("same")}`;
        const { clerkDouble } = await import("./support/clerk-double");
        const getUser = (clerkDouble as any).clerkClient.users.getUser;
        (clerkDouble as any).clerkClient.users.getUser = async (id: string) => id === clerkId
            ? { id, username: "Same Person", firstName: null, lastName: null, hasImage: false, imageUrl: "", primaryEmailAddressId: "e1", emailAddresses: [{ id: "e1", emailAddress: "same.person@example.test", verification: { status: "verified" } }] }
            : getUser(id);
        try {
            const me = await api({ user: { clerkId } }).get("/v1/me");
            expect(me.status, JSON.stringify(me.body)).toBe(200);
            expect([a1._id, b1._id]).not.toContain(me.body.data.user._id);
            expect(me.body.data.context.tenantId).toBeNull();
            const account = await sys(() => User.findById(me.body.data.user._id).lean());
            expect(account!.tenantId ?? null).toBeNull();
            expect(account!.email).toBe("same.person@example.test");
            for (const id of [a1._id, b1._id]) expect((await sys(() => User.findById(id).lean()))!.clerkId).toBeUndefined();
        } finally {
            (clerkDouble as any).clerkClient.users.getUser = getUser;
        }
    });

    // ------------------------------------------------------------ 8. realtime

    describe("realtime", () => {
        let server: Awaited<ReturnType<typeof startSocketServer>>;
        const sockets: Socket[] = [];
        const open = (token: string) => new Promise<Socket>((resolve, reject) => {
            const s = ioClient(`http://localhost:${server.port}`, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
            sockets.push(s);
            s.once("connect", () => resolve(s));
            s.once("connect_error", reject);
        });
        beforeAll(async () => { server = await startSocketServer(); });
        afterAll(async () => { sockets.forEach((s) => s.close()); await server.close(); });

        it("room events of one application never reach another application's socket", async () => {
            const [sA1, sA2, sB1] = await Promise.all([open(tA1), open(tA2), open(tB1)]);
            const got: Record<string, any[]> = { a2: [], b1: [] };
            sA2.on("userTyping", (p) => got.a2.push(p));
            sB1.onAny((event, p) => got.b1.push({ event, p }));
            sA1.emit("joinConversation", convA);
            sA2.emit("joinConversation", convA);
            sB1.emit("joinConversation", convA); // knows the id; must not get in
            await sleep(400);
            sA1.emit("typing", { conversationId: convA });
            sA1.emit("typing", convA);
            await sleep(600);
            expect(got.a2.length).toBeGreaterThan(0);
            expect(JSON.stringify(got.b1)).not.toContain(convA);
            expect(JSON.stringify(got.b1)).not.toContain(a1._id);
            // Presence of application A's users is not delivered to application B
            sA1.emit("presence:set", { status: "Busy" });
            await sleep(500);
            expect(JSON.stringify(got.b1)).not.toContain(a1._id);
        });

        it("a deactivated user's token stops working for sockets and REST", async () => {
            const extra = await register(A, "user-leaving");
            const t = await tokenFor(A, "user-leaving");
            expect((await as(t).get("/v1/me")).status).toBe(200);
            expect((await http().delete("/v1/app-users/user-leaving").set(basic(A))).status).toBe(200);
            expect((await as(t).get("/v1/me")).status).toBe(401);
            await expect(open(t)).rejects.toBeTruthy();
            expect((await http().post("/v1/app-tokens").set(basic(A)).send({ externalUserRef: "user-leaving" })).status).toBe(403);
            expect(JSON.stringify((await as(tA1).get("/v1/directory?limit=100")).body)).not.toContain(extra._id);
            expect((await http().get("/v1/app-users/user-leaving").set(basic(A))).body.data.status).toBe("deactivated");
            // Brought back by the app, and only by the app
            expect((await http().patch("/v1/app-users/user-leaving").set(basic(B)).send({ active: true })).status).toBe(404);
            expect((await http().patch("/v1/app-users/user-leaving").set(basic(A)).send({ active: true })).body.data.status).toBe("active");
            expect((await as(await tokenFor(A, "user-leaving")).get("/v1/me")).status).toBe(200);
            // The token issued before the deactivation stays dead
            expect((await as(t).get("/v1/me")).status).toBe(401);
        });
    });

    // ------------------------------------------------------------ 8b. Developer Portal (owner session)

    it("the owner manages the app's users from their SpreeWe session; nobody else can", async () => {
        const base = `/v1/apps/${A.app._id}/users`;
        const created = await api(ownerA).post(base).send({ externalUserId: "portal-1", name: "Portal Made", email: "portal@example.test" });
        expect(created.status, JSON.stringify(created.body)).toBe(201);
        expect(created.body.data).toMatchObject({ externalUserId: "portal-1", status: "active", tenantId: A.app.tenantId });
        expect((await api(ownerA).post(base).send({ externalUserId: "portal-1", name: "Portal Again" })).status).toBe(409);
        // Same user as the server API sees, and it can sign in through the app
        expect((await http().get("/v1/app-users/portal-1").set(basic(A))).body.data._id).toBe(created.body.data._id);
        expect((await as(await tokenFor(A, "portal-1")).get("/v1/me")).body.data.context.tenantId).toBe(A.app.tenantId);

        const list = await api(ownerA).get(`${base}?limit=100`);
        expect(list.status).toBe(200);
        expect(list.body.data.map((u: any) => u.externalUserId)).toEqual(expect.arrayContaining(["user-1", "user-2", "portal-1"]));
        expect(list.body.data.every((u: any) => u.tenantId === A.app.tenantId)).toBe(true);
        expect(JSON.stringify(list.body)).not.toContain(b1._id);
        expect((await api(ownerA).get(`${base}?limit=1`)).body.page.nextCursor).toBeTruthy();
        expect((await api(ownerA).get(`${base}/portal-1`)).body.data.email).toBe("portal@example.test");

        expect((await api(ownerA).patch(`${base}/portal-1`).send({ name: "Portal Renamed", active: false })).body.data).toMatchObject({ name: "Portal Renamed", status: "deactivated" });
        expect((await http().post("/v1/app-tokens").set(basic(A)).send({ externalUserRef: "portal-1" })).status).toBe(403);
        expect((await api(ownerA).get(`${base}?status=deactivated`)).body.data.map((u: any) => u.externalUserId)).toContain("portal-1");
        expect((await api(ownerA).patch(`${base}/portal-1`).send({ active: true })).body.data.status).toBe("active");
        const audit = await api(ownerA).get(`/v1/apps/${A.app._id}/audit`);
        expect(audit.body.data.filter((e: any) => e.action.startsWith("user.") && e.actorKind === "owner").map((e: any) => e.action)).toEqual(expect.arrayContaining(["user.registered", "user.deactivated", "user.reactivated"]));

        // Another developer, a SpreeWe user, an anonymous caller, an app user's token and the app credential are all refused
        for (const who of [ownerB, { user: spree } as Session]) {
            expect((await api(who).get(base)).status).toBe(404);
            expect((await api(who).post(base).send({ externalUserId: "intruder-1", name: "Intruder One" })).status).toBe(404);
            expect((await api(who).get(`${base}/user-1`)).status).toBe(404);
            expect((await api(who).patch(`${base}/user-1`).send({ active: false })).status).toBe(404);
        }
        expect((await http().get(base)).status).toBe(401);
        expect((await as(tA1).get(base)).status).toBe(403);
        expect((await as(tB1).get(base)).status).toBe(403);
        expect((await http().get(base).set(basic(A))).status).toBe(401);
        // The owner of A can't reach B's users through their own app id either
        expect((await api(ownerA).get(`/v1/apps/${B.app._id}/users`)).status).toBe(404);
        expect((await api(ownerA).get(`${base}/${encodeURIComponent("user-2")}`)).body.data._id).toBe(a2._id);
        expect(await sys(() => User.countDocuments({ externalUserId: "intruder-1" }))).toBe(0);
        expect((await sys(() => User.findById(a1._id).lean()))!.deactivatedAt ?? null).toBeNull();
        // From inside an organization the owner's own app isn't manageable (wrong context)
        const org = newOrg();
        const inOrg: Session = { user: ownerA.user, org, role: "org:admin" };
        await enter(inOrg);
        expect((await api(inOrg).get(base)).status).toBe(404);
    });

    // ------------------------------------------------------------ 9. app lifecycle and legacy apps

    it("consent and OAuth can't link SpreeWe accounts to an application that has its own tenant", async () => {
        expect((await api({ user: spree }).post(`/v1/apps/${A.app._id}/grants`).send({ scopes: ["profile:read"] })).status).toBe(409);
        const withCb = await newApp(ownerA, { callbackUrls: ["https://example.com/cb"] });
        const req = await http().post("/v1/consent-requests").set(basic(withCb)).send({ redirectUri: "https://example.com/cb", scopes: ["profile:read"], state: "state-12345" });
        expect(req.status).toBe(409);
        expect(await sys(() => AppGrant.countDocuments({ appId: A.app._id, managed: { $ne: true } }))).toBe(0);
    });

    it("legacy global apps keep working by consent and can't register users", async () => {
        const owner: Session = { user: await makeUser() };
        const legacy = await newApp(owner, { scopes: ["profile:read"] });
        await legacyGlobal(legacy.app._id);
        expect((await api({ user: spree }).post(`/v1/apps/${legacy.app._id}/grants`).send({ scopes: ["profile:read"] })).status).toBe(201);
        const tok = await http().post("/v1/app-tokens").set(basic(legacy)).send({ userId: String(spree._id) });
        expect(tok.status, JSON.stringify(tok.body)).toBe(201);
        expect(tok.body.data.tenantId).toBeNull();
        expect((await as(tok.body.data.accessToken).get("/v1/me")).body.data.context.tenantId).toBeNull();
        expect((await http().post("/v1/app-users").set(basic(legacy)).send({ externalUserId: "x-1", name: "Some One" })).status).toBe(403);
        expect((await api(owner).get(`/v1/apps/${legacy.app._id}/users`)).status).toBe(403);
        expect((await api(owner).post(`/v1/apps/${legacy.app._id}/users`).send({ externalUserId: "x-1", name: "Some One" })).status).toBe(403);
        // …and can't act for an application user
        expect((await http().post("/v1/app-tokens").set(basic(legacy)).send({ userId: a1._id })).status).toBe(403);
        expect((await api(owner).get("/v1/apps")).body.data.map((x: any) => x._id)).toContain(legacy.app._id);
    });

    it("suspending an app closes its workspace; revoking it closes it for good", async () => {
        const owner: Session = { user: await makeUser() };
        const C = await newApp(owner);
        await register(C, "c-1");
        const t = await tokenFor(C, "c-1");
        expect((await as(t).get("/v1/me")).status).toBe(200);
        expect((await api(owner).post(`/v1/apps/${C.app._id}/suspend`)).status).toBe(201);
        expect((await sys(() => Tenant.findById(C.app.tenantId).lean()))!.status).toBe("suspended");
        expect((await as(t).get("/v1/me")).status).toBe(401);
        expect((await http().post("/v1/app-users").set(basic(C)).send({ externalUserId: "c-2", name: "Some One" })).status).toBe(403);
        expect((await api(owner).post(`/v1/apps/${C.app._id}/reactivate`)).status).toBe(201);
        expect((await sys(() => Tenant.findById(C.app.tenantId).lean()))!.status).toBe("active");
        expect((await as(t).get("/v1/me")).status).toBe(200);
        expect((await api(owner).post(`/v1/apps/${C.app._id}/revoke`).send({ confirm: C.app.name })).status).toBe(201);
        expect((await sys(() => Tenant.findById(C.app.tenantId).lean()))!.status).toBe("deleted");
        expect((await as(t).get("/v1/me")).status).toBe(401);
        // Other applications are untouched
        expect((await as(tA1).get("/v1/me")).status).toBe(200);
    });
});
