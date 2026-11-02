import "fake-indexeddb/auto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Message from "../src/models/messageModel";
import { runAsSystem } from "../src/tenancy/context";
import { enter, makeUser, newOrg, Session, sleep, startSocketServer, uniq } from "./helpers";
import { SpreeWeClient, ChatMessage } from "../../packages/chat-sdk/src";

/**
 * The prototype SDK (packages/chat-sdk, user-session mode) end to end: two users, each with their own
 * SDK client and E2EE device, against the real REST routes, /v1/e2ee, Socket.IO gateway and database,
 * with the real Olm/Megolm library. Only Clerk is the test double (as in every test): the SDK's
 * Bearer token is passed through as the test-auth header.
 */
const realFetch = globalThis.fetch;
globalThis.fetch = ((url: any, init: any = {}) => {
    const headers = { ...(init.headers || {}) } as Record<string, string>;
    const bearer = headers.Authorization?.replace(/^Bearer /, "");
    if (bearer) headers["x-test-auth"] = bearer;
    delete headers.Authorization;
    return realFetch(url, { ...init, headers });
}) as typeof fetch;

describe("SDK prototype: two users, encrypted send / receive", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const clients: SpreeWeClient[] = [];

    const token = (s: Session) => JSON.stringify({ sub: s.user.clerkId, org: s.org, role: s.role });
    const client = (s: Session) => {
        const c = new SpreeWeClient({
            apiUrl: `http://localhost:${server.port}`,
            getToken: async () => token(s),
            wasmUrl: "unused-in-node",
            deviceLabel: uniq("sdk"),
        });
        clients.push(c);
        return c;
    };
    const nextMessage = (c: SpreeWeClient, conversationId: string, ms = 8000) => new Promise<ChatMessage | null>((resolve) => {
        const timer = setTimeout(() => { off(); resolve(null); }, ms);
        const off = c.onMessage((m) => {
            if (m.conversationId !== conversationId) return;
            clearTimeout(timer);
            off();
            resolve(m);
        });
    });

    beforeAll(async () => {
        server = await startSocketServer();
    });

    afterAll(async () => {
        clients.forEach((c) => c.disconnect());
        await server.close();
        globalThis.fetch = realFetch;
    });

    it("personal: connect → E2EE device → direct conversation → encrypted send → live receive → decrypt → history", async () => {
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        const alice = client({ user: u });
        const bob = client({ user: v });
        expect((await alice.connect())._id).toBe(String(u._id));
        await bob.connect();
        expect(alice.deviceId).toMatch(/^[A-Z0-9]{10}$/);

        const conversationId = await alice.openDirect(String(v._id));
        // Bob isn't in the room yet (the server lists a conversation once it has a message): he still
        // gets the first message as a member (delivered to the user), then lists it
        await sleep(200);

        const marker = uniq("secret-");
        const received = nextMessage(bob, conversationId);
        await alice.send(conversationId, `hello ${marker}`);
        const m = await received;
        expect(m).not.toBeNull();
        // The key may arrive just after the message: resolved through history once keys are synced
        let text = m!.state === "ok" ? m!.text : "";
        for (let i = 0; i < 10 && !text; i++) {
            await sleep(300);
            const h = await bob.history(conversationId);
            text = h.find((x) => x.id === m!.id && x.state === "ok")?.text || "";
        }
        expect(text).toBe(`hello ${marker}`);
        expect(m!.senderId).toBe(String(u._id));
        expect((await bob.listConversations()).map((c) => c.id)).toContain(conversationId);

        // The server stored only ciphertext
        const stored: any = await runAsSystem(() => Message.findById(m!.id).lean());
        expect(stored.e2ee?.ciphertext).toBeTruthy();
        expect(JSON.stringify(stored)).not.toContain(marker);

        // Reply the other way, and the sender reads both from history
        const back = nextMessage(alice, conversationId);
        await bob.send(conversationId, "hi back");
        expect(await back).not.toBeNull();
        let history: ChatMessage[] = [];
        for (let i = 0; i < 10; i++) {
            history = await alice.history(conversationId);
            if (history.filter((x) => x.state === "ok").length >= 2) break;
            await sleep(300);
        }
        expect(history.filter((x) => x.state === "ok").map((x) => x.text)).toEqual([`hello ${marker}`, "hi back"]);
    });

    it("organization workspace: members chat encrypted; the same users' personal clients don't see it", async () => {
        const org = newOrg();
        const [u, v] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: u, org });
        await enter({ user: v, org });
        const alice = client({ user: u, org });
        const bob = client({ user: v, org });
        await alice.connect();
        await bob.connect();
        const conversationId = await alice.openDirect(String(v._id));

        const received = nextMessage(bob, conversationId);
        await alice.send(conversationId, "workspace hello");
        const m = await received;
        expect(m).not.toBeNull();
        let text = m!.state === "ok" ? m!.text : "";
        for (let i = 0; i < 10 && !text; i++) {
            await sleep(300);
            text = (await bob.history(conversationId)).find((x) => x.id === m!.id && x.state === "ok")?.text || "";
        }
        expect(text).toBe("workspace hello");

        // Tenant isolation: the personal context lists no workspace conversation, and can't read it
        const personal = client({ user: v });
        await personal.connect();
        expect((await personal.listConversations()).map((c) => c.id)).not.toContain(conversationId);
        await expect(personal.history(conversationId)).rejects.toThrow();
    });
});
