import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCOPES, backendTokenProvider, isSpreeWeError, type SpreeWeClient } from "@spreewe/core";
import { enableE2ee } from "@spreewe/e2ee";
import { getChat } from "@spreewe/chat";
import { getFiles, type FileItem } from "@spreewe/files";
import { appClient, clientFor, eventually, grant, makeUser, registerApp, serverExchange, startSocketServer, type Session, type TestApp } from "./support";

/**
 * @spreewe/files against the real backend: end-to-end encrypted attachments sent through
 * @spreewe/chat, then listed with GET /files and GET /conversations/:id/media, named by decrypting
 * their message on the recipient's device, downloaded and decrypted; plus apps that can't decrypt,
 * missing scopes, kind filters, live refresh and deletes.
 */
let server: { port: number; close: () => Promise<void> };
let base: string;
let alice: Session, bob: Session, owner: Session;
let full: TestApp, readOnly: TestApp;
const clients: SpreeWeClient[] = [];
const track = (c: SpreeWeClient) => (clients.push(c), c);
const ALL = [...SCOPES];
const WITHOUT_E2EE = ALL.filter((s) => !["e2ee:device", "messages:write", "messages:edit"].includes(s));

let a: SpreeWeClient, b: SpreeWeClient, conversationId: string;
let aliceId: string, bobId: string;

const TEXT = "quarterly numbers " + Date.now();
// 1×1 transparent PNG
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="), (c) => c.charCodeAt(0));

beforeAll(async () => {
    server = await startSocketServer();
    base = `http://localhost:${server.port}`;
    [alice, bob, owner] = (await Promise.all([makeUser(), makeUser(), makeUser()])).map((user) => ({ user }));
    aliceId = String(alice.user._id);
    bobId = String(bob.user._id);
    const quotas = { environment: "production", callbackUrls: ["https://app.example.com/oauth/callback"], quotas: { rateLimitPerMinute: 6000, messagesPerDay: 100000 } };
    full = await registerApp(owner, ALL, quotas);
    readOnly = await registerApp(owner, WITHOUT_E2EE, quotas);
    for (const u of [alice, bob]) {
        await grant(u, full, ALL);
        await grant(u, readOnly, WITHOUT_E2EE);
    }

    a = track(appClient(base, full, aliceId));
    b = track(appClient(base, full, bobId));
    enableE2ee(a, { storage: "memory" });
    enableE2ee(b, { storage: "memory" });
    conversationId = await getChat(a).openDirect(bobId);
    await Promise.all([getChat(a).start(), getChat(b).start()]);
    await Promise.all([getChat(a).e2ee!.start(), getChat(b).e2ee!.start()]);

    // Alice sends two encrypted attachments; wait until Bob's device has decrypted them in chat
    const sa = getChat(a).open(conversationId);
    const sb = getChat(b).open(conversationId);
    await eventually(() => expect(sb.messages.value.loading).toBe(false));
    await sa.sendFile(new File([TEXT], "numbers.txt", { type: "text/plain" }), { caption: "for the meeting" });
    await sa.sendFile(new File([PNG], "pixel.png", { type: "image/png" }));
    await eventually(() => {
        const names = sb.messages.value.items.map((m) => m.attachment?.name);
        expect(names).toEqual(expect.arrayContaining(["numbers.txt", "pixel.png"]));
    }, 15_000);
    sa.release();
    sb.release();
});

afterAll(async () => {
    clients.forEach((c) => c.destroy());
    await server?.close();
});

function find(items: FileItem[], name: string): FileItem | undefined {
    return items.find((i) => i.name === name);
}

describe("files service with an encryption device", () => {
    it("lists the user's files (GET /files) and decrypts names, types and captions on this device", async () => {
        const lib = getFiles(b).library();
        await lib.load();
        const doc = await eventually(() => {
            const hit = find(lib.state.value.items, "numbers.txt");
            expect(hit?.state).toBe("ok");
            return hit!;
        });
        expect(doc.encrypted).toBe(true);
        expect(doc.kind).toBe("file");
        expect(doc.mimeType).toBe("text/plain");
        expect(doc.caption).toBe("for the meeting");
        expect(doc.size).toBe(new TextEncoder().encode(TEXT).length);
        expect(doc.conversationId).toBe(conversationId);
        expect(doc.senderId).toBe(aliceId);
        expect(doc.sender?.username).toBeTruthy();
        expect(doc.conversationTitle).toBeTruthy();
        expect(doc.secure?.key).toBeTruthy();
        const img = find(lib.state.value.items, "pixel.png");
        expect(img?.kind).toBe("image");
        expect(img?.state).toBe("ok");
    });

    it("downloads and decrypts a file (integrity-checked)", async () => {
        const files = getFiles(b);
        const doc = find(files.library().state.value.items, "numbers.txt")!;
        const blob = await files.download(doc);
        expect(blob.type).toBe("text/plain");
        expect(await blob.text()).toBe(TEXT);
    });

    it("filters by kind on the server", async () => {
        const files = getFiles(b);
        const images = files.library("image");
        await images.load();
        await eventually(() => expect(find(images.state.value.items, "pixel.png")?.state).toBe("ok"));
        expect(images.state.value.items.every((i) => i.kind === "image")).toBe(true);
        const docs = files.library("file");
        await docs.load();
        await eventually(() => expect(find(docs.state.value.items, "numbers.txt")?.state).toBe("ok"));
        expect(docs.state.value.items.some((i) => i.kind === "image")).toBe(false);
    });

    it("lists a conversation's shared media (with ciphertext) and previews images as decrypted object URLs", async () => {
        const files = getFiles(b);
        const media = files.conversation(conversationId);
        await media.load();
        const img = await eventually(() => {
            const hit = find(media.state.value.items, "pixel.png");
            expect(hit?.state).toBe("ok");
            return hit!;
        });
        expect(img.mimeType).toBe("image/png");
        expect(find(media.state.value.items, "numbers.txt")?.state).toBe("ok");
        const url = await files.preview(img);
        expect(url).toMatch(/^blob:/);
        const bytes = new Uint8Array(await (await fetch(url!)).arrayBuffer());
        expect([...bytes]).toEqual([...PNG]);
        // Cached
        expect(await files.preview(img)).toBe(url);
        expect(await files.preview(find(media.state.value.items, "numbers.txt")!)).toBeNull();
        files.releasePreviews();
    });

    it("the sender's own device decrypts its attachments too", async () => {
        const lib = getFiles(a).library();
        await lib.load();
        await eventually(() => expect(find(lib.state.value.items, "numbers.txt")?.state).toBe("ok"));
    });

    it("a new attachment refreshes a loaded conversation list live; a deleted message leaves it", async () => {
        const files = getFiles(b);
        const media = files.conversation(conversationId);
        await media.load();
        const sa = getChat(a).open(conversationId);
        await eventually(() => expect(sa.messages.value.loading).toBe(false));
        await sa.sendFile(new File(["live " + Date.now()], "live.txt", { type: "text/plain" }));
        const item = await eventually(() => {
            const hit = find(media.state.value.items, "live.txt");
            expect(hit?.state).toBe("ok");
            return hit!;
        }, 10_000);
        await sa.delete(item.id);
        await eventually(() => expect(media.state.value.items.some((i) => i.id === item.id)).toBe(false));
        sa.release();
    });
});

describe("files service without the ability to decrypt", () => {
    it("an app without e2ee:device lists encrypted files as withheld and can't download them", async () => {
        const ro = track(appClient(base, readOnly, bobId));
        const files = getFiles(ro);
        const lib = files.library();
        await lib.load();
        const items = await eventually(() => {
            const enc = lib.state.value.items.filter((i) => i.encrypted);
            expect(enc.length).toBeGreaterThanOrEqual(2);
            expect(enc.every((i) => i.state === "withheld")).toBe(true);
            return enc;
        });
        for (const i of items) {
            expect(i.name).toBe("");
            expect(i.secure).toBeUndefined();
        }
        const err = await files.download(items[0]).catch((e) => e);
        expect(isSpreeWeError(err, "E2EE_UNAVAILABLE")).toBe(true);

        // The media list: the server strips the ciphertext for this app
        const media = files.conversation(conversationId);
        await media.load();
        await eventually(() => expect(media.state.value.items.filter((i) => i.encrypted).every((i) => i.state === "withheld")).toBe(true));
    });

    it("a client with e2ee:device but no encryption device enabled shows them as locked", async () => {
        const c = track(appClient(base, full, bobId));
        const files = getFiles(c);
        const lib = files.library();
        await lib.load();
        const enc = await eventually(() => {
            const list = lib.state.value.items.filter((i) => i.encrypted);
            expect(list.length).toBeGreaterThanOrEqual(2);
            expect(list.every((i) => i.state === "locked")).toBe(true);
            return list;
        });
        const err = await files.download(enc[0]).catch((e) => e);
        expect(isSpreeWeError(err, "E2EE_UNAVAILABLE")).toBe(true);
    });

    it("without files:read the lists fail with a 403 naming the scope", async () => {
        const c = track(clientFor(base, backendTokenProvider({ fetchToken: serverExchange(base, full, bobId, { scopes: ["profile:read"] }) })));
        const files = getFiles(c);
        const lib = files.library();
        const err = await lib.load().catch((e) => e);
        expect(isSpreeWeError(err)).toBe(true);
        expect(err.status).toBe(403);
        expect(err.message).toContain("files:read");
        expect(lib.state.value.error).toBe(err);
        const mediaErr = await files.conversation(conversationId).load().catch((e) => e);
        expect(mediaErr.status).toBe(403);
    });
});
