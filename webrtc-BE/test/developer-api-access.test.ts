import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { io as ioClient, Socket } from "socket.io-client";
import Message from "../src/models/messageModel";
import { runAsSystem } from "../src/tenancy/context";
import { ALL_SCOPES, APP_SCOPES, DELIVERED_EVENT_SCOPES, SOCKET_EVENT_SCOPES, UNAVAILABLE_SCOPES } from "../src/developer/scopes";
import { routes as v1Routes } from "../src/api/v1/registry";
import "../src/api/v1/routes";
import sessionRouter from "../src/routes/routes";
import tenantRouter from "../src/routes/tenant.routes";
import { api, connect, enc, makeUser, nextEvent, oid, Session, sleep, startSocketServer, testApp, uniq } from "./helpers";

/**
 * Phase 1 of the third-party API: developer-app user tokens reach the existing session routes, /v1
 * routes and Socket.IO events, each gated by one scope, through the same handlers (same membership,
 * role and tenant checks). Message ciphertext is never sent to apps.
 */
const basic = (keyId: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const http = () => request(testApp());

/** Owner registers an app with `scopes`; `user` grants them; returns a user token. */
async function appToken(user: Session, scopes: string[], owner?: Session): Promise<string> {
    const own = owner || { user: await makeUser() };
    const app = (await api(own).post("/v1/apps").send({ name: uniq("API"), environment: "development", callbackUrls: ["https://example.com/cb"], scopes })).body.data;
    expect(app?._id, "app registration").toBeTruthy();
    const cred = (await api(own).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name })).body.data;
    expect((await api(user).post(`/v1/apps/${app._id}/grants`).send({ scopes })).status).toBe(201);
    const tok = await http().post("/v1/app-tokens").set(basic(cred.credential.keyId, cred.secret)).send({ userId: String(user.user._id) });
    expect(tok.status, JSON.stringify(tok.body)).toBe(201);
    return tok.body.data.accessToken as string;
}

const available = ALL_SCOPES.filter((s) => !UNAVAILABLE_SCOPES.has(s));

describe("permission coverage", () => {
    it("every session route makes an explicit app-access decision with a known scope", () => {
        const decisions: { route: string; scope: unknown }[] = [];
        for (const router of [sessionRouter, tenantRouter] as any[]) {
            for (const layer of router.stack) {
                if (!layer.route) continue;
                const method = Object.keys(layer.route.methods)[0];
                const guard = layer.route.stack.find((l: any) => "appScope" in (l.handle || {}));
                decisions.push({ route: `${method.toUpperCase()} ${layer.route.path}`, scope: guard ? guard.handle.appScope : "MISSING" });
            }
        }
        expect(decisions.length).toBeGreaterThanOrEqual(45);
        expect(decisions.filter((d) => d.scope === "MISSING")).toEqual([]);
        expect(decisions.filter((d) => d.scope !== null && !(String(d.scope) in APP_SCOPES))).toEqual([]);
    });

    it("every /v1 route scope, socket event scope and delivered event scope is a known scope", () => {
        for (const r of v1Routes) if (r.scope) expect(APP_SCOPES, `${r.method} ${r.path}`).toHaveProperty([r.scope]);
        for (const [e, s] of Object.entries(SOCKET_EVENT_SCOPES)) expect(APP_SCOPES, e).toHaveProperty([s]);
        for (const [e, s] of Object.entries(DELIVERED_EVENT_SCOPES)) expect(APP_SCOPES, e).toHaveProperty([s]);
    });

    it("app management, consent decisions and organization delete / transfer stay SpreeWe-session only", () => {
        const firstParty = (path: string, method: string) => v1Routes.find((r) => r.path === path && r.method === method);
        for (const [m, p] of [["post", "/apps"], ["post", "/consent-requests/:requestId/approve"], ["post", "/workspace/organization/delete"], ["post", "/workspace/organization/transfer"], ["get", "/workspace/apps"], ["post", "/e2ee/devices"]]) {
            const r = firstParty(p, m);
            expect(r, `${m} ${p}`).toBeTruthy();
            expect(r!.scope, `${m} ${p}`).toBeUndefined();
        }
    });

    it("unavailable scopes can't be added to an app", async () => {
        const owner: Session = { user: await makeUser() };
        for (const s of UNAVAILABLE_SCOPES) {
            const res = await api(owner).post("/v1/apps").send({ name: uniq("X"), environment: "development", scopes: [s] });
            expect(res.status, s).toBe(400);
        }
    });
});

describe("REST access with app tokens", () => {
    let alice: Session, bob: Session, carol: Session, token: string;
    beforeAll(async () => {
        [alice, bob, carol] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
        token = await appToken(alice, available);
    });

    it("works through the same handlers: direct chat, groups, members, history (no ciphertext), notifications, search, profile", async () => {
        const direct = await http().post("/conversations").set(bearer(token)).send({ receiverId: String(bob.user._id) });
        expect(direct.status, JSON.stringify(direct.body)).toBe(200);
        const conversationId = String(direct.body.conversationId);
        await runAsSystem(() => Message.create({ conversationId: oid(conversationId), userId: bob.user._id, content: "", type: "text", e2ee: enc("secret-marker") } as any), "test");

        const history = await http().get(`/messages/${conversationId}`).set(bearer(token));
        expect(history.status).toBe(200);
        expect(JSON.stringify(history.body)).not.toContain("ciphertext");
        expect(history.body.data.some((m: any) => m.encrypted === true && m.content === null)).toBe(true);
        expect((await http().get("/conversations").set(bearer(token))).body.data.map((c: any) => String(c._id))).toContain(conversationId);

        const group = await http().post("/conversations/group").set(bearer(token)).send({ groupName: uniq("G"), groupMembers: JSON.stringify([String(bob.user._id), String(carol.user._id)]) });
        expect(group.status, JSON.stringify(group.body)).toBe(201);
        const groupId = String(group.body.data._id);
        expect((await http().get("/groupConversations").set(bearer(token))).body.data.map((g: any) => String(g._id))).toContain(groupId);
        expect((await http().put(`/conversations/group/${groupId}/remove-member`).set(bearer(token)).send({ userId: String(carol.user._id) })).status).toBe(200);

        expect((await http().get("/notifications").set(bearer(token))).status).toBe(200);
        expect((await http().post("/notifications/read").set(bearer(token)).send({})).status).toBe(200);
        expect((await http().get("/search?q=ab").set(bearer(token))).status).toBe(200);
        expect((await http().get("/files").set(bearer(token))).status).toBe(200);
        const from = new Date().toISOString(), to = new Date(Date.now() + 7 * 86400_000).toISOString();
        expect((await http().get(`/meetings?from=${from}&to=${to}`).set(bearer(token))).status).toBe(200);
        const profile = await http().patch("/web/user/profile").set(bearer(token)).send({ bio: "set by an app" });
        expect(profile.status, JSON.stringify(profile.body)).toBe(200);
        expect((await http().get("/web/user/me").set(bearer(token))).body.data.bio).toBe("set by an app");
        expect((await http().get("/v1/organizations/mine").set(bearer(token))).status).toBe(200);
    });

    it("refuses every route whose scope the token lacks (403), and session-only routes", async () => {
        const narrow = await appToken(alice, ["profile:read"]);
        const cases: [string, string][] = [
            ["get", "/conversations"], ["post", "/conversations"], ["get", "/groupConversations"], ["post", "/conversations/group"],
            ["get", "/messages/000000000000000000000000"], ["delete", "/messages/000000000000000000000000"], ["put", "/messages/000000000000000000000000/save"],
            ["get", "/search?q=ab"], ["get", "/files"], ["get", "/meetings"], ["post", "/meetings"], ["get", "/notifications"], ["post", "/notifications/read"],
            ["patch", "/web/user/profile"], ["get", "/directory"], ["get", "/tenant/workspaces"], ["post", "/upload"],
            ["get", "/v1/organizations/mine"], ["get", "/v1/teams"], ["post", "/v1/contacts/lookup"], ["delete", "/web/deleteUser/000000000000000000000000"],
        ];
        for (const [m, p] of cases) {
            const res = await (http() as any)[m](p).set(bearer(narrow)).send({});
            expect(res.status, `${m.toUpperCase()} ${p}`).toBe(403);
        }
        expect((await http().get("/web/user/me").set(bearer(narrow))).status).toBe(200);
    });

    it("keeps the user's own permissions: no access to conversations the user isn't in", async () => {
        const other = await api(bob).post("/conversations").send({ receiverId: String(carol.user._id) });
        const otherId = String(other.body.conversationId);
        const res = await http().get(`/messages/${otherId}`).set(bearer(token));
        expect([403, 404]).toContain(res.status);
        expect((await http().delete(`/conversations/${otherId}`).set(bearer(token))).status).not.toBe(200);
    });

    it("counts app requests and errors on the session routes too", async () => {
        const owner: Session = { user: await makeUser() };
        const app = (await api(owner).post("/v1/apps").send({ name: uniq("M"), environment: "development", scopes: ["conversations:read"] })).body.data;
        const cred = (await api(owner).post(`/v1/apps/${app._id}/credentials`).send({ confirm: app.name })).body.data;
        await api(alice).post(`/v1/apps/${app._id}/grants`).send({ scopes: ["conversations:read"] });
        const t = (await http().post("/v1/app-tokens").set(basic(cred.credential.keyId, cred.secret)).send({ userId: String(alice.user._id) })).body.data.accessToken;
        expect((await http().get("/conversations").set(bearer(t))).status).toBe(200);
        expect((await http().get("/groupConversations").set(bearer(t))).status).toBe(403);
        let today: any = null;
        for (let i = 0; i < 20 && !(today?.apiErrors >= 1); i++) {
            await sleep(100);
            today = (await api(owner).get(`/v1/apps/${app._id}/usage?days=1`)).body.data[0];
        }
        expect(today.apiRequests).toBeGreaterThanOrEqual(2);
        expect(today.apiErrors).toBe(0); // the 403 failed the scope check before the app request was metered
    });
});

describe("Socket.IO access with app tokens (shadow rooms)", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    const appSocket = (token: string) => new Promise<Socket>((resolve, reject) => {
        const s = ioClient(`http://localhost:${server.port}`, { auth: { token }, transports: ["websocket"], forceNew: true, reconnection: false });
        open.push(s);
        s.once("connect", () => resolve(s));
        s.once("connect_error", reject);
    });
    const userSocket = async (s: Session) => {
        const sock = await connect(server.port, s);
        open.push(sock);
        await sleep(150);
        return sock;
    };
    const ackOf = <T = any>(s: Socket, event: string, payload: unknown) => new Promise<T>((resolve) => s.emit(event, payload, resolve));

    beforeAll(async () => {
        server = await startSocketServer();
    });

    afterAll(async () => {
        open.forEach((s) => s.disconnect());
        await server.close();
    });

    it("joins a conversation the user is in, receives messages without ciphertext, typing and reactions; sends typing", async () => {
        const [alice, bob] = (await Promise.all([makeUser(), makeUser()])).map((user) => ({ user }));
        const conv = String((await api(alice).post("/conversations").send({ receiverId: String(bob.user._id) })).body.conversationId);
        const app = await appSocket(await appToken(alice, ["realtime:connect", "messages:read"]));
        const bobSock = await userSocket(bob);
        bobSock.emit("joinConversation", conv);
        app.emit("joinConversation", conv);
        await sleep(250);

        const got = nextEvent(app, "receiveMessage", 3000, (m) => String(m?.conversationId) === conv);
        bobSock.emit("sendMessage", { user: { _id: String(bob.user._id) }, conversationId: conv, content: "", type: "text", e2ee: enc("hello app") });
        const m = await got;
        expect(m).not.toBeNull();
        expect(m.encrypted).toBe(true);
        expect(m.e2ee).toBeUndefined();
        expect(JSON.stringify(m)).not.toContain(Buffer.from("hello app").toString("base64").replace(/=+$/, ""));

        const typing = nextEvent(app, "userTyping", 2000, (t) => t?.conversationId === conv);
        bobSock.emit("typing", conv);
        expect(await typing).toMatchObject({ userId: String(bob.user._id), isTyping: true });

        const reaction = nextEvent(app, "messageReactionUpdated", 2000, (r) => String(r?.conversationId) === conv);
        bobSock.emit("reactToMessage", { conversationId: conv, messageId: String(m._id), emoji: "👍" });
        expect(await reaction).not.toBeNull();

        const bobSeesTyping = nextEvent(bobSock, "userTyping", 2000, (t) => t?.conversationId === conv);
        app.emit("typing", conv);
        expect(await bobSeesTyping).toMatchObject({ userId: String(alice.user._id), isTyping: true });
    });

    it("can't join a conversation the user isn't in, and gets nothing from it", async () => {
        const [alice, bob, carol] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
        const conv = String((await api(bob).post("/conversations").send({ receiverId: String(carol.user._id) })).body.conversationId);
        const app = await appSocket(await appToken(alice, ["realtime:connect", "messages:read"]));
        const bobSock = await userSocket(bob);
        bobSock.emit("joinConversation", conv);
        app.emit("joinConversation", conv);
        await sleep(250);
        const leak = nextEvent(app, "receiveMessage", 1200);
        const typingLeak = nextEvent(app, "userTyping", 1200);
        bobSock.emit("sendMessage", { user: { _id: String(bob.user._id) }, conversationId: conv, content: "", type: "text", e2ee: enc("private") });
        bobSock.emit("typing", conv);
        expect(await leak).toBeNull();
        expect(await typingLeak).toBeNull();
    });

    it("receives no room events its scopes don't cover (joined via messages:read, no groups:read)", async () => {
        const [alice, bob, carol] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
        const created = await api(alice).post("/conversations/group").send({ groupName: uniq("G"), groupMembers: JSON.stringify([String(bob.user._id), String(carol.user._id)]) });
        const groupId = String(created.body.data._id);
        const app = await appSocket(await appToken(alice, ["realtime:connect", "messages:read"]));
        app.emit("joinConversation", groupId);
        await sleep(250);
        const updated = nextEvent(app, "group:updated", 1200);
        await api(alice).put(`/conversations/group/${groupId}/add-member`).send({ userIds: [String((await makeUser())._id)] });
        expect(await updated).toBeNull();
    });

    it("loses the group room when the user is removed from the group", async () => {
        const [admin, alice, carol] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
        const created = await api(admin).post("/conversations/group").send({ groupName: uniq("G"), groupMembers: JSON.stringify([String(alice.user._id), String(carol.user._id)]) });
        const groupId = String(created.body.data._id);
        const app = await appSocket(await appToken(alice, ["realtime:connect", "messages:read"]));
        const adminSock = await userSocket(admin);
        for (const s of [adminSock, app]) s.emit("joinConversation", groupId);
        await sleep(250);
        const before = nextEvent(app, "receiveMessage", 2000, (m) => String(m?.conversationId) === groupId);
        adminSock.emit("sendMessage", { user: { _id: String(admin.user._id) }, conversationId: groupId, content: "", type: "text", e2ee: enc("before") });
        expect(await before).not.toBeNull();

        expect((await api(admin).put(`/conversations/group/${groupId}/remove-member`).send({ userId: String(alice.user._id) })).status).toBe(200);
        await sleep(250);
        const after = nextEvent(app, "receiveMessage", 1200, (m) => String(m?.conversationId) === groupId);
        adminSock.emit("sendMessage", { user: { _id: String(admin.user._id) }, conversationId: groupId, content: "", type: "text", e2ee: enc("after") });
        expect(await after).toBeNull();
    });

    it("presence and group requests need their scopes; the handlers apply the user's own permissions", async () => {
        const [alice, bob, carol] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
        const created = await api(alice).post("/conversations/group").send({ groupName: uniq("G"), groupMembers: JSON.stringify([String(bob.user._id), String(carol.user._id)]) });
        const groupId = String(created.body.data._id);

        const narrow = await appSocket(await appToken(alice, ["realtime:connect"]));
        const refused = await Promise.race([ackOf(narrow, "presence:set", { status: "Busy" }), sleep(800).then(() => "no-answer")]);
        expect(refused).toBe("no-answer"); // refused before reaching the handler

        const full = await appSocket(await appToken(alice, ["realtime:connect", "profile:write", "groups:write"]));
        expect((await ackOf<any>(full, "presence:set", { status: "Busy" })).success).toBe(true);
        expect((await ackOf<any>(full, "group:update", { groupId, groupName: "Renamed by app" })).success).toBe(true);

        // Bob's app can't administer a group Bob doesn't administer
        const bobApp = await appSocket(await appToken(bob, ["realtime:connect", "groups:write"]));
        expect((await ackOf<any>(bobApp, "group:update", { groupId, groupName: "Hijack" })).error).toBeTruthy();
    });

    it("an app connection doesn't replace the user's own connection", async () => {
        const [alice, bob] = (await Promise.all([makeUser(), makeUser()])).map((user) => ({ user }));
        const conv = String((await api(bob).post("/conversations").send({ receiverId: String(alice.user._id) })).body.conversationId);
        const aliceSock = await userSocket(alice);
        await appSocket(await appToken(alice, ["realtime:connect", "messages:read"]));
        await sleep(200);
        const own = nextEvent(aliceSock, "receiveMessage", 2000, (m) => String(m?.conversationId) === conv);
        const bobSock = await userSocket(bob);
        bobSock.emit("sendMessage", { user: { _id: String(bob.user._id) }, conversationId: conv, content: "", type: "text", e2ee: enc("to alice") });
        expect(await own).not.toBeNull();
    });
});
