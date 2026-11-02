import crypto from "crypto";
import path from "path";
import { ChildProcess, spawn } from "child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
import type { Socket } from "socket.io-client";
import { addMessage, api, connect, enter, makeUser, newOrg, nextEvent, Session, sleep, startSocketServer, testApp, uniq, enc, plainOf } from "./helpers";

/**
 * Phase 5C: two real backend instances sharing one MongoDB replica set through the Socket.IO MongoDB
 * adapter. Instance A runs in this process; instance B is a separate process (test/support/instance.ts)
 * — the realtime registries are per process, exactly as in production. Every scenario sends on one
 * instance and receives on the other, and checks that authorization still applies across instances.
 */
describe("multi-instance Socket.IO (MongoDB adapter)", () => {
    let a: Awaited<ReturnType<typeof startSocketServer>>;
    let child: ChildProcess;
    let portB = 0;
    const sockets: Socket[] = [];
    const on = async (port: number, s: Session) => {
        const sock = await connect(port, s);
        sockets.push(sock);
        return sock;
    };
    const dm = async (s: Session, other: any): Promise<string> => {
        const res = await api(s).post("/conversations").send({ receiverId: String(other._id) });
        expect(res.status).toBe(200);
        return String(res.body.conversationId ?? res.body.data?.conversationId ?? res.body.data?._id);
    };
    // Lets both change streams start before the first cross-instance event
    const settle = () => sleep(400);

    beforeAll(async () => {
        process.env.SOCKET_ADAPTER = "mongo";
        a = await startSocketServer();
        const { setUpCluster } = await import("../src/realtime/cluster");
        const { io } = await import("../src/realtime/io");
        await setUpCluster(io());
        const root = path.resolve(__dirname, "..");
        child = spawn(process.execPath, ["-r", "ts-node/register/transpile-only", "test/support/instance.ts"], {
            cwd: root,
            env: {
                ...process.env,
                SOCKET_ADAPTER: "mongo",
                INSTANCE_MONGO_URI: process.env.TEST_MONGO_URI,
                INSTANCE_DB: mongoose.connection.name,
                TS_NODE_PROJECT: path.join(root, "tsconfig.json"),
                SOCKET_REVALIDATE_MS: "0", // revocation must arrive through the cluster, not the sweep
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        portB = await new Promise<number>((resolve, reject) => {
            let err = "";
            const timer = setTimeout(() => reject(new Error(`instance B did not start: ${err.slice(-500)}`)), 120_000);
            child.stderr!.on("data", (d) => { err += String(d); });
            child.stdout!.on("data", (d) => {
                const m = /READY (\d+)/.exec(String(d));
                if (m) { clearTimeout(timer); resolve(Number(m[1])); }
            });
            child.once("exit", (code) => reject(new Error(`instance B exited (${code}): ${err.slice(-500)}`)));
        });
        await settle();
    }, 180_000);

    afterAll(async () => {
        sockets.forEach((s) => s.disconnect());
        child?.kill();
        await a?.close();
    });

    it("messages: sent on A, delivered live to the recipient on B", async () => {
        const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
        const conv = await dm({ user: alice }, bob);
        const sa = await on(a.port, { user: alice });
        const sb = await on(portB, { user: bob });
        await settle();
        const got = nextEvent(sb, "receiveMessage", 4000, (m) => String(m?.conversationId) === conv && plainOf(m) === "cross-instance hello");
        sa.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, e2ee: enc("cross-instance hello"), type: "text" });
        expect(await got).not.toBeNull();
    });

    it("typing and read receipts cross instances (conversation room)", async () => {
        const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
        const conv = await dm({ user: alice }, bob);
        const sa = await on(a.port, { user: alice });
        const sb = await on(portB, { user: bob });
        sa.emit("joinConversation", conv);
        sb.emit("joinConversation", conv);
        await settle();
        const typing = nextEvent(sa, "userTyping", 4000, (p) => String(p?.conversationId) === conv);
        sb.emit("typing", conv);
        expect(await typing).toMatchObject({ isTyping: true, userId: String(bob._id) });
        await addMessage(conv, alice, "please read");
        const read = nextEvent(sa, "messagesMarkedRead", 4000, (p) => String(p?.conversationId) === conv);
        sb.emit("markMessagesRead", conv);
        expect(await read).toMatchObject({ userId: String(bob._id) });
    });

    it("presence: a contact on B sees the user come online on A; one instance closing does not mark them offline", async () => {
        const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
        await dm({ user: alice }, bob);
        const sb = await on(portB, { user: bob });
        await settle();
        const online = nextEvent(sb, "user:presence", 4000, (p) => p?.userId === String(alice._id) && p?.isOnline === true);
        const aliceOnA = await on(a.port, { user: alice });
        expect(await online).not.toBeNull();
        // Second device on B, then the A device leaves: alice stays online
        await on(portB, { user: alice });
        await settle();
        const offline = nextEvent(sb, "user:presence", 2000, (p) => p?.userId === String(alice._id) && p?.isOnline === false);
        aliceOnA.disconnect();
        expect(await offline).toBeNull();
    });

    it("calls: ring on B, accept on B reaches the caller on A, leaving ends it for both", async () => {
        const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
        const conv = await dm({ user: alice }, bob);
        const sa = await on(a.port, { user: alice });
        const sb = await on(portB, { user: bob });
        await settle();
        const ring = nextEvent<any>(sb, "call:incoming", 5000, (p) => String(p?.groupId ?? p?.conversationId) === conv);
        sa.emit("call:start", { groupId: conv, callType: "audio", mode: "ring" });
        const incoming = await ring;
        expect(incoming).not.toBeNull();
        const callId = String(incoming.callId ?? incoming._id);
        const joined = nextEvent(sa, "call:participant-joined", 5000, (p) => String(p?.userId) === String(bob._id));
        const accepted = await new Promise<any>((resolve) => sb.emit("call:accept", { callId }, resolve));
        expect(accepted?.success).toBe(true);
        expect(await joined).not.toBeNull();
        const ended = nextEvent(sb, "call:ended", 6000);
        const left = nextEvent(sb, "call:participant-left", 6000);
        sa.emit("call:leave", { callId });
        expect((await ended) ?? (await left)).not.toBeNull();
    });

    it("workspace context is enforced on the receiving instance (global message never reaches a workspace socket on B)", async () => {
        const org = newOrg();
        const [alice, bob] = await Promise.all([makeUser(), makeUser()]);
        await enter({ user: bob, org });
        const conv = await dm({ user: alice }, bob); // global conversation
        const sa = await on(a.port, { user: alice });
        // The workspace socket is bob's only (primary) socket: the event IS targeted at it, and must be filtered on B
        const bobWork = await on(portB, { user: bob, org });
        await settle();
        const leaked = nextEvent(bobWork, "receiveMessage", 2500, (m) => String(m?.conversationId) === conv);
        sa.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, e2ee: enc("global only"), type: "text" });
        expect(await leaked).toBeNull();
        bobWork.disconnect();
        await sleep(300);
        // Control: the same delivery reaches his personal socket on B
        const bobHome = await on(portB, { user: bob });
        await settle();
        const home = nextEvent(bobHome, "receiveMessage", 4000, (m) => String(m?.conversationId) === conv);
        sa.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, e2ee: enc("global only 2"), type: "text" });
        expect(await home).not.toBeNull();
    });

    it("cross-tenant: a socket of another tenant on B never receives a tenant conversation's events", async () => {
        const orgA = newOrg(), orgB = newOrg();
        const [alice, bob, mallory] = await Promise.all([makeUser(), makeUser(), makeUser()]);
        await enter({ user: alice, org: orgA });
        await enter({ user: bob, org: orgA });
        await enter({ user: mallory, org: orgB });
        const conv = await dm({ user: alice, org: orgA }, bob);
        const sa = await on(a.port, { user: alice, org: orgA });
        const sb = await on(portB, { user: bob, org: orgA });
        const sm = await on(portB, { user: mallory, org: orgB });
        sm.emit("joinConversation", conv); // refused by the membership check
        await settle();
        const ok = nextEvent(sb, "receiveMessage", 4000, (m) => String(m?.conversationId) === conv);
        const leak = nextEvent(sm, "receiveMessage", 2500, (m) => String(m?.conversationId) === conv);
        sa.emit("sendMessage", { user: { _id: String(alice._id) }, conversationId: conv, e2ee: enc("tenant secret"), type: "text" });
        expect(await ok).not.toBeNull();
        expect(await leak).toBeNull();
    });

    it("external conversation: the guest's personal socket on B gets it; their own-workspace socket on B does not", async () => {
        const host = newOrg(), guestOrg = newOrg();
        const [admin, guest] = await Promise.all([makeUser(), makeUser()]);
        const adminS = { user: admin, org: host, role: "org:admin" };
        await enter(adminS);
        await enter({ user: guest, org: guestOrg });
        await api(adminS).patch("/tenant/current/policies").send({ allowExternalChat: true });
        const ext = (await api(adminS).post("/tenant/external-conversations").send({ userId: String(guest._id) })).body.data.conversationId;
        const sa = await on(a.port, adminS);
        // The guest's own-workspace socket as their primary socket: targeted, and filtered on B
        const guestWork = await on(portB, { user: guest, org: guestOrg });
        await settle();
        const leak = nextEvent(guestWork, "receiveMessage", 2500, (m) => String(m?.conversationId) === String(ext));
        sa.emit("sendMessage", { user: { _id: String(admin._id) }, conversationId: ext, e2ee: enc("hello guest"), type: "text" });
        expect(await leak).toBeNull();
        guestWork.disconnect();
        await sleep(300);
        const guestHome = await on(portB, { user: guest });
        await settle();
        const home = nextEvent(guestHome, "receiveMessage", 4000, (m) => String(m?.conversationId) === String(ext));
        sa.emit("sendMessage", { user: { _id: String(admin._id) }, conversationId: ext, e2ee: enc("hello guest 2"), type: "text" });
        expect(await home).not.toBeNull();
    });

    it("membership revocation via the Clerk webhook on A disconnects the member's socket on B immediately", async () => {
        const org = newOrg();
        const member = await makeUser();
        await enter({ user: member, org });
        const sb = await on(portB, { user: member, org });
        await settle();
        const dropped = new Promise<number>((resolve) => { const t0 = Date.now(); sb.once("disconnect", () => resolve(Date.now() - t0)); setTimeout(() => resolve(-1), 5000); });
        const body = JSON.stringify({
            type: "organizationMembership.deleted", timestamp: Date.now(), object: "event",
            data: { id: `orgmem_${uniq("m")}`, role: "org:member", organization: { id: org, name: "Acme" }, public_user_data: { user_id: member.clerkId } },
        });
        const id = `msg_${uniq("w")}`, ts = String(Math.floor(Date.now() / 1000));
        const key = Buffer.from(process.env.CLERK_WEBHOOK_SIGNING_SECRET!.replace(/^whsec_/, ""), "base64");
        const sig = crypto.createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
        const res = await request(testApp()).post("/webhooks/clerk").set({ "svix-id": id, "svix-timestamp": ts, "svix-signature": `v1,${sig}`, "content-type": "application/json" }).send(body);
        expect(res.status).toBe(200);
        const ms = await dropped;
        expect(ms).toBeGreaterThanOrEqual(0); // B's revalidation sweep is off: this came through the cluster
    });

    it("readiness: a second instance WITHOUT the adapter is detected", async () => {
        const { clusterProblems } = await import("../src/realtime/cluster");
        expect(clusterProblems()).toEqual([]);
        const res = await request(testApp()).get("/health/ready");
        expect(res.status).toBe(200);
        await mongoose.connection.db!.collection("runtime_instances").insertOne({ _id: "rogue:1" as any, seenAt: new Date(), adapter: "none" });
        const { heartbeatNow } = await import("../src/realtime/cluster");
        await heartbeatNow();
        expect(clusterProblems()).toEqual(["multiple instances without a shared Socket.IO adapter"]);
        expect((await request(testApp()).get("/health/ready")).status).toBe(503);
        await mongoose.connection.db!.collection("runtime_instances").deleteOne({ _id: "rogue:1" as any });
        await heartbeatNow();
        expect(clusterProblems()).toEqual([]);
    });
});
