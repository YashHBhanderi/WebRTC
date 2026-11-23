import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import Conversation from "../src/models/conversationModel";
import Notification from "../src/models/notificationModel";
import Meeting from "../src/models/meetingModel";
import { RequestContext, runAsSystem, runWithContext } from "../src/tenancy/context";
import { visibleIn } from "../src/tenancy/scope";
import { makeUser } from "./helpers";

const ctx = (userId: unknown, tenantId: string | null): RequestContext => ({
    kind: "user", userId: String(userId), tenantId, clerkOrgId: tenantId ? "org_x" : null, role: tenantId ? "member" : null, isPlatformAdmin: false,
});
const T1 = new mongoose.Types.ObjectId().toString();
const T2 = new mongoose.Types.ObjectId().toString();

describe("tenant scope plugin (data layer)", () => {
    it("stamps new conversations from the context, ignoring values in the input", async () => {
        const [a, b] = await Promise.all([makeUser(), makeUser()]);
        const created = await runWithContext(ctx(a._id, T1), () => Conversation.create({ members: [a._id, b._id], isGroup: false }));
        expect(String(created.tenantId)).toBe(T1);
        expect(created.scope).toBe("tenant");
        const global = await runWithContext(ctx(a._id, null), () => Conversation.create({ members: [a._id, b._id], isGroup: false }));
        expect(global.tenantId).toBeNull();
        expect(global.scope).toBe("global");
    });

    it("filters find, count, aggregate, distinct, update and delete by context", async () => {
        const [a, b] = await Promise.all([makeUser(), makeUser()]);
        const inT1 = await runWithContext(ctx(a._id, T1), () => Conversation.create({ members: [a._id, b._id], isGroup: false }));
        const inT2 = await runWithContext(ctx(a._id, T2), () => Conversation.create({ members: [a._id, b._id], isGroup: false }));

        await runWithContext(ctx(a._id, T1), async () => {
            const ids = (await Conversation.find({ members: a._id })).map((c) => String(c._id));
            expect(ids).toContain(String(inT1._id));
            expect(ids).not.toContain(String(inT2._id));
            expect(await Conversation.findById(inT2._id)).toBeNull();
            expect(await Conversation.exists({ _id: inT2._id })).toBeNull();
            expect(await Conversation.countDocuments({ members: a._id })).toBe(1);
            const agg = await Conversation.aggregate([{ $match: { members: a._id } }]);
            expect(agg.map((c) => String(c._id))).toEqual([String(inT1._id)]);
            expect((await Conversation.distinct("_id", { members: a._id })).map(String)).toEqual([String(inT1._id)]);
            // A query that already uses $or keeps its own condition (AND-ed, never replaced)
            expect(await Conversation.countDocuments({ $or: [{ _id: inT2._id }, { _id: inT1._id }] })).toBe(1);
            const upd = await Conversation.updateOne({ _id: inT2._id }, { $set: { groupDescription: "hacked" } });
            expect(upd.matchedCount).toBe(0);
            const del = await Conversation.deleteOne({ _id: inT2._id });
            expect(del.deletedCount).toBe(0);
        });
        // System context (migrations, timers) still sees everything
        expect(await runAsSystem(() => Conversation.countDocuments({ members: a._id }))).toBe(2);
    });

    it("derived records take their conversation's scope, including insertMany", async () => {
        const [a, b] = await Promise.all([makeUser(), makeUser()]);
        const conv = await runWithContext(ctx(a._id, T1), () => Conversation.create({ members: [a._id, b._id], isGroup: true, groupName: "Ops" }));
        // Created from a different (global) context: the record still belongs to T1
        const [n] = await runWithContext(ctx(b._id, null), () => Notification.insertMany([{ userId: b._id, type: "mention", conversationId: conv._id, text: "hi" }]));
        expect(String(n.tenantId)).toBe(T1);
        expect(n.scope).toBe("tenant");
        await runWithContext(ctx(b._id, null), async () => {
            expect(await Notification.countDocuments({ userId: b._id })).toBe(0);
        });
        await runWithContext(ctx(b._id, T1), async () => {
            expect(await Notification.countDocuments({ userId: b._id })).toBe(1);
        });
        const meeting = await runAsSystem(() => Meeting.create({
            title: "Sync", organizerId: a._id, conversationId: conv._id, startAt: new Date(), endAt: new Date(Date.now() + 60_000), code: `c${Date.now()}`,
        } as any));
        expect(String(meeting.tenantId)).toBe(T1);
    });

    it("visibility rules for socket delivery", () => {
        const u = "u1";
        expect(visibleIn({ tenantId: null, scope: "global", externalParticipants: [] }, null, u)).toBe(true);
        expect(visibleIn({ tenantId: null, scope: "global", externalParticipants: [] }, T1, u)).toBe(false);
        expect(visibleIn({ tenantId: T1, scope: "tenant", externalParticipants: [] }, T1, u)).toBe(true);
        expect(visibleIn({ tenantId: T1, scope: "tenant", externalParticipants: [] }, T2, u)).toBe(false);
        expect(visibleIn({ tenantId: T1, scope: "tenant", externalParticipants: [] }, null, u)).toBe(false);
        expect(visibleIn({ tenantId: T1, scope: "external", externalParticipants: [u] }, null, u)).toBe(true);
        expect(visibleIn({ tenantId: T1, scope: "external", externalParticipants: [u] }, T2, "someoneElse")).toBe(false);
    });
});
