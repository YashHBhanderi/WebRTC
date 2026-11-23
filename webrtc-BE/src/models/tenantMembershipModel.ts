import mongoose, { Document, Schema } from "mongoose";

/**
 * Local projection of Clerk organization membership: "this user was seen acting in this
 * workspace with this role". Used for the tenant directory and for checking who may be added to
 * tenant conversations. It is NOT the authority for access: every request proves current
 * membership through the verified session token's active organization.
 *
 * Kept current by (1) use: each request in the workspace refreshes it, and (2) Clerk webhooks
 * (organizationMembership.*, organization.deleted, user.deleted). A removal is a tombstone
 * (status "removed" + removedAt) that also refuses still-valid session tokens issued earlier.
 * The role stored here is for display only; permissions always come from the session token.
 *
 * Organizations managed in SpreeWe (Tenant.managedBy = "spreewe") are different: this record IS the
 * authority. Access needs an active row here AND Clerk's session claim; the role (incl. owner and
 * guest) comes from here. Clerk is kept in sync (src/organizations/clerk-sync.ts).
 */
export type MembershipRole = "owner" | "admin" | "member" | "guest";
export interface ITenantMembership extends Document {
    tenantId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    role: MembershipRole;
    /** How the membership started (spreewe-managed organizations) */
    source?: "creator" | "invitation" | "request" | "code" | "open" | "clerk" | "app" | null;
    joinedAt?: Date | null;
    status: "active" | "removed";
    /** When Clerk removed the membership; tokens issued before this are refused for the workspace */
    removedAt?: Date | null;
    /** Timestamp (ms) of the newest Clerk event applied; older events are ignored */
    clerkEventAt?: number | null;
    lastSeenAt: Date;
    createdAt: Date;
    updatedAt: Date;
}

const TenantMembershipSchema = new Schema<ITenantMembership>({
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["owner", "admin", "member", "guest"], default: "member" },
    source: { type: String, enum: ["creator", "invitation", "request", "code", "open", "clerk", "app", null], default: null },
    joinedAt: { type: Date, default: null },
    status: { type: String, enum: ["active", "removed"], default: "active" },
    removedAt: { type: Date, default: null },
    clerkEventAt: { type: Number, default: null },
    lastSeenAt: { type: Date, default: Date.now },
}, { timestamps: true });

// One row per (tenant, user); "my workspaces" and "workspace directory" lookups
TenantMembershipSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
TenantMembershipSchema.index({ userId: 1, status: 1 });
TenantMembershipSchema.index({ tenantId: 1, status: 1 });

const TenantMembership = mongoose.model<ITenantMembership>("TenantMembership", TenantMembershipSchema);
export default TenantMembership;
