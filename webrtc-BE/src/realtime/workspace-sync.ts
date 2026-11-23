import { TenantRole } from "../tenancy/context";
import { forgetMembership, forgetTenant } from "../tenancy/tenant.service";
import { forgetConversationScope } from "../tenancy/scope";
import { disconnectWorkspaceSockets, socketContexts } from "./io";
import { onCluster, publish } from "./cluster";

/**
 * Keeps authorization state that lives in memory (per instance) in step with the database after a
 * membership or workspace change, on EVERY instance:
 *   - membership / tenant / conversation-scope caches are dropped (they were only cleared locally);
 *   - live sockets get the new role in place (their context is fixed at the handshake, and every
 *     handler of that socket reads the same object), or are disconnected when access ended.
 * Without this, a demoted member kept member rules on socket paths until reconnecting.
 */

/** The member's role changed (or access ended: role null). Call after the database write. */
export function syncMembership(tenantId: string, userId: string, role: TenantRole | null): void {
    applyMembershipLocally(String(tenantId), String(userId), role);
    publish({ kind: "membership", tenantId: String(tenantId), userId: String(userId), role });
    if (role === null) {
        // All of the user's sockets in that workspace, on every instance (rooms are left on disconnect)
        disconnectWorkspaceSockets(String(tenantId), String(userId));
    }
}

function applyMembershipLocally(tenantId: string, userId: string, role: TenantRole | null): void {
    forgetMembership(tenantId, userId);
    if (role === null) {
        return;
    }
    for (const ctx of socketContexts.values()) {
        if (!ctx.app && ctx.tenantId === tenantId && String(ctx.userId) === userId) {
            ctx.role = role;
        }
    }
}

/** The workspace itself changed (settings, policies, status): drop the cached copy everywhere. */
export function syncTenant(tenantId: string): void {
    forgetTenant(String(tenantId));
    forgetMembership(String(tenantId));
    publish({ kind: "tenant", tenantId: String(tenantId) });
}

/** A conversation's audience changed (e.g. external participants of a shared channel). */
export function syncConversationScope(conversationId: unknown): void {
    forgetConversationScope(String(conversationId));
    publish({ kind: "conversation-scope", conversationId: String(conversationId) });
}

onCluster("membership", (m) => applyMembershipLocally(String(m.tenantId), String(m.userId), (m.role as TenantRole | null) ?? null));
onCluster("tenant", (m) => { forgetTenant(String(m.tenantId)); forgetMembership(String(m.tenantId)); });
onCluster("conversation-scope", (m) => forgetConversationScope(String(m.conversationId)));
