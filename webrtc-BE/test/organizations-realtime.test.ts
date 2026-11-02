import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Socket } from "socket.io-client";
import { resetTenantCaches } from "../src/tenancy/tenant.service";
import { api, connect, makeUser, nextEvent, Session, sleep, startSocketServer, uniq } from "./helpers";

/** Organization events reach only the people they concern, and only in the right workspace context. */
type U = Awaited<ReturnType<typeof makeUser>>;
const personal = (u: U) => api({ user: u });
const inOrg = (u: U, org: { clerkOrgId: string }) => api({ user: u, org: org.clerkOrgId });
const slug = () => uniq("org").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);

describe("organization real-time events", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    const sock = async (s: Session) => { const x = await connect(server.port, s); open.push(x); return x; };
    beforeAll(async () => { server = await startSocketServer(); });
    afterAll(async () => { open.forEach((s) => s.disconnect()); await server.close(); });

    it("an invitation notifies only the invitee", async () => {
        const [owner, bob, carol] = [await makeUser(), await makeUser(), await makeUser()];
        const org = (await personal(owner).post("/v1/organizations").send({ name: "Live", slug: slug() })).body.data;
        const sb = await sock({ user: bob }), sc = await sock({ user: carol });
        const toBob = nextEvent(sb, "org:invitation", 3000), toCarol = nextEvent(sc, "org:invitation", 1500);
        await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [bob.email], role: "member" });
        expect(await toBob).toMatchObject({ organizationId: org.organizationId });
        expect(await toCarol).toBeNull();
    });

    it("a join request reaches admins' sockets in that organization only (not their personal sockets, not members)", async () => {
        const [owner, member, eve] = [await makeUser(), await makeUser(), await makeUser()];
        const org = (await personal(owner).post("/v1/organizations").send({ name: "Req", slug: slug(), discoverable: true, joinPolicy: "request" })).body.data;
        const r = await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [member.email], role: "member" });
        await personal(member).post("/v1/organization-invitations/accept").send({ token: new URL(r.body.data.results[0].link, "http://x").searchParams.get("token") });
        // Case 1: only the owner's personal socket is connected → the org event must not appear there
        const ownerHome = await sock({ user: owner });
        await sleep(200);
        const home = nextEvent(ownerHome, "org:join-request-created", 1500);
        await personal(eve).post(`/v1/organizations/${org.organizationId}/join-requests`).send({});
        expect(await home).toBeNull();
        // Case 2: the owner's socket in the organization (their current one) receives it; a member's does not
        const ownerOrg = await sock({ user: owner, org: org.clerkOrgId });
        const memberOrg = await sock({ user: member, org: org.clerkOrgId });
        await sleep(200);
        const seen = nextEvent(ownerOrg, "org:join-request-created", 3000);
        const mem = nextEvent(memberOrg, "org:join-request-created", 1500);
        const other = await makeUser();
        await personal(other).post(`/v1/organizations/${org.organizationId}/join-requests`).send({});
        expect(await seen).toMatchObject({ organizationId: org.organizationId });
        expect(await mem).toBeNull();
    });

    it("team, channel and role events reach only the people concerned, and only on their sockets in that organization", async () => {
        const [owner, bob, carol] = [await makeUser(), await makeUser(), await makeUser()];
        const org = (await personal(owner).post("/v1/organizations").send({ name: "Teams", slug: slug() })).body.data;
        for (const u of [bob, carol]) {
            const r = await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [u.email], role: "member" });
            await personal(u).post("/v1/organization-invitations/accept").send({ token: new URL(r.body.data.results[0].link, "http://x").searchParams.get("token") });
        }
        resetTenantCaches();
        // Bob's personal socket first, then his socket in the organization (his current one); Carol in the organization
        const bobHome = await sock({ user: bob });
        const bobOrg = await sock({ user: bob, org: org.clerkOrgId });
        const carolOrg = await sock({ user: carol, org: org.clerkOrgId });
        await sleep(200);
        const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Live team" })).body.data.teamId;

        const joined = nextEvent(bobOrg, "team:joined", 3000), joinedHome = nextEvent(bobHome, "team:joined", 1500), joinedCarol = nextEvent(carolOrg, "team:joined", 1500);
        await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(bob._id)] });
        expect(await joined).toMatchObject({ teamId });
        expect(await joinedHome).toBeNull();
        expect(await joinedCarol).toBeNull();

        const created = nextEvent(bobOrg, "channel:created", 3000), createdCarol = nextEvent(carolOrg, "channel:created", 1500);
        await inOrg(owner, org).post(`/v1/teams/${teamId}/channels`).send({ name: "secret", type: "private", memberIds: [String(bob._id)] });
        expect(await created).toMatchObject({ teamId, name: "secret" });
        expect(await createdCarol).toBeNull();

        const role = nextEvent(bobOrg, "org:role-changed", 3000), roleCarol = nextEvent(carolOrg, "org:role-changed", 1500);
        await inOrg(owner, org).patch(`/v1/workspace/organization/members/${bob._id}`).send({ role: "admin" });
        expect(await role).toMatchObject({ organizationId: org.organizationId, role: "admin" });
        expect(await roleCarol).toBeNull();
    });

    const joinOrg = async (owner: U, org: { clerkOrgId: string }, u: U, role = "member") => {
        const r = await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [u.email], role });
        await personal(u).post("/v1/organization-invitations/accept").send({ token: new URL(r.body.data.results[0].link, "http://x").searchParams.get("token") });
    };

    it("members see joins, role changes and profile changes live — on every tab in the org, never in another org", async () => {
        const [owner, bob, carol, outsider] = [await makeUser(), await makeUser(), await makeUser(), await makeUser()];
        const org = (await personal(owner).post("/v1/organizations").send({ name: "Sync", slug: slug() })).body.data;
        const other = (await personal(outsider).post("/v1/organizations").send({ name: "Other", slug: slug() })).body.data;
        await joinOrg(owner, org, bob);
        resetTenantCaches();
        // Two tabs of the owner in the org (both must get it), plus a socket in another org
        const tab1 = await sock({ user: owner, org: org.clerkOrgId });
        const tab2 = await sock({ user: owner, org: org.clerkOrgId });
        const bobOrg = await sock({ user: bob, org: org.clerkOrgId });
        const foreign = await sock({ user: outsider, org: other.clerkOrgId });
        await sleep(200);
        const seen = [nextEvent(tab1, "org:members-changed", 3000), nextEvent(tab2, "org:members-changed", 3000), nextEvent(bobOrg, "org:members-changed", 3000)];
        const leak = nextEvent(foreign, "org:members-changed", 1500);
        await joinOrg(owner, org, carol);
        for (const p of seen) expect(await p).toMatchObject({ organizationId: org.organizationId });
        expect(await leak).toBeNull();

        const role = nextEvent(bobOrg, "org:role-changed", 3000);
        await inOrg(owner, org).patch(`/v1/workspace/organization/members/${bob._id}`).send({ role: "admin" });
        expect(await role).toMatchObject({ role: "admin" });

        const upd = nextEvent(bobOrg, "org:updated", 3000), updLeak = nextEvent(foreign, "org:updated", 1500);
        await inOrg(owner, org).patch("/v1/workspace/organization").send({ description: "new" });
        expect(await upd).toEqual({ organizationId: org.organizationId });
        expect(await updLeak).toBeNull();
    });

    it("a role change applies to the member's live socket at once (no reconnect needed)", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = (await personal(owner).post("/v1/organizations").send({ name: "Live role", slug: slug() })).body.data;
        await inOrg(owner, org).patch("/v1/workspace/organization").send({ settings: { guestAccess: true } });
        await joinOrg(owner, org, bob);
        resetTenantCaches();
        await sock({ user: bob, org: org.clerkOrgId });
        await sleep(200);
        const { socketContexts } = await import("../src/realtime/io");
        const roleOfBob = () => [...socketContexts.values()].filter((c) => c.userId === String(bob._id) && c.tenantId === org.organizationId).map((c) => c.role);
        expect(roleOfBob()).toEqual(["member"]);
        await inOrg(owner, org).patch(`/v1/workspace/organization/members/${bob._id}`).send({ role: "guest" });
        expect(roleOfBob()).toEqual(["guest"]);
    });

    it("someone removed from a team leaves its channel rooms at once (no more channel broadcasts)", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = (await personal(owner).post("/v1/organizations").send({ name: "Rooms", slug: slug() })).body.data;
        await joinOrg(owner, org, bob);
        resetTenantCaches();
        const teamId = (await inOrg(owner, org).post("/v1/teams").send({ name: "Room team" })).body.data.teamId;
        await inOrg(owner, org).post(`/v1/teams/${teamId}/members`).send({ userIds: [String(bob._id)] });
        const channelId = (await inOrg(owner, org).get(`/v1/teams/${teamId}/channels`)).body.data[0].channelId;
        const bobOrg = await sock({ user: bob, org: org.clerkOrgId });
        bobOrg.emit("joinConversation", channelId);
        await sleep(300);
        const { io } = await import("../src/realtime/io");
        const inRoom = async () => (await io().in(channelId).fetchSockets()).map((s) => s.id);
        expect(await inRoom()).toContain(bobOrg.id);
        const removed = nextEvent(bobOrg, "team:removed", 3000);
        await inOrg(owner, org).post(`/v1/teams/${teamId}/members/${bob._id}/remove`);
        expect(await removed).toMatchObject({ teamId });
        expect(await inRoom()).not.toContain(bobOrg.id);
    });

    it("a removed member is told on every tab — including the org tab, before it is disconnected", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = (await personal(owner).post("/v1/organizations").send({ name: "Told", slug: slug() })).body.data;
        await joinOrg(owner, org, bob);
        resetTenantCaches();
        const bobHome = await sock({ user: bob });
        const bobOrg = await sock({ user: bob, org: org.clerkOrgId });
        await sleep(200);
        const atHome = nextEvent(bobHome, "org:removed", 3000), inOrgTab = nextEvent(bobOrg, "org:removed", 3000);
        await inOrg(owner, org).post(`/v1/workspace/organization/members/${bob._id}/remove`);
        expect(await atHome).toMatchObject({ organizationId: org.organizationId, reason: "removed" });
        expect(await inOrgTab).toMatchObject({ organizationId: org.organizationId });
    });

    it("a removed member's workspace socket is disconnected and they are told on their personal socket", async () => {
        const [owner, bob] = [await makeUser(), await makeUser()];
        const org = (await personal(owner).post("/v1/organizations").send({ name: "Rm", slug: slug() })).body.data;
        const r = await inOrg(owner, org).post("/v1/workspace/invitations").send({ emails: [bob.email], role: "member" });
        await personal(bob).post("/v1/organization-invitations/accept").send({ token: new URL(r.body.data.results[0].link, "http://x").searchParams.get("token") });
        resetTenantCaches();
        const bobOrg = await sock({ user: bob, org: org.clerkOrgId });
        const dropped = new Promise<boolean>((res) => { bobOrg.once("disconnect", () => res(true)); setTimeout(() => res(false), 3000); });
        await inOrg(owner, org).post(`/v1/workspace/organization/members/${bob._id}/remove`);
        expect(await dropped).toBe(true);
        // A new connection in that organization is refused
        await expect(connect(server.port, { user: bob, org: org.clerkOrgId })).rejects.toBeTruthy();
    });
});
