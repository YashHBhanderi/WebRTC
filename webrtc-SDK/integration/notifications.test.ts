import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCOPES, backendTokenProvider, isSpreeWeError, type SpreeWeClient } from "@spreewe/core";
import { enableE2ee } from "@spreewe/e2ee";
import { getChat } from "@spreewe/chat";
import { getNotifications, type SpreeWeNotification } from "@spreewe/notifications";
import { appClient, clientFor, eventually, grant, makeUser, registerApp, serverExchange, startSocketServer, type Session, type TestApp } from "./support";

/**
 * @spreewe/notifications against the real backend: activity entries created by the message gateway
 * (mentions and replies in end-to-end encrypted chats), live `notification:new` / `notification:read`,
 * the unread count, marking read, views, paging, re-sync after a reconnect and missing scopes.
 */
let server: { port: number; close: () => Promise<void> };
let base: string;
let alice: Session, bob: Session, owner: Session;
let full: TestApp;
const clients: SpreeWeClient[] = [];
const track = (c: SpreeWeClient) => (clients.push(c), c);
const ALL = [...SCOPES];

let a: SpreeWeClient, b: SpreeWeClient, conversationId: string;
let aliceId: string, bobId: string;

beforeAll(async () => {
    server = await startSocketServer();
    base = `http://localhost:${server.port}`;
    [alice, bob, owner] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
    aliceId = String(alice.user._id);
    bobId = String(bob.user._id);
    const quotas = { environment: "production", callbackUrls: ["https://app.example.com/oauth/callback"], quotas: { rateLimitPerMinute: 6000, messagesPerDay: 100000 } };
    full = await registerApp(owner, ALL, quotas);
    for (const u of [alice, bob]) await grant(u, full, ALL);

    a = track(appClient(base, full, aliceId));
    b = track(appClient(base, full, bobId));
    enableE2ee(a, { storage: "memory" });
    enableE2ee(b, { storage: "memory" });
    conversationId = await getChat(a).openDirect(bobId);
    await Promise.all([getChat(a).start(), getChat(b).start()]);
    await Promise.all([getChat(a).e2ee!.start(), getChat(b).e2ee!.start()]);
});

afterAll(async () => {
    clients.forEach((c) => c.destroy());
    await server?.close();
});

/** A fresh client for Bob, reading only over REST */
function bobAgain(scopes?: string[]): SpreeWeClient {
    return track(clientFor(base, backendTokenProvider({ fetchToken: serverExchange(base, full, bobId, scopes ? { scopes } : {}) })));
}

async function openLoaded(client: SpreeWeClient) {
    const s = getChat(client).open(conversationId);
    await eventually(() => expect(s.messages.value.loading).toBe(false));
    return s;
}

describe("notifications service", () => {
    const live: SpreeWeNotification[] = [];
    let mentionId = "";
    let replyId = "";

    it("a mention in an encrypted chat arrives live as notification:new and raises the unread count", async () => {
        const nb = getNotifications(b);
        await nb.load();
        expect(nb.items.value.loaded).toBe(true);
        expect(nb.live.value).toBe("live");
        await eventually(() => expect(nb.unreadLoaded.value).toBe(true));
        const before = nb.unread.value;
        nb.onNotification((n) => live.push(n));

        const sa = await openLoaded(a);
        await sa.send("hi @bob, please look", { mentions: [bobId] });
        const n = await eventually(() => {
            const hit = live.find((x) => x.type === "mention");
            expect(hit).toBeTruthy();
            return hit!;
        });
        mentionId = n._id;
        expect(n.actor?._id).toBe(aliceId);
        expect(n.actor?.username).toBeTruthy();
        expect(n.conversationId).toBe(conversationId);
        expect(n.messageId).toBeTruthy();
        expect(n.read).toBe(false);
        // The server can't read end-to-end encrypted text: the preview is fixed
        expect(n.text).toBe("New message");
        expect(n.text).not.toContain("please look");

        await eventually(() => expect(nb.unread.value).toBe(before + 1));
        expect(nb.items.value.items[0]._id).toBe(mentionId);
        sa.release();
    });

    it("a reply to Bob's message creates a reply notification", async () => {
        const sa = await openLoaded(a);
        const sb = await openLoaded(b);
        await sb.send("a question from bob");
        const question = await eventually(() => {
            const m = sa.messages.value.items.find((x) => x.text === "a question from bob" && !x.local);
            expect(m).toBeTruthy();
            return m!;
        });
        await sa.send("the answer", { replyTo: question._id });
        const n = await eventually(() => {
            const hit = live.find((x) => x.type === "reply");
            expect(hit).toBeTruthy();
            return hit!;
        });
        replyId = n._id;
        expect(n.actor?._id).toBe(aliceId);
        expect(n.conversationId).toBe(conversationId);

        // The server agrees (fresh client, REST only)
        const other = getNotifications(bobAgain());
        await other.load();
        const ids = other.items.value.items.map((x) => x._id);
        expect(ids).toEqual(expect.arrayContaining([mentionId, replyId]));
        expect(await other.refreshUnread()).toBe(getNotifications(b).unread.value);
        sa.release();
        sb.release();
    });

    it("views: mentions only, and unread only", async () => {
        const nb = getNotifications(b);
        const mentions = nb.feed("mentions");
        await mentions.load();
        expect(mentions.state.value.items.length).toBeGreaterThan(0);
        expect(mentions.state.value.items.every((x) => x.type === "mention")).toBe(true);
        const unread = nb.feed("unread");
        await unread.load();
        expect(unread.state.value.items.map((x) => x._id)).toEqual(expect.arrayContaining([mentionId, replyId]));
        expect(unread.state.value.items.every((x) => !x.read)).toBe(true);
    });

    it("marks one read by id, then all; notification:read updates another live client", async () => {
        const nb = getNotifications(b);
        // A second live client for Bob (another tab of the host app)
        const watcherClient = track(appClient(base, full, bobId));
        const watcher = getNotifications(watcherClient);
        await watcher.load();
        expect(watcher.live.value).toBe("live");
        const unreadBefore = await nb.refreshUnread();
        expect(unreadBefore).toBeGreaterThanOrEqual(2);

        expect(await nb.markRead([mentionId])).toBe(1);
        expect(nb.findItem(mentionId)?.read).toBe(true);
        await eventually(() => expect(nb.unread.value).toBe(unreadBefore - 1));
        await eventually(() => expect(watcher.unread.value).toBe(unreadBefore - 1));
        // The watcher learns which item was read elsewhere
        await eventually(() => expect(watcher.findItem(mentionId)?.read).toBe(true));
        expect(watcher.findItem(replyId)?.read).toBe(false);

        // Marking an already read one again changes nothing
        expect(await nb.markRead([mentionId])).toBe(0);

        await nb.markAllRead();
        expect(nb.unread.value).toBe(0);
        await eventually(() => expect(watcher.unread.value).toBe(0));
        await eventually(() => expect(watcher.items.value.items.every((x) => x.read)).toBe(true));
        expect(await getNotifications(bobAgain()).refreshUnread()).toBe(0);
    });

    it("pages with the before cursor (newest first, no duplicates)", async () => {
        const sa = await openLoaded(a);
        for (let i = 0; i < 32; i++) await sa.send(`ping ${i} @bob`, { mentions: [bobId] });
        const other = getNotifications(bobAgain());
        await eventually(async () => expect(await other.refreshUnread()).toBe(32), 20_000, 200);
        const feed = other.feed("mentions");
        await feed.load();
        expect(feed.state.value.items).toHaveLength(30);
        expect(feed.state.value.hasMore).toBe(true);
        await feed.loadMore();
        const items = feed.state.value.items;
        expect(items.length).toBeGreaterThanOrEqual(33);
        expect(new Set(items.map((x) => x._id)).size).toBe(items.length);
        const times = items.map((x) => Date.parse(x.createdAt));
        expect([...times].sort((p, q) => q - p)).toEqual(times);
        sa.release();
        await getNotifications(b).markAllRead();
    });

    it("re-syncs the feed and the count after a reconnect (events missed while offline)", async () => {
        const nb = getNotifications(b);
        await nb.load({ refresh: true });
        await eventually(() => expect(nb.unread.value).toBe(0));
        b.realtime.disconnect();
        const missed: SpreeWeNotification[] = [];
        const off = nb.onNotification((n) => missed.push(n));

        const sa = await openLoaded(a);
        await sa.send("while you were away @bob", { mentions: [bobId] });
        // Stored on the server, but not delivered to the disconnected client
        const other = getNotifications(bobAgain());
        await eventually(async () => expect(await other.refreshUnread()).toBe(1));
        expect(missed).toHaveLength(0);
        expect(nb.unread.value).toBe(0);

        await b.realtime.connect();
        await eventually(() => expect(nb.unread.value).toBe(1));
        await eventually(() => expect(nb.items.value.items[0]?.read).toBe(false));
        expect(nb.items.value.items[0].type).toBe("mention");
        off();
        sa.release();
    });
});

describe("notifications scopes", () => {
    it("without notifications:write, reading works and marking read is refused with 403", async () => {
        const c = bobAgain(["notifications:read", "realtime:connect"]);
        const n = getNotifications(c);
        await n.load();
        expect(n.items.value.items.length).toBeGreaterThan(0);
        expect(await n.canMarkRead()).toBe(false);
        const target = n.items.value.items.find((x) => !x.read) || n.items.value.items[0];
        const wasRead = target.read;
        const err = await n.markRead([target._id]).catch((e) => e);
        expect(isSpreeWeError(err)).toBe(true);
        expect(err.status).toBe(403);
        expect(err.message).toContain("notifications:write");
        // Rolled back
        expect(n.findItem(target._id)?.read).toBe(wasRead);
    });

    it("without notifications:read, the feed reports a 403 error state", async () => {
        const c = bobAgain(["profile:read", "realtime:connect"]);
        const n = getNotifications(c);
        const err = await n.load().catch((e) => e);
        expect(isSpreeWeError(err)).toBe(true);
        expect(err.status).toBe(403);
        expect(n.items.value.error).toBe(err);
        expect(n.items.value.loaded).toBe(false);
        await expect(n.refreshUnread()).rejects.toMatchObject({ status: 403 });
        expect(n.unreadError.value).toBeTruthy();
    });

    it("without realtime:connect, the feed works over REST and live is 'unavailable'", async () => {
        const c = bobAgain(["notifications:read", "notifications:write"]);
        const n = getNotifications(c);
        await n.load();
        expect(n.items.value.loaded).toBe(true);
        expect(n.live.value).toBe("unavailable");
        // The shared socket was never opened by this module
        expect(c.realtime.state.value).toBe("idle");
    });
});
