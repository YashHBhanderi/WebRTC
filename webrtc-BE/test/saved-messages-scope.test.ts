import { afterEach, describe, expect, it } from "vitest";
import { resetTenantCaches } from "../src/tenancy/tenant.service";
import { clerkTestState } from "./support/clerk-double";
import { addMessage, api, makeUser, uniq } from "./helpers";

/**
 * Saved messages follow the active scope: a message saved in an organization is listed (and can be
 * removed) in that organization; personal saves stay personal. Each scope only shows its own.
 */
type U = Awaited<ReturnType<typeof makeUser>>;
const personal = (u: U) => api({ user: u });
const inOrg = (u: U, org: { clerkOrgId: string }) => api({ user: u, org: org.clerkOrgId });
const slug = () => uniq("org").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);

async function orgWith(owner: U, members: U[]) {
    const org = (await personal(owner).post("/v1/organizations").send({ name: "Org " + uniq(""), slug: slug() })).body.data;
    for (const m of members) {
        const r = await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [m.email], role: "member" });
        const token = new URL(r.body.data.results[0].link, "http://x").searchParams.get("token");
        expect((await personal(m).post("/v1/organization-invitations/accept").send({ token })).status).toBe(201);
    }
    return org as { organizationId: string; clerkOrgId: string };
}
const ids = (res: any) => (res.body?.data?.items || []).map((i: any) => i.messageId);

afterEach(() => { clerkTestState.failing.clear(); resetTenantCaches(); });

describe("saved messages per scope", () => {
    it("save, list and remove work in an organization and in personal scope, each showing only its own", async () => {
        const [alice, bob] = [await makeUser(), await makeUser()];
        const org = await orgWith(alice, [bob]);

        const orgChat = await inOrg(alice, org).post("/conversations").send({ receiverId: String(bob._id) });
        expect(orgChat.status, JSON.stringify(orgChat.body)).toBe(200);
        const orgMsg = await addMessage(orgChat.body.conversationId, alice, "org");
        const dm = await personal(alice).post("/conversations").send({ receiverId: String(bob._id) });
        const dmMsg = await addMessage(dm.body.conversationId, alice, "personal");

        const save = await inOrg(alice, org).put(`/messages/${orgMsg._id}/save`).send({ saved: true });
        expect(save.status, JSON.stringify(save.body)).toBe(200);
        expect((await personal(alice).put(`/messages/${dmMsg._id}/save`).send({ saved: true })).status).toBe(200);

        const inOrgList = await inOrg(alice, org).get("/saved-messages");
        expect(inOrgList.status, JSON.stringify(inOrgList.body)).toBe(200);
        expect(ids(inOrgList)).toEqual([String(orgMsg._id)]);
        expect(ids(await personal(alice).get("/saved-messages"))).toEqual([String(dmMsg._id)]);

        // The history marks it saved in its scope
        const h = await inOrg(alice, org).get(`/messages/${orgChat.body.conversationId}`);
        expect(h.body.data.find((m: any) => String(m._id) === String(orgMsg._id))?.saved).toBe(true);

        expect((await inOrg(alice, org).put(`/messages/${orgMsg._id}/save`).send({ saved: false })).status).toBe(200);
        expect(ids(await inOrg(alice, org).get("/saved-messages"))).toEqual([]);
        expect(ids(await personal(alice).get("/saved-messages"))).toEqual([String(dmMsg._id)]);
    });
});

describe("saved messages: repair of records stored before the fix", () => {
    it("migration 2026-10-28-saved-message-scope moves an organization save stored as personal back to its organization", async () => {
        const SavedMessage = (await import("../src/models/savedMessageModel")).default;
        const { checkScopeConsistency } = await import("../src/tenancy/consistency");
        const { runAsSystem } = await import("../src/tenancy/context");
        const [alice, bob] = [await makeUser(), await makeUser()];
        const org = await orgWith(alice, [bob]);
        const chat = await inOrg(alice, org).post("/conversations").send({ receiverId: String(bob._id) });
        const msg = await addMessage(chat.body.conversationId, alice, "org");
        // What the old code stored: the organization's message saved with no organization
        await SavedMessage.collection.insertOne({ userId: alice._id, messageId: msg._id, conversationId: msg.conversationId, tenantId: null, createdAt: new Date() });
        expect(ids(await inOrg(alice, org).get("/saved-messages"))).toEqual([]);
        await runAsSystem(() => checkScopeConsistency({ fix: true }), "test-migration");
        expect(ids(await inOrg(alice, org).get("/saved-messages"))).toEqual([String(msg._id)]);
        expect(ids(await personal(alice).get("/saved-messages"))).toEqual([]);
    });
});
