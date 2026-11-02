import mongoose, { Schema } from "mongoose";
import { tenantScopePlugin } from "../tenancy/scope";
import type { MembershipRole } from "../models/tenantMembershipModel";

/**
 * Organization management (SpreeWe-managed organizations). Invitations, join requests and the audit
 * log are administrative records: they are read and written only by src/organizations/*.service.ts,
 * which always filters by the organization explicitly (and runs as system). Teams and team
 * memberships are workspace data and carry the fail-closed tenant scope plugin.
 */

// ------------------------------------------------------------------ invitations

export interface IOrgInvitation {
    _id: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
    /** Lower-cased; matched against the accepting user's VERIFIED Clerk emails */
    email: string;
    role: Exclude<MembershipRole, "owner">;
    /** sha256 of the secret link token (the token itself is shown once and never stored) */
    tokenHash: string;
    status: "pending" | "accepted" | "revoked" | "expired";
    expiresAt: Date;
    invitedBy: mongoose.Types.ObjectId;
    acceptedBy?: mongoose.Types.ObjectId | null;
    decidedAt?: Date | null;
    sentCount: number;
    createdAt: Date;
    updatedAt: Date;
}

const InvitationSchema = new Schema<IOrgInvitation>({
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    role: { type: String, enum: ["admin", "member", "guest"], default: "member" },
    tokenHash: { type: String, required: true },
    status: { type: String, enum: ["pending", "accepted", "revoked", "expired"], default: "pending" },
    expiresAt: { type: Date, required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    acceptedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
    sentCount: { type: Number, default: 1 },
}, { timestamps: true, collection: "org_invitations" });
InvitationSchema.index({ tokenHash: 1 }, { unique: true });
// At most one open invitation per address per organization
InvitationSchema.index({ tenantId: 1, email: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });
InvitationSchema.index({ email: 1, status: 1 });
InvitationSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

export const OrgInvitation = mongoose.model<IOrgInvitation>("OrgInvitation", InvitationSchema);

// ------------------------------------------------------------------ join requests

export interface IJoinRequest {
    _id: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    message: string;
    status: "pending" | "approved" | "rejected" | "cancelled";
    decidedBy?: mongoose.Types.ObjectId | null;
    decidedAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
}

const JoinRequestSchema = new Schema<IJoinRequest>({
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    message: { type: String, default: "", maxlength: 500 },
    status: { type: String, enum: ["pending", "approved", "rejected", "cancelled"], default: "pending" },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    decidedAt: { type: Date, default: null },
}, { timestamps: true, collection: "org_join_requests" });
JoinRequestSchema.index({ tenantId: 1, userId: 1 }, { unique: true, partialFilterExpression: { status: "pending" } });
JoinRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
JoinRequestSchema.index({ userId: 1, status: 1 });

export const JoinRequest = mongoose.model<IJoinRequest>("JoinRequest", JoinRequestSchema);

// ------------------------------------------------------------------ audit

export interface IOrgAuditEvent {
    tenantId: mongoose.Types.ObjectId;
    actorId: mongoose.Types.ObjectId | null;
    action: string;
    /** Ids and short codes only — never message content, tokens or emails of non-members */
    target?: Record<string, unknown>;
    at: Date;
}

const OrgAuditSchema = new Schema<IOrgAuditEvent>({
    tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    action: { type: String, required: true, maxlength: 80 },
    target: { type: Schema.Types.Mixed, default: {} },
    at: { type: Date, default: Date.now },
}, { collection: "org_audit_events" });
OrgAuditSchema.index({ tenantId: 1, at: -1 });

export const OrgAuditEvent = mongoose.model<IOrgAuditEvent>("OrgAuditEvent", OrgAuditSchema);

// ------------------------------------------------------------------ teams

export type TeamVisibility = "public" | "private";
export type TeamRole = "owner" | "manager" | "member";

export interface ITeam {
    _id: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
    name: string;
    description: string;
    avatar: string;
    /** public: any non-guest organization member may see and join it; private: by team owners only */
    visibility: TeamVisibility;
    status: "active" | "archived";
    createdBy: mongoose.Types.ObjectId;
    settings: { membersCanCreateChannels: boolean; membersCanAddMembers: boolean };
    createdAt: Date;
    updatedAt: Date;
}

const TeamSchema = new Schema<ITeam>({
    name: { type: String, required: true, trim: true, maxlength: 80 },
    description: { type: String, default: "", maxlength: 500 },
    avatar: { type: String, default: "" },
    visibility: { type: String, enum: ["public", "private"], default: "public" },
    status: { type: String, enum: ["active", "archived"], default: "active" },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    settings: {
        type: new Schema({ membersCanCreateChannels: { type: Boolean, default: true }, membersCanAddMembers: { type: Boolean, default: false } }, { _id: false }),
        default: () => ({ membersCanCreateChannels: true, membersCanAddMembers: false }),
    },
}, { timestamps: true, collection: "teams" });
TeamSchema.plugin(tenantScopePlugin, { kind: "tenant" });
TeamSchema.index({ tenantId: 1, name: 1 }, { unique: true, partialFilterExpression: { status: "active" }, collation: { locale: "en", strength: 2 } });

export const Team = mongoose.model<ITeam>("Team", TeamSchema);

export interface ITeamMembership {
    _id: mongoose.Types.ObjectId;
    tenantId: mongoose.Types.ObjectId;
    teamId: mongoose.Types.ObjectId;
    userId: mongoose.Types.ObjectId;
    role: TeamRole;
    status: "active" | "removed";
    createdAt: Date;
    updatedAt: Date;
}

const TeamMembershipSchema = new Schema<ITeamMembership>({
    teamId: { type: Schema.Types.ObjectId, ref: "Team", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    role: { type: String, enum: ["owner", "manager", "member"], default: "member" },
    status: { type: String, enum: ["active", "removed"], default: "active" },
}, { timestamps: true, collection: "team_memberships" });
TeamMembershipSchema.plugin(tenantScopePlugin, { kind: "tenant" });
TeamMembershipSchema.index({ teamId: 1, userId: 1 }, { unique: true });
TeamMembershipSchema.index({ tenantId: 1, userId: 1, status: 1 });

export const TeamMembership = mongoose.model<ITeamMembership>("TeamMembership", TeamMembershipSchema);
