import mongoose, { Document, Schema } from "mongoose";

/**
 * Tenant-level policies. Everything that lets data leave the workspace is OFF by default and
 * can only be enabled by a tenant owner/admin (enforced on the server).
 */
export interface ITenantPolicies {
    /** Members may start chats with people outside the organization */
    allowExternalChat: boolean;
    /** Calls / meetings are allowed in external conversations */
    allowExternalCalls: boolean;
    /** Files may be shared in external conversations */
    allowExternalFiles: boolean;
    /** Plain members (not only admins) may start external conversations */
    membersCanStartExternal: boolean;
}

export const DEFAULT_TENANT_POLICIES: ITenantPolicies = {
    allowExternalChat: false,
    allowExternalCalls: false,
    allowExternalFiles: false,
    membersCanStartExternal: false,
};

/**
 * How people may become members (backend-enforced; see docs/organizations/membership-and-permissions.md).
 *   invite   only through an invitation (private organizations)
 *   request  anyone who can see the organization may ask; an owner / admin approves
 *   open     anyone who can see it may join directly (still restricted by allowedEmailDomains)
 */
export type JoinPolicy = "invite" | "request" | "open";

export interface ITenantSettings {
    /** Listed in organization discovery. Never grants access to content by itself */
    discoverable: boolean;
    joinPolicy: JoinPolicy;
    /** Lower-case domains; when non-empty only verified emails on these domains may join or be invited */
    allowedEmailDomains: string[];
    /** Plain members may invite (as members only) */
    membersCanInvite: boolean;
    /** Plain members may create teams */
    membersCanCreateTeams: boolean;
    /** Guests may be invited at all */
    guestAccess: boolean;
    /** Join by code / link (hash stored; the code is shown once) */
    joinCodeEnabled: boolean;
}

export const DEFAULT_TENANT_SETTINGS: ITenantSettings = {
    discoverable: false,
    joinPolicy: "invite",
    allowedEmailDomains: [],
    membersCanInvite: false,
    membersCanCreateTeams: true,
    guestAccess: false,
    joinCodeEnabled: false,
};

/**
 * An organization workspace. Membership and invitations live in Clerk Organizations; this
 * document holds what Clerk doesn't: our policies, status and the stable local id that every
 * tenant-scoped record references.
 */
export interface ITenant extends Document {
    /**
     * organization (or missing): a Clerk / SpreeWe organization workspace.
     * app: the dedicated workspace of ONE developer application. Its members are only the users that
     * application registered (User.tenantId); no Clerk session can ever enter it.
     */
    kind?: "organization" | "app";
    /** kind "app": the application this tenant belongs to */
    appId?: mongoose.Types.ObjectId | null;
    /** Clerk organization id ("org_…"), stable external reference. Absent for application tenants. */
    clerkOrgId: string;
    name: string;
    slug: string;
    /** deleted = organization deleted in Clerk (data kept, access refused) */
    status: "active" | "suspended" | "deleted";
    deletedAt?: Date | null;
    /** Timestamp (ms) of the newest Clerk event applied; older events are ignored */
    clerkEventAt?: number | null;
    policies: ITenantPolicies;
    /**
     * spreewe: created and administered in SpreeWe; membership and roles are SpreeWe's (Clerk only
     * proves the session). clerk (or missing): created in Clerk; the session's role is used as before.
     */
    managedBy?: "spreewe" | "clerk";
    description?: string;
    avatar?: string;
    settings?: ITenantSettings;
    /** sha256 of the current join code (null = none) */
    joinCodeHash?: string | null;
    createdBy?: mongoose.Types.ObjectId | null;
    createdAt: Date;
    updatedAt: Date;
}

const PoliciesSchema = new Schema<ITenantPolicies>({
    allowExternalChat: { type: Boolean, default: false },
    allowExternalCalls: { type: Boolean, default: false },
    allowExternalFiles: { type: Boolean, default: false },
    membersCanStartExternal: { type: Boolean, default: false },
}, { _id: false });

const TenantSchema = new Schema<ITenant>({
    kind: { type: String, enum: ["organization", "app"], default: "organization" },
    appId: { type: Schema.Types.ObjectId, ref: "DeveloperApp", default: null },
    clerkOrgId: {
        type: String, match: /^org_[A-Za-z0-9]+$/, default: undefined,
        required: [function (this: ITenant) { return this.kind !== "app"; }, "clerkOrgId is required for organizations"],
    },
    name: { type: String, default: "", maxlength: 200 },
    slug: { type: String, default: "", maxlength: 200 },
    status: { type: String, enum: ["active", "suspended", "deleted"], default: "active" },
    deletedAt: { type: Date, default: null },
    clerkEventAt: { type: Number, default: null },
    policies: { type: PoliciesSchema, default: () => ({ ...DEFAULT_TENANT_POLICIES }) },
    managedBy: { type: String, enum: ["spreewe", "clerk"], default: "clerk" },
    description: { type: String, default: "", maxlength: 500 },
    avatar: { type: String, default: "" },
    settings: {
        type: new Schema<ITenantSettings>({
            discoverable: { type: Boolean, default: false },
            joinPolicy: { type: String, enum: ["invite", "request", "open"], default: "invite" },
            allowedEmailDomains: { type: [String], default: [] },
            membersCanInvite: { type: Boolean, default: false },
            membersCanCreateTeams: { type: Boolean, default: true },
            guestAccess: { type: Boolean, default: false },
            joinCodeEnabled: { type: Boolean, default: false },
        }, { _id: false }),
        default: () => ({ ...DEFAULT_TENANT_SETTINGS }),
    },
    joinCodeHash: { type: String, default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
}, { timestamps: true });

// Application tenants have no Clerk organization: unique among the tenants that have one
TenantSchema.index({ clerkOrgId: 1 }, { unique: true, partialFilterExpression: { clerkOrgId: { $type: "string" } } });
// One dedicated tenant per application
TenantSchema.index({ appId: 1 }, { unique: true, partialFilterExpression: { kind: "app" } });
// An application tenant never carries a Clerk organization id
TenantSchema.pre("validate", function (this: ITenant) {
    if (this.kind === "app") {
        if (!this.appId) this.invalidate("appId", "An application tenant needs its appId");
        if (this.clerkOrgId) this.invalidate("clerkOrgId", "An application tenant has no Clerk organization");
    }
});
// SpreeWe-managed organizations have unique slugs (legacy Clerk tenants may share or lack one)
TenantSchema.index({ slug: 1 }, { unique: true, partialFilterExpression: { managedBy: "spreewe" } });
TenantSchema.index({ "settings.discoverable": 1, status: 1 });

const Tenant = mongoose.model<ITenant>("Tenant", TenantSchema);
export default Tenant;
