import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCOPES, SpreeWeError, backendTokenProvider, isSpreeWeError, type SpreeWeClient } from "@spreewe/core";
import { enableE2ee } from "@spreewe/e2ee";
import { getChat } from "@spreewe/chat";
import { appClient, clientFor, eventually, grant, makeUser, registerApp, serverExchange, startSocketServer, type Session, type TestApp } from "./support";

/**
 * @spreewe/core + @spreewe/e2ee + @spreewe/chat against the real backend: token exchange, REST
 * envelopes and errors, Socket.IO handshake and room re-join, and end-to-end encrypted messaging
 * between two app devices (real Olm / Megolm).
 */
let server: { port: number; close: () => Promise<void> };
let base: string;
let alice: Session, bob: Session, owner: Session;
let full: TestApp, readOnly: TestApp;
const clients: SpreeWeClient[] = [];
const track = (c: SpreeWeClient) => (clients.push(c), c);

const ALL = [...SCOPES];
const WITHOUT_E2EE = ALL.filter((s) => !["e2ee:device", "messages:write", "messages:edit"].includes(s));

beforeAll(async () => {
    server = await startSocketServer();
    base = `http://localhost:${server.port}`;
    [alice, bob, owner] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
    // Production apps may raise the per-app request quota (development apps: at most 120/min, shared by all users)
    const quotas = { environment: "production", callbackUrls: ["https://app.example.com/oauth/callback"], quotas: { rateLimitPerMinute: 6000, messagesPerDay: 100000 } };
    full = await registerApp(owner, ALL, quotas);
    readOnly = await registerApp(owner, WITHOUT_E2EE, quotas);
    for (const u of [alice, bob]) {
        await grant(u, full, ALL);
        await grant(u, readOnly, WITHOUT_E2EE);
    }
});

afterAll(async () => {
    clients.forEach((c) => c.destroy());
    await server?.close();
});

describe("core: auth, REST, errors", () => {
    it("exchanges a token through the provider and loads /v1/me, with and without the /api prefix", async () => {
        for (const prefix of ["", "/api"]) {
            const c = track(appClient(`${base}${prefix}`, full, String(alice.user._id)));
            const me = await c.loadMe();
            expect(me.user._id).toBe(String(alice.user._id));
            expect(await c.hasScopes("messages:read", "e2ee:device")).toBe(true);
        }
    });

    it("reports the token's scopes", async () => {
        const c = track(appClient(base, readOnly, String(alice.user._id)));
        const scopes = await c.scopes();
        expect(scopes?.has("messages:read")).toBe(true);
        expect(scopes?.has("e2ee:device")).toBe(false);
    });

    it("maps /v1 and session-route errors to SpreeWeError", async () => {
        const c = track(appClient(base, full, String(alice.user._id)));
        const v1 = await c.http.get("/v1/conversations/not-an-id/messages").catch((e) => e);
        expect(isSpreeWeError(v1)).toBe(true);
        expect((v1 as SpreeWeError).status).toBe(400);
        expect((v1 as SpreeWeError).code).toBe("VALIDATION_ERROR");
        const legacy = await c.http.get("/conversations/65a1b2c3d4e5f60718293a4b/group").catch((e) => e);
        expect(isSpreeWeError(legacy)).toBe(true);
        expect([403, 404]).toContain((legacy as SpreeWeError).status);
    });

    it("retries once with a force-refreshed token after a 401", async () => {
        const exchange = serverExchange(base, full, String(alice.user._id));
        let calls = 0;
        const provider = backendTokenProvider({
            fetchToken: async () => {
                calls++;
                // First token is garbage (as if revoked): the client must recover by itself
                return calls === 1 ? { accessToken: "x.y.z", expiresIn: 600 } : exchange();
            },
        });
        const c = track(clientFor(base, provider));
        const me = await c.loadMe();
        expect(me.user._id).toBe(String(alice.user._id));
        expect(calls).toBe(2);
    });

    it("lists the directory as a cursor page", async () => {
        const c = track(appClient(base, full, String(alice.user._id)));
        const page = await c.people.directory({ limit: 5 });
        expect(Array.isArray(page.items)).toBe(true);
        expect(page).toHaveProperty("nextCursor");
    });
});

describe("realtime", () => {
    it("connects with an app token and re-joins rooms after a reconnect", async () => {
        // Sender without e2ee:device: typing from apps WITH it is dropped by the server (known issue below)
        const a = track(appClient(base, readOnly, String(alice.user._id)));
        const b = track(appClient(base, full, String(bob.user._id)));
        const conversationId = await getChat(a).openDirect(String(bob.user._id));
        await Promise.all([a.realtime.connect(), b.realtime.connect()]);
        expect(a.realtime.state.value).toBe("connected");
        a.realtime.joinConversation(conversationId);
        b.realtime.joinConversation(conversationId);

        const typing: string[] = [];
        b.realtime.on<{ userId: string; isTyping: boolean }>("userTyping", (t) => t.isTyping && typing.push(t.userId));
        await eventually(() => {
            a.realtime.emit("typing", conversationId);
            expect(typing).toContain(String(alice.user._id));
        });

        // Drop B's transport: Socket.IO reconnects and the client re-joins the room by itself
        (b.realtime as any).socket.io.engine.close();
        await eventually(() => expect(b.realtime.state.value).toBe("reconnecting"), 3000, 5).catch(() => undefined);
        await eventually(() => expect(b.realtime.connected).toBe(true));
        typing.length = 0;
        await eventually(() => {
            a.realtime.emit("typing", conversationId);
            expect(typing).toContain(String(alice.user._id));
        });
    });

    it("refuses a handshake without realtime:connect with a fatal MISSING_SCOPE error", async () => {
        const narrow = track(
            clientFor(base, backendTokenProvider({ fetchToken: serverExchange(base, full, String(alice.user._id), { scopes: ["profile:read"] }) })),
        );
        const err = await narrow.realtime.connect().catch((e) => e);
        expect(isSpreeWeError(err, "MISSING_SCOPE")).toBe(true);
        expect(narrow.realtime.state.value).toBe("failed");
    });

    it("rejects acks the server answers with { error } and times out refused events", async () => {
        const c = track(appClient(base, full, String(alice.user._id)));
        await c.realtime.connect();
        const refused = await c.realtime.request("chat:archive", { conversationId: "65a1b2c3d4e5f60718293a4b" }).catch((e) => e);
        expect(isSpreeWeError(refused, "SOCKET_REFUSED")).toBe(true);
        const ro = track(appClient(base, readOnly, String(alice.user._id)));
        await ro.realtime.connect();
        // Not in the app's scopes: the server never acks it
        const timeout = await ro.realtime.request("message:edit", { messageId: "x" }, { timeoutMs: 800 }).catch((e) => e);
        expect(isSpreeWeError(timeout, "ACK_TIMEOUT")).toBe(true);
    });
});

describe("chat with end-to-end encryption (two app devices)", () => {
    let a: SpreeWeClient, b: SpreeWeClient, conversationId: string;

    beforeAll(async () => {
        a = track(appClient(base, full, String(alice.user._id)));
        b = track(appClient(base, full, String(bob.user._id)));
        enableE2ee(a, { storage: "memory" });
        enableE2ee(b, { storage: "memory" });
        conversationId = await getChat(a).openDirect(String(bob.user._id));
        await Promise.all([getChat(a).start(), getChat(b).start()]);
        const devA = getChat(a).e2ee!;
        const devB = getChat(b).e2ee!;
        await Promise.all([devA.start(), devB.start()]);
        expect(devA.status.value).toBe("ready");
        expect(devB.status.value).toBe("ready");
    });

    it("sends an encrypted message that the other device decrypts; the sender's copy is confirmed", async () => {
        const sa = getChat(a).open(conversationId);
        const sb = getChat(b).open(conversationId);
        await eventually(() => expect(sa.messages.value.loading).toBe(false));
        await eventually(() => expect(sb.messages.value.loading).toBe(false));

        await sa.send("hello bob, this is encrypted");
        const got = await eventually(() => {
            const m = sb.messages.value.items.find((x) => x.text === "hello bob, this is encrypted");
            expect(m?.bodyState).toBe("ok");
            return m!;
        });
        expect(got.userId).toBe(String(alice.user._id));
        expect(got.content).toBe("");
        expect(got.e2ee?.algorithm).toBe("m.megolm.v1.aes-sha2");
        await eventually(() => {
            const mine = sa.messages.value.items.filter((x) => x.text === "hello bob, this is encrypted");
            expect(mine).toHaveLength(1);
            expect(mine[0].local).toBeUndefined();
        });
        sa.release();
        sb.release();
    });

    it("history is decrypted when a conversation is opened later; the list preview is decrypted", async () => {
        const chatB = getChat(b);
        await chatB.loadConversations({ refresh: true });
        await eventually(() => {
            const c = chatB.findConversation(conversationId);
            expect(c?.preview).toBe("hello bob, this is encrypted");
        });
        const sb = chatB.open(conversationId);
        await eventually(() => expect(sb.messages.value.items.some((m) => m.text === "hello bob, this is encrypted" && m.bodyState === "ok")).toBe(true));
        sb.release();
    });

    it("reactions, edits, typing and deletes reach the other side", async () => {
        const sa = getChat(a).open(conversationId);
        const sb = getChat(b).open(conversationId);
        await eventually(() => expect(sb.messages.value.loading).toBe(false));
        await sb.send("reply from bob");
        const msg = await eventually(() => {
            const m = sa.messages.value.items.find((x) => x.text === "reply from bob" && !x.local);
            expect(m).toBeTruthy();
            return m!;
        });

        sa.react(msg._id, "👍");
        await eventually(() => expect(sb.messages.value.items.find((x) => x._id === msg._id)?.reactions?.some((r) => r.emoji === "👍")).toBe(true));

        await sb.edit(msg._id, "reply from bob (edited)");
        await eventually(() => {
            const m = sa.messages.value.items.find((x) => x._id === msg._id);
            expect(m?.text).toBe("reply from bob (edited)");
            expect(m?.editedAt).toBeTruthy();
        });

        await sb.delete(msg._id);
        await eventually(() => expect(sa.messages.value.items.find((x) => x._id === msg._id)?.isDeleted).toBe(true));
        sa.release();
        sb.release();
    });

    it("typing from an app without e2ee:device reaches an e2ee app's session", async () => {
        const ro = track(appClient(base, readOnly, String(bob.user._id)));
        const sro = getChat(ro).open(conversationId);
        const sa = getChat(a).open(conversationId);
        await eventually(() => expect(sro.messages.value.loading).toBe(false));
        await eventually(() => expect(sa.messages.value.loading).toBe(false));
        await eventually(() => {
            sro.typingStarted();
            expect(sa.typing.value).toContain(String(bob.user._id));
        });
        sro.stopTyping();
        await eventually(() => expect(sa.typing.value).not.toContain(String(bob.user._id)));
        sro.release();
        sa.release();
    });

    // KNOWN BACKEND ISSUE (webrtc-BE/src/realtime/gateways/chat.gateway.ts:31): apps holding messages:read
    // AND e2ee:device join the "messages:read+e2ee" room shadow, but the typing handler only accepts the
    // "messages:read" shadow, so their typing events are dropped. it.fails turns red once the server is fixed.
    it.fails("typing from an app WITH e2ee:device reaches the other side (fails until the backend is fixed)", async () => {
        const sa = getChat(a).open(conversationId);
        const sb = getChat(b).open(conversationId);
        await eventually(() => expect(sa.messages.value.loading).toBe(false));
        try {
            await eventually(() => {
                sb.typingStarted();
                expect(sa.typing.value).toContain(String(bob.user._id));
            }, 2500);
        } finally {
            sb.stopTyping();
            sa.release();
            sb.release();
        }
    });

    it("an app without e2ee:device sees that messages exist but never their content", async () => {
        const ro = track(appClient(base, readOnly, String(bob.user._id)));
        const chat = getChat(ro);
        await chat.loadConversations();
        const c = chat.findConversation(conversationId);
        expect(c?.previewState).toBe("withheld");
        const s = chat.open(conversationId);
        await eventually(() => expect(s.messages.value.loading).toBe(false));
        const encrypted = s.messages.value.items.filter((m) => m.type === "text");
        expect(encrypted.length).toBeGreaterThan(0);
        for (const m of encrypted) {
            expect(m.bodyState).toBe("withheld");
            expect(m.e2ee).toBeUndefined();
            expect(m.text).toBe("");
        }
        expect(chat.sendBlocker()?.reason).toBe("no-e2ee");
        s.release();
    });

    it("sends an encrypted attachment that the other device downloads and decrypts", async () => {
        const sa = getChat(a).open(conversationId);
        const sb = getChat(b).open(conversationId);
        await eventually(() => expect(sb.messages.value.loading).toBe(false));
        const bytes = new TextEncoder().encode("secret file contents " + Date.now());
        const file = new File([bytes], "notes.txt", { type: "text/plain" });
        await sa.sendFile(file, { caption: "see attached" });
        const m = await eventually(() => {
            const x = sb.messages.value.items.find((y) => y.attachment?.name === "notes.txt");
            expect(x?.text).toBe("see attached");
            return x!;
        });
        expect(m.attachment?.secure?.key).toBeTruthy();
        const loaded = await sb.loadAttachment(m._id);
        expect(loaded?.state, loaded?.error).toBe("ready");
        const text = await (await fetch(loaded!.url!)).text();
        expect(text).toBe(new TextDecoder().decode(bytes));
        sa.release();
        sb.release();
    });
});
