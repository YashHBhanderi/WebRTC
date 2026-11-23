import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { Team, TeamMembership } from "../src/organizations/models";
import { RequestContext, runAsSystem, runWithContext } from "../src/tenancy/context";

/**
 * The "tenant" scope kind (teams, team memberships): workspace-owned records. Fail-closed: no context
 * refuses; the personal context sees nothing; inserts AND upserts are stamped with the verified
 * workspace (an upsert once stored tenantId null — invisible, silently breaking team membership).
 */
const ctxFor = (tenantId: string | null, userId = new mongoose.Types.ObjectId().toString()): RequestContext => ({ kind: "user", userId, tenantId, clerkOrgId: tenantId ? "org_x" : null, role: tenantId ? "member" : null, isPlatformAdmin: false });

describe("tenant-owned scope kind", () => {
    it("inserts and upserts are stamped with the active workspace; other workspaces and the personal context see nothing", async () => {
        const a = new mongoose.Types.ObjectId().toString(), b = new mongoose.Types.ObjectId().toString();
        const user = new mongoose.Types.ObjectId();
        const team = await runWithContext(ctxFor(a), () => Team.create({ name: "Alpha " + Date.now(), createdBy: user, tenantId: new mongoose.Types.ObjectId(b) /* ignored */ }));
        expect(String(team.tenantId)).toBe(a);
        await runWithContext(ctxFor(a), () => TeamMembership.updateOne({ teamId: team._id, userId: user }, { $set: { role: "member", status: "active" } }, { upsert: true }));
        const row = await runAsSystem(() => TeamMembership.findOne({ teamId: team._id, userId: user }).lean(), "test");
        expect(String(row!.tenantId)).toBe(a);
        expect(row!.scope).toBe("tenant");
        expect(await runWithContext(ctxFor(a), () => TeamMembership.countDocuments({ teamId: team._id }))).toBe(1);
        expect(await runWithContext(ctxFor(b), () => TeamMembership.countDocuments({ teamId: team._id }))).toBe(0);
        expect(await runWithContext(ctxFor(null), () => Team.countDocuments({ _id: team._id }))).toBe(0);
    });

    it("refuses: no context at all, creating outside a workspace, upserting outside a workspace", async () => {
        await expect(Team.find({})).rejects.toThrow(/context/i);
        await expect(runWithContext(ctxFor(null), () => Team.create({ name: "Nope", createdBy: new mongoose.Types.ObjectId() }))).rejects.toThrow(/workspace/i);
        await expect(runWithContext(ctxFor(null), () => TeamMembership.updateOne({ teamId: new mongoose.Types.ObjectId(), userId: new mongoose.Types.ObjectId() }, { $set: { role: "member" } }, { upsert: true }))).rejects.toThrow(/workspace/i);
    });
});
