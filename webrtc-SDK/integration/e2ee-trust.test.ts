import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCOPES, backendTokenProvider, type SpreeWeClient } from "@spreewe/core";
import { createServerClient, type SpreeWeServerClient } from "@spreewe/core/server";
import { enableE2ee } from "@spreewe/e2ee";
import { getChat } from "@spreewe/chat";
import { clientFor, eventually, makeUser, registerApp, startSocketServer } from "./support";

let server: { port: number; close: () => Promise<void> };
let base: string;
let backend: SpreeWeServerClient;
const clients: SpreeWeClient[] = [];
const ids: Record<string, string> = {};

function browser(ext: string): SpreeWeClient {
    const c = clientFor(base, backendTokenProvider({ fetchToken: () => backend.userToken(ext, { forceRefresh: true }) }));
    clients.push(c);
    enableE2ee(c, { storage: "memory" });
    return c;
}

beforeAll(async () => {
    server = await startSocketServer();
    base = `http://localhost:${server.port}`;
    const app = await registerApp({ user: await makeUser() }, [...SCOPES], { environment: "production", callbackUrls: [], quotas: { rateLimitPerMinute: 6000, messagesPerDay: 100000 } }, { dedicated: true });
    backend = createServerClient({ baseUrl: base, keyId: app.keyId, secret: app.secret });
    for (const n of ["alice", "bob", "carol", "dave"]) ids[n] = (await backend.users.register({ externalUserId: n, name: `User ${n}` }))._id;
});
afterAll(async () => { clients.forEach((c) => c.destroy()); await server?.close(); });

const view = (c: SpreeWeClient, conv: string) => getChat(c).open(conv);

const rows = (s: any) => s.messages.value.items.filter((m: any) => m.type !== "system").map((m: any) => ({ t: m.text, s: m.bodyState, w: m.warning }));

describe("E2EE message trust and late first devices", () => {
    it("no 'unverified device' warning between ordinary devices", async () => {
        const [a, b] = [browser("alice"), browser("bob")];
        const conv = await getChat(a).openDirect(ids.bob);
        await Promise.all([getChat(a).start(), getChat(b).start()]);
        await Promise.all([getChat(a).e2ee!.start(), getChat(b).e2ee!.start()]);
        const [sa, sb] = [view(a, conv), view(b, conv)];
        await eventually(() => expect(sb.messages.value.loading).toBe(false));
        await sa.send("s1 hello");
        await eventually(() => expect(rows(sb)).toContainEqual({ t: "s1 hello", s: "ok", w: undefined }), 10000);
        await eventually(() => expect(rows(sa).find((r: any) => r.t === "s1 hello")?.w).toBeUndefined(), 10000);
    });

    it("a message sent before the recipient had any device becomes readable on their first device", async () => {
        const a = browser("carol");
        const conv = await getChat(a).openDirect(ids.dave);
        await getChat(a).start();
        await getChat(a).e2ee!.start();
        const sa = view(a, conv);
        await eventually(() => expect(sa.messages.value.loading).toBe(false));
        await sa.send("sent before dave had a device");
        const b = browser("dave");
        await getChat(b).start();
        await getChat(b).e2ee!.start();
        const sb = view(b, conv);
        await eventually(() => expect(rows(sb)).toContainEqual({ t: "sent before dave had a device", s: "ok", w: undefined }), 15000);

        // A SECOND device of dave doesn't get that history: clear message, not endless waiting
        const b2 = browser("dave");
        await getChat(b2).start();
        await getChat(b2).e2ee!.start();
        const sb2 = view(b2, conv);
        await eventually(() => {
            const r = rows(sb2);
            expect(r.length).toBeGreaterThan(0);
            expect(r[0].s).toBe("failed");
            expect(r[0].w).toMatch(/before this device was set up/);
        }, 15000);
    });
});
