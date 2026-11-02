import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SpreeWeApiError, SpreeWeServerClient } from "../../docs/integrations/examples/backend/spreewe-server-client";
import { SpreeWeBrowserClient } from "../../docs/integrations/examples/frontend/spreewe-browser-client";
import { addMessage, api, makeUser, nextEvent, sleep, startSocketServer, uniq, enc, plainOf } from "./helpers";

// The published examples, run against a real (in-process) SpreeWe server over HTTP + Socket.IO
describe("developer examples work end to end", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    beforeAll(async () => {
        server = await startSocketServer();
    });
    afterAll(async () => {
        await server.close();
    });

    it("backend exchange → browser REST + realtime, with no credential in the browser client", async () => {
        const [owner, alice, bob] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        const name = uniq("Example");
        const app = (await api({ user: owner }).post("/v1/apps").send({ name, environment: "development", callbackUrls: ["https://yourapp.example.com/spreewe/callback"], scopes: ["profile:read", "conversations:read", "realtime:connect", "messages:read", "messages:write"] })).body.data;
        const cred = (await api({ user: owner }).post(`/v1/apps/${app._id}/credentials`).send({ confirm: name })).body.data;
        const base = `http://localhost:${server.port}`;
        const backend = new SpreeWeServerClient(base, cred.credential.keyId, cred.secret);

        // Before consent the backend gets a clear 403
        await expect(backend.userToken(`yourapp-user-${alice._id}`)).rejects.toBeInstanceOf(SpreeWeApiError);
        // Consent flow: YOUR backend starts it (credential), the user approves in SpreeWe, SpreeWe redirects back with state
        const scopes = ["profile:read", "conversations:read", "realtime:connect", "messages:read", "messages:write"];
        const { consentUrl } = await backend.startConsent(`yourapp-user-${alice._id}`, scopes, "https://yourapp.example.com/spreewe/callback", "csrf-state-abc123");
        const requestId = new URL(consentUrl, "https://spreewe.example.com").searchParams.get("request")!;
        const approved = await api({ user: alice }).post(`/v1/consent-requests/${requestId}/approve`).send({ scopes });
        expect(approved.body.data.redirectUrl).toMatch(/^https:\/\/yourapp\.example\.com\/spreewe\/callback\?state=csrf-state-abc123&result=approved/);

        // The browser client only knows how to ask "your backend" for a token
        const browser = new SpreeWeBrowserClient(base, base, async () => {
            const t = await backend.userToken(`yourapp-user-${alice._id}`);
            return { accessToken: t.accessToken, expiresAt: t.expiresAt };
        });
        expect(JSON.stringify(browser)).not.toContain(cred.secret);
        const me = await browser.get("/v1/me");
        expect(me.data.user._id).toBe(String(alice._id));

        const conv = (await api({ user: alice }).post("/conversations").send({ receiverId: String(bob._id) })).body;
        const conversationId = String(conv.conversationId); // POST /conversations answers { conversationId }
        await addMessage(conversationId, bob, "hello example");
        expect(JSON.stringify((await browser.get("/v1/conversations")).data)).toContain(conversationId);

        const received: any[] = [];
        await browser.connect((m) => received.push(m));
        const { connect } = await import("./helpers");
        const bobSock = await connect(server.port, { user: bob });
        await sleep(200);
        // End-to-end encryption: the app gets a notice that a message arrived, never its content
        bobSock.emit("sendMessage", { user: { _id: String(bob._id) }, conversationId, e2ee: enc("reply"), type: "text" });
        await sleep(800);
        expect(received.some((m) => m?.encrypted === true && m?.e2ee === undefined && m?.content === null)).toBe(true);
        expect(JSON.stringify(received)).not.toContain(enc("reply").ciphertext);
        browser.close();
        bobSock.disconnect();

        // Sign-out: the backend revokes the token
        const t = await backend.userToken(`yourapp-user-${alice._id}`);
        await backend.revoke(t.accessToken);
        const res = await fetch(`${base}/v1/me`, { headers: { Authorization: `Bearer ${t.accessToken}` } });
        expect(res.status).toBe(401);
    });
});
