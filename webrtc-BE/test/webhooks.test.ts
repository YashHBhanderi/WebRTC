import http from "http";
import { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Socket } from "socket.io-client";
import { BlockedDestinationError, isPublicAddress, parseDestination, setWebhookNetworkForTests, validateDestination } from "../src/webhooks/ssrf";
import { postWebhook } from "../src/webhooks/sender";
import { sign, verifySignature } from "../src/webhooks/crypto";
import { backoffMs, runWebhookWorkerOnce } from "../src/webhooks/worker";
import { fanOut, forgetEndpointCache, messageCreatedData } from "../src/webhooks/events";
import { WebhookDelivery, WebhookEndpoint } from "../src/webhooks/models";
import { AppAuditEvent, DeveloperApp } from "../src/developer/models";
import { runAsSystem } from "../src/tenancy/context";
import { addMessage, api, connect, enter, makeUser, newOrg, Session, sleep, startSocketServer, testApp, uniq, enc, plainOf } from "./helpers";

const http2 = () => request(testApp());
const basic = (keyId: string, secret: string) => ({ Authorization: `Basic ${Buffer.from(`${keyId}:${secret}`).toString("base64")}` });

// ---------------------------------------------------------------- local receiver
interface Hit { headers: http.IncomingHttpHeaders; body: string; path: string }
let receiver: http.Server;
let port = 0;
let hits: Hit[] = [];
let mode: "ok" | "fail" | "redirect" | "hang" | "echo" = "ok";

beforeAll(async () => {
    receiver = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            hits.push({ headers: req.headers, body, path: req.url || "" });
            if (mode === "hang") return; // never answers
            if (mode === "redirect") { res.writeHead(302, { Location: `http://127.0.0.1:${port}/elsewhere` }); return res.end(); }
            if (mode === "fail") { res.writeHead(500); return res.end("boom"); }
            const parsed = JSON.parse(body || "{}");
            res.writeHead(200, { "content-type": "application/json" });
            res.end(parsed.type === "webhook.verification" ? JSON.stringify({ challenge: parsed.data.challenge }) : "{}");
        });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    port = (receiver.address() as AddressInfo).port;
    // receiver.test → 127.0.0.1 (test-only resolver + loopback + port allowance)
    setWebhookNetworkForTests({ resolver: async (h) => (h === "receiver.test" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]), allowLoopback: true, allowPorts: [port] });
});
afterAll(async () => {
    setWebhookNetworkForTests({ resolver: null, allowLoopback: false });
    await new Promise<void>((r) => receiver.close(() => r()));
});
afterEach(() => {
    mode = "ok";
});

// ---------------------------------------------------------------- SSRF
describe("SSRF protection", () => {
    it("message.created carries bounded text only", () => {
        expect(String(messageCreatedData({ _id: "m", conversationId: "c", type: "text", content: "a".repeat(5000) }).content).length).toBe(4000);
        expect(messageCreatedData({ _id: "m", conversationId: "c", type: "file", content: "https://bucket/secret.pdf" }).content).toBeNull();
    });

    it("rejects unsafe URLs, protocols, ports and every private / alternate IP form", () => {
        const bad = [
            "ftp://example.com/x", "file:///etc/passwd", "gopher://example.com", "https://user:pass@example.com/x", "https://example.com:22/x",
            "https://example.com/x#frag", "https://localhost/x", "https://api.localhost/x", "https://printer.local/x", "https://metadata.google.internal/x",
            "https://127.0.0.1/x", "https://2130706433/x", "https://0x7f.0.0.1/x", "https://0177.0.0.1/x", "https://127.1/x",
            "https://10.0.0.5/x", "https://172.16.4.4/x", "https://192.168.1.1/x", "https://100.64.0.1/x", "https://169.254.169.254/latest/meta-data",
            "https://0.0.0.0/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x", "https://[::ffff:7f00:1]/x", "https://[64:ff9b::7f00:1]/x",
            "https://[2002:7f00:1::]/x", "https://[fd00::1]/x", "https://[fe80::1]/x", "https://[::]/x", "https://224.0.0.1/x",
        ];
        for (const url of bad) expect(() => parseDestination(url, "production"), url).toThrow(BlockedDestinationError);
        expect(() => parseDestination("http://example.com/hook", "production")).toThrow(/https/);
        expect(parseDestination("http://example.com:8080/hook", "development").port).toBe(8080);
        expect(parseDestination("https://93.184.216.34/hook", "production").hostname).toBe("93.184.216.34");
        expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
        expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    });

    it("rejects host names that resolve (even partly) to private addresses", async () => {
        setWebhookNetworkForTests({ resolver: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }] });
        await expect(validateDestination("https://mixed.example.com/x", "production")).rejects.toThrow(/private/);
        setWebhookNetworkForTests({ resolver: async () => [{ address: "::ffff:169.254.169.254", family: 6 }] });
        await expect(validateDestination("https://sneaky.example.com/x", "production")).rejects.toThrow(/private/);
        setWebhookNetworkForTests({ resolver: async () => { throw new Error("nx"); } });
        await expect(validateDestination("https://nx.example.com/x", "production")).rejects.toThrow(/resolve/);
        setWebhookNetworkForTests({ resolver: async (h) => (h === "receiver.test" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]), allowLoopback: true, allowPorts: [port] });
    });

    it("DNS rebinding: a host that was public at configuration but resolves privately at delivery is not contacted", async () => {
        hits = [];
        setWebhookNetworkForTests({ resolver: async () => [{ address: "93.184.216.34", family: 4 }], allowPorts: [port] });
        await expect(validateDestination(`http://rebind.example.com:${port}/hook`, "development")).resolves.toBeTruthy();
        // …now the same name points at the loopback receiver (loopback NOT allowed here)
        setWebhookNetworkForTests({ resolver: async () => [{ address: "127.0.0.1", family: 4 }], allowLoopback: false, allowPorts: [port] });
        const result = await postWebhook(`http://rebind.example.com:${port}/hook`, "development", "{}", {});
        expect(result.error).toBe("blocked_destination");
        expect(hits.length).toBe(0);
        setWebhookNetworkForTests({ resolver: async (h) => (h === "receiver.test" ? [{ address: "127.0.0.1", family: 4 }] : [{ address: "93.184.216.34", family: 4 }]), allowLoopback: true, allowPorts: [port] });
    });

    it("never follows redirects, and times out slow endpoints", async () => {
        hits = [];
        mode = "redirect";
        const r = await postWebhook(`http://receiver.test:${port}/hook`, "development", "{}", {});
        expect(r.error).toBe("redirect_not_followed");
        expect(hits.map((h) => h.path)).toEqual(["/hook"]);
        mode = "hang";
        process.env.WEBHOOK_TIMEOUT_MS = "1000";
        const t = await postWebhook(`http://receiver.test:${port}/slow`, "development", "{}", {});
        delete process.env.WEBHOOK_TIMEOUT_MS;
        expect(t.error).toBe("timeout");
    });
});

// ---------------------------------------------------------------- signatures
describe("signatures and replay protection", () => {
    it("verifies v1 signatures, rejects tampering and stale timestamps, accepts any valid secret during rotation", () => {
        const now = Date.now();
        const ts = Math.floor(now / 1000);
        const body = JSON.stringify({ a: 1 });
        const sig = `v1=${sign("swh_old", "d1", ts, body)} v1=${sign("swh_new", "d1", ts, body)}`;
        const h = { id: "d1", timestamp: String(ts), signature: sig };
        expect(verifySignature("swh_new", h, body, 300, now)).toBe(true);
        expect(verifySignature("swh_old", h, body, 300, now)).toBe(true);
        expect(verifySignature("swh_other", h, body, 300, now)).toBe(false);
        expect(verifySignature("swh_new", h, body + " ", 300, now)).toBe(false);
        expect(verifySignature("swh_new", { ...h, id: "d2" }, body, 300, now)).toBe(false);
        expect(verifySignature("swh_new", h, body, 300, now + 10 * 60_000)).toBe(false);
    });

    it("backoff grows exponentially with jitter and is capped", () => {
        expect(backoffMs(1, 1)).toBe(30_000);
        expect(backoffMs(2, 1)).toBe(60_000);
        expect(backoffMs(1, 0)).toBe(15_000);
        expect(backoffMs(30, 1)).toBe(6 * 3600_000);
    });
});

// ---------------------------------------------------------------- end to end
async function setupApp(owner: Session, scopes: string[], extra: Record<string, unknown> = {}) {
    const name = uniq("Hook");
    const app = (await api(owner).post("/v1/apps").send({ name, environment: "development", scopes, callbackUrls: ["https://example.com/cb"], ...extra })).body.data;
    const cred = (await api(owner).post(`/v1/apps/${app._id}/credentials`).send({ confirm: name })).body.data;
    return { app, name, keyId: cred.credential.keyId as string, secret: cred.secret as string };
}

async function addEndpoint(owner: Session, app: any, name: string, events: string[]) {
    const res = await api(owner).post(`/v1/apps/${app._id}/webhooks`).send({ url: `http://receiver.test:${port}/hook`, events, confirm: name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const v = await api(owner).post(`/v1/apps/${app._id}/webhooks/${res.body.data.endpoint._id}/verify`).send({});
    expect(v.body.data.verified, JSON.stringify(v.body)).toBe(true);
    forgetEndpointCache();
    return { endpoint: res.body.data.endpoint, secret: res.body.data.secret as string };
}

const drain = async () => {
    for (let i = 0; i < 5; i++) {
        await sleep(50);
        if (!(await runWebhookWorkerOnce())) break;
    }
};

describe("outbound webhooks end to end", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    beforeAll(async () => {
        server = await startSocketServer();
    });
    afterAll(async () => {
        open.forEach((s) => s.disconnect());
        await server.close();
    });

    it("management: ownership, verification challenge, secret shown once, scope-gated events, caps, app tokens refused", async () => {
        const [owner, other, user] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        const reg = await setupApp({ user: owner }, ["profile:read", "messages:read"]);
        // event without the app scope
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks`).send({ url: `http://receiver.test:${port}/hook`, events: ["call.started"], confirm: reg.name })).status).toBe(403);
        // SSRF at configuration
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks`).send({ url: "https://169.254.169.254/latest", events: ["message.created"], confirm: reg.name })).status).toBe(400);
        hits = [];
        const created = await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks`).send({ url: `http://receiver.test:${port}/hook`, events: ["message.created"], confirm: reg.name });
        expect(created.body.data.endpoint.status).toBe("pending_verification");
        const secret = created.body.data.secret;
        expect(secret).toMatch(/^swh_/);
        const list = await api({ user: owner }).get(`/v1/apps/${reg.app._id}/webhooks`);
        expect(JSON.stringify(list.body)).not.toContain(secret);
        expect(JSON.stringify(list.body)).not.toContain("enc");
        // Verification: a challenge that doesn't come back fails; echo activates
        mode = "fail";
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks/${created.body.data.endpoint._id}/verify`).send({})).body.data.verified).toBe(false);
        mode = "ok";
        const v = await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks/${created.body.data.endpoint._id}/verify`).send({});
        expect(v.body.data.verified).toBe(true);
        const challengeHit = hits[hits.length - 1];
        expect(verifySignature(secret, { id: String(challengeHit.headers["spreewe-webhook-id"]), timestamp: String(challengeHit.headers["spreewe-webhook-timestamp"]), signature: String(challengeHit.headers["spreewe-webhook-signature"]) }, challengeHit.body)).toBe(true);
        // Not the owner → 404; app tokens → 403
        expect((await api({ user: other }).get(`/v1/apps/${reg.app._id}/webhooks`)).status).toBe(404);
        await api({ user }).post(`/v1/apps/${reg.app._id}/grants`).send({ scopes: ["profile:read"] });
        const tok = (await http2().post("/v1/app-tokens").set(basic(reg.keyId, reg.secret)).send({ userId: String(user._id) })).body.data.accessToken;
        expect((await http2().get(`/v1/apps/${reg.app._id}/webhooks`).set("Authorization", `Bearer ${tok}`)).status).toBe(403);
        // Cap: 5 endpoints
        for (let i = 0; i < 4; i++) await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks`).send({ url: `http://receiver.test:${port}/h${i}`, events: ["message.created"], confirm: reg.name });
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks`).send({ url: `http://receiver.test:${port}/h9`, events: ["message.created"], confirm: reg.name })).status).toBe(409);
    });

    it("message.created reaches only apps the user authorised, with minimal fields, without blocking chat", async () => {
        const [owner, alice, bob] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        const reg = await setupApp({ user: owner }, ["messages:read"]);
        const { secret } = await addEndpoint({ user: owner }, reg.app, reg.name, ["message.created"]);
        await api({ user: alice }).post(`/v1/apps/${reg.app._id}/grants`).send({ scopes: ["messages:read"] });
        const conv = String((await api({ user: alice }).post("/conversations").send({ receiverId: String(bob._id) })).body.conversationId);
        const bobSock = await connect(server.port, { user: bob });
        const aliceSock = await connect(server.port, { user: alice });
        open.push(bobSock, aliceSock);
        await sleep(200);
        hits = [];
        mode = "hang"; // the receiver hangs: chat must not be slowed down
        const started = Date.now();
        const got = new Promise<number>((resolve) => bobSock.once("receiveMessage", () => resolve(Date.now() - started)));
        aliceSock.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, e2ee: enc("hello webhook"), type: "text" });
        expect(await got).toBeLessThan(1500);
        mode = "ok";
        await sleep(200);
        await drain();
        const hit = hits.find((h) => h.path === "/hook" && h.body.includes("message.created"));
        expect(hit).toBeTruthy();
        // End-to-end encrypted: apps learn a message was posted, never its text or ciphertext
        expect(hit!.body).not.toContain("hello webhook");
        expect(hit!.body).not.toContain(enc("hello webhook").ciphertext);
        const body = JSON.parse(hit!.body);
        expect(verifySignature(secret, { id: String(hit!.headers["spreewe-webhook-id"]), timestamp: String(hit!.headers["spreewe-webhook-timestamp"]), signature: String(hit!.headers["spreewe-webhook-signature"]) }, hit!.body)).toBe(true);
        expect(body.audience.userIds).toEqual([String(alice._id)]); // bob didn't authorise the app
        expect(Object.keys(body.data).sort()).toEqual(["content", "conversationId", "createdAt", "encrypted", "messageId", "senderId", "type"]);
        expect(body.data).toMatchObject({ encrypted: true, content: null });
        expect(hit!.body).not.toMatch(/email|fileUrl|downloadUrl|token|sig=/);
        // Delivered once; payload purged after success
        const rows = await runAsSystem(() => WebhookDelivery.find({ appId: reg.app._id }).lean(), "test-inspection");
        expect(rows.filter((r) => r.status === "succeeded").every((r) => r.payload === null)).toBe(true);
    });

    it("tenant isolation: workspace apps get only their workspace's events; global apps never get workspace events; external = guests only", async () => {
        const org = newOrg();
        const [admin, member, outsider, guest] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);
        await enter({ user: admin, org, role: "org:admin" });
        await enter({ user: member, org });
        const wsApp = await setupApp({ user: admin, org, role: "org:admin" }, ["messages:read"], { tenantBound: true });
        const wsHook = await addEndpoint({ user: admin, org, role: "org:admin" }, wsApp.app, wsApp.name, ["message.created"]);
        const glApp = await setupApp({ user: member }, ["messages:read"]);
        const glHook = await addEndpoint({ user: member }, glApp.app, glApp.name, ["message.created"]);
        await api({ user: member, org }).post(`/v1/apps/${wsApp.app._id}/grants`).send({ scopes: ["messages:read"] });
        await api({ user: member }).post(`/v1/apps/${glApp.app._id}/grants`).send({ scopes: ["messages:read"] });
        await api({ user: guest }).post(`/v1/apps/${glApp.app._id}/grants`).send({ scopes: ["messages:read"] });

        const wsConv = String((await api({ user: member, org }).post("/conversations").send({ receiverId: String(admin._id) })).body.conversationId);
        const glConv = String((await api({ user: member }).post("/conversations").send({ receiverId: String(outsider._id) })).body.conversationId);
        await api({ user: admin, org, role: "org:admin" }).patch("/tenant/current/policies").send({ allowExternalChat: true });
        const extConv = (await api({ user: admin, org, role: "org:admin" }).post("/tenant/external-conversations").send({ userId: String(guest._id) })).body.data.conversationId;

        const deliveriesFor = async (endpointId: string, conversationId: string) => {
            const rows = await runAsSystem(() => WebhookDelivery.find({ endpointId }).lean(), "test-inspection");
            return rows.filter((r) => (r.payload || "").includes(conversationId) || r.status === "succeeded");
        };
        const msg = (c: string) => ({ _id: uniq("m"), conversationId: c, type: "text", content: "x", userId: String(member._id) });
        expect(await runAsSystem(() => fanOut({ type: "message.created", conversationId: wsConv, data: msg(wsConv) }), "test")).toBe(1);
        expect(await runAsSystem(() => fanOut({ type: "message.created", conversationId: glConv, data: msg(glConv) }), "test")).toBe(1);
        const wsRows = await deliveriesFor(wsHook.endpoint._id, wsConv);
        const glRows = await deliveriesFor(glHook.endpoint._id, glConv);
        expect(wsRows.length).toBe(1);
        expect(glRows.length).toBe(1);
        expect(JSON.stringify(await deliveriesFor(wsHook.endpoint._id, glConv))).not.toContain(glConv);
        expect(JSON.stringify(await deliveriesFor(glHook.endpoint._id, wsConv))).not.toContain(wsConv);
        // External chat hosted by the workspace: the workspace app sees it (host members), the global app only for the guest
        await runAsSystem(() => fanOut({ type: "message.created", conversationId: extConv, data: msg(extConv) }), "test");
        const glExt = (await runAsSystem(() => WebhookDelivery.find({ endpointId: glHook.endpoint._id }).lean(), "test-inspection")).find((r) => (r.payload || "").includes(extConv));
        expect(JSON.parse(glExt!.payload!).audience.userIds).toEqual([String(guest._id)]);
        // A removed member no longer generates events for the workspace app
        const Tenant = (await import("../src/models/tenantModel")).default;
        const TM = (await import("../src/models/tenantMembershipModel")).default;
        await runAsSystem(async () => {
            const t = await Tenant.findOne({ clerkOrgId: org }).lean();
            await TM.updateOne({ tenantId: t!._id, userId: member._id }, { $set: { status: "removed" } });
        }, "test-fixture");
        expect(await runAsSystem(() => fanOut({ type: "message.created", conversationId: wsConv, data: msg(wsConv) }), "test")).toBe(0);
    });

    it("idempotent enqueue, crashed-lease recovery, retries → dead → endpoint disabled → recovery, suspension pauses", async () => {
        const [owner, alice, bob] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        const reg = await setupApp({ user: owner }, ["messages:read"]);
        const { endpoint } = await addEndpoint({ user: owner }, reg.app, reg.name, ["message.created"]);
        await api({ user: alice }).post(`/v1/apps/${reg.app._id}/grants`).send({ scopes: ["messages:read"] });
        const conv = String((await api({ user: alice }).post("/conversations").send({ receiverId: String(bob._id) })).body.conversationId);
        await addMessage(conv, alice);
        await runAsSystem(() => fanOut({ type: "message.created", conversationId: conv, data: { messageId: "m1" } }), "test");
        const [row] = await runAsSystem(() => WebhookDelivery.find({ endpointId: endpoint._id }).lean(), "test-inspection");
        await WebhookDelivery.createIndexes(); // as migration 2026-10-24 does; autoIndex is async
        // Same (endpoint, event) twice → still one row
        await runAsSystem(() => WebhookDelivery.insertMany([{ endpointId: row.endpointId, appId: row.appId, eventId: row.eventId, eventType: row.eventType, payload: "{}", expireAt: new Date(Date.now() + 1e6) }], { ordered: false }), "test").catch(() => undefined);
        expect(await runAsSystem(() => WebhookDelivery.countDocuments({ endpointId: endpoint._id }), "test-inspection")).toBe(1);

        // Crashed worker: delivering with an expired lease is picked up again
        await runAsSystem(() => WebhookDelivery.updateOne({ _id: row._id }, { $set: { status: "delivering", lockedUntil: new Date(Date.now() - 1000) } }), "test-fixture");
        process.env.WEBHOOK_MAX_ATTEMPTS = "2";
        process.env.WEBHOOK_DISABLE_AFTER_FAILURES = "2";
        try {
            mode = "fail";
            await runWebhookWorkerOnce();
            let d = await runAsSystem(() => WebhookDelivery.findById(row._id).lean(), "test-inspection");
            expect(d!.status).toBe("retrying");
            expect(d!.attempts).toBe(1);
            expect(d!.lastError).toBe("http_500");
            expect(d!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
            await runAsSystem(() => WebhookDelivery.updateOne({ _id: row._id }, { $set: { nextAttemptAt: new Date() } }), "test-fixture");
            await runWebhookWorkerOnce();
            d = await runAsSystem(() => WebhookDelivery.findById(row._id).lean(), "test-inspection");
            expect(d!.status).toBe("dead");
            const ep = await runAsSystem(() => WebhookEndpoint.findById(endpoint._id).lean(), "test-inspection");
            expect(ep!.status).toBe("disabled");
            expect(ep!.disabledReason).toBe("too_many_failures");
            expect(await runAsSystem(() => AppAuditEvent.exists({ appId: ep!.appId, action: "webhook.endpoint_disabled" }), "test-inspection")).toBeTruthy();
            const history = await api({ user: owner }).get(`/v1/apps/${reg.app._id}/webhooks/${endpoint._id}/deliveries`);
            expect(history.body.data[0]).toMatchObject({ status: "dead", attempts: 2, lastError: "http_500" });
            expect(JSON.stringify(history.body)).not.toContain("payload");
        } finally {
            delete process.env.WEBHOOK_MAX_ATTEMPTS;
            delete process.env.WEBHOOK_DISABLE_AFTER_FAILURES;
        }
        // Recovery: re-enable → verify → retry the dead delivery
        mode = "ok";
        await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks/${endpoint._id}/enable`).send({});
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks/${endpoint._id}/verify`).send({})).body.data.verified).toBe(true);
        expect((await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks/${endpoint._id}/deliveries/${row._id}/retry`).send({})).status).toBe(201);
        await runWebhookWorkerOnce();
        expect((await runAsSystem(() => WebhookDelivery.findById(row._id).lean(), "test-inspection"))!.status).toBe("succeeded");

        // Suspended app: deliveries pause without consuming attempts
        await runAsSystem(() => fanOut({ type: "message.created", conversationId: conv, data: { messageId: "m2" } }), "test");
        await runAsSystem(() => DeveloperApp.updateOne({ _id: reg.app._id }, { $set: { status: "suspended" } }), "test-fixture");
        await runWebhookWorkerOnce();
        const paused = await runAsSystem(() => WebhookDelivery.findOne({ endpointId: endpoint._id, status: "pending" }).lean(), "test-inspection");
        expect(paused?.attempts).toBe(0);
        expect(paused?.lastError).toBe("app_suspended");
    });

    it("secret rotation: both secrets sign during the grace period; keepOldSeconds=0 revokes the old one", async () => {
        const owner = await makeUser();
        const reg = await setupApp({ user: owner }, ["messages:read"]);
        const { endpoint, secret: first } = await addEndpoint({ user: owner }, reg.app, reg.name, ["message.created"]);
        const r1 = await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks/${endpoint._id}/rotate-secret`).send({ confirm: reg.name });
        expect(r1.status).toBe(201);
        const second = r1.body.data.secret;
        const { signatureHeaders } = await import("../src/webhooks/worker");
        const ep = await runAsSystem(() => WebhookEndpoint.findById(endpoint._id).lean(), "test-inspection");
        const h = signatureHeaders(ep!, "d1", "message.created", "{}");
        const hv = { id: "d1", timestamp: h["SpreeWe-Webhook-Timestamp"], signature: h["SpreeWe-Webhook-Signature"] };
        expect(verifySignature(first, hv, "{}")).toBe(true);
        expect(verifySignature(second, hv, "{}")).toBe(true);
        await api({ user: owner }).post(`/v1/apps/${reg.app._id}/webhooks/${endpoint._id}/rotate-secret`).send({ confirm: reg.name, keepOldSeconds: 0 });
        const ep2 = await runAsSystem(() => WebhookEndpoint.findById(endpoint._id).lean(), "test-inspection");
        const h2 = signatureHeaders(ep2!, "d2", "message.created", "{}");
        const hv2 = { id: "d2", timestamp: h2["SpreeWe-Webhook-Timestamp"], signature: h2["SpreeWe-Webhook-Signature"] };
        expect(verifySignature(first, hv2, "{}")).toBe(false);
        expect(verifySignature(second, hv2, "{}")).toBe(false);
        expect(h2["SpreeWe-Webhook-Signature"].split(" ").length).toBe(1);
    });
});
