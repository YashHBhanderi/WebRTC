import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";
import Conversation from "../src/models/conversationModel";
import { Team, TeamMembership } from "../src/organizations/models";
import { runAsSystem } from "../src/tenancy/context";
import { resetTenantCaches } from "../src/tenancy/tenant.service";
import { clerkTestState } from "./support/clerk-double";
import { addMessage, api, connect, makeUser, nextEvent, oid, startSocketServer, uniq, enc, plainOf } from "./helpers";

/**
 * Teams and channels: who sees and reads what. Channels are conversations, so these tests read
 * messages through the ordinary conversation endpoints and sockets.
 */
type U = Awaited<ReturnType<typeof makeUser>>;
const personal = (u: U) => api({ user: u });
const inOrg = (u: U, org: { clerkOrgId: string }) => api({ user: u, org: org.clerkOrgId });
const slug = () => uniq("org").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);

async function orgWith(owner: U, members: U[], extra: Record<string, unknown> = {}) {
    const org = (await personal(owner).post("/v1/organizations").send({ name: "Org " + uniq(""), slug: slug(), ...extra })).body.data;
    for (const m of members) {
        const r = await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [m.email], role: "member" });
        const token = new URL(r.body.data.results[0].link, "http://x").searchParams.get("token");
        expect((await personal(m).post("/v1/organization-invitations/accept").send({ token })).status).toBe(201);
    }
    return org as { organizationId: string; clerkOrgId: string; name: string };
}
const readable = async (u: U, org: { clerkOrgId: string } | null, channelId: string) => {
    const res = await (org ? inOrg(u, org) : personal(u)).get(`/v1/conversations/${channelId}/messages`);
    return res.status;
};

// Unique team names / one membership per person, as migration 2026-10-27 builds them; autoIndex is async
beforeAll(() => Promise.all([Team, TeamMembership].map((m: any) => m.createIndexes())));
afterEach(() => { clerkTestState.failing.clear(); resetTenantCaches(); });

describe("teams", () => {
    it("a team owner creates a team (with a General channel) and a standard channel; members see and read them", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await orgWith(owner, [bob]);
        const t = await inOrg(owner, org).post("/v1/teams").send({ name: "Engineering", description: "Builders" });
        expect(t.status).toBe(201);
        const teamId = t.body.data.teamId;
        const channels = await inOrg(owner, org).get(`/v1/teams/${teamId}/channels`);
        expect(channels.body.data.map((c: any) => c.name)).toEqual(["General"]);
        expect((await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(bob._id)] })).status).toBe(201);
        const std = await inOrg(owner, org).post(`/v1/teams/${teamId}/channels`).send({ name: "design", type: "standard" });
        expect(std.status).toBe(201);
        // Bob (team member) is in every standard channel and can read it
        await addMessage(std.body.data.channelId, owner, "standard hello");
        expect(await readable(bob, org, std.body.data.channelId)).toBe(200);
        // Channels are not mixed into the chat group list
        const groups = await inOrg(bob, org).get("/groupConversations");
        expect(JSON.stringify(groups.body)).not.toContain(std.body.data.channelId);
        // Duplicate team names are refused
        expect((await inOrg(owner, org).post("/v1/teams").send({ name: "engineering" })).status).toBe(409);
    });

    it("private teams are invisible to non-members; public teams can be joined, but not by guests", async () => {
        const [owner, bob, guest] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await orgWith(owner, [bob]);
        await inOrg(owner, org).patch("/v1/workspace/organization").send({ settings: { guestAccess: true } });
        const g = await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [guest.email], role: "guest" });
        await personal(guest).post("/v1/organization-invitations/accept").send({ token: new URL(g.body.data.results[0].link, "http://x").searchParams.get("token") });
        const priv = (await inOrg(owner, org).post("/v1/teams").send({ name: "Leadership", visibility: "private" })).body.data.teamId;
        const pub = (await inOrg(owner, org).post("/v1/teams").send({ name: "Social" })).body.data.teamId;
        const bobTeams = (await inOrg(bob, org).get("/v1/teams")).body.data.map((t: any) => t.teamId);
        expect(bobTeams).toContain(pub);
        expect(bobTeams).not.toContain(priv);
        expect((await inOrg(bob, org).get(`/v1/teams/${priv}`)).status).toBe(404);
        expect((await inOrg(bob, org).post(`/v1/teams/${priv}/join`)).status).toBe(404);
        expect((await inOrg(bob, org).post(`/v1/teams/${pub}/join`)).status).toBe(201);
        expect((await inOrg(guest, org).get("/v1/teams")).body.data).toEqual([]);
        expect((await inOrg(guest, org).post(`/v1/teams/${pub}/join`)).status).toBe(404);
        expect((await inOrg(guest, org).post("/v1/teams").send({ name: "Guest team" })).status).toBe(403);
    });

    it("team roles: plain members can't manage; the last team owner can't leave", async () => {
        const [owner, bob, carol] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await orgWith(owner, [bob, carol]);
        const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Ops" })).body.data.teamId;
        await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(bob._id)] });
        const b = inOrg(bob, org);
        expect((await b.post(`/v1/teams/${teamId}/members`).send({ userIds: [String(carol._id)] })).status).toBe(403);
        expect((await b.patch(`/v1/teams/${teamId}/members/${bob._id}`).send({ role: "owner" })).status).toBe(403);
        expect((await b.patch(`/v1/teams/${teamId}`).send({ name: "Mine now" })).status).toBe(403);
        expect((await b.post(`/v1/teams/${teamId}/archive`)).status).toBe(403);
        // The org owner created the team and is its only team owner
        expect((await inOrg(owner, org).post(`/v1/teams/${teamId}/members/${owner._id}/remove`)).status).toBe(409);
        // Adding a non-member of the organization is refused
        const outsider = await makeUser();
        expect((await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(outsider._id)] })).status).toBe(400);
    });

    it("adding people never changes the role of someone already on the team (a manager can't demote an owner that way)", async () => {
        const [owner, bob, carol] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await orgWith(owner, [bob, carol]);
        const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Ops" })).body.data.teamId;
        await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(bob._id)], role: "manager" });
        await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(carol._id)], role: "owner" });
        const res = await inOrg(bob, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(carol._id), String(owner._id)] });
        expect(res.status).toBe(201);
        expect(res.body.data.added).toBe(0);
        const roles = Object.fromEntries((await inOrg(owner, org).get(`/v1/teams/${teamId}/members`)).body.data.map((m: any) => [m.userId, m.role]));
        expect(roles).toMatchObject({ [String(carol._id)]: "owner", [String(owner._id)]: "owner", [String(bob._id)]: "manager" });
    });

    it("two team owners demoting or removing each other at the same moment never leave the team without an owner", async () => {
        const [owner, bob, carol] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await orgWith(owner, [bob, carol]);
        const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Ops" })).body.data.teamId;
        const teamOwners = async () => (await inOrg(owner, org).get(`/v1/teams/${teamId}/members`)).body.data.filter((m: any) => m.role === "owner").length;
        for (const act of [
            (me: U, other: U) => inOrg(me, org).patch(`/v1/teams/${teamId}/members/${other._id}`).send({ role: "member" }),
            (me: U, other: U) => inOrg(me, org).post(`/v1/teams/${teamId}/members/${other._id}/remove`),
        ]) {
            await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(bob._id), String(carol._id)] });
            for (const u of [bob, carol]) await inOrg(owner, org).patch(`/v1/teams/${teamId}/members/${u._id}`).send({ role: "owner" });
            // The org owner steps out, so bob and carol are the only team owners
            expect((await inOrg(owner, org).post(`/v1/teams/${teamId}/members/${owner._id}/remove`)).status).toBe(201);
            const res = await Promise.all([act(bob, carol), act(carol, bob)]);
            expect(await teamOwners(), String(res.map((r) => r.status))).toBeGreaterThanOrEqual(1);
            expect(res.filter((r) => r.status < 300).length).toBeLessThanOrEqual(1);
            await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(owner._id)], role: "owner" });
        }
    });
});

describe("guests", () => {
    it("see, find and add only people they share a conversation with — never the organization's directory", async () => {
        const [owner, bob, carol, guest] = [await makeUser(uniq("gowner")), await makeUser(uniq("gbob")), await makeUser(uniq("gcarol")), await makeUser()];
        const org = await orgWith(owner, [bob, carol], { allowExternalChat: true });
        await inOrg(owner, org).patch("/v1/workspace/organization").send({ settings: { guestAccess: true } });
        await inOrg(owner, org).patch("/v1/workspace/policies").send({ membersCanStartExternal: true });
        const g = await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [guest.email], role: "guest" });
        expect((await personal(guest).post("/v1/organization-invitations/accept").send({ token: new URL(g.body.data.results[0].link, "http://x").searchParams.get("token") })).status).toBe(201);
        const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Project" })).body.data.teamId;
        await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(bob._id), String(guest._id)] });
        const gs = inOrg(guest, org);

        // Bob shares the team's General channel with the guest; Carol shares nothing
        const dir = await gs.get("/v1/directory");
        expect(dir.status).toBe(200);
        expect(JSON.stringify(dir.body)).toContain(bob.username);
        expect(JSON.stringify(dir.body)).not.toContain(carol.username);
        expect(JSON.stringify((await gs.get(`/search?q=${encodeURIComponent(carol.username)}`)).body)).not.toContain(String(carol._id));
        expect((await gs.get(`/web/user/${carol._id}`)).status).toBe(404);
        expect((await gs.get(`/web/user/${bob._id}`)).status).toBe(200);
        expect((await gs.post("/conversations").send({ receiverId: String(carol._id) })).status).toBe(403);
        expect((await gs.get("/v1/workspace/members")).status).toBe(403);
        expect((await gs.get("/v1/workspace/organization/members")).status).toBe(403);
        // External chats are for members, never guests
        expect((await gs.get("/v1/workspace")).body.data?.permissions?.startExternal).toBe(false);
        // A member still sees the whole directory
        expect(JSON.stringify((await inOrg(bob, org).get("/v1/directory")).body)).toContain(carol.username);
    });
});

describe("private channels", () => {
    it("are visible and readable only by their members — not by other team members, nor org admins", async () => {
        const [owner, admin, bob, carol] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
        const org = await orgWith(owner, [admin, bob, carol]);
        await inOrg(owner, org).patch(`/v1/workspace/organization/members/${admin._id}`).send({ role: "admin" });
        const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Product" })).body.data.teamId;
        await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(admin._id), String(bob._id), String(carol._id)] });
        const ch = await inOrg(bob, org).post(`/v1/teams/${teamId}/channels`).send({ name: "secret", type: "private", memberIds: [] });
        expect(ch.status).toBe(201);
        const channelId = ch.body.data.channelId;
        await addMessage(channelId, bob, "private plans");
        expect(await readable(bob, org, channelId)).toBe(200);
        for (const u of [carol, admin, owner]) {
            expect(await readable(u, org, channelId)).toBe(404);
            expect((await inOrg(u, org).get(`/v1/teams/${teamId}/channels`)).body.data.map((c: any) => c.channelId)).not.toContain(channelId);
        }
        // An org admin can't add themselves either
        expect((await inOrg(admin, org).post(`/v1/teams/${teamId}/channels/${channelId}/members`).send({ userIds: [String(admin._id)] })).status).toBe(404);
        // Search doesn't reveal it
        const search = await inOrg(carol, org).get("/search?q=private");
        expect(JSON.stringify(search.body)).not.toContain("private plans");
        // Chat-group operations can't bypass the team rules
        expect((await inOrg(bob, org).post(`/conversations/group/${channelId}/members`).send({ userIds: [String(carol._id)] })).status).not.toBe(200);
        // Bob adds Carol properly; she can read now
        expect((await inOrg(bob, org).post(`/v1/teams/${teamId}/channels/${channelId}/members`).send({ userIds: [String(carol._id)] })).status).toBe(201);
        expect(await readable(carol, org, channelId)).toBe(200);
    });

    it("socket: a non-member can't join a private channel's room or receive its events", async () => {
        const server = await startSocketServer();
        const sockets: Socket[] = [];
        try {
            const [owner, bob, carol] = [await makeUser(), await makeUser(), await makeUser()];
            const org = await orgWith(owner, [bob, carol]);
            const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Sock" })).body.data.teamId;
            await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(bob._id), String(carol._id)] });
            const channelId = (await inOrg(bob, org).post(`/v1/teams/${teamId}/channels`).send({ name: "p", type: "private" })).body.data.channelId;
            const sb = await connect(server.port, { user: bob, org: org.clerkOrgId });
            const sc = await connect(server.port, { user: carol, org: org.clerkOrgId });
            sockets.push(sb, sc);
            sb.emit("joinConversation", channelId);
            sc.emit("joinConversation", channelId); // refused
            await new Promise((r) => setTimeout(r, 300));
            const leak = nextEvent(sc, "receiveMessage", 1500, (m) => String(m?.conversationId) === channelId);
            const leakTyping = nextEvent(sc, "userTyping", 1500, (m) => String(m?.conversationId) === channelId);
            sb.emit("typing", channelId);
            sb.emit("sendMessage", { user: { _id: String(bob._id) }, conversationId: channelId, e2ee: enc("members only"), type: "text" });
            expect(await leak).toBeNull();
            expect(await leakTyping).toBeNull();
            // Carol can't post into it either
            sc.emit("sendMessage", { user: { _id: String(carol._id) }, conversationId: channelId, e2ee: enc("intruder"), type: "text" });
            await new Promise((r) => setTimeout(r, 500));
            expect(JSON.stringify((await inOrg(bob, org).get(`/v1/conversations/${channelId}/messages`)).body)).not.toContain("intruder");
        } finally {
            sockets.forEach((s) => s.disconnect());
            await server.close();
        }
    });
});

describe("shared channels and external people", () => {
    it("need the external policy; external people read only that channel, labelled external, never internal ones", async () => {
        const [owner, bob, ext] = [await makeUser(), await makeUser(), await makeUser()];
        const org = await orgWith(owner, [bob]);
        const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Partners" })).body.data.teamId;
        const internal = (await inOrg(owner, org).get(`/v1/teams/${teamId}/channels`)).body.data[0].channelId;
        expect((await inOrg(owner, org).post(`/v1/teams/${teamId}/channels`).send({ name: "with-partner", type: "shared", externalUserIds: [String(ext._id)] })).status).toBe(403);
        await inOrg(owner, org).patch("/v1/workspace/policies").send({ allowExternalChat: true });
        // An organization member can't be passed as "external"
        expect((await inOrg(owner, org).post(`/v1/teams/${teamId}/channels`).send({ name: "x", type: "shared", externalUserIds: [String(bob._id)] })).status).toBe(400);
        const shared = await inOrg(owner, org).post(`/v1/teams/${teamId}/channels`).send({ name: "with-partner", type: "shared", externalUserIds: [String(ext._id)] });
        expect(shared.status).toBe(201);
        expect(shared.body.data.external).toBe(true);
        const sharedId = shared.body.data.channelId;
        await addMessage(sharedId, owner, "hello partner");
        await addMessage(internal, owner, "internal only");
        // The external person reads the shared channel from their personal context…
        expect(await readable(ext, null, sharedId)).toBe(200);
        // …but never internal channels, teams, members or the directory
        expect(await readable(ext, null, internal)).toBe(404);
        expect((await inOrg(ext, org).get("/v1/teams")).status).toBe(403);
        expect((await inOrg(ext, org).get("/v1/workspace/organization/members")).status).toBe(403);
        // A plain member can't create shared channels (policy: only admins start external)
        expect((await inOrg(bob, org).post(`/v1/teams/${teamId}/channels`).send({ name: "y", type: "shared", externalUserIds: [String(ext._id)] })).status).toBe(403);
    });
});

describe("workspace switching and removal", () => {
    it("a user in two organizations and the personal context sees each one's teams and channels only there", async () => {
        const [a1, b1, multi] = [await makeUser(), await makeUser(), await makeUser()];
        const orgA = await orgWith(a1, [multi]);
        const orgB = await orgWith(b1, [multi]);
        const teamA = (await inOrg(a1, orgA).post("/v1/teams").send({ name: "Alpha" })).body.data.teamId;
        const teamB = (await inOrg(b1, orgB).post("/v1/teams").send({ name: "Beta" })).body.data.teamId;
        await inOrg(a1, orgA).post(`/v1/teams/${teamA}/members`).send({ userIds: [String(multi._id)] });
        await inOrg(b1, orgB).post(`/v1/teams/${teamB}/members`).send({ userIds: [String(multi._id)] });
        const chA = (await inOrg(multi, orgA).get(`/v1/teams/${teamA}/channels`)).body.data[0].channelId;
        const inA = (await inOrg(multi, orgA).get("/v1/teams")).body.data.map((t: any) => t.teamId);
        const inB = (await inOrg(multi, orgB).get("/v1/teams")).body.data.map((t: any) => t.teamId);
        expect(inA).toEqual([teamA]);
        expect(inB).toEqual([teamB]);
        expect((await inOrg(multi, orgB).get(`/v1/teams/${teamA}`)).status).toBe(404);
        expect(await readable(multi, orgB, chA)).toBe(404);
        expect(await readable(multi, null, chA)).toBe(404);
        expect((await personal(multi).get("/v1/teams")).status).toBe(400);
        // Teams of another organization are invisible even with a direct query by id in the wrong context
        const wrong = await runAsSystem(() => Team.findById(teamA).lean(), "test");
        expect(String(wrong!.tenantId)).toBe(orgA.organizationId);
    });

    it("a member removed from the organization loses every channel immediately", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = await orgWith(owner, [bob]);
        const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Gone" })).body.data.teamId;
        await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(bob._id)] });
        const general = (await inOrg(bob, org).get(`/v1/teams/${teamId}/channels`)).body.data[0].channelId;
        expect(await readable(bob, org, general)).toBe(200);
        await inOrg(owner, org).post(`/v1/workspace/organization/members/${bob._id}/remove`);
        expect(await readable(bob, org, general)).toBe(403);
        expect(await readable(bob, null, general)).toBe(404);
        const ch = await runAsSystem(() => Conversation.findById(general).lean(), "test");
        expect((ch!.members || []).map(String)).not.toContain(String(bob._id));
        void oid;
    });
});
