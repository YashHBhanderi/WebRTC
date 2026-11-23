import { beforeAll, describe, expect, it } from "vitest";
import Conversation from "../src/models/conversationModel";
import Recording from "../src/models/recordingModel";
import Call from "../src/models/callModel";
import Tenant from "../src/models/tenantModel";
import { runAsSystem } from "../src/tenancy/context";
import { addMessage, api, enter, makeUser, newOrg, oid, Session } from "./helpers";

const idOf = (body: any): string => String(body?.data?._id ?? body?.data?.conversationId ?? body?._id ?? body?.conversationId ?? body?.data?.meetingId);
const denied = (status: number) => [403, 404].includes(status);

async function createGroup(s: Session, members: any[], name = "Team chat") {
    return api(s).post("/conversations/group")
        .field("groupName", name)
        .field("groupMembers", JSON.stringify(members.map((m) => String(m._id))));
}

async function createDm(s: Session, other: any): Promise<string> {
    const res = await api(s).post("/conversations").send({ receiverId: String(other._id) });
    expect(res.status).toBe(200);
    const id = idOf(res.body);
    await addMessage(id, s.user);
    return id;
}

describe("tenant isolation (HTTP)", () => {
    const orgA = newOrg();
    const orgB = newOrg();
    let a1: any, a2: any, a3: any, b1: any, both: any, outsider: any;
    const A = (u: any, role = "org:member"): Session => ({ user: u, org: orgA, role });
    const B = (u: any, role = "org:member"): Session => ({ user: u, org: orgB, role });
    const G = (u: any): Session => ({ user: u });

    beforeAll(async () => {
        [a1, a2, a3, b1, both, outsider] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser(), makeUser(), makeUser()]);
        // Clerk membership as seen by the server (first request in each workspace)
        for (const s of [A(a1, "org:admin"), A(a2), A(a3), A(both), B(b1), B(both)]) {
            await enter(s);
        }
    });

    it("a conversation created in a workspace belongs to it (never to a client-supplied tenant)", async () => {
        const forgedTenant = String(oid("0123456789abcdef01234567"));
        const res = await api(A(a1)).post("/conversations").send({ receiverId: String(a2._id), tenantId: forgedTenant, scope: "global" });
        expect(res.status).toBe(200);
        const stored = await runAsSystem(() => Conversation.findById(idOf(res.body)).lean());
        const tenant = await Tenant.findOne({ clerkOrgId: orgA }).lean();
        expect(String(stored?.tenantId)).toBe(String(tenant?._id));
        expect(stored?.scope).toBe("tenant");
    });

    it("Tenant B cannot read, list, modify or delete Tenant A's conversations (req. 2)", async () => {
        const created = await createGroup(A(a1), [a2, a3]);
        expect(created.status).toBe(201);
        const groupId = idOf(created.body);
        await addMessage(groupId, a1);

        const asB = api(B(b1));
        expect(denied((await asB.get(`/messages/${groupId}`)).status)).toBe(true);
        expect(denied((await asB.get(`/conversations/${groupId}/group`)).status)).toBe(true);
        expect(denied((await asB.put(`/conversations/group/${groupId}/add-member`).send({ userIds: [String(b1._id)] })).status)).toBe(true);
        expect(denied((await asB.delete(`/conversations/${groupId}`)).status)).toBe(true);
        expect(JSON.stringify((await asB.get("/groupConversations")).body)).not.toContain(groupId);
        expect(JSON.stringify((await asB.get("/search?q=Team")).body)).not.toContain(groupId);
        // Still intact for its members
        expect((await api(A(a2)).get(`/messages/${groupId}`)).status).toBe(200);
    });

    it("a member of two workspaces cannot cross-access when switching (req. 3)", async () => {
        const inA = await createDm(A(both), a2);
        const inB = await createDm(B(both), b1);

        // Workspace B context cannot see A's chat, and vice versa, and the global context sees neither
        expect(denied((await api(B(both)).get(`/messages/${inA}`)).status)).toBe(true);
        expect(denied((await api(A(both)).get(`/messages/${inB}`)).status)).toBe(true);
        expect(denied((await api(G(both)).get(`/messages/${inA}`)).status)).toBe(true);

        const listA = JSON.stringify((await api(A(both)).get("/conversations")).body);
        const listB = JSON.stringify((await api(B(both)).get("/conversations")).body);
        const listG = JSON.stringify((await api(G(both)).get("/conversations")).body);
        expect(listA).toContain(inA);
        expect(listA).not.toContain(inB);
        expect(listB).toContain(inB);
        expect(listB).not.toContain(inA);
        expect(listG).not.toContain(inA);
        expect(listG).not.toContain(inB);
    });

    it("global chats are not visible inside a workspace", async () => {
        const g = await createDm(G(both), outsider);
        expect(denied((await api(A(both)).get(`/messages/${g}`)).status)).toBe(true);
        expect((await api(G(both)).get(`/messages/${g}`)).status).toBe(200);
    });

    it("workspace chats can only include workspace members", async () => {
        const dm = await api(A(a1)).post("/conversations").send({ receiverId: String(b1._id) });
        expect(dm.status).toBe(403);
        const group = await createGroup(A(a1), [a2, outsider]);
        expect(group.status).toBe(403);

        const ok = await createGroup(A(a1), [a2, a3]);
        const add = await api(A(a1)).put(`/conversations/group/${idOf(ok.body)}/add-member`).send({ userIds: [String(outsider._id)] });
        expect(add.status).toBe(403);
    });

    it("non-members cannot access workspace meetings and recordings (req. 4)", async () => {
        const start = new Date(Date.now() + 3600_000);
        const meeting = await api(A(a1)).post("/meetings").send({
            title: "Quarterly planning", startAt: start.toISOString(), endAt: new Date(start.getTime() + 1800_000).toISOString(), invitees: [String(a2._id)],
        });
        expect(meeting.status).toBe(200);
        const meetingId = String(meeting.body.data?._id);
        const code = meeting.body.data?.code;
        expect(meetingId).toMatch(/^[a-f0-9]{24}$/);

        expect(denied((await api(B(b1)).get(`/meetings/${meetingId}`)).status)).toBe(true);
        expect(denied((await api(G(outsider)).get(`/meetings/${meetingId}`)).status)).toBe(true);
        if (code) {
            // The meeting code does not open a workspace meeting from another context
            expect(denied((await api(G(outsider)).post(`/meetings/code/${code}/join`).send({})).status)).toBe(true);
            expect(denied((await api(B(b1)).post(`/meetings/code/${code}/join`).send({})).status)).toBe(true);
        }
        expect(JSON.stringify((await api(B(b1)).get(`/meetings?from=${new Date(Date.now() - 86400_000).toISOString()}&to=${new Date(Date.now() + 7 * 86400_000).toISOString()}`)).body)).not.toContain(meetingId);

        // A recording of a call in that meeting's chat
        const conversationId = String(meeting.body.data?.conversationId);
        const call = await runAsSystem(() => Call.create({ conversationId: oid(conversationId), initiatedBy: a1._id, callType: "video", participants: [{ userId: a1._id, status: "joined" }] } as any));
        const recording = await runAsSystem(() => Recording.create({
            callId: call._id, conversationId: oid(conversationId), title: "Quarterly planning", startedBy: a1._id, startedAt: new Date(), status: "completed",
        } as any));
        expect(recording.scope).toBe("tenant");
        expect((await api(A(a2)).get(`/recordings/${recording._id}`)).status).toBe(200);
        expect(denied((await api(B(b1)).get(`/recordings/${recording._id}`)).status)).toBe(true);
        expect(denied((await api(A(a3)).get(`/recordings/${recording._id}`)).status)).toBe(true);
        expect(denied((await api(G(a2)).get(`/recordings/${recording._id}`)).status)).toBe(true);
        expect(denied((await api(B(b1)).get(`/conversations/${conversationId}/recordings`)).status)).toBe(true);
        // Call history of B never shows A's calls
        expect(JSON.stringify((await api(B(b1)).get("/calls")).body)).not.toContain(String(call._id));
    });

    it("forged ids are rejected: other tenant's conversation id, malformed ids, malformed org claims (req. 6)", async () => {
        const target = await createDm(A(a1), a2);
        expect(denied((await api(B(b1)).get(`/messages/${target}`)).status)).toBe(true);
        expect((await api(B(b1)).get(`/messages/not-an-id`)).status).toBeGreaterThanOrEqual(400);
        const badOrg = await api({ user: a1, org: "org_bad!chars" }).get("/conversations");
        expect(badOrg.status).toBe(401);
    });
});

describe("workspace directory and profiles", () => {
    const org = newOrg();

    it("lists only workspace members inside a workspace, and no emails for strangers (security gap fix)", async () => {
        const [m1, m2, hidden, stranger] = await Promise.all([makeUser(), makeUser(), makeUser(undefined, { globalDiscoverable: false }), makeUser()]);
        await enter({ user: m1, org });
        await enter({ user: m2, org });

        const inside = (await api({ user: m1, org }).get("/web/users/except-current")).body.data.map((u: any) => String(u._id));
        expect(inside).toEqual([String(m2._id)]);

        const global = (await api({ user: stranger }).get("/web/users/except-current")).body.data;
        const ids = global.map((u: any) => String(u._id));
        expect(ids).not.toContain(String(hidden._id));
        expect(global.every((u: any) => u.email === undefined && u.password === undefined)).toBe(true);

        // /web/users used to return every account with its email
        const all = (await api({ user: stranger }).get("/web/users")).body.data;
        expect(all.every((u: any) => u.email === undefined)).toBe(true);

        // Personal context has no public profiles: strangers are "not found" (discoverable or not);
        // people I share a conversation with come back without email
        expect((await api({ user: stranger }).get(`/web/user/${hidden._id}`)).status).toBe(404);
        expect((await api({ user: stranger }).get(`/web/user/${m1._id}`)).status).toBe(404);
        expect((await api({ user: stranger }).post("/conversations").send({ receiverId: String(m1._id) })).status).toBe(200);
        const visible = await api({ user: stranger }).get(`/web/user/${m1._id}`);
        expect(visible.status).toBe(200);
        expect(visible.body.data.email).toBeUndefined();
        // Inside the workspace, outsiders are not found
        expect((await api({ user: m1, org }).get(`/web/user/${stranger._id}`)).status).toBe(404);
        // People search follows the same rules
        const search = JSON.stringify((await api({ user: m1, org }).get(`/search?q=${stranger.username}`)).body);
        expect(search).not.toContain(String(stranger._id));
    });
});

describe("workspace policies and external conversations (req. 5)", () => {
    const org = newOrg();
    let admin: any, member: any, member2: any, guest: any, other: any;
    const W = (u: any, role = "org:member"): Session => ({ user: u, org, role });

    beforeAll(async () => {
        // member2 is only reachable through the workspace (hidden from the global directory)
        [admin, member, member2, guest, other] = await Promise.all([makeUser(), makeUser(), makeUser(undefined, { globalDiscoverable: false }), makeUser(), makeUser()]);
        await enter(W(admin, "org:admin"));
        await enter(W(member));
        await enter(W(member2));
    });

    it("external chat is off by default; only owners/admins can change policies", async () => {
        const start = await api(W(admin, "org:admin")).post("/tenant/external-conversations").send({ userId: String(guest._id) });
        expect(start.status).toBe(403);

        expect((await api(W(member)).patch("/tenant/current/policies").send({ allowExternalChat: true })).status).toBe(403);
        expect((await api(W(admin, "org:admin")).patch("/tenant/current/policies").send({ notAPolicy: true })).status).toBe(400);
        expect((await api(W(admin, "org:admin")).patch("/tenant/current/policies").send({ allowExternalChat: "yes" })).status).toBe(400);
        const ok = await api(W(admin, "org:admin")).patch("/tenant/current/policies").send({ allowExternalChat: true });
        expect(ok.status).toBe(200);
        expect(ok.body.data.policies.allowExternalChat).toBe(true);
    });

    it("an approved guest sees only that external conversation, never the workspace's internal data", async () => {
        const internal = await createDm(W(member), member2);

        // Members can't start external chats unless the policy allows it
        expect((await api(W(member)).post("/tenant/external-conversations").send({ userId: String(guest._id) })).status).toBe(403);
        const ext = await api(W(admin, "org:admin")).post("/tenant/external-conversations").send({ userId: String(guest._id) });
        expect(ext.status).toBe(200);
        const extId = ext.body.data.conversationId;
        await addMessage(extId, admin);

        // Guest (global context) can use the external chat…
        expect((await api({ user: guest }).get(`/messages/${extId}`)).status).toBe(200);
        expect(JSON.stringify((await api({ user: guest }).get("/conversations")).body)).toContain(extId);
        // …but not internal chats, the workspace directory, or workspace endpoints
        expect(denied((await api({ user: guest }).get(`/messages/${internal}`)).status)).toBe(true);
        const dir = (await api({ user: guest }).get("/directory")).body.data.map((u: any) => String(u._id));
        expect(dir).not.toContain(String(member2._id));
        // …while the workspace directory does list them
        const wsDir = (await api(W(admin, "org:admin")).get("/directory")).body.data.map((u: any) => String(u._id));
        expect(wsDir).toContain(String(member2._id));
        expect((await api({ user: guest }).get(`/web/user/${member2._id}`)).status).toBe(404);
        expect((await api({ user: guest }).get("/tenant/current")).status).toBe(400);
        // Another outsider can't use it
        expect(denied((await api({ user: other }).get(`/messages/${extId}`)).status)).toBe(true);
        // A workspace member in the global context doesn't see workspace data
        expect(denied((await api({ user: member }).get(`/messages/${internal}`)).status)).toBe(true);
    });

    it("a workspace member can't be invited as an external guest", async () => {
        const res = await api(W(admin, "org:admin")).post("/tenant/external-conversations").send({ userId: String(member._id) });
        expect(res.status).toBe(400);
    });

    it("platform admins get no implicit access to workspace data", async () => {
        process.env.PLATFORM_ADMIN_CLERK_IDS = other.clerkId;
        const internal = await createDm(W(member), member2);
        expect(denied((await api({ user: other }).get(`/messages/${internal}`)).status)).toBe(true);
        delete process.env.PLATFORM_ADMIN_CLERK_IDS;
    });
});

describe("message operations by id respect the context", () => {
    it("an author cannot delete their workspace message from another context", async () => {
        const org = newOrg();
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: u, org });
        await enter({ user: v, org });
        const res = await api({ user: u, org }).post("/conversations").send({ receiverId: String(v._id) });
        const conversationId = idOf(res.body);
        const msg = await addMessage(conversationId, u, "keep me");
        expect([403, 404]).toContain((await api({ user: u }).delete(`/messages/${msg._id}`)).status);
        expect((await api({ user: u, org }).delete(`/messages/${msg._id}`)).status).toBe(200);
    });
});
