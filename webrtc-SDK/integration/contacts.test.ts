import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCOPES, backendTokenProvider, isSpreeWeError, type PresenceUpdate, type SpreeWeClient, type SpreeWeError } from "@spreewe/core";
import { getContacts } from "@spreewe/contacts";
import { appClient, clientFor, eventually, grant, makeUser, registerApp, serverExchange, startSocketServer, uniq, type Session, type TestApp } from "./support";

/**
 * @spreewe/contacts against the real backend: directory (GET /v1/directory), profiles
 * (GET /web/user/:id), lookup / start by e-mail (POST /v1/contacts/*), presence (socket presence:set →
 * user:presence on a contact's app socket), block / unblock acks, and profile updates
 * (PATCH /web/user/profile, multipart).
 *
 * Visibility in the personal (global) context: the directory and profiles only show people the user
 * already shares a conversation with (webrtc-BE tenancy/tenant.service.ts directoryFilter / canSeeUser);
 * everyone else is found by exact e-mail. Presence goes only to people who share a conversation
 * (services/presence.service.ts contactsOf / visibleTo).
 */
let server: { port: number; close: () => Promise<void> };
let base: string;
let alice: Session, bob: Session, carol: Session, owner: Session;
let full: TestApp;
const clients: SpreeWeClient[] = [];
const track = (c: SpreeWeClient) => (clients.push(c), c);
const ALL = [...SCOPES];

let a: SpreeWeClient, b: SpreeWeClient;
let conversationId = "";

beforeAll(async () => {
    server = await startSocketServer();
    base = `http://localhost:${server.port}`;
    // Distinct name prefixes so directory searches are unambiguous
    [alice, bob, carol, owner] = (await Promise.all([makeUser(uniq("alice")), makeUser(uniq("bob")), makeUser(uniq("carol")), makeUser()])).map((user) => ({ user }));
    const quotas = { environment: "production", callbackUrls: ["https://app.example.com/oauth/callback"], quotas: { rateLimitPerMinute: 6000, messagesPerDay: 100000 } };
    full = await registerApp(owner, ALL, quotas);
    for (const u of [alice, bob, carol]) await grant(u, full, ALL);
    a = track(appClient(base, full, String(alice.user._id)));
    b = track(appClient(base, full, String(bob.user._id)));
});

afterAll(async () => {
    clients.forEach((c) => c.destroy());
    await server?.close();
});

describe("contacts: finding people", () => {
    it("does not list or show strangers in the personal context", async () => {
        const page = await getContacts(a).search({ q: bob.user.username });
        expect(page.items.some((u) => u._id === String(bob.user._id))).toBe(false);
        const err = (await getContacts(a).profile(String(bob.user._id)).catch((e) => e)) as SpreeWeError;
        expect(err.status).toBe(404);
    });

    it("looks people up by exact e-mail; unknown and invalid addresses get the server's answers", async () => {
        const ca = getContacts(a);
        const hit = await ca.lookup(bob.user.email.toUpperCase());
        expect(hit.found).toBe(true);
        expect(hit.user?._id).toBe(String(bob.user._id));
        expect(hit.user?.username).toBe(bob.user.username);
        expect(hit.external).toBe(false);
        expect(hit.conversationId).toBeNull();

        const miss = await ca.lookup("nobody-here@example.test");
        expect(miss.found).toBe(false);
        expect(miss.message).toBe("No eligible account found for this email.");

        const invalid = (await ca.lookup("not-an-email").catch((e) => e)) as SpreeWeError;
        expect(invalid.status).toBe(400);
        expect(invalid.message).toBe("Enter a valid email address");

        // scope "external" only exists inside an organization
        const external = (await ca.lookup(bob.user.email, { scope: "external" }).catch((e) => e)) as SpreeWeError;
        expect(external.status).toBe(400);
        expect(external.message).toBe("External contacts exist only in an organization");
    });

    it("starts a chat by e-mail (and reuses it)", async () => {
        const ca = getContacts(a);
        const started = await ca.startConversation(bob.user.email);
        expect(started.external).toBe(false);
        expect(started.conversationId).toMatch(/^[a-f0-9]{24}$/);
        conversationId = started.conversationId;
        expect((await ca.startConversation(bob.user.email)).conversationId).toBe(conversationId);
        expect((await ca.lookup(bob.user.email)).conversationId).toBe(conversationId);
        await ca.startConversation(carol.user.email);
    });

    it("now finds the contact in the directory, seeds presence, and pages with a cursor", async () => {
        const ca = getContacts(a);
        const page = await ca.search({ q: bob.user.username.slice(0, 6) });
        const entry = page.items.find((u) => u._id === String(bob.user._id));
        expect(entry).toBeDefined();
        expect(entry).not.toHaveProperty("email");
        expect(a.people.presence.value.has(String(bob.user._id))).toBe(true);

        const q = ca.browse({ pageSize: 1 });
        await eventually(() => expect(q.state.value.loaded).toBe(true));
        expect(q.state.value.items).toHaveLength(1);
        expect(q.state.value.nextCursor).toBeTruthy();
        await q.loadMore();
        expect(q.state.value.items).toHaveLength(2);
        const ids = q.state.value.items.map((u) => u._id).sort();
        expect(ids).toEqual([String(bob.user._id), String(carol.user._id)].sort());
        if (!q.state.value.done) await q.loadMore();
        expect(q.state.value.done).toBe(true);
        expect(q.state.value.items).toHaveLength(2);
    });

    it("loads the contact's profile", async () => {
        const p = await getContacts(a).profile(String(bob.user._id), { refresh: true });
        expect(p._id).toBe(String(bob.user._id));
        expect(p.username).toBe(bob.user.username);
        expect(typeof p.bio).toBe("string");
        expect(p).not.toHaveProperty("email");
    });
});

describe("contacts: presence", () => {
    it("presence:set from one user reaches a contact's app socket as user:presence", async () => {
        const ca = getContacts(a);
        const cb = getContacts(b);
        expect(await ca.startPresence()).toBe(true);
        const seen: PresenceUpdate[] = [];
        a.realtime.on<PresenceUpdate>("user:presence", (p) => String(p?.userId) === String(bob.user._id) && seen.push(p));

        const mine = await cb.setPresence({ status: "Busy", statusMessage: "  In a workshop  " });
        expect(mine.ownStatus).toBe("Busy");
        expect(mine.status).toBe("Busy");
        expect(mine.statusMessage).toBe("In a workshop");
        // App connections never mark the user online (realtime-events.md, presence.gateway.ts)
        expect(mine.isOnline).toBe(false);

        await eventually(() => {
            const last = seen[seen.length - 1];
            expect(last?.status).toBe("Busy");
            expect(last?.statusMessage).toBe("In a workshop");
        });
        expect(a.people.presence.value.get(String(bob.user._id))?.status).toBe("Busy");
        expect((await cb.loadMyProfile({ refresh: true })).status).toBe("Busy");
    });

    it("rejects invalid statuses locally and over-long messages with the server's rule", async () => {
        const cb = getContacts(b);
        expect(isSpreeWeError(await cb.setPresence({ status: "Sleeping" as any }).catch((e) => e), "INVALID_ARGUMENT")).toBe(true);
        expect(isSpreeWeError(await cb.setPresence({ statusMessage: "x".repeat(141) }).catch((e) => e), "INVALID_ARGUMENT")).toBe(true);
        // Raw socket: the server's own refusal arrives as SOCKET_REFUSED
        const raw = await b.realtime.request("presence:set", { status: "Sleeping" }).catch((e) => e);
        expect(isSpreeWeError(raw, "SOCKET_REFUSED")).toBe(true);
        expect((raw as SpreeWeError).message).toBe("Invalid status");
    });

    it("'Appear offline' shows as offline Available to contacts over the socket", async () => {
        const seen: PresenceUpdate[] = [];
        const off = a.realtime.on<PresenceUpdate>("user:presence", (p) => String(p?.userId) === String(bob.user._id) && seen.push(p));
        try {
            const mine = await getContacts(b).setPresence({ status: "Appear offline" });
            expect(mine.ownStatus).toBe("Appear offline");
            await eventually(() => {
                const last = seen[seen.length - 1];
                expect(last?.isOnline).toBe(false);
                expect(last?.status).toBe("Available");
            });
        } finally {
            off();
        }
    });

    // KNOWN BACKEND ISSUE (webrtc-BE/src/api/v1/routes.ts:107-110 and controllers/userController.ts:68): the
    // directory and GET /web/user/:userId read users with .lean(), which skips the model's toJSON mask
    // (models/userModel.ts:114), so a contact's real "Appear offline" choice is revealed to others —
    // presence.service.ts promises it never is. it.fails turns red once the server masks it.
    it.fails("the directory and profiles never reveal 'Appear offline' (fails until the backend is fixed)", async () => {
        const page = await getContacts(a).search({ q: bob.user.username });
        const entry = page.items.find((u) => u._id === String(bob.user._id));
        expect(entry?.status).not.toBe("Appear offline");
        const profile = await getContacts(a).profile(String(bob.user._id), { refresh: true });
        expect(profile.status).not.toBe("Appear offline");
    });

    it("back to Available", async () => {
        const mine = await getContacts(b).setPresence({ status: "Available", statusMessage: "" });
        expect(mine.ownStatus).toBe("Available");
        expect(mine.statusMessage).toBe("");
    });
});

describe("contacts: blocking", () => {
    it("blocks and unblocks over the socket with acks; lookups and the chat state follow", async () => {
        const ca = getContacts(a);
        const blocked = await ca.block(String(bob.user._id));
        expect(blocked).toEqual({ userId: String(bob.user._id), blocked: true });
        expect(ca.blocked.value.get(String(bob.user._id))).toBe(true);
        // Blocked people can't be found by e-mail (same answer as unregistered)
        expect((await ca.lookup(bob.user.email)).found).toBe(false);
        expect(await ca.blockedInConversation(conversationId)).toEqual({ peerId: String(bob.user._id), blockedByMe: true });
        // Bob can't find Alice either (either-way block), and isn't told why
        expect((await getContacts(b).lookup(alice.user.email)).found).toBe(false);

        const unblocked = await ca.unblock(String(bob.user._id));
        expect(unblocked).toEqual({ userId: String(bob.user._id), blocked: false });
        expect(ca.blocked.value.get(String(bob.user._id))).toBe(false);
        expect((await ca.lookup(bob.user.email)).found).toBe(true);
        expect((await ca.blockedInConversation(conversationId)).blockedByMe).toBe(false);
    });

    it("passes the server's refusal through (blocking yourself)", async () => {
        const err = (await getContacts(a).block(String(alice.user._id)).catch((e) => e)) as SpreeWeError;
        expect(isSpreeWeError(err, "SOCKET_REFUSED")).toBe(true);
        expect(err.message).toBe("You cannot block yourself");
    });
});

describe("contacts: my profile", () => {
    it("loads my own profile with my real status and updates name and bio (multipart)", async () => {
        const ca = getContacts(a);
        const me = await ca.loadMyProfile();
        expect(me._id).toBe(String(alice.user._id));
        expect(me.email).toBe(alice.user.email);
        const name = `Alice ${Date.now().toString(36).slice(-5)}`;
        const updated = await ca.updateProfile({ username: name, bio: "Builds things with SpreeWe" });
        expect(updated.username).toBe(name);
        expect(updated.bio).toBe("Builds things with SpreeWe");
        expect(ca.me.value?.username).toBe(name);
        expect((await a.loadMe({ refresh: true })).user.username).toBe(name);
        // A contact sees the change
        const seenByBob = await getContacts(b).profile(String(alice.user._id), { refresh: true });
        expect(seenByBob.username).toBe(name);
        expect(seenByBob.bio).toBe("Builds things with SpreeWe");
    });

    it("updates discoverability: people who opt out can't be found by e-mail", async () => {
        const cb = getContacts(b);
        await cb.updateProfile({ globalDiscoverable: false });
        expect((await cb.loadMyProfile({ refresh: true })).globalDiscoverable).toBe(false);
        // A stranger (no shared conversation) can no longer find Bob
        const c = track(appClient(base, full, String(carol.user._id)));
        expect((await getContacts(c).lookup(bob.user.email)).found).toBe(false);
        await cb.updateProfile({ globalDiscoverable: true });
        expect((await getContacts(c).lookup(bob.user.email)).found).toBe(true);
    });

    it("validates locally with the server's rules, and the server's own messages come through", async () => {
        const ca = getContacts(a);
        expect(isSpreeWeError(await ca.updateProfile({ username: "x" }).catch((e) => e), "INVALID_ARGUMENT")).toBe(true);
        expect(isSpreeWeError(await ca.updateProfile({ bio: "b".repeat(161) }).catch((e) => e), "INVALID_ARGUMENT")).toBe(true);
        expect(isSpreeWeError(await ca.updateProfile({}).catch((e) => e), "INVALID_ARGUMENT")).toBe(true);
        expect(isSpreeWeError(await ca.updateProfile({ image: new Blob(["hi"], { type: "text/plain" }) }).catch((e) => e), "INVALID_ARGUMENT")).toBe(true);
        // Same request without the SDK's checks: the server refuses it with the same message
        const form = new FormData();
        form.append("username", "x");
        const raw = (await a.http.patch("/web/user/profile", undefined, { form }).catch((e) => e)) as SpreeWeError;
        expect(raw.status).toBe(400);
        expect(raw.code).toBe("VALIDATION_ERROR");
        expect(raw.message).toBe("Username must be 3-30 characters");
    });
});

describe("contacts: scopes", () => {
    it("without contacts:write / profile:write: lookups work, writes fail with a clear scope error", async () => {
        const narrow = track(
            clientFor(
                base,
                backendTokenProvider({ fetchToken: serverExchange(base, full, String(alice.user._id), { scopes: ["profile:read", "directory:read", "realtime:connect"] }) }),
            ),
        );
        const cn = getContacts(narrow);
        expect((await cn.lookup(bob.user.email)).found).toBe(true);
        const start = (await cn.startConversation(bob.user.email).catch((e) => e)) as SpreeWeError;
        expect(start.status).toBe(403);
        expect(start.message).toBe("The token lacks the contacts:write scope");
        // Socket events outside the token's scopes are never acked: the SDK refuses them up front
        const block = (await cn.block(String(bob.user._id)).catch((e) => e)) as SpreeWeError;
        expect(isSpreeWeError(block, "MISSING_SCOPE")).toBe(true);
        expect(block.message).toBe("The token lacks the contacts:write scope");
        const presence = (await cn.setPresence({ status: "Busy" }).catch((e) => e)) as SpreeWeError;
        expect(isSpreeWeError(presence, "MISSING_SCOPE")).toBe(true);
        const profile = (await cn.updateProfile({ bio: "nope" }).catch((e) => e)) as SpreeWeError;
        expect(profile.status).toBe(403);
        expect(profile.message).toBe("The token lacks the profile:write scope");
    });

    it("without directory:read the directory answers 403 naming the scope", async () => {
        const noDir = track(clientFor(base, backendTokenProvider({ fetchToken: serverExchange(base, full, String(alice.user._id), { scopes: ["profile:read"] }) })));
        const err = (await getContacts(noDir).search().catch((e) => e)) as SpreeWeError;
        expect(err.status).toBe(403);
        expect(err.message).toBe("The token lacks the directory:read scope");
        expect(await getContacts(noDir).startPresence()).toBe(false);
    });
});
