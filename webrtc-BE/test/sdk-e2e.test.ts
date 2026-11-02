import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Message from "../src/models/messageModel";
import { runAsSystem } from "../src/tenancy/context";
import { enter, makeUser, newOrg, Session, sleep, startSocketServer, uniq } from "./helpers";
import { SpreeWeClient, ChatMessage, SpreeWeEventName, SpreeWeEvents } from "../../packages/chat-sdk/src";

/**
 * The SDK (packages/chat-sdk, user-session mode) end to end: each user has their own SDK client and
 * E2EE device, against the real REST routes, /v1, Socket.IO gateways and database, with the real
 * Olm/Megolm library. Only Clerk is the test double (as in every test): the SDK's Bearer token is
 * passed through as the test-auth header. Call MEDIA (WebRTC) can't run in Node; call signaling can.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: any, init: any = {}) => {
    const headers = { ...(init.headers || {}) } as Record<string, string>;
    const bearer = headers.Authorization?.replace(/^Bearer /, "");
    if (bearer) headers["x-test-auth"] = bearer;
    delete headers.Authorization;
    return realFetch(url, { ...init, headers });
}) as typeof fetch;

describe("SDK: chat, calls signaling, organizations", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const clients: SpreeWeClient[] = [];

    const token = (s: Session) => JSON.stringify({ sub: s.user.clerkId, org: s.org, role: s.role });
    const connect = async (s: Session) => {
        const c = new SpreeWeClient({ apiUrl: `http://localhost:${server.port}`, getToken: async () => token(s), wasmUrl: "unused-in-node", deviceLabel: uniq("sdk") });
        clients.push(c);
        await c.connect();
        return c;
    };
    function next<K extends SpreeWeEventName>(c: SpreeWeClient, event: K, match: (p: SpreeWeEvents[K]) => boolean = () => true, ms = 8000): Promise<SpreeWeEvents[K] | null> {
        return new Promise((resolve) => {
            const timer = setTimeout(() => { off(); resolve(null); }, ms);
            const off = c.events.on(event, (p) => { if (!match(p)) return; clearTimeout(timer); off(); resolve(p); });
        });
    }
    /** Decrypted text of a message, waiting for its room key if needed */
    async function textOf(c: SpreeWeClient, conversationId: string, id: string): Promise<string> {
        for (let i = 0; i < 15; i++) {
            const m = (await c.messages.history(conversationId)).find((x) => x.id === id);
            if (m?.state === "ok") return m.text;
            await sleep(300);
        }
        return "";
    }
    async function sendAndReceive(from: SpreeWeClient, to: SpreeWeClient, conversationId: string, text: string): Promise<ChatMessage> {
        const got = next(to, "message", (m) => m.conversationId === conversationId);
        await from.messages.send(conversationId, text);
        const m = await got;
        expect(m, `message "${text}" not delivered`).not.toBeNull();
        expect(await textOf(to, conversationId, m!.id)).toBe(text);
        return m!;
    }

    beforeAll(async () => {
        server = await startSocketServer();
    });

    afterAll(async () => {
        clients.forEach((c) => c.disconnect());
        await server.close();
        globalThis.fetch = realFetch;
    });

    it("auth + E2EE devices; direct chat: send, receive, decrypt, history; server stores ciphertext only", async () => {
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        const alice = await connect({ user: u });
        const bob = await connect({ user: v });
        expect(alice.me?._id).toBe(String(u._id));
        const devices = await alice.auth.devices();
        expect(devices.find((d) => d.current)?.deviceId).toBe(alice.deviceId);

        const id = await alice.conversations.openDirect(String(v._id));
        await sleep(200);
        const marker = uniq("secret-");
        const m = await sendAndReceive(alice, bob, id, `hello ${marker}`);
        expect(m.senderId).toBe(String(u._id));
        const stored: any = await runAsSystem(() => Message.findById(m.id).lean());
        expect(stored.e2ee?.ciphertext).toBeTruthy();
        expect(JSON.stringify(stored)).not.toContain(marker);
        // Listed with both participants and the OTHER person's name (was: empty members, "Conversation")
        const listed = (await bob.conversations.list()).find((c) => c.id === id);
        expect(listed).toBeTruthy();
        expect(listed!.isGroup).toBe(false);
        expect(listed!.members.map((x) => x._id).sort()).toEqual([String(u._id), String(v._id)].sort());
        expect(listed!.name).not.toBe("Conversation");
        expect([u.name, u.username, u.email]).toContain(listed!.name);

        await sendAndReceive(bob, alice, id, "hi back");
        const history = (await alice.messages.history(id)).filter((x) => x.state === "ok").map((x) => x.text);
        expect(history).toEqual([`hello ${marker}`, "hi back"]);
    });

    it("messages: reply, edit (re-encrypted), react, pin, delete, typing, read receipts", async () => {
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        const alice = await connect({ user: u });
        const bob = await connect({ user: v });
        const id = await alice.conversations.openDirect(String(v._id));
        await sleep(200);
        const first = await sendAndReceive(alice, bob, id, "original");

        // Reply
        const reply = next(alice, "message", (m) => m.conversationId === id);
        await bob.messages.send(id, "a reply", { replyTo: first.id });
        expect((await reply)?.replyToId).toBe(first.id);

        // Edit: the other side gets the updated, decryptable message
        const updated = next(bob, "message.updated", (m) => m.id === first.id);
        await alice.messages.edit(id, first.id, "edited text");
        expect(await updated).not.toBeNull();
        expect(await textOf(bob, id, first.id)).toBe("edited text");
        const stored: any = await runAsSystem(() => Message.findById(first.id).lean());
        expect(JSON.stringify(stored)).not.toContain("edited text");

        // React
        const reacted = next(alice, "reaction.updated", (r) => String(r.messageId) === first.id);
        bob.messages.react(id, first.id, "👍");
        expect((await reacted)?.reactions?.some((r: any) => r.emoji === "👍")).toBe(true);

        // Pin
        const pins = next(bob, "pins.updated", (p) => String(p.conversationId) === id);
        await alice.messages.pin(first.id, true);
        expect((await pins)?.pins?.length).toBeGreaterThan(0);

        // Typing (to the room)
        const typing = next(bob, "typing", (t) => t.conversationId === id);
        alice.chat.typing(id, true);
        expect(await typing).toMatchObject({ userId: String(u._id), isTyping: true });

        // Read receipts
        const read = next(alice, "messages.read", (r: any) => String(r?.conversationId) === id);
        bob.messages.markRead(id);
        expect(await read).not.toBeNull();

        // Delete own message: the other side is told
        const deleted = next(bob, "message.deleted", (d) => d.messageId === first.id);
        await alice.messages.delete(first.id);
        expect(await deleted).not.toBeNull();
        const after = (await bob.messages.history(id)).find((m) => m.id === first.id);
        expect(!after || after.deleted).toBe(true);
    });

    it("groups: create, members receive encrypted messages, remove a member (no longer receives)", async () => {
        const [u, v, w] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        const alice = await connect({ user: u });
        const bob = await connect({ user: v });
        const carol = await connect({ user: w });
        const group = await alice.conversations.createGroup({ name: "SDK group", memberIds: [String(v._id), String(w._id)] });
        expect(group.isGroup).toBe(true);
        // Every member lists the group (was: list() returned direct conversations only)
        for (const c of [alice, bob, carol]) {
            const g = (await c.conversations.list()).find((x) => x.id === group.id);
            expect(g, "group missing from list()").toBeTruthy();
            expect(g!.isGroup).toBe(true);
            expect(g!.name).toBe("SDK group");
            expect(g!.members.length).toBe(3);
        }
        await sleep(200);
        bob.conversations.join(group.id);
        carol.conversations.join(group.id);
        await sleep(200);

        const toCarol = next(carol, "message", (m) => m.conversationId === group.id);
        await sendAndReceive(alice, bob, group.id, "group hello");
        expect(await textOf(carol, group.id, (await toCarol)!.id)).toBe("group hello");

        await alice.conversations.removeMember(group.id, String(w._id));
        await sleep(300);
        const notForCarol = next(carol, "message", (m) => m.conversationId === group.id, 1500);
        await sendAndReceive(alice, bob, group.id, "after removal");
        expect(await notForCarol).toBeNull();
        await expect(carol.messages.history(group.id)).rejects.toThrow();
    });

    it("calls signaling: ring → incoming → accept → participant joined → state → end", async () => {
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        const alice = await connect({ user: u });
        const bob = await connect({ user: v });
        const id = await alice.conversations.openDirect(String(v._id));
        await sendAndReceive(alice, bob, id, "call me");

        const incoming = next(bob, "call.incoming", (c) => c.conversationId === id);
        const call = await alice.calls.start(id, "audio");
        expect(call.callId).toBeTruthy();
        expect((await incoming)?.callId).toBe(call.callId);

        const joined = next(alice, "call.participant-joined", (p) => String(p.callId) === call.callId);
        await bob.calls.accept(call.callId);
        expect(String((await joined)?.userId)).toBe(String(v._id));
        expect(await alice.calls.active(id)).not.toBeNull();
        expect(await alice.calls.state(call.callId)).toBeTruthy();

        const ended = next(bob, "call.ended", (p) => String(p.callId) === call.callId);
        await alice.calls.end(call.callId);
        expect(await ended).not.toBeNull();
        // Media can't join from Node (no WebRTC): the SDK says so instead of failing obscurely
        await expect(alice.calls.join(call.callId, "audio")).rejects.toThrow(/browser with WebRTC/);
    });

    it("users, presence, notifications, recordings (read)", async () => {
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        const alice = await connect({ user: u });
        const bob = await connect({ user: v });
        const id = await alice.conversations.openDirect(String(v._id));
        await sendAndReceive(alice, bob, id, "presence check");
        // Visible once they share a conversation (the server's context rule)
        expect((await alice.users.get(String(v._id)))?._id).toBe(String(v._id));

        // Own sockets always get the change. (Contacts get it too, but the server caches presence
        // visibility for 60 s, so a contact made seconds ago isn't a reliable test: known limitation.)
        const presence = next(alice, "presence", (p) => String(p.userId) === String(u._id));
        const ack = await alice.users.setPresence("Busy");
        expect(ack?.presence).toBeTruthy();
        expect(await presence).not.toBeNull();

        expect(Array.isArray((await bob.chat.notifications.list()).items)).toBe(true);
        expect(typeof (await bob.chat.notifications.unreadCount())).toBe("number");
        expect(Array.isArray(await alice.recordings.list(id))).toBe(true);
    });

    it("organizations: workspace chat works; the same user's personal context can't see or read it", async () => {
        const org = newOrg();
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: u, org });
        await enter({ user: v, org });
        const alice = await connect({ user: u, org });
        const bob = await connect({ user: v, org });
        expect(await alice.organizations.mine()).toBeTruthy();
        const id = await alice.conversations.openDirect(String(v._id));
        await sendAndReceive(alice, bob, id, "workspace hello");

        const personal = await connect({ user: v });
        expect((await personal.conversations.list()).map((c) => c.id)).not.toContain(id);
        await expect(personal.messages.history(id)).rejects.toThrow();
    });
});
