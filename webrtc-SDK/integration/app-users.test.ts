import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backendTokenProvider, isSpreeWeError, type SpreeWeClient } from "@spreewe/core";
import { createServerClient, type SpreeWeServerClient } from "@spreewe/core/server";
import { getGroups } from "@spreewe/groups";
import { api, clientFor, eventually, makeUser, registerApp, startSocketServer, type Session } from "./support";

/**
 * The server client (@spreewe/core/server) and the browser client together, against the real
 * backend: two developer apps, each with its own tenant and its own registered users. What a
 * developer's backend and frontend would do, with nothing on the SpreeWe side mocked.
 */
const SCOPES = ["profile:read", "directory:read", "conversations:read", "conversations:write", "groups:read", "groups:write", "groups:manage", "messages:read", "realtime:connect"];

let server: { port: number; close: () => Promise<void> };
let base: string;
let acme: SpreeWeServerClient;
let globex: SpreeWeServerClient;
let spreeUser: Session;
const clients: SpreeWeClient[] = [];

/** A browser client for one of an app's users: tokens come from that app's backend (the server client). */
function browser(backend: SpreeWeServerClient, externalUserId: string): SpreeWeClient {
    const c = clientFor(base, backendTokenProvider({ fetchToken: () => backend.userToken(externalUserId, { forceRefresh: true }) }));
    clients.push(c);
    return c;
}

beforeAll(async () => {
    server = await startSocketServer();
    base = `http://localhost:${server.port}`;
    const [ownerA, ownerB] = [{ user: await makeUser() }, { user: await makeUser() }];
    spreeUser = { user: await makeUser() };
    const [a, b] = [await registerApp(ownerA, SCOPES, {}, { dedicated: true }), await registerApp(ownerB, SCOPES, {}, { dedicated: true })];
    acme = createServerClient({ baseUrl: base, keyId: a.keyId, secret: a.secret });
    globex = createServerClient({ baseUrl: base, keyId: b.keyId, secret: b.secret });
});

afterAll(async () => {
    clients.forEach((c) => c.destroy());
    await server.close();
});

describe("app users through the SDK", () => {
    it("registers, reads, lists, updates, deactivates and reactivates users of its own app", async () => {
        const asha = await acme.users.register({ externalUserId: "acme-1", name: "Asha Rao", email: "asha@example.test" });
        expect(asha).toMatchObject({ externalUserId: "acme-1", name: "Asha Rao", email: "asha@example.test", status: "active" });
        expect(asha._id).toMatch(/^[0-9a-f]{24}$/);
        await acme.users.register({ externalUserId: "acme-2", name: "Ben Ortiz" });
        await acme.users.register({ externalUserId: "acme-3", name: "Chen Wei" });

        await expect(acme.users.register({ externalUserId: "acme-1", name: "Someone Else" })).rejects.toMatchObject({ status: 409 });
        expect((await acme.users.ensure({ externalUserId: "acme-1", name: "Someone Else" }))._id).toBe(asha._id);
        expect((await acme.users.get("acme-1")).name).toBe("Asha Rao");

        const page = await acme.users.list({ limit: 2 });
        expect(page.items).toHaveLength(2);
        expect(page.nextCursor).toBeTruthy();
        const all: string[] = [];
        for await (const u of acme.users.all()) all.push(u.externalUserId);
        expect(all.sort()).toEqual(["acme-1", "acme-2", "acme-3"]);

        expect(await acme.users.update("acme-3", { name: "Chen W.", email: "chen@example.test" })).toMatchObject({ name: "Chen W.", email: "chen@example.test" });
        expect((await acme.users.update("acme-3", { email: null })).email).toBeNull();

        const token = await acme.userToken("acme-3");
        await acme.users.deactivate("acme-3");
        expect((await acme.users.get("acme-3")).status).toBe("deactivated");
        await expect(acme.userToken("acme-3")).rejects.toMatchObject({ status: 403 });
        // The token issued before the deactivation no longer works
        const stale = clientFor(base, backendTokenProvider({ fetchToken: async () => token }));
        clients.push(stale);
        await expect(stale.loadMe()).rejects.toMatchObject({ status: 401 });
        expect((await acme.users.list({ status: "deactivated" })).items.map((u) => u.externalUserId)).toEqual(["acme-3"]);
        expect((await acme.users.reactivate("acme-3")).status).toBe("active");
        expect((await acme.userToken("acme-3")).tenantId).toBe(asha.tenantId);
    });

    it("another app's credential can't see or change those users, and the same external id is a different person there", async () => {
        const theirs = await globex.users.register({ externalUserId: "acme-1", name: "Gita Other", email: "asha@example.test" });
        const ours = await acme.users.get("acme-1");
        expect(theirs._id).not.toBe(ours._id);
        expect(theirs.tenantId).not.toBe(ours.tenantId);
        await globex.users.register({ externalUserId: "globex-2", name: "Hugo Lang" });

        await expect(globex.users.get("acme-2")).rejects.toMatchObject({ status: 404 });
        await expect(globex.users.update("acme-2", { name: "Taken Over" })).rejects.toMatchObject({ status: 404 });
        await expect(globex.users.deactivate("acme-2")).rejects.toMatchObject({ status: 404 });
        await expect(globex.userToken("acme-2")).rejects.toMatchObject({ status: 403 });
        expect((await acme.users.get("acme-2")).name).toBe("Ben Ortiz");
        const seen: string[] = [];
        for await (const u of globex.users.all()) seen.push(u._id);
        expect(seen).not.toContain(ours._id);
        expect(seen).toHaveLength(2);
    });

    it("signed-in users act in their app's tenant and only find each other", async () => {
        const [asha, ben] = [browser(acme, "acme-1"), browser(acme, "acme-2")];
        const gita = browser(globex, "acme-1");
        const [meA, meG] = [await asha.loadMe(), await gita.loadMe()];
        const [ours, theirs] = [await acme.users.get("acme-1"), await globex.users.get("acme-1")];
        expect(String(meA.user._id)).toBe(ours._id);
        expect((meA as any).context).toEqual({ tenantId: ours.tenantId, role: "member" });
        expect((meG as any).context.tenantId).toBe(theirs.tenantId);

        const dirA = (await asha.people.directory({ limit: 100 })).items.map((p) => String(p._id));
        expect(dirA.sort()).toEqual([(await acme.users.get("acme-2"))._id, (await acme.users.get("acme-3"))._id].sort());
        const dirG = (await gita.people.directory({ limit: 100 })).items.map((p) => String(p._id));
        expect(dirG).toEqual([(await globex.users.get("globex-2"))._id]);

        // Profiles: a colleague yes; another app's user, or a SpreeWe account, looks like an unknown id
        expect(String((await asha.people.profile((await acme.users.get("acme-2"))._id))._id)).toBe((await acme.users.get("acme-2"))._id);
        for (const foreign of [theirs._id, String(spreeUser.user._id)]) {
            const err = await asha.people.profile(foreign).catch((e) => e);
            expect(isSpreeWeError(err) && err.status, foreign).toBe(404);
        }
        expect(await ben.userId()).toBe((await acme.users.get("acme-2"))._id);
    });

    it("conversations and groups stay inside the app; the other app can't reach them, live or by id", async () => {
        const [asha, ben, gita] = [browser(acme, "acme-1"), browser(acme, "acme-2"), browser(globex, "acme-1")];
        const [benId, chenId, gitaId] = [(await acme.users.get("acme-2"))._id, (await acme.users.get("acme-3"))._id, (await globex.users.get("acme-1"))._id];

        // Direct conversation: colleague yes, other app / SpreeWe account no
        const conv = await asha.http.post<any>("/conversations", { receiverId: benId });
        const convId = String(conv?._id ?? conv?.conversation?._id ?? conv?.conversationId);
        expect(convId).toMatch(/^[0-9a-f]{24}$/);
        for (const foreign of [gitaId, String(spreeUser.user._id)]) {
            await expect(asha.http.post("/conversations", { receiverId: foreign })).rejects.toMatchObject({ status: expect.any(Number) });
        }
        await expect(gita.http.page(`/v1/conversations/${convId}/messages`)).rejects.toBeTruthy();
        expect(JSON.stringify(await gita.http.page("/v1/conversations", { query: { limit: 100 } }))).not.toContain(convId);

        // Groups through the groups module
        const groups = getGroups(asha);
        await expect(groups.create({ name: "Mixed", memberIds: [benId, gitaId] })).rejects.toBeTruthy();
        const groupId = await groups.create({ name: "Acme team", memberIds: [benId, chenId] });
        expect(groupId).toMatch(/^[0-9a-f]{24}$/);
        const groupIdsOf = async (c: SpreeWeClient) => {
            const svc = getGroups(c);
            await svc.loadGroups({ refresh: true });
            return JSON.stringify(svc.groups.value);
        };
        await eventually(async () => expect(await groupIdsOf(ben)).toContain(groupId));
        expect(await groupIdsOf(gita)).not.toContain(groupId);
        expect((await getGroups(ben).loadDetails(groupId)).members.map((m: any) => String(m._id ?? m)).sort()).toEqual([await asha.userId(), benId, chenId].sort());
        await expect(getGroups(gita).loadDetails(groupId)).rejects.toBeTruthy();
        await expect(groups.addMembers(groupId, [gitaId])).rejects.toBeTruthy();

        // Realtime: Ben gets Asha's typing; the other app's socket gets nothing from that room
        await Promise.all([asha.realtime.connect(), ben.realtime.connect(), gita.realtime.connect()]);
        const leaked: unknown[] = [];
        const got: unknown[] = [];
        ben.realtime.on("userTyping", (p) => got.push(p));
        for (const event of ["userTyping", "receiveMessage", "group:added", "group:updated", "user:presence"]) {
            gita.realtime.on(event, (p) => { if (JSON.stringify(p).includes(convId) || JSON.stringify(p).includes(ourId)) leaked.push({ event, p }); });
        }
        const ourId = await asha.userId();
        asha.realtime.joinConversation(convId);
        ben.realtime.joinConversation(convId);
        gita.realtime.joinConversation(convId);
        await new Promise((r) => setTimeout(r, 400));
        await eventually(() => {
            asha.realtime.emit("typing", { conversationId: convId });
            asha.realtime.emit("typing", convId);
            expect(got.length).toBeGreaterThan(0);
        }, 5000, 200);
        await new Promise((r) => setTimeout(r, 500));
        expect(leaked).toEqual([]);
    });

    it("a SpreeWe account can't be turned into an app user, and consent apps can't register users", async () => {
        // The personal app does not see app users
        const lookup = await api(spreeUser).post("/v1/contacts/lookup").send({ email: "asha@example.test" });
        expect(lookup.body?.data?.found ?? false).toBe(false);
        expect((await api(spreeUser).get(`/web/user/${(await acme.users.get("acme-1"))._id}`)).status).toBe(404);
        // A consent-based (legacy) app has no tenant of its own
        const legacy = await registerApp({ user: await makeUser() }, ["profile:read"]);
        const legacyClient = createServerClient({ baseUrl: base, keyId: legacy.keyId, secret: legacy.secret });
        await expect(legacyClient.users.register({ externalUserId: "x-1", name: "Some One" })).rejects.toMatchObject({ status: 403 });
        await expect(legacyClient.users.list()).rejects.toMatchObject({ status: 403 });
        // A wrong secret is refused
        const wrong = createServerClient({ baseUrl: base, keyId: legacy.keyId, secret: "sws_wrong-secret-value" });
        await expect(wrong.users.list()).rejects.toMatchObject({ status: 401 });
    });
});
