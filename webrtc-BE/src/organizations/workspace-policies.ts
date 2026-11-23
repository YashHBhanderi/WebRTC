import { RequestContext } from "../tenancy/context";
import { updatePolicies } from "../tenancy/tenant.service";
import { syncTenant } from "../realtime/workspace-sync";
import { orgEvents } from "./events";

/**
 * Workspace policies (external chat, calls, files...) for both API surfaces: the change itself is in
 * tenant.service; here every instance drops its cached copy and open views of the workspace refresh.
 */
export async function updateWorkspacePolicies(ctx: RequestContext, input: unknown) {
    const summary = await updatePolicies(ctx, input);
    if (ctx.tenantId) {
        syncTenant(ctx.tenantId);
        orgEvents.updated(ctx.tenantId);
    }
    return summary;
}
