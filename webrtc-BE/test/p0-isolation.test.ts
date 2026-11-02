import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import type { Socket } from "socket.io-client";
import Message from "../src/models/messageModel";
import Notification from "../src/models/notificationModel";
import Call from "../src/models/callModel";
import Tenant from "../src/models/tenantModel";
import TenantMembership from "../src/models/tenantMembershipModel";
import { runAsSystem } from "../src/tenancy/context";
import { signLegacyUrl } from "../src/services/legacy-files.service";
import { revalidateWorkspaceSockets } from "../src/realtime/revalidate";
import { resetTenantCaches } from "../src/tenancy/tenant.service";
import { addMessage, api, connect, enter, makeUser, newOrg, nextEvent, oid, Session, sleep, startSocketServer, testApp, enc, plainOf } from "./helpers";

const idOf = (b: any) => String(b?.data?._id ?? b?.conversation?._id ?? b?._id ?? b?.conversationId);
const denied = (s: number) => s === 403 || s === 404;

async function dm(s: Session, other: any): Promise<string> {
    const res = await api(s).post("/conversations").send({ receiverId: String(other._id) });
    expect(res.status).toBe(200);
    return idOf(res.body);
}

// ---------------------------------------------------------------- A. legacy uploads (req. 8, 9)
describe("legacy /uploads are no longer public", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-uploads-"));
    const org = newOrg();
    let owner: any, peer: any, outsider: any, otherTenant: any, conv: string;
    const msgWith = async (name: string) => runAsSystem(() => Message.create({
        conversationId: oid(conv), userId: owner._id, content: name, type: name.endsWith(".pdf") ? "pdf" : "image",
        fileUrl: `http://localhost:8080/uploads/${encodeURIComponent(name)}`, thumbnailUrl: "",
    }), "test-fixture");

    beforeAll(async () => {
        process.env.LEGACY_UPLOADS_DIR = dir;
        fs.writeFileSync(path.join(dir, "contract 1.pdf"), "%PDF-1.4 private");
        fs.writeFileSync(path.join(dir, "pic.png"), "PNGDATA");
        [owner, peer, outsider, otherTenant] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);
        await enter({ user: owner, org });
        await enter({ user: peer, org });
        await enter({ user: otherTenant, org: newOrg() });
        conv = await dm({ user: owner, org }, peer);
    });
    afterAll(() => {
        delete process.env.LEGACY_UPLOADS_DIR;
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it("anonymous, unsigned, forged, expired, cross-file and traversal requests all get 404", async () => {
        const app = request(testApp());
        expect((await app.get("/uploads/pic.png")).status).toBe(404);
        expect((await app.get("/api/uploads/contract%201.pdf")).status).toBe(404);
        expect((await app.get("/uploads/pic.png?exp=9999999999&sig=AAAA")).status).toBe(404);
        const expired = signLegacyUrl("/uploads/pic.png", Date.now() - 2 * 3600_000)!;
        expect((await app.get(expired)).status).toBe(404);
        const forOther = new URL(signLegacyUrl("/uploads/pic.png")!, "http://x");
        expect((await app.get(`/uploads/${encodeURIComponent("contract 1.pdf")}${forOther.search}`)).status).toBe(404);
        const traversal = new URL(signLegacyUrl("/uploads/..%2Fpackage.json") ?? "/uploads/x?exp=1&sig=x", "http://x");
        expect((await app.get(`/uploads/..%2F..%2Fpackage.json${traversal.search}`)).status).toBe(404);
        // A valid signature still works, so the 404s above are not an outage
        expect((await app.get(signLegacyUrl("/uploads/pic.png")!)).status).toBe(200);
    });

    it("members get a short-lived signed link via the message; other users and contexts get nothing", async () => {
        await msgWith("contract 1.pdf");
        const history = await api({ user: peer, org }).get(`/messages/${conv}`);
        expect(history.status).toBe(200);
        const item = history.body.data.find((m: any) => m.content === "contract 1.pdf");
        expect(item.fileUrl).toMatch(/\/uploads\/contract%201\.pdf\?exp=\d+&sig=/);
        const url = new URL(item.fileUrl);
        const file = await request(testApp()).get(url.pathname + url.search);
        expect(file.status).toBe(200);
        expect(file.headers["content-disposition"]).toMatch(/attachment/);
        expect(file.headers["x-content-type-options"]).toBe("nosniff");
        for (const s of [{ user: outsider }, { user: otherTenant }, { user: peer }] as Session[]) {
            const res = await api(s).get(`/messages/${conv}`);
            expect(denied(res.status)).toBe(true);
            expect(JSON.stringify(res.body)).not.toContain("sig=");
        }
    });
});

// ---------------------------------------------------------------- B. external isolation (req. 10)
describe("external conversation isolation", () => {
    const host = newOrg();
    const guestOrg = newOrg();
    let admin: any, member: any, guest: any, ext: string, internal: string;
    const H = (u: any, role = "org:member"): Session => ({ user: u, org: host, role });

    beforeAll(async () => {
        [admin, member, guest] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        await enter(H(admin, "org:admin"));
        await enter(H(member));
        await enter({ user: guest, org: guestOrg });
        await api(H(admin, "org:admin")).patch("/tenant/current/policies").send({ allowExternalChat: true });
        ext = (await api(H(admin, "org:admin")).post("/tenant/external-conversations").send({ userId: String(guest._id) })).body.data.conversationId;
        internal = await dm(H(admin), member);
        await addMessage(ext, admin, "external hello");
        await addMessage(internal, admin, "internal secret");
    });

    it("guest: only from their personal context, never inside their own organization's workspace", async () => {
        expect((await api({ user: guest }).get(`/messages/${ext}`)).status).toBe(200);
        expect(denied((await api({ user: guest, org: guestOrg }).get(`/messages/${ext}`)).status)).toBe(true);
        expect(JSON.stringify((await api({ user: guest, org: guestOrg }).get("/conversations")).body)).not.toContain(ext);
        expect(denied((await api({ user: guest }).get(`/messages/${internal}`)).status)).toBe(true);
    });

    it("host members: only inside the host workspace (not from their personal context)", async () => {
        expect((await api(H(admin)).get(`/messages/${ext}`)).status).toBe(200);
        expect(denied((await api({ user: admin }).get(`/messages/${ext}`)).status)).toBe(true);
    });

    it("search, notifications and call history follow the same rule", async () => {
        const gSearch = JSON.stringify((await api({ user: guest }).get("/search?q=hello")).body);
        expect(gSearch).toContain("external hello");
        expect(gSearch).not.toContain("internal secret");
        expect(JSON.stringify((await api({ user: guest }).get("/search?q=secret")).body)).not.toContain("internal secret");

        const [forGuest] = await runAsSystem(() => Notification.insertMany([{ userId: guest._id, type: "mention", conversationId: oid(ext), text: "ping" }]), "test-fixture");
        const [forAdmin] = await runAsSystem(() => Notification.insertMany([{ userId: admin._id, type: "mention", conversationId: oid(ext), text: "ping" }]), "test-fixture");
        expect(forGuest.guestUserIds?.map(String)).toEqual([String(guest._id)]);
        const ids = (s: Session) => api(s).get("/notifications").then((r) => JSON.stringify(r.body));
        expect(await ids({ user: guest })).toContain(String(forGuest._id));
        expect(await ids({ user: guest, org: guestOrg })).not.toContain(String(forGuest._id));
        expect(await ids(H(admin))).toContain(String(forAdmin._id));
        expect(await ids({ user: admin })).not.toContain(String(forAdmin._id));

        const call = await runAsSystem(() => Call.create({ conversationId: oid(ext), initiatedBy: admin._id, callType: "audio", participants: [{ userId: admin._id, status: "joined" }, { userId: guest._id, status: "joined" }] } as any), "test-fixture");
        expect(JSON.stringify((await api({ user: guest }).get("/calls")).body)).toContain(String(call._id));
        expect(JSON.stringify((await api({ user: guest, org: guestOrg }).get("/calls")).body)).not.toContain(String(call._id));
        expect(JSON.stringify((await api({ user: admin }).get("/calls")).body)).not.toContain(String(call._id));
    });
});

// ---------------------------------------------------------------- sockets: external, presence, revocation
describe("socket delivery: external conversations, presence, cross-instance revocation", () => {
    let server: Awaited<ReturnType<typeof startSocketServer>>;
    const open: Socket[] = [];
    const sock = async (s: Session) => {
        const socket = await connect(server.port, s);
        open.push(socket);
        await sleep(150);
        return socket;
    };
    beforeAll(async () => {
        server = await startSocketServer();
    });
    afterAll(async () => {
        open.forEach((s) => s.disconnect());
        await server.close();
    });

    it("external messages reach the guest's personal socket, not a socket in their own workspace", async () => {
        const host = newOrg();
        const guestOrg = newOrg();
        const [admin, guest] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: admin, org: host, role: "org:admin" });
        await enter({ user: guest, org: guestOrg });
        await api({ user: admin, org: host, role: "org:admin" }).patch("/tenant/current/policies").send({ allowExternalChat: true });
        const ext = (await api({ user: admin, org: host, role: "org:admin" }).post("/tenant/external-conversations").send({ userId: String(guest._id) })).body.data.conversationId;
        const adminSock = await sock({ user: admin, org: host, role: "org:admin" });

        const guestWork = await sock({ user: guest, org: guestOrg });
        const leaked = nextEvent(guestWork, "receiveMessage", 1000, (m) => String(m?.conversationId) === ext);
        adminSock.emit("sendMessage", { user: { _id: String(admin._id) }, conversationId: ext, e2ee: enc("to guest"), type: "text" });
        expect(await leaked).toBeNull();
        guestWork.disconnect();

        const guestHome = await sock({ user: guest });
        const arrives = nextEvent(guestHome, "receiveMessage", 2000, (m) => String(m?.conversationId) === ext);
        adminSock.emit("sendMessage", { user: { _id: String(admin._id) }, conversationId: ext, e2ee: enc("to guest 2"), type: "text" });
        expect(await arrives).not.toBeNull();
    });

    it("presence is only pushed to sockets whose context can see the person (req. C)", async () => {
        const org = newOrg();
        const [x, y] = await Promise.all([makeUser(undefined, { globalDiscoverable: false }), makeUser()]);
        await enter({ user: x, org });
        await enter({ user: y, org });
        await dm({ user: x, org }, y); // they only share a workspace conversation

        const yGlobal = await sock({ user: y });
        const notSeen = nextEvent(yGlobal, "user:presence", 1200, (p) => p?.userId === String(x._id));
        const x1 = await sock({ user: x, org });
        expect(await notSeen).toBeNull();
        x1.disconnect();
        yGlobal.disconnect();
        await sleep(200);

        const yWork = await sock({ user: y, org });
        const seen = nextEvent(yWork, "user:presence", 2000, (p) => p?.userId === String(x._id));
        await sock({ user: x, org });
        expect(await seen).not.toBeNull();
    });

    it("a removal written by another instance disconnects live sockets on this one (revalidation sweep)", async () => {
        const org = newOrg();
        const u = await makeUser();
        await enter({ user: u, org });
        const s = await sock({ user: u, org, iat: Math.floor(Date.now() / 1000) - 5 });
        const gone = new Promise<boolean>((resolve) => {
            s.once("disconnect", () => resolve(true));
            setTimeout(() => resolve(false), 3000);
        });
        // Simulate the webhook having been processed by a different instance (no local cache invalidation)
        await runAsSystem(async () => {
            const t = await Tenant.findOne({ clerkOrgId: org }).lean();
            await TenantMembership.updateOne({ tenantId: t!._id, userId: u._id }, { $set: { status: "removed", removedAt: new Date() } });
        }, "test-fixture");
        expect(await revalidateWorkspaceSockets()).toBeGreaterThanOrEqual(1);
        expect(await gone).toBe(true);
    });

    it("MEMBERSHIP_CHECK_CACHE_MS=0 makes new requests see another instance's removal immediately", async () => {
        const org = newOrg();
        const u = await makeUser();
        await enter({ user: u, org });
        process.env.MEMBERSHIP_CHECK_CACHE_MS = "0";
        try {
            const iat = Math.floor(Date.now() / 1000) - 5;
            expect((await api({ user: u, org, iat }).get("/tenant/current")).status).toBe(200);
            await runAsSystem(async () => {
                const t = await Tenant.findOne({ clerkOrgId: org }).lean();
                await TenantMembership.updateOne({ tenantId: t!._id, userId: u._id }, { $set: { status: "removed", removedAt: new Date() } });
            }, "test-fixture");
            // No resetTenantCaches(): the cache is simply not used
            expect((await api({ user: u, org, iat }).get("/tenant/current")).status).toBe(403);
        } finally {
            delete process.env.MEMBERSHIP_CHECK_CACHE_MS;
            resetTenantCaches();
        }
    });
});
