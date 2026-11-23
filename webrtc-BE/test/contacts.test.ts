import { afterEach, beforeAll, describe, expect, it } from "vitest";
import Block from "../src/models/blockModel";
import Conversation from "../src/models/conversationModel";
import User from "../src/models/userModel";
import TenantMembership from "../src/models/tenantMembershipModel";
import { runAsSystem } from "../src/tenancy/context";
import { resetTenantCaches } from "../src/tenancy/tenant.service";
import { resetLookupLimits, NOT_FOUND_MESSAGE } from "../src/contacts/contact.service";
import { OrgInvitation } from "../src/organizations/models";
import { clerkTestState } from "./support/clerk-double";
import { api, makeUser, oid, uniq } from "./helpers";

/**
 * Contact discovery: by exact email only (no public directory), external conversations only where
 * the organization allows them, and invitations that work across email domains.
 */
type U = Awaited<ReturnType<typeof makeUser>>;
const personal = (u: U) => api({ user: u });
const inOrg = (u: U, org: { clerkOrgId: string }) => api({ user: u, org: org.clerkOrgId });
const slug = () => uniq("org").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
const lookup = (s: ReturnType<typeof api>, email: string, scope?: string) => s.post("/v1/contacts/lookup").send({ email, ...(scope ? { scope } : {}) });

async function orgWith(owner: U, members: U[], extra: Record<string, unknown> = {}) {
    const org = (await personal(owner).post("/v1/organizations").send({ name: "Org " + uniq(""), slug: slug(), ...extra })).body.data;
    for (const m of members) {
        const r = await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [m.email], role: "member" });
        const token = new URL(r.body.data.results[0].link, "http://x").searchParams.get("token");
        expect((await personal(m).post("/v1/organization-invitations/accept").send({ token })).status).toBe(201);
    }
    resetTenantCaches();
    return org as { organizationId: string; clerkOrgId: string; name: string };
}

beforeAll(() => Promise.all([Conversation, TenantMembership, OrgInvitation].map((m: any) => m.createIndexes())));
afterEach(() => { resetLookupLimits(); delete process.env.CONTACT_LOOKUP_PER_10MIN; clerkTestState.emails.clear(); resetTenantCaches(); });

describe("personal context: find people by email, no directory", () => {
    it("finds an eligible account by exact email (case-insensitive) with minimal profile data, and opens or reuses one chat", async () => {
        const [me, ann] = [await makeUser(), await makeUser()];
        const res = await lookup(personal(me), `  ${ann.email.toUpperCase()} `);
        expect(res.status).toBe(201);
        expect(res.body.data).toMatchObject({ found: true, user: { _id: String(ann._id), username: ann.username }, external: false, conversationId: null });
        expect(JSON.stringify(res.body)).not.toContain(ann.email); // never echoes account emails
        const a = await personal(me).post("/v1/contacts/start").send({ email: ann.email });
        const b = await personal(me).post("/v1/contacts/start").send({ email: ann.email });
        expect(a.status).toBe(201);
        expect(b.body.data.conversationId).toBe(a.body.data.conversationId);
        expect((await lookup(personal(me), ann.email)).body.data.conversationId).toBe(a.body.data.conversationId);
    });

    it("unregistered, blocked (either way), opted-out and own addresses all get the same answer", async () => {
        const [me, blockedByMe, blocksMe, hidden] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
        await runAsSystem(() => Block.create({ blockerId: me._id, blockedUserId: blockedByMe._id }), "test");
        await runAsSystem(() => Block.create({ blockerId: blocksMe._id, blockedUserId: me._id }), "test");
        await runAsSystem(() => User.updateOne({ _id: hidden._id }, { $set: { globalDiscoverable: false } }), "test");
        const answers = [];
        for (const email of ["nobody-" + uniq("x") + "@example.test", blockedByMe.email, blocksMe.email, hidden.email, me.email]) {
            const r = await lookup(personal(me), email);
            expect(r.status).toBe(201);
            answers.push(JSON.stringify(r.body.data));
        }
        expect(new Set(answers).size).toBe(1);
        expect(answers[0]).toContain(NOT_FOUND_MESSAGE);
        // …and the API can't be used to start a chat with them either
        expect((await personal(me).post("/v1/contacts/start").send({ email: hidden.email })).status).toBe(404);
        expect((await personal(me).post("/conversations").send({ receiverId: String(hidden._id) })).status).toBe(404);
        expect((await personal(me).post("/conversations").send({ receiverId: String(blocksMe._id) })).status).toBe(403);
    });

    it("validates the address and rate-limits lookups per user", async () => {
        const me = await makeUser();
        expect((await lookup(personal(me), "not-an-email")).status).toBe(400);
        process.env.CONTACT_LOOKUP_PER_10MIN = "3";
        for (let i = 0; i < 3; i++) expect((await lookup(personal(me), `p${i}@example.test`)).status).toBe(201);
        expect((await lookup(personal(me), "p9@example.test")).status).toBe(429);
        // Someone else has their own budget
        expect((await lookup(personal(await makeUser()), "p9@example.test")).status).toBe(201);
    });

    it("the people list, people search and profiles show only people I already talk to", async () => {
        const [me, friend, stranger] = [await makeUser(uniq("pme")), await makeUser(uniq("pfriend")), await makeUser(uniq("pstranger"))];
        await personal(me).post("/v1/contacts/start").send({ email: friend.email });
        const list = JSON.stringify((await personal(me).get("/web/users/except-current")).body);
        expect(list).toContain(String(friend._id));
        expect(list).not.toContain(String(stranger._id));
        expect(JSON.stringify((await personal(me).get(`/search?q=${encodeURIComponent(stranger.username)}`)).body)).not.toContain(String(stranger._id));
        expect((await personal(me).get(`/web/user/${stranger._id}`)).status).toBe(404);
        expect((await personal(me).get(`/web/user/${friend._id}`)).status).toBe(200);
    });
});

describe("organization context: members and external people", () => {
    it("finds members of the active organization by email, never members of other organizations", async () => {
        const [owner, bob, other] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await orgWith(owner, [bob]);
        await orgWith(other, []); // a member of a different organization
        const found = await lookup(inOrg(owner, org), bob.email);
        expect(found.body.data).toMatchObject({ found: true, external: false, user: { _id: String(bob._id) } });
        expect((await lookup(inOrg(owner, org), other.email)).body.data).toEqual({ found: false, message: NOT_FOUND_MESSAGE });
        const chat = await inOrg(owner, org).post("/v1/contacts/start").send({ email: bob.email });
        expect(chat.status).toBe(201);
        expect(chat.body.data.external).toBe(false);
    });

    it("external search is refused while the policy is off; once on, the conversation is external and the outsider sees nothing else", async () => {
        const [owner, bob, outsider] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await orgWith(owner, [bob]);
        const off = await lookup(inOrg(owner, org), outsider.email, "external");
        expect(off.status).toBe(403);
        expect(JSON.stringify(off.body)).toContain("policy does not permit");
        expect((await inOrg(owner, org).post("/v1/contacts/start").send({ email: outsider.email, scope: "external" })).status).toBe(403);

        await inOrg(owner, org).patch("/v1/workspace/policies").send({ allowExternalChat: true });
        resetTenantCaches();
        // A plain member may not start external chats unless allowed
        expect((await lookup(inOrg(bob, org), outsider.email, "external")).status).toBe(403);
        const hit = await lookup(inOrg(owner, org), outsider.email, "external");
        expect(hit.body.data).toMatchObject({ found: true, external: true });
        // A member found through the external search is offered as an internal contact (no duplicate person)
        expect((await lookup(inOrg(owner, org), bob.email, "external")).body.data).toMatchObject({ found: true, external: false });

        const started = await inOrg(owner, org).post("/v1/contacts/start").send({ email: outsider.email, scope: "external" });
        expect(started.body.data.external).toBe(true);
        const conv = await runAsSystem(() => Conversation.findById(started.body.data.conversationId).lean(), "test");
        expect(conv).toMatchObject({ scope: "external", tenantId: oid(org.organizationId) });
        expect((conv!.externalParticipants || []).map(String)).toEqual([String(outsider._id)]);

        // The outsider: no access to the organization, its member list or its people
        expect((await inOrg(outsider, org).get("/v1/workspace/organization")).status).toBe(403);
        const theirs = JSON.stringify((await personal(outsider).get("/web/users/except-current")).body);
        expect(theirs).not.toContain(String(bob._id));
        expect((await lookup(personal(outsider), bob.email)).body.data.found).toBe(true); // findable by email like anyone…
        expect(JSON.stringify(await personal(outsider).get("/v1/teams").then((r) => r.body))).not.toContain("teamId");
    });
});

describe("invitations across email domains", () => {
    it("a gmail.com address joins Acme; a member of one organization joins another", async () => {
        const [owner, other] = [await makeUser(), await makeUser()];
        const gmail = await makeUser(uniq("g"), { email: `${uniq("someone")}@gmail.com` });
        const acme = await orgWith(owner, [gmail]);
        expect((await runAsSystem(() => TenantMembership.findOne({ tenantId: oid(acme.organizationId), userId: gmail._id }).lean(), "test"))!.status).toBe("active");
        const contoso = await orgWith(other, [gmail]); // already in Acme
        const mine = (await personal(gmail).get("/v1/organizations/mine")).body.data.map((o: any) => o.organizationId).sort();
        expect(mine).toEqual([acme.organizationId, contoso.organizationId].sort());
        // An organization that restricts domains still applies its policy
        await inOrg(owner, acme).patch("/v1/workspace/organization").send({ settings: { allowedEmailDomains: ["acme.example"] } });
        const late = await makeUser(uniq("late"), { email: `${uniq("late")}@gmail.com` });
        const res = await inOrg(owner, acme).post("/v1/workspace/invitations").send({ emails: [late.email], role: "member" });
        expect(res.body.data.results[0].status).toBe("domain_not_allowed");
    });

    it("an invitation grants exactly its role, once", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await orgWith(owner, []);
        const r = await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [bob.email], role: "member" });
        const token = new URL(r.body.data.results[0].link, "http://x").searchParams.get("token");
        // Extra fields can't change the role
        expect((await personal(bob).post("/v1/organization-invitations/accept").send({ token, role: "owner" })).status).toBe(400);
        expect((await personal(bob).post("/v1/organization-invitations/accept").send({ token })).status).toBe(201);
        expect((await runAsSystem(() => TenantMembership.findOne({ tenantId: oid(org.organizationId), userId: bob._id }).lean(), "test"))!.role).toBe("member");
        expect((await personal(bob).post("/v1/organization-invitations/accept").send({ token })).status).toBe(410);
    });
});
