import crypto from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Socket } from "socket.io-client";
import Tenant from "../src/models/tenantModel";
import TenantMembership from "../src/models/tenantMembershipModel";
import ClerkWebhookEvent from "../src/models/clerkWebhookEventModel";
import { runAsSystem } from "../src/tenancy/context";
import { api, connect, enter, makeUser, newOrg, sleep, startSocketServer, testApp, uniq } from "./helpers";

/**
 * Real Svix signature verification (Clerk's verifyWebhook) — only the signing happens here, with a
 * test-only secret. Signed content = `${svix-id}.${svix-timestamp}.${raw body}`, HMAC-SHA256.
 */
function sign(body: string, opts: { id?: string; timestampSec?: number; secret?: string } = {}) {
    const secret = opts.secret ?? process.env.CLERK_WEBHOOK_SIGNING_SECRET!;
    const id = opts.id ?? `msg_${uniq("w")}`;
    const ts = String(opts.timestampSec ?? Math.floor(Date.now() / 1000));
    const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
    const signature = crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
    return { "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${signature}`, "content-type": "application/json" };
}

function deliver(event: unknown, opts: Parameters<typeof sign>[1] = {}) {
    const body = JSON.stringify(event);
    return request(testApp()).post("/webhooks/clerk").set(sign(body, opts)).send(body);
}

const membershipEvent = (type: string, orgId: string, clerkUserId: string, role: string, timestamp: number) => ({
    type, timestamp, object: "event",
    data: { id: `orgmem_${uniq("m")}`, role, organization: { id: orgId, name: "Acme" }, public_user_data: { user_id: clerkUserId } },
});

const membership = async (tenantClerkId: string, userId: unknown) => runAsSystem(async () => {
    const t = await Tenant.findOne({ clerkOrgId: tenantClerkId }).lean();
    return t ? TenantMembership.findOne({ tenantId: t._id, userId }).lean() : null;
}, "test-inspection");

describe("Clerk webhooks — signature and payload validation (req. 5, 7)", () => {
    it("rejects missing, invalid and wrongly-keyed signatures without touching data", async () => {
        const org = newOrg();
        const user = await makeUser();
        const body = JSON.stringify(membershipEvent("organizationMembership.created", org, user.clerkId, "org:admin", Date.now()));

        expect((await request(testApp()).post("/webhooks/clerk").set("content-type", "application/json").send(body)).status).toBe(400);
        const forged = { ...sign(body), "svix-signature": "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" };
        expect((await request(testApp()).post("/webhooks/clerk").set(forged).send(body)).status).toBe(400);
        const otherKey = sign(body, { secret: "whsec_" + Buffer.from("not-the-real-secret-000000000000").toString("base64") });
        expect((await request(testApp()).post("/webhooks/clerk").set(otherKey).send(body)).status).toBe(400);
        // Correct signature over different bytes (tampered body)
        const tampered = await request(testApp()).post("/webhooks/clerk").set(sign(body)).send(body.replace("org:admin", "org:owner"));
        expect(tampered.status).toBe(400);
        // Replay of an old delivery (outside the timestamp tolerance)
        expect((await deliver(JSON.parse(body), { timestampSec: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(400);

        expect(await runAsSystem(() => Tenant.findOne({ clerkOrgId: org }).lean(), "test-inspection")).toBeNull();
    });

    it("rejects signed but malformed payloads", async () => {
        const res = await deliver({ type: "organizationMembership.created", timestamp: Date.now(), data: { role: "org:admin", organization: { id: "not-an-org" } } });
        expect(res.status).toBe(400);
    });
});

describe("Clerk webhooks — sync semantics", () => {
    it("organization.created creates the tenant with secure default policies (payload can't set them)", async () => {
        const org = newOrg();
        const res = await deliver({ type: "organization.created", timestamp: Date.now(), data: { id: org, name: "Acme Ltd", slug: "acme", status: "suspended", policies: { allowExternalChat: true } } });
        expect(res.status).toBe(200);
        const t = await runAsSystem(() => Tenant.findOne({ clerkOrgId: org }).lean(), "test-inspection");
        expect(t?.name).toBe("Acme Ltd");
        expect(t?.status).toBe("active");
        expect(t?.policies?.allowExternalChat).toBe(false);
    });

    it("duplicate delivery is applied once and cannot undo newer state (req. 6)", async () => {
        const org = newOrg();
        const user = await makeUser();
        await enter({ user, org });
        const t0 = Date.now();
        const created = membershipEvent("organizationMembership.created", org, user.clerkId, "org:member", t0);
        const id = `msg_${uniq("dup")}`;
        expect((await deliver(created, { id })).body.outcome).toBe("applied");
        const deleted = membershipEvent("organizationMembership.deleted", org, user.clerkId, "org:member", t0 + 1000);
        expect((await deliver(deleted)).status).toBe(200);
        // Same svix-id again: acknowledged as duplicate, not re-applied
        const again = await deliver(created, { id });
        expect(again.status).toBe(200);
        expect(again.body.duplicate).toBe(true);
        expect((await membership(org, user._id))?.status).toBe("removed");
        // The same old event under a NEW svix-id (out of order) is ignored as stale
        const late = await deliver(created);
        expect(late.body.outcome).toBe("stale");
        expect((await membership(org, user._id))?.status).toBe("removed");
        const ledger = await runAsSystem(() => ClerkWebhookEvent.findById(id).lean(), "test-inspection");
        expect(ledger?.attempts).toBe(1);
    });

    it("webhook roles are display-only: a payload saying admin grants nothing (req. 7)", async () => {
        const org = newOrg();
        const user = await makeUser();
        await enter({ user, org, role: "org:member" });
        await deliver(membershipEvent("organizationMembership.updated", org, user.clerkId, "org:admin", Date.now()));
        expect((await membership(org, user._id))?.role).toBe("admin");
        // The session token still says member → policies stay locked
        const res = await api({ user, org, role: "org:member" }).patch("/tenant/current/policies").send({ allowExternalChat: true });
        expect(res.status).toBe(403);
    });

    it("a transient failure answers 500 and the retry applies it (req. retries)", async () => {
        const org = newOrg();
        const user = await makeUser();
        await enter({ user, org });
        const id = `msg_${uniq("retry")}`;
        const event = membershipEvent("organizationMembership.deleted", org, user.clerkId, "org:member", Date.now());
        const spy = vi.spyOn(TenantMembership, "updateOne").mockRejectedValueOnce(new Error("transient db error"));
        const first = await deliver(event, { id });
        spy.mockRestore();
        expect(first.status).toBe(500);
        expect((await runAsSystem(() => ClerkWebhookEvent.findById(id).lean(), "test-inspection"))?.status).toBe("failed");
        const retry = await deliver(event, { id });
        expect(retry.status).toBe(200);
        const ledger = await runAsSystem(() => ClerkWebhookEvent.findById(id).lean(), "test-inspection");
        expect(ledger?.status).toBe("done");
        expect(ledger?.attempts).toBe(2);
        expect((await membership(org, user._id))?.status).toBe("removed");
    });

    it("users not provisioned locally are skipped, not invented", async () => {
        const org = newOrg();
        const res = await deliver(membershipEvent("organizationMembership.created", org, `user_${uniq("ghost")}`, "org:member", Date.now()));
        expect(res.status).toBe(200);
        expect(String(res.body.outcome)).toMatch(/^skipped:/);
    });
});

describe("Clerk webhooks — revocation is immediate (req. 4)", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    beforeAll(async () => {
        server = await startSocketServer();
    });
    afterAll(async () => {
        open.forEach((s) => s.disconnect());
        await server.close();
    });

    it("membership removal refuses still-valid tokens, disconnects sockets and updates the directory", async () => {
        const org = newOrg();
        const [admin, leaver] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: admin, org, role: "org:admin" });
        await enter({ user: leaver, org });
        const issuedBefore = Math.floor(Date.now() / 1000) - 5;
        const socket = await connect(server.port, { user: leaver, org, iat: issuedBefore });
        open.push(socket);
        const disconnected = new Promise<boolean>((resolve) => {
            socket.once("disconnect", () => resolve(true));
            setTimeout(() => resolve(false), 3000);
        });

        expect((await deliver(membershipEvent("organizationMembership.deleted", org, leaver.clerkId, "org:member", Date.now()))).status).toBe(200);

        // A token issued before the removal (Clerk would still accept it until it expires)
        expect((await api({ user: leaver, org, iat: issuedBefore }).get("/tenant/current")).status).toBe(403);
        expect((await api({ user: leaver, org, iat: issuedBefore }).get("/conversations")).status).toBe(403);
        expect(await disconnected).toBe(true);
        // Reconnecting with the old token is refused too
        await expect(connect(server.port, { user: leaver, org, iat: issuedBefore })).rejects.toBeTruthy();
        // Directory no longer lists them
        const dir = (await api({ user: admin, org, role: "org:admin" }).get("/directory")).body.data.map((u: any) => String(u._id));
        expect(dir).not.toContain(String(leaver._id));
        // The global context is unaffected
        expect((await api({ user: leaver }).get("/conversations")).status).toBe(200);

        // Re-added in Clerk: a token issued after the removal works again
        await sleep(1100);
        const later = Math.floor(Date.now() / 1000) + 1;
        expect((await api({ user: leaver, org, iat: later }).get("/tenant/current")).status).toBe(200);
        expect((await membership(org, leaver._id))?.status).toBe("active");
    });

    it("organization deletion ends access for every member and keeps the data", async () => {
        const org = newOrg();
        const [a, b] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: a, org });
        await enter({ user: b, org });
        const conv = await api({ user: a, org }).post("/conversations").send({ receiverId: String(b._id) });
        expect(conv.status).toBe(200);
        const socket = await connect(server.port, { user: b, org });
        open.push(socket);
        const disconnected = new Promise<boolean>((resolve) => {
            socket.once("disconnect", () => resolve(true));
            setTimeout(() => resolve(false), 3000);
        });

        expect((await deliver({ type: "organization.deleted", timestamp: Date.now(), data: { id: org, deleted: true } })).status).toBe(200);
        expect((await api({ user: a, org }).get("/conversations")).status).toBe(403);
        expect((await api({ user: b, org }).get("/tenant/current")).status).toBe(403);
        expect(await disconnected).toBe(true);
        const t = await runAsSystem(() => Tenant.findOne({ clerkOrgId: org }).lean(), "test-inspection");
        expect(t?.status).toBe("deleted");
        // A later "organization.updated" (or replay of created) cannot resurrect it
        await deliver({ type: "organization.updated", timestamp: Date.now() + 10, data: { id: org, name: "Back" } });
        expect((await runAsSystem(() => Tenant.findOne({ clerkOrgId: org }).lean(), "test-inspection"))?.status).toBe("deleted");
    });

    it("user.deleted removes the user from every directory and every workspace", async () => {
        const org = newOrg();
        const [stay, gone] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: stay, org });
        await enter({ user: gone, org });
        expect((await deliver({ type: "user.deleted", timestamp: Date.now(), data: { id: gone.clerkId, deleted: true } })).status).toBe(200);
        const ws = (await api({ user: stay, org }).get("/directory")).body.data.map((u: any) => String(u._id));
        const global = (await api({ user: stay }).get("/directory")).body.data.map((u: any) => String(u._id));
        expect(ws).not.toContain(String(gone._id));
        expect(global).not.toContain(String(gone._id));
        expect((await membership(org, gone._id))?.status).toBe("removed");
    });
});
