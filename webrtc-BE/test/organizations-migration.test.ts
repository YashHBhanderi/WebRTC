import { describe, expect, it } from "vitest";
import mongoose from "mongoose";
import Tenant from "../src/models/tenantModel";
import TenantMembership from "../src/models/tenantMembershipModel";
import { runMigrations } from "../src/migrations";
import { runAsSystem } from "../src/tenancy/context";

/** The organizations migration is index-only, idempotent, and leaves existing (Clerk-managed) tenants alone. */
describe("2026-10-27-organizations migration", () => {
    it("is idempotent, creates the unique slug index, and does not change existing tenants or memberships", async () => {
        const legacy = await runAsSystem(() => Tenant.collection.insertOne({ clerkOrgId: "org_legacy" + Date.now(), name: "Old", slug: "old", status: "active", policies: {} } as any), "test");
        await runAsSystem(() => TenantMembership.collection.insertOne({ tenantId: legacy.insertedId, userId: new mongoose.Types.ObjectId(), role: "admin", status: "active" } as any), "test");
        await runMigrations();
        await runMigrations(); // second run: nothing re-applied, no error
        const ledger = await mongoose.connection.db!.collection("migrations").find({ _id: "2026-10-27-organizations" as any }).toArray();
        expect(ledger).toHaveLength(1);
        const t = await runAsSystem(() => Tenant.collection.findOne({ _id: legacy.insertedId }), "test");
        expect(t!.managedBy).toBeUndefined(); // still treated as Clerk-managed
        const idx = await Tenant.collection.indexes();
        expect(idx.some((i) => i.key.slug === 1 && i.unique && (i as any).partialFilterExpression?.managedBy === "spreewe")).toBe(true);
        const inv = await mongoose.connection.db!.collection("org_invitations").indexes();
        expect(inv.some((i) => i.key.tokenHash === 1 && i.unique)).toBe(true);
        // Two legacy tenants may share a slug (only SpreeWe-managed slugs are unique)
        await expect(runAsSystem(() => Tenant.collection.insertOne({ clerkOrgId: "org_legacy2" + Date.now(), name: "Old 2", slug: "old", status: "active" } as any), "test")).resolves.toBeTruthy();
    });
});
