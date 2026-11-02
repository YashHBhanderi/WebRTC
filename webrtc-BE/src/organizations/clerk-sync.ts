import { clerkClient } from "@clerk/express";
import type { MembershipRole } from "../models/tenantMembershipModel";

/**
 * Clerk side of SpreeWe-managed organizations (server-to-server, Backend API; the secret key never
 * reaches a browser). Clerk only needs to know enough for its session to carry the active
 * organization: the organization itself and who belongs to it. Authority over membership and roles is
 * SpreeWe's (TenantMembership); see docs/organizations/clerk-integration.md.
 *
 * Every function is idempotent so a failed workflow can simply be retried or compensated:
 * "already a member" becomes a role update, "not found" on delete counts as done.
 */
export class ClerkSyncError extends Error {
    constructor(public readonly operation: string, public readonly code: string) {
        super(`Clerk ${operation} failed (${code})`);
        this.name = "ClerkSyncError";
    }
}

const codeOf = (error: unknown): string => {
    const e = error as { errors?: { code?: string }[]; status?: number; code?: string };
    return String(e?.errors?.[0]?.code || e?.code || (e?.status ? `http_${e.status}` : "unknown"));
};

/** SpreeWe role → Clerk role (this instance has only the built-in admin / member roles). */
export function clerkRoleFor(role: MembershipRole): "org:admin" | "org:member" {
    return role === "owner" || role === "admin" ? "org:admin" : "org:member";
}

/** 0 = unlimited (subject to the Clerk plan). CLERK_ORG_MAX_MEMBERSHIPS overrides. */
function maxMemberships(): number {
    const n = Number(process.env.CLERK_ORG_MAX_MEMBERSHIPS);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export async function createClerkOrganization(name: string, creatorClerkId: string): Promise<string> {
    try {
        // The marker lets the Clerk webhook recognise a SpreeWe-managed organization even before SpreeWe has stored it
        const org = await clerkClient.organizations.createOrganization({ name, createdBy: creatorClerkId, maxAllowedMemberships: maxMemberships(), publicMetadata: { managedBy: "spreewe" } });
        return org.id;
    } catch (error) {
        throw new ClerkSyncError("createOrganization", codeOf(error));
    }
}

export async function deleteClerkOrganization(clerkOrgId: string): Promise<void> {
    try {
        await clerkClient.organizations.deleteOrganization(clerkOrgId);
    } catch (error) {
        const code = codeOf(error);
        if (code === "resource_not_found" || code === "http_404") return;
        throw new ClerkSyncError("deleteOrganization", code);
    }
}

export async function ensureClerkMembership(clerkOrgId: string, clerkUserId: string, role: MembershipRole): Promise<void> {
    const clerkRole = clerkRoleFor(role);
    try {
        await clerkClient.organizations.createOrganizationMembership({ organizationId: clerkOrgId, userId: clerkUserId, role: clerkRole });
    } catch (error) {
        const code = codeOf(error);
        if (code !== "already_a_member_in_organization") throw new ClerkSyncError("createOrganizationMembership", code);
        try {
            await clerkClient.organizations.updateOrganizationMembership({ organizationId: clerkOrgId, userId: clerkUserId, role: clerkRole });
        } catch (inner) {
            throw new ClerkSyncError("updateOrganizationMembership", codeOf(inner));
        }
    }
}

export async function removeClerkMembership(clerkOrgId: string, clerkUserId: string): Promise<void> {
    try {
        await clerkClient.organizations.deleteOrganizationMembership({ organizationId: clerkOrgId, userId: clerkUserId });
    } catch (error) {
        const code = codeOf(error);
        if (code === "resource_not_found" || code === "http_404" || code === "not_a_member_in_organization") return;
        throw new ClerkSyncError("deleteOrganizationMembership", code);
    }
}

/** The caller's VERIFIED email addresses, read from Clerk now (not the stored profile copy). */
export async function verifiedEmailsOf(clerkUserId: string): Promise<string[]> {
    try {
        const user = await clerkClient.users.getUser(clerkUserId);
        return (user.emailAddresses || [])
            .filter((e: any) => e?.verification?.status === "verified")
            .map((e: any) => String(e.emailAddress).trim().toLowerCase());
    } catch (error) {
        throw new ClerkSyncError("getUser", codeOf(error));
    }
}
