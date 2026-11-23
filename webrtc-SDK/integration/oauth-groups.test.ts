import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCOPES, createOAuthClient, isSpreeWeError, type SpreeWeClient } from "@spreewe/core";
import { getGroups, type GroupsService } from "@spreewe/groups";
import { api, appClient, clientFor, eventually, grant, makeUser, registerApp, startSocketServer, type Session, type TestApp } from "./support";

/**
 * OAuth 2.0 + PKCE through the SDK's OAuthClient against the real /oauth endpoints (the consent
 * decision is made with the user's session, as SpreeWe's consent page does), and the groups module.
 */
const REDIRECT = "https://app.example.com/oauth/callback";
let server: { port: number; close: () => Promise<void> };
let base: string;
let alice: Session, bob: Session, carol: Session, dave: Session, owner: Session;
let app: TestApp;
const clients: SpreeWeClient[] = [];
const track = (c: SpreeWeClient) => (clients.push(c), c);

beforeAll(async () => {
    server = await startSocketServer();
    base = `http://localhost:${server.port}`;
    [alice, bob, carol, dave, owner] = (await Promise.all([makeUser(), makeUser(), makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
    app = await registerApp(owner, [...SCOPES], { environment: "production", callbackUrls: [REDIRECT], quotas: { rateLimitPerMinute: 6000 } });
});

afterAll(async () => {
    clients.forEach((c) => c.destroy());
    await server?.close();
});

/** What SpreeWe's consent page does after the user clicks Allow / Deny */
async function decide(user: Session, authorizeUrl: string, approve: boolean, scopes?: string[]): Promise<string> {
    const res = await fetch(authorizeUrl, { redirect: "manual" });
    expect(res.status).toBe(302);
    const requestId = new URL(res.headers.get("location")!, base).searchParams.get("request");
    expect(requestId).toBeTruthy();
    const decision = await api(user).post(`/v1/consent-requests/${requestId}/${approve ? "approve" : "deny"}`).send(approve ? { scopes } : {});
    expect(decision.status, JSON.stringify(decision.body)).toBeLessThan(300);
    return decision.body.data.redirectUrl as string;
}

describe("OAuth 2.0 + PKCE (OAuthClient)", () => {
    const scopes = ["profile:read", "realtime:connect", "conversations:read"] as const;

    it("authorizes, exchanges the code, calls the API, rotates refresh tokens and signs out", async () => {
        const oauth = createOAuthClient({ baseUrl: base, clientId: app.appId, redirectUri: REDIRECT, scopes, storage: "memory" });
        const url = await oauth.createAuthorizeUrl();
        expect(new URL(url).searchParams.get("code_challenge_method")).toBe("S256");
        const redirect = await decide(alice, url, true, [...scopes]);
        expect(oauth.isRedirectCallback(redirect)).toBe(true);
        const tokens = await oauth.handleRedirectCallback(redirect, { replaceUrl: false });
        expect(tokens.refreshToken.startsWith("swr_")).toBe(true);
        expect(oauth.grantedScopes.sort()).toEqual([...scopes].sort());

        const client = track(clientFor(base, oauth));
        expect((await client.loadMe()).user._id).toBe(String(alice.user._id));
        await client.realtime.connect();
        expect(client.realtime.connected).toBe(true);

        // Concurrent forced refreshes share ONE rotation (a second use of the old refresh token
        // would revoke the whole family on the server)
        const [t1, t2] = await Promise.all([oauth.getToken({ forceRefresh: true }), oauth.getToken({ forceRefresh: true })]);
        expect(t1).toBe(t2);
        const t3 = await oauth.getToken({ forceRefresh: true });
        expect(t3).not.toBe(t1);
        expect((await client.loadMe({ refresh: true })).user._id).toBe(String(alice.user._id));

        await oauth.signOut();
        expect(oauth.isSignedIn).toBe(false);
        const err = await oauth.getToken().catch((e) => e);
        expect(isSpreeWeError(err, "SIGNED_OUT")).toBe(true);
    });

    it("reports a denied consent and a state mismatch", async () => {
        const oauth = createOAuthClient({ baseUrl: base, clientId: app.appId, redirectUri: REDIRECT, scopes, storage: "memory" });
        const denied = await decide(bob, await oauth.createAuthorizeUrl(), false);
        const e1 = await oauth.handleRedirectCallback(denied, { replaceUrl: false }).catch((e) => e);
        expect(isSpreeWeError(e1, "OAUTH_ERROR")).toBe(true);

        await oauth.createAuthorizeUrl();
        const e2 = await oauth.handleRedirectCallback(`${REDIRECT}?state=forged-state-123&code=swc_x`, { replaceUrl: false }).catch((e) => e);
        expect(isSpreeWeError(e2, "OAUTH_STATE_MISMATCH")).toBe(true);
    });

    it("a revoked grant signs the client out on the next refresh", async () => {
        const oauth = createOAuthClient({ baseUrl: base, clientId: app.appId, redirectUri: REDIRECT, scopes, storage: "memory" });
        await oauth.handleRedirectCallback(await decide(carol, await oauth.createAuthorizeUrl(), true, [...scopes]), { replaceUrl: false });
        const reasons: string[] = [];
        oauth.onSignedOut((r) => reasons.push(r));
        const grants = (await api(carol).get("/v1/me/app-grants")).body.data as { _id: string; appId?: string; app?: { _id: string } }[];
        const g = grants.find((x) => String(x.appId ?? x.app?._id) === app.appId) ?? grants[0];
        expect((await api(carol).delete(`/v1/me/app-grants/${g._id}`)).status).toBeLessThan(300);
        const err = await oauth.getToken({ forceRefresh: true }).catch((e) => e);
        expect(isSpreeWeError(err, "SIGNED_OUT")).toBe(true);
        expect(reasons).toEqual(["revoked"]);
    });
});

describe("groups", () => {
    let a: GroupsService, b: GroupsService, c: GroupsService, d: GroupsService, groupId: string;

    beforeAll(async () => {
        for (const u of [alice, bob, carol, dave]) await grant(u, app, [...SCOPES]);
        [a, b, c, d] = [alice, bob, carol, dave].map((u) => getGroups(track(appClient(base, app, String(u.user._id)))));
        await Promise.all([a, b, c, d].map((s) => s.loadGroups()));
    });

    it("creates a group; members see it appear live", async () => {
        groupId = await a.create({ name: "SDK test group", description: "made by the SDK", memberIds: [String(bob.user._id), String(carol.user._id)] });
        await eventually(() => expect(a.groups.value.items.some((g) => g.id === groupId)).toBe(true));
        const details = await a.loadDetails(groupId);
        expect(details.members).toHaveLength(3);
        expect(details.admins).toContain(String(alice.user._id));
        // Bob loads it (group:added is sent on member additions, not on creation)
        await b.loadGroups({ refresh: true });
        expect(b.groups.value.items.find((g) => g.id === groupId)?.memberCount).toBe(3);
    });

    it("renames, adds a member, promotes an admin: other members' details update live", async () => {
        const bobView = b.group(groupId);
        await eventually(() => expect(bobView.value.group).toBeTruthy());
        await a.update(groupId, { name: "Renamed by SDK" });
        await eventually(() => expect(bobView.value.group?.name).toBe("Renamed by SDK"));
        await a.addMembers(groupId, [String(dave.user._id)]);
        await eventually(() => expect(bobView.value.group?.members.map((m) => String(m._id))).toContain(String(dave.user._id)));
        await eventually(() => expect(d.groups.value.items.some((g) => g.id === groupId)).toBe(true));
        await a.promote(groupId, String(bob.user._id));
        await eventually(() => expect(bobView.value.group?.admins).toContain(String(bob.user._id)));
    });

    it("rejects admin actions from a non-admin with the server's error", async () => {
        const err = await c.removeMember(groupId, String(dave.user._id)).catch((e) => e);
        expect(isSpreeWeError(err, "SOCKET_REFUSED")).toBe(true);
    });

    it("removal, leaving and deletion end the membership for the affected users", async () => {
        const carolView = c.group(groupId);
        await eventually(() => expect(carolView.value.group).toBeTruthy());
        await a.removeMember(groupId, String(carol.user._id));
        await eventually(() => expect(carolView.value.gone).toBe("removed"));

        await b.leave(groupId);
        expect(b.group(groupId).value.gone).toBe("left");

        const daveView = d.group(groupId);
        await eventually(() => expect(daveView.value.group).toBeTruthy());
        await a.delete(groupId);
        await eventually(() => expect(daveView.value.gone).toBe("deleted"));
        await eventually(() => expect(d.groups.value.items.some((g) => g.id === groupId)).toBe(false));
    });
});
