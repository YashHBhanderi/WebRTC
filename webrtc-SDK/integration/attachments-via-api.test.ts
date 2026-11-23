import { Readable } from "stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SCOPES, backendTokenProvider, type SpreeWeClient } from "@spreewe/core";
import { createServerClient, type SpreeWeServerClient } from "@spreewe/core/server";
import { enableE2ee } from "@spreewe/e2ee";
import { getChat } from "@spreewe/chat";
import { getFiles } from "@spreewe/files";
import storage from "../../webrtc-BE/src/services/storage.service";
import { clientFor, eventually, makeUser, registerApp, startSocketServer } from "./support";

/**
 * Attachments of a developer app's users go browser -> SpreeWe API -> bucket, and back the same way.
 * The bucket is replaced by an in-memory map; any direct browser request to it would fail the test.
 */
const bucket = new Map<string, Buffer>();
const meta = new Map<string, { contentType: string; metadata: Record<string, string> }>();
let server: { port: number; close: () => Promise<void> };
let base: string;
let backend: SpreeWeServerClient;
const clients: SpreeWeClient[] = [];
const ids: Record<string, string> = {};
const realFetch = globalThis.fetch;
const bucketHits: string[] = [];

function browser(ext: string): SpreeWeClient {
    const c = clientFor(base, backendTokenProvider({ fetchToken: () => backend.userToken(ext, { forceRefresh: true }) }));
    clients.push(c);
    enableE2ee(c, { storage: "memory" });
    return c;
}

beforeAll(async () => {
    vi.spyOn(storage, "put").mockImplementation(async (input: any) => {
        const chunks: Buffer[] = [];
        if (Buffer.isBuffer(input.body)) chunks.push(input.body);
        else for await (const c of input.body) chunks.push(Buffer.from(c));
        bucket.set(input.key, Buffer.concat(chunks));
        meta.set(input.key, { contentType: input.contentType, metadata: input.metadata || {} });
    });
    vi.spyOn(storage, "head").mockImplementation((async (key: string) => (bucket.has(key) ? { size: bucket.get(key)!.length, ...meta.get(key)! } : null)) as any);
    vi.spyOn(storage, "signedGetUrl").mockImplementation(async (key: string) => `https://bucket.invalid/${key}?signed`);
    vi.spyOn(storage, "openStream").mockImplementation(async (key: string) => {
        const b = bucket.get(key);
        if (!b) throw Object.assign(new Error("missing"), { status: 404 });
        return { body: Readable.from([b]), length: b.length };
    });
    globalThis.fetch = (async (input: any, init?: any) => {
        const url = String(input?.url || input);
        if (url.startsWith("https://bucket.invalid/")) {
            bucketHits.push(url);
            throw new TypeError("Failed to fetch (bucket is closed to browsers)");
        }
        return realFetch(input, init);
    }) as any;
    server = await startSocketServer();
    base = `http://localhost:${server.port}`;
    const app = await registerApp({ user: await makeUser() }, [...SCOPES], { environment: "production", callbackUrls: [], quotas: { rateLimitPerMinute: 6000, messagesPerDay: 100000 } }, { dedicated: true });
    backend = createServerClient({ baseUrl: base, keyId: app.keyId, secret: app.secret });
    for (const n of ["ann", "ben"]) ids[n] = (await backend.users.register({ externalUserId: n, name: `User ${n}` }))._id;
});
afterAll(async () => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
    clients.forEach((c) => c.destroy());
    await server?.close();
});

describe("attachments through the SpreeWe API", () => {
    it("upload, then download + decrypt in chat and in the files list, without touching the bucket from the client", async () => {
        const [a, b] = [browser("ann"), browser("ben")];
        const conv = await getChat(a).openDirect(ids.ben);
        await Promise.all([getChat(a).start(), getChat(b).start()]);
        await Promise.all([getChat(a).e2ee!.start(), getChat(b).e2ee!.start()]);
        const [sa, sb] = [getChat(a).open(conv), getChat(b).open(conv)];
        await eventually(() => expect(sb.messages.value.loading).toBe(false));

        const original = "hello attachment " + "x".repeat(2000);
        await sa.sendFile(new File([original], "notes.txt", { type: "text/plain" }));
        expect(bucket.size).toBe(1);
        expect([...bucket.values()][0].toString()).not.toContain("hello attachment"); // ciphertext at rest

        const m = await eventually(() => {
            const x = sb.messages.value.items.find((i: any) => i.attachment);
            expect(x?.attachment?.secure).toBeTruthy();
            return x!;
        }, 10000);
        const view = await sb.loadAttachment(m._id);
        expect(view?.state).toBe("ready");
        expect(await (await realFetch(view!.url!)).text()).toBe(original);

        const files = getFiles(b);
        const list = files.conversation(conv);
        await list.refresh();
        const item = await eventually(() => {
            const it = list.state.value.items.find((i: any) => i.id === m._id);
            expect(it?.state).toBe("ok");
            return it!;
        }, 10000);
        const blob = await files.download(item);
        expect(await blob.text()).toBe(original);

        expect(bucketHits).toEqual([]);
    });
});
