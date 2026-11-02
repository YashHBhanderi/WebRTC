import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import Conversation from "../src/models/conversationModel";
import Message from "../src/models/messageModel";
import Notification from "../src/models/notificationModel";
import Call from "../src/models/callModel";
import { RequestContext, currentContext, runAsSystem, runWithContext } from "../src/tenancy/context";
import { checkScopeConsistency } from "../src/tenancy/consistency";
import { addMessage, api, enter, makeUser, newOrg, oid, sleep } from "./helpers";

const ctx = (userId: unknown, tenantId: string | null): RequestContext => ({
    kind: "user", userId: String(userId), tenantId, clerkOrgId: tenantId ? "org_x" : null, role: tenantId ? "member" : null, isPlatformAdmin: false,
});

// Requirement 1: missing tenant context rejects tenant-scoped reads and writes
describe("fail-closed tenant context", () => {
    it("every read and write on scoped models without a context is refused", async () => {
        const [a, b] = await Promise.all([makeUser(), makeUser()]);
        const conv = await runAsSystem(() => Conversation.create({ members: [a._id, b._id], isGroup: false, tenantId: null, scope: "global" }), "test-fixture");
        const id = conv._id;
        const refused = /Tenant context required/;
        await expect(Conversation.find({ _id: id })).rejects.toThrow(refused);
        await expect(Conversation.findById(id)).rejects.toThrow(refused);
        await expect(Conversation.exists({ _id: id })).rejects.toThrow(refused);
        await expect(Conversation.countDocuments({})).rejects.toThrow(refused);
        await expect(Conversation.distinct("_id")).rejects.toThrow(refused);
        await expect(Conversation.aggregate([{ $match: { _id: id } }])).rejects.toThrow(refused);
        await expect(Conversation.updateOne({ _id: id }, { $set: { groupDescription: "x" } })).rejects.toThrow(refused);
        await expect(Conversation.updateMany({}, { $set: { groupDescription: "x" } })).rejects.toThrow(refused);
        await expect(Conversation.findOneAndUpdate({ _id: id }, { $set: { groupDescription: "x" } })).rejects.toThrow(refused);
        await expect(Conversation.deleteOne({ _id: id })).rejects.toThrow(refused);
        await expect(Conversation.deleteMany({})).rejects.toThrow(refused);
        await expect(Conversation.create({ members: [a._id, b._id], isGroup: false })).rejects.toThrow(refused);
        await expect(Message.find({ conversationId: id })).rejects.toThrow(refused);
        await expect(Call.find({})).rejects.toThrow(refused);
        // A record with no conversation can't pick a scope without a user context
        await expect(Notification.insertMany([{ userId: a._id, type: "mention", text: "x" }])).rejects.toThrow(refused);
        // Nothing was modified
        const after = await runAsSystem(() => Conversation.findById(id).lean(), "test-inspection");
        expect(after?.groupDescription).toBeUndefined();
    });

    it("explicit system work still works, and system-created conversations must state their scope", async () => {
        const [a, b] = await Promise.all([makeUser(), makeUser()]);
        await expect(runAsSystem(() => Conversation.create({ members: [a._id, b._id], isGroup: false }), "test")).rejects.toThrow(/scope not set/);
        const ok = await runAsSystem(() => Conversation.create({ members: [a._id, b._id], isGroup: false, tenantId: null, scope: "global" }), "test");
        expect(ok.scope).toBe("global");
        expect(await runAsSystem(() => Conversation.countDocuments({ _id: ok._id }), "test")).toBe(1);
    });

    it("explicit global operations (user context, no workspace) work (req. 2)", async () => {
        const [a, b] = await Promise.all([makeUser(), makeUser()]);
        const created = await runWithContext(ctx(a._id, null), () => Conversation.create({ members: [a._id, b._id], isGroup: false }));
        expect(created.scope).toBe("global");
        expect(await runWithContext(ctx(a._id, null), () => Conversation.countDocuments({ _id: created._id }))).toBe(1);
    });

    it("context never leaks between concurrent async work (req. 8)", async () => {
        const T1 = new mongoose.Types.ObjectId().toString();
        const T2 = new mongoose.Types.ObjectId().toString();
        const seen = await Promise.all(Array.from({ length: 40 }, (_, i) => {
            const mine = i % 2 ? T1 : T2;
            return runWithContext(ctx("u" + i, mine), async () => {
                await sleep(Math.random() * 20);
                await Promise.resolve();
                await sleep(Math.random() * 20);
                const c = currentContext();
                return c?.kind === "user" && c.tenantId === mine;
            });
        }));
        expect(seen.every(Boolean)).toBe(true);
    });

    it("concurrent HTTP requests from two workspaces each see only their own data (req. 8)", async () => {
        const orgA = newOrg();
        const orgB = newOrg();
        const [a1, a2, b1, b2] = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);
        for (const s of [{ user: a1, org: orgA }, { user: a2, org: orgA }, { user: b1, org: orgB }, { user: b2, org: orgB }]) await enter(s);
        const idOf = (b: any) => String(b?.data?._id ?? b?.conversation?._id ?? b?._id ?? b?.conversationId);
        const ca = idOf((await api({ user: a1, org: orgA }).post("/conversations").send({ receiverId: String(a2._id) })).body);
        const cb = idOf((await api({ user: b1, org: orgB }).post("/conversations").send({ receiverId: String(b2._id) })).body);
        await addMessage(ca, a1);
        await addMessage(cb, b1);
        const results = await Promise.all(Array.from({ length: 30 }, (_, i) => i % 2
            ? api({ user: a1, org: orgA }).get("/conversations").then((r) => ({ who: "A", body: JSON.stringify(r.body) }))
            : api({ user: b1, org: orgB }).get("/conversations").then((r) => ({ who: "B", body: JSON.stringify(r.body) }))));
        for (const r of results) {
            expect(r.body).toContain(r.who === "A" ? String(ca) : String(cb));
            expect(r.body).not.toContain(r.who === "A" ? String(cb) : String(ca));
        }
    });
});

// Requirement 9: aggregation and raw-query paths cannot bypass tenant isolation
describe("bypass paths", () => {
    it("aggregations on scoped models are filtered by context", async () => {
        const [a, b] = await Promise.all([makeUser(), makeUser()]);
        const T1 = new mongoose.Types.ObjectId().toString();
        const inT1 = await runWithContext(ctx(a._id, T1), () => Conversation.create({ members: [a._id, b._id], isGroup: false }));
        const glob = await runWithContext(ctx(a._id, null), () => Conversation.create({ members: [a._id, b._id], isGroup: false }));
        const rows = await runWithContext(ctx(a._id, null), () => Conversation.aggregate([{ $match: { members: a._id } }, { $group: { _id: null, ids: { $push: "$_id" } } }]));
        const ids = (rows[0]?.ids || []).map(String);
        expect(ids).toContain(String(glob._id));
        expect(ids).not.toContain(String(inT1._id));
    });

    it("no raw driver access or cross-collection $lookup outside reviewed files (static check)", () => {
        const root = path.join(__dirname, "..", "src");
        const files: string[] = [];
        const walk = (dir: string) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p);
            else if (p.endsWith(".ts")) files.push(p);
        });
        walk(root);
        const rel = (p: string) => path.relative(root, p).replace(/\\/g, "/");
        // Reviewed exceptions: migrations (system), the consistency checker (system-only), the Socket.IO
        // cluster (only its own infrastructure collections socket_io_events / runtime_instances; no tenant data)
        const rawAllowed = (f: string) => f.startsWith("migrations/") || f === "tenancy/consistency.ts" || f === "realtime/cluster.ts";
        const lookupAllowed = new Set(["services/conversationService.ts", "tenancy/consistency.ts"]);
        const scoped = /from:\s*["'](conversations|messages|calls|meetings|recordings|notifications|saved_messages)["']/;
        const offenders: string[] = [];
        for (const f of files) {
            const text = fs.readFileSync(f, "utf8");
            const r = rel(f);
            if (!rawAllowed(r) && /\.collection\.(find|aggregate|update|delete|insert|bulkWrite|replace|count|distinct)/.test(text)) offenders.push(`${r}: raw collection access`);
            if (!rawAllowed(r) && /mongoose\.connection\.db/.test(text)) offenders.push(`${r}: raw db access`);
            if (!lookupAllowed.has(r) && scoped.test(text)) offenders.push(`${r}: $lookup into a tenant-scoped collection`);
            if (/\.bulkWrite\(/.test(text) && /(Conversation|Message|Call|Meeting|Recording|Notification|SavedMessage)\.bulkWrite/.test(text)) offenders.push(`${r}: bulkWrite on a scoped model`);
        }
        expect(offenders).toEqual([]);
    });

    it("the consistency check finds and repairs records whose scope disagrees with their conversation", async () => {
        const [a, b] = await Promise.all([makeUser(), makeUser()]);
        const T1 = new mongoose.Types.ObjectId();
        const conv = await runAsSystem(() => Conversation.create({ members: [a._id, b._id], isGroup: false, tenantId: T1, scope: "tenant" }), "test-fixture");
        const ok = await addMessage(conv._id, a);
        expect(String(ok.tenantId)).toBe(String(T1));
        // A raw write (what the plugin can't see) leaves a message claiming to be global
        const bad = await Message.collection.insertOne({ conversationId: conv._id, userId: a._id, content: "x", type: "text", tenantId: null, scope: "global", createdAt: new Date() } as any);
        // Fail closed: invisible in the conversation's own workspace, and not visible globally either via its conversation
        const inT1 = await runWithContext(ctx(a._id, String(T1)), () => Message.find({ conversationId: conv._id }).lean());
        expect(inT1.map((m) => String(m._id))).not.toContain(String(bad.insertedId));
        const report = await runAsSystem(() => checkScopeConsistency({ fix: true }), "test");
        const messages = report.find((r) => r.model === "Message")!;
        expect(messages.mismatched).toBeGreaterThanOrEqual(1);
        expect(messages.sampleIds).toContain(String(bad.insertedId));
        const fixed = await runWithContext(ctx(a._id, String(T1)), () => Message.find({ conversationId: conv._id }).lean());
        expect(fixed.map((m) => String(m._id))).toContain(String(bad.insertedId));
        await expect(checkScopeConsistency()).rejects.toThrow(/must run as system/);
        expect(oid(conv._id)).toBeTruthy();
    });
});
