import crypto from "crypto";
import request from "supertest";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Tenant from "../src/models/tenantModel";
import TenantMembership from "../src/models/tenantMembershipModel";
import { JoinRequest, OrgInvitation, Team, TeamMembership } from "../src/organizations/models";
import { runAsSystem } from "../src/tenancy/context";
import { resetTenantCaches } from "../src/tenancy/tenant.service";
import { clerkTestState } from "./support/clerk-double";
import { api, makeUser, newOrg, oid, testApp, uniq } from "./helpers";

/**
 * Organization management (SpreeWe-managed organizations): creation, invitations, joining, roles,
 * removal and Clerk synchronisation failures. Clerk is the in-memory double (test/support/clerk-double.ts).
 */
type U = Awaited<ReturnType<typeof makeUser>>;
const personal = (u: U) => api({ user: u });
const inOrg = (u: U, clerkOrgId: string) => api({ user: u, org: clerkOrgId });
const slug = () => uniq("org").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);

async function createOrg(owner: U, extra: Record<string, unknown> = {}) {
    const res = await personal(owner).post("/v1/organizations").send({ name: "Acme " + uniq(""), slug: slug(), ...extra });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data as { organizationId: string; clerkOrgId: string; name: string; slug: string };
}
async function inviteLink(owner: U, org: { clerkOrgId: string }, email: string, role = "member") {
    const res = await inOrg(owner, org.clerkOrgId).post("/v1/workspace/invitations").send({ emails: [email], role });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const r = res.body.data.results[0];
    return { ...r, token: r.link ? new URL(r.link, "http://x").searchParams.get("token")! : "" };
}
const membership = (tenantId: string, userId: unknown) => runAsSystem(() => TenantMembership.findOne({ tenantId: oid(tenantId), userId: oid(userId) }).lean(), "test");
const setSettings = (owner: U, org: { clerkOrgId: string }, settings: Record<string, unknown>) => inOrg(owner, org.clerkOrgId).patch("/v1/workspace/organization").send({ settings });

// Unique indexes (slug, one pending invitation / request) as migration 2026-10-27 builds them; autoIndex is async
beforeAll(() => Promise.all([Tenant, TenantMembership, OrgInvitation, JoinRequest, Team, TeamMembership].map((m: any) => m.createIndexes())));

afterEach(() => {
    clerkTestState.failing.clear();
    clerkTestState.emails.clear();
    resetTenantCaches();
});

describe("organization creation", () => {
    it("a personal user creates an organization and becomes its owner; Clerk organization created and linked", async () => {
        const owner = await makeUser();
        const org = await createOrg(owner);
        expect(clerkTestState.orgs.get(org.clerkOrgId)?.members.get(owner.clerkId!)).toBe("org:admin");
        const t = await runAsSystem(() => Tenant.findById(org.organizationId).lean(), "test");
        expect(t).toMatchObject({ managedBy: "spreewe", clerkOrgId: org.clerkOrgId, status: "active" });
        expect((await membership(org.organizationId, owner._id))).toMatchObject({ role: "owner", status: "active", source: "creator" });
        const overview = await inOrg(owner, org.clerkOrgId).get("/v1/workspace/organization");
        expect(overview.status).toBe(200);
        expect(overview.body.data).toMatchObject({ role: "owner", memberCount: 1 });
        expect(overview.body.data.permissions["org:delete"]).toBe(true);
        const mine = await personal(owner).get("/v1/organizations/mine");
        expect(mine.body.data.map((o: any) => o.organizationId)).toContain(org.organizationId);
    });

    it("validates input, rejects unknown fields, and keeps slugs unique (also under a race, with Clerk rolled back)", async () => {
        const owner = await makeUser();
        expect((await personal(owner).post("/v1/organizations").send({ name: "x", slug: "ok-slug" })).status).toBe(400);
        expect((await personal(owner).post("/v1/organizations").send({ name: "Fine", slug: "Bad Slug" })).status).toBe(400);
        expect((await personal(owner).post("/v1/organizations").send({ name: "Fine", slug: slug(), role: "owner" })).status).toBe(400);
        const s = slug();
        const before = clerkTestState.orgs.size;
        const results = await Promise.all([1, 2, 3].map(() => personal(owner).post("/v1/organizations").send({ name: "Race", slug: s })));
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect(results.filter((r) => r.status === 409).length).toBe(2);
        // The losers' Clerk organizations were deleted again (or never created)
        expect(clerkTestState.orgs.size).toBe(before + 1);
    });

    it("a Clerk failure leaves nothing behind", async () => {
        const owner = await makeUser();
        clerkTestState.failing.add("createOrganization");
        const s = slug();
        expect((await personal(owner).post("/v1/organizations").send({ name: "Nope", slug: s })).status).toBe(500);
        expect(await runAsSystem(() => Tenant.exists({ slug: s }), "test")).toBeNull();
    });

    it("creation is rate limited per user", async () => {
        const owner = await makeUser();
        const codes: number[] = [];
        for (let i = 0; i < 6; i++) codes.push((await personal(owner).post("/v1/organizations").send({ name: "Org " + i, slug: slug() })).status);
        expect(codes.slice(0, 5).every((c) => c === 201)).toBe(true);
        expect(codes[5]).toBe(429);
    });
});

describe("invitations", () => {
    it("owner invites; the invitee previews and accepts with the link and becomes a member (Clerk membership added)", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        const inv = await inviteLink(owner, org, bob.email);
        expect(inv.status).toBe("invited");
        expect(inv.token).toMatch(/^inv_/);
        const preview = await personal(bob).post("/v1/organization-invitations/preview").send({ token: inv.token });
        expect(preview.status).toBe(201);
        expect(preview.body.data).toMatchObject({ name: org.name, role: "member" });
        const acc = await personal(bob).post("/v1/organization-invitations/accept").send({ token: inv.token });
        expect(acc.status, JSON.stringify(acc.body)).toBe(201);
        expect(acc.body.data.outcome).toBe("added");
        expect(clerkTestState.orgs.get(org.clerkOrgId)?.members.get(bob.clerkId!)).toBe("org:member");
        expect((await inOrg(bob, org.clerkOrgId).get("/v1/workspace/organization")).body.data.role).toBe("member");
        // The token is never stored
        const row = await runAsSystem(() => OrgInvitation.findById(inv.invitationId).lean(), "test");
        expect(JSON.stringify(row)).not.toContain(inv.token);
    });

    it("replay, email mismatch, expired and revoked invitations are refused; a mismatched attempt does not consume it", async () => {
        const [owner, bob, carol] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        const inv = await inviteLink(owner, org, bob.email);
        const stolen = await personal(carol).post("/v1/organization-invitations/accept").send({ token: inv.token });
        expect(stolen.status).toBe(403); // someone else's invitation: says so, without naming the address
        expect(JSON.stringify(stolen.body)).not.toContain(bob.email);
        expect((await runAsSystem(() => OrgInvitation.findById(inv.invitationId).lean(), "test"))!.status).toBe("pending");
        expect((await personal(bob).post("/v1/organization-invitations/accept").send({ token: inv.token })).status).toBe(201);
        expect((await personal(bob).post("/v1/organization-invitations/accept").send({ token: inv.token })).status).toBe(410); // replay: "already been used"
        // Unverified email does not count
        const dave = await makeUser();
        clerkTestState.emails.set(dave.clerkId!, [{ email: dave.email, verified: false }]);
        const inv2 = await inviteLink(owner, org, dave.email);
        expect((await personal(dave).post("/v1/organization-invitations/accept").send({ token: inv2.token })).status).toBe(403);
        clerkTestState.emails.delete(dave.clerkId!);
        // Expired
        await runAsSystem(() => OrgInvitation.updateOne({ _id: oid(inv2.invitationId) }, { $set: { expiresAt: new Date(Date.now() - 1000) } }), "test");
        const expired = await personal(dave).post("/v1/organization-invitations/accept").send({ token: inv2.token });
        expect(expired.status).toBe(410);
        expect(JSON.stringify(expired.body)).toContain("expired");
        // Revoked
        const erin = await makeUser();
        const inv3 = await inviteLink(owner, org, erin.email);
        expect((await inOrg(owner, org.clerkOrgId).post(`/v1/workspace/invitations/${inv3.invitationId}/revoke`)).status).toBe(201);
        const revoked = await personal(erin).post("/v1/organization-invitations/accept").send({ token: inv3.token });
        expect(revoked.status).toBe(410);
        expect(JSON.stringify(revoked.body)).toContain("revoked");
        // Resend rotates the token: the old link stops working
        const frank = await makeUser();
        const inv4 = await inviteLink(owner, org, frank.email);
        const resent = await inOrg(owner, org.clerkOrgId).post(`/v1/workspace/invitations/${inv4.invitationId}/resend`);
        const newToken = new URL(resent.body.data.link, "http://x").searchParams.get("token");
        expect((await personal(frank).post("/v1/organization-invitations/accept").send({ token: inv4.token })).status).toBe(404);
        expect((await personal(frank).post("/v1/organization-invitations/accept").send({ token: newToken })).status).toBe(201);
    });

    it("concurrent acceptance: exactly one succeeds, one membership", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        const inv = await inviteLink(owner, org, bob.email);
        const results = await Promise.all(Array.from({ length: 6 }, () => personal(bob).post("/v1/organization-invitations/accept").send({ token: inv.token })));
        expect(results.filter((r) => r.status === 201)).toHaveLength(1);
        expect(await runAsSystem(() => TenantMembership.countDocuments({ tenantId: oid(org.organizationId), userId: bob._id }), "test")).toBe(1);
    });

    it("in-app: my pending invitations (by verified email) can be accepted without the link", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        await inviteLink(owner, org, bob.email);
        const mine = await personal(bob).get("/v1/me/organization-invitations");
        expect(mine.body.data.map((i: any) => i.organizationId)).toEqual([org.organizationId]);
        const acc = await personal(bob).post("/v1/organization-invitations/accept").send({ invitationId: mine.body.data[0].invitationId });
        expect(acc.status).toBe(201);
        // Someone else can't accept it by id
        const carol = await makeUser();
        const inv2 = await inviteLink(owner, org, (await makeUser()).email);
        expect((await personal(carol).post("/v1/organization-invitations/accept").send({ invitationId: inv2.invitationId })).status).toBe(403);
        expect((await runAsSystem(() => OrgInvitation.findById(inv2.invitationId).lean(), "test"))!.status).toBe("pending");
    });

    it("roles an inviter may grant: admins invite members (not admins); members only when allowed; guests only when enabled", async () => {
        const [owner, admin, member] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        for (const u of [admin, member]) {
            const inv = await inviteLink(owner, org, u.email);
            await personal(u).post("/v1/organization-invitations/accept").send({ token: inv.token });
        }
        expect((await inOrg(owner, org.clerkOrgId).patch(`/v1/workspace/organization/members/${admin._id}`).send({ role: "admin" })).status).toBe(200);
        const a = inOrg(admin, org.clerkOrgId);
        expect((await a.post("/v1/workspace/invitations").send({ emails: ["new1@example.test"], role: "member" })).status).toBe(201);
        expect((await a.post("/v1/workspace/invitations").send({ emails: ["new2@example.test"], role: "admin" })).status).toBe(403);
        expect((await a.post("/v1/workspace/invitations").send({ emails: ["new3@example.test"], role: "guest" })).status).toBe(403); // guests off
        const m = inOrg(member, org.clerkOrgId);
        expect((await m.post("/v1/workspace/invitations").send({ emails: ["new4@example.test"], role: "member" })).status).toBe(403);
        await setSettings(owner, org, { membersCanInvite: true, guestAccess: true });
        expect((await m.post("/v1/workspace/invitations").send({ emails: ["new5@example.test"], role: "member" })).status).toBe(201);
        expect((await m.post("/v1/workspace/invitations").send({ emails: ["new6@example.test"], role: "guest" })).status).toBe(403);
        expect((await a.post("/v1/workspace/invitations").send({ emails: ["new7@example.test"], role: "guest" })).status).toBe(201);
    });
});

describe("authorization of administrative operations", () => {
    it("a plain member is refused every administrative operation", async () => {
        const [owner, member, other] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        for (const u of [member, other]) await personal(u).post("/v1/organization-invitations/accept").send({ token: (await inviteLink(owner, org, u.email)).token });
        const m = inOrg(member, org.clerkOrgId);
        const calls = [
            m.patch("/v1/workspace/organization").send({ name: "Hijacked" }),
            m.patch(`/v1/workspace/organization/members/${other._id}`).send({ role: "admin" }),
            m.patch(`/v1/workspace/organization/members/${member._id}`).send({ role: "owner" }),
            m.post(`/v1/workspace/organization/members/${other._id}/remove`),
            m.get("/v1/workspace/join-requests"),
            m.get("/v1/workspace/invitations"),
            m.post("/v1/workspace/join-code").send({ enable: true }),
            m.get("/v1/workspace/audit"),
            m.post("/v1/workspace/organization/delete").send({ confirm: org.name }),
            m.post("/v1/workspace/organization/transfer").send({ userId: String(member._id) }),
        ];
        for (const res of await Promise.all(calls)) expect(res.status, res.req?.path).toBe(403);
        expect((await runAsSystem(() => Tenant.findById(org.organizationId).lean(), "test"))!.name).toBe(org.name);
    });

    it("no role escalation: admins can't grant admin or touch owners; nobody changes their own role", async () => {
        const [owner, admin, member] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        for (const u of [admin, member]) await personal(u).post("/v1/organization-invitations/accept").send({ token: (await inviteLink(owner, org, u.email)).token });
        await inOrg(owner, org.clerkOrgId).patch(`/v1/workspace/organization/members/${admin._id}`).send({ role: "admin" });
        const a = inOrg(admin, org.clerkOrgId);
        expect((await a.patch(`/v1/workspace/organization/members/${member._id}`).send({ role: "admin" })).status).toBe(403);
        expect((await a.patch(`/v1/workspace/organization/members/${owner._id}`).send({ role: "member" })).status).toBe(403);
        expect((await a.post(`/v1/workspace/organization/members/${owner._id}/remove`)).status).toBe(403);
        expect((await a.patch(`/v1/workspace/organization/members/${admin._id}`).send({ role: "owner" })).status).toBe(403);
        expect((await inOrg(owner, org.clerkOrgId).patch(`/v1/workspace/organization/members/${owner._id}`).send({ role: "member" })).status).toBe(403);
    });

    it("the last owner can't leave, be removed or be demoted; transfer works", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        await personal(bob).post("/v1/organization-invitations/accept").send({ token: (await inviteLink(owner, org, bob.email)).token });
        expect((await inOrg(owner, org.clerkOrgId).post("/v1/workspace/leave")).status).toBe(409);
        expect((await inOrg(owner, org.clerkOrgId).post("/v1/workspace/organization/transfer").send({ userId: String(bob._id) })).status).toBe(201);
        resetTenantCaches();
        expect((await membership(org.organizationId, bob._id))!.role).toBe("owner");
        expect((await membership(org.organizationId, owner._id))!.role).toBe("admin");
        expect((await inOrg(bob, org.clerkOrgId).post("/v1/workspace/leave")).status).toBe(409);
        expect((await inOrg(owner, org.clerkOrgId).post("/v1/workspace/leave")).status).toBe(201);
    });

    it("two owners demoting, removing or leaving at the same moment never leave the organization without an owner", async () => {
        const [a, b] = [await makeUser(), await makeUser()];
        const org = await createOrg(a);
        await personal(b).post("/v1/organization-invitations/accept").send({ token: (await inviteLink(a, org, b.email, "admin")).token });
        const owners = () => runAsSystem(() => TenantMembership.countDocuments({ tenantId: oid(org.organizationId), status: "active", role: "owner" }), "test");
        const races: [string, (me: U, other: U) => Promise<request.Response>][] = [
            ["demote", (me, other) => inOrg(me, org.clerkOrgId).patch(`/v1/workspace/organization/members/${other._id}`).send({ role: "admin" })],
            ["remove", (me, other) => inOrg(me, org.clerkOrgId).post(`/v1/workspace/organization/members/${other._id}/remove`)],
            ["leave", (me) => inOrg(me, org.clerkOrgId).post("/v1/workspace/leave")],
        ];
        for (const [name, act] of races) {
            // Both are owners again before each race
            await runAsSystem(() => TenantMembership.updateMany({ tenantId: oid(org.organizationId), userId: { $in: [a._id, b._id] } }, { $set: { role: "owner", status: "active" } }), "test");
            resetTenantCaches();
            const res = await Promise.all([act(a, b), act(b, a)]);
            expect(await owners(), `${name}: ${res.map((r) => r.status)}`).toBeGreaterThanOrEqual(1);
            expect(res.filter((r) => r.status < 300).length, name).toBeLessThanOrEqual(1);
        }
    });

    it("a legacy Clerk-managed workspace gets a clear refusal for organization management, teams and channels", async () => {
        const u = await makeUser();
        const legacy = api({ user: u, org: newOrg(), role: "org:admin" });
        for (const res of [await legacy.get("/v1/workspace/organization"), await legacy.get("/v1/teams"), await legacy.post("/v1/teams").send({ name: "Ops" })]) {
            expect(res.status).toBe(404);
            expect(JSON.stringify(res.body)).toContain("managed in Clerk");
        }
    });

    it("platform administrators get nothing inside an organization", async () => {
        const [owner, platform] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        process.env.PLATFORM_ADMIN_CLERK_IDS = platform.clerkId!;
        try {
            expect((await inOrg(platform, org.clerkOrgId).get("/v1/workspace/organization")).status).toBe(403);
        } finally {
            delete process.env.PLATFORM_ADMIN_CLERK_IDS;
        }
    });
});

describe("joining", () => {
    it("discoverable + request: listed, request, duplicate refused, owner approves → member; reject works", async () => {
        const [owner, eve, mallory] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await createOrg(owner, { discoverable: true, joinPolicy: "request" });
        const found = await personal(eve).get(`/v1/organizations/discover?q=${encodeURIComponent(org.name)}`);
        expect(found.body.data.map((o: any) => o.organizationId)).toContain(org.organizationId);
        expect(JSON.stringify(found.body.data)).not.toMatch(/members|email/);
        expect((await personal(eve).post(`/v1/organizations/${org.organizationId}/join`).send({})).status).toBe(404); // not open
        const req = await personal(eve).post(`/v1/organizations/${org.organizationId}/join-requests`).send({ message: "hi" });
        expect(req.status).toBe(201);
        expect((await personal(eve).post(`/v1/organizations/${org.organizationId}/join-requests`).send({})).status).toBe(409);
        const list = await inOrg(owner, org.clerkOrgId).get("/v1/workspace/join-requests");
        expect(list.body.data.map((r: any) => String(r.userId))).toContain(String(eve._id));
        expect((await inOrg(eve, org.clerkOrgId).get("/v1/workspace/organization")).status).toBe(403); // not yet
        expect((await inOrg(owner, org.clerkOrgId).post(`/v1/workspace/join-requests/${req.body.data.requestId}/approve`)).status).toBe(201);
        resetTenantCaches();
        expect((await inOrg(eve, org.clerkOrgId).get("/v1/workspace/organization")).body.data.role).toBe("member");
        const r2 = await personal(mallory).post(`/v1/organizations/${org.organizationId}/join-requests`).send({});
        await inOrg(owner, org.clerkOrgId).post(`/v1/workspace/join-requests/${r2.body.data.requestId}/reject`);
        expect((await membership(org.organizationId, mallory._id))).toBeNull();
        expect((await personal(mallory).get("/v1/me/join-requests")).body.data[0].status).toBe("rejected");
    });

    it("private organizations: not discoverable, no joining or requesting by id; only a valid join code works", async () => {
        const [owner, eve] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        const found = await personal(eve).get(`/v1/organizations/discover?q=${encodeURIComponent(org.name)}`);
        expect(found.body.data.map((o: any) => o.organizationId)).not.toContain(org.organizationId);
        expect((await personal(eve).post(`/v1/organizations/${org.organizationId}/join`).send({})).status).toBe(404);
        expect((await personal(eve).post(`/v1/organizations/${org.organizationId}/join-requests`).send({})).status).toBe(404);
        expect((await personal(eve).post(`/v1/organizations/${org.organizationId}/join`).send({ code: "AAAAAAAAAA" })).status).toBe(404);
        const code = (await inOrg(owner, org.clerkOrgId).post("/v1/workspace/join-code").send({ enable: true })).body.data.code;
        expect(code).toMatch(/^[A-Z2-9]{10}$/);
        expect((await personal(eve).post(`/v1/organizations/${org.organizationId}/join`).send({ code: code.toLowerCase() })).status).toBe(201);
        await inOrg(owner, org.clerkOrgId).post("/v1/workspace/join-code").send({ enable: false });
        const late = await makeUser();
        expect((await personal(late).post(`/v1/organizations/${org.organizationId}/join`).send({ code })).status).toBe(404);
    });

    it("open organizations: join directly, but the allowed-domain list is enforced on verified emails", async () => {
        const [owner, eve, outsider] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await createOrg(owner, { discoverable: true, joinPolicy: "open" });
        expect((await personal(eve).post(`/v1/organizations/${org.organizationId}/join`).send({})).status).toBe(201);
        await setSettings(owner, org, { allowedEmailDomains: ["acme.example"] });
        expect((await personal(outsider).post(`/v1/organizations/${org.organizationId}/join`).send({})).status).toBe(403);
        clerkTestState.emails.set(outsider.clerkId!, [{ email: "someone@acme.example", verified: true }]);
        expect((await personal(outsider).post(`/v1/organizations/${org.organizationId}/join`).send({})).status).toBe(201);
    });
});

describe("removal, revocation and Clerk synchronisation", () => {
    it("a removed member loses access immediately; their Clerk membership is removed", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        await personal(bob).post("/v1/organization-invitations/accept").send({ token: (await inviteLink(owner, org, bob.email)).token });
        expect((await inOrg(bob, org.clerkOrgId).get("/v1/workspace/organization")).status).toBe(200);
        expect((await inOrg(owner, org.clerkOrgId).post(`/v1/workspace/organization/members/${bob._id}/remove`)).status).toBe(201);
        expect((await inOrg(bob, org.clerkOrgId).get("/v1/workspace/organization")).status).toBe(403);
        expect(clerkTestState.orgs.get(org.clerkOrgId)?.members.has(bob.clerkId!)).toBe(false);
    });

    it("removal still revokes access when Clerk is down (failure recorded for retry)", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        await personal(bob).post("/v1/organization-invitations/accept").send({ token: (await inviteLink(owner, org, bob.email)).token });
        clerkTestState.failing.add("deleteOrganizationMembership");
        expect((await inOrg(owner, org.clerkOrgId).post(`/v1/workspace/organization/members/${bob._id}/remove`)).status).toBe(201);
        expect((await inOrg(bob, org.clerkOrgId).get("/v1/workspace/organization")).status).toBe(403);
        const audit = await inOrg(owner, org.clerkOrgId).get("/v1/workspace/audit");
        expect(audit.body.data.map((e: any) => e.action)).toContain("clerk.sync_failed");
    });

    it("a Clerk failure while accepting grants nothing and gives the invitation back", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        const inv = await inviteLink(owner, org, bob.email);
        clerkTestState.failing.add("createOrganizationMembership");
        expect((await personal(bob).post("/v1/organization-invitations/accept").send({ token: inv.token })).status).toBe(503);
        expect(await membership(org.organizationId, bob._id)).toBeNull();
        expect((await inOrg(bob, org.clerkOrgId).get("/v1/workspace/organization")).status).toBe(403);
        clerkTestState.failing.clear();
        expect((await personal(bob).post("/v1/organization-invitations/accept").send({ token: inv.token })).status).toBe(201);
    });

    it("membership only in Clerk (dashboard, or a half-finished sync) never grants access; Clerk webhooks can't add members", async () => {
        const [owner, sneaky] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        clerkTestState.orgs.get(org.clerkOrgId)!.members.set(sneaky.clerkId!, "org:admin");
        expect((await inOrg(sneaky, org.clerkOrgId).get("/v1/workspace/organization")).status).toBe(403);
        expect((await inOrg(sneaky, org.clerkOrgId).get("/v1/conversations")).status).toBe(403);
        // A signed Clerk membership.created webhook does not create access either
        const body = JSON.stringify({ type: "organizationMembership.created", timestamp: Date.now(), object: "event", data: { id: "orgmem_x", role: "org:admin", organization: { id: org.clerkOrgId, name: "x" }, public_user_data: { user_id: sneaky.clerkId } } });
        const id = `msg_${uniq("w")}`, ts = String(Math.floor(Date.now() / 1000));
        const sig = crypto.createHmac("sha256", Buffer.from(process.env.CLERK_WEBHOOK_SIGNING_SECRET!.replace(/^whsec_/, ""), "base64")).update(`${id}.${ts}.${body}`).digest("base64");
        await request(testApp()).post("/webhooks/clerk").set({ "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}`, "content-type": "application/json" }).send(body);
        expect(await membership(org.organizationId, sneaky._id)).toBeNull();
        resetTenantCaches();
        expect((await inOrg(sneaky, org.clerkOrgId).get("/v1/workspace/organization")).status).toBe(403);
    });

    it("a deleted organization refuses everyone at once", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await createOrg(owner);
        await personal(bob).post("/v1/organization-invitations/accept").send({ token: (await inviteLink(owner, org, bob.email)).token });
        expect((await inOrg(owner, org.clerkOrgId).post("/v1/workspace/organization/delete").send({ confirm: "wrong" })).status).toBe(400);
        expect((await inOrg(owner, org.clerkOrgId).post("/v1/workspace/organization/delete").send({ confirm: org.name })).status).toBe(201);
        for (const u of [owner, bob]) expect((await inOrg(u, org.clerkOrgId).get("/v1/workspace/organization")).status).toBe(403);
        expect(clerkTestState.orgs.has(org.clerkOrgId)).toBe(false);
    });
});
