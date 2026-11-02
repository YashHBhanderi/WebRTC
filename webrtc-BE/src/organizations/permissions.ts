import type { MembershipRole } from "../models/tenantMembershipModel";
import type { ITenantSettings } from "../models/tenantModel";
import { DEFAULT_TENANT_SETTINGS } from "../models/tenantModel";

/**
 * Organization permission matrix (single source of truth; documented in
 * docs/organizations/membership-and-permissions.md and tested in test/organizations.test.ts).
 * The role always comes from the server's membership record, never from the client.
 * Platform administrators get nothing here.
 */
export type OrgAction =
    | "org:read"
    | "org:update"
    | "org:delete"
    | "org:audit"
    | "members:read"
    | "members:invite"
    | "members:remove"
    | "members:role"
    | "requests:decide"
    | "joincode:manage"
    | "teams:create"
    | "directory:read";

const ADMIN: MembershipRole[] = ["owner", "admin"];

export function orgCan(role: MembershipRole | null | undefined, action: OrgAction, settings: Partial<ITenantSettings> = DEFAULT_TENANT_SETTINGS): boolean {
    if (!role) return false;
    const s = { ...DEFAULT_TENANT_SETTINGS, ...settings };
    switch (action) {
        case "org:read":
            return true;
        case "members:read":
        case "directory:read":
            return role !== "guest";
        case "org:update":
        case "org:audit":
        case "requests:decide":
        case "joincode:manage":
        case "members:remove":
        case "members:role":
            return ADMIN.includes(role);
        case "org:delete":
            return role === "owner";
        case "members:invite":
            return ADMIN.includes(role) || (role === "member" && s.membersCanInvite);
        case "teams:create":
            return ADMIN.includes(role) || (role === "member" && s.membersCanCreateTeams);
        default:
            return false;
    }
}

/** Roles a user with `actor` may hand out in an invitation. */
export function invitableRoles(actor: MembershipRole, settings: Partial<ITenantSettings> = DEFAULT_TENANT_SETTINGS): MembershipRole[] {
    const s = { ...DEFAULT_TENANT_SETTINGS, ...settings };
    const guest: MembershipRole[] = s.guestAccess ? ["guest"] : [];
    switch (actor) {
        case "owner": return ["admin", "member", ...guest];
        case "admin": return ["member", ...guest];
        case "member": return s.membersCanInvite ? ["member"] : [];
        default: return [];
    }
}

/**
 * May `actor` change `target`'s role from `from` to `to`? Nobody changes their own role (ownership is
 * transferred explicitly); admins manage members and guests only; owners manage everyone. The
 * last-owner rule is checked by the caller against the database.
 */
export function mayChangeRole(actor: MembershipRole, from: MembershipRole, to: MembershipRole, self: boolean): boolean {
    if (self || from === to) return false;
    if (actor === "owner") return true;
    if (actor === "admin") return (from === "member" || from === "guest") && (to === "member" || to === "guest");
    return false;
}

/** May `actor` remove a member with role `target`? (Not themselves: that is "leave".) */
export function mayRemove(actor: MembershipRole, target: MembershipRole, self: boolean): boolean {
    if (self) return false;
    if (actor === "owner") return true;
    if (actor === "admin") return target === "member" || target === "guest";
    return false;
}
