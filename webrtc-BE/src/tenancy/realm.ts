import mongoose from "mongoose";
import User from "../models/userModel";
import { ForbiddenError } from "../utils/errors";
import { RequestContext, realmOf, runAsSystem } from "./context";

/**
 * Identity realms. Every user belongs to exactly one realm, fixed at creation:
 *   null            SpreeWe accounts (Clerk sign-in): the personal app and organization workspaces
 *   <app tenant id> users a developer application registered through the API; they exist only in
 *                   that application's dedicated tenant
 * People of different realms can never be put in the same conversation, group, meeting or call, and
 * can't look each other up. The users model filters by realm inside user requests; these helpers
 * cover the places that deliberately read users as system.
 */
const oid = (id: string) => new mongoose.Types.ObjectId(id);

/** Filter fragment for explicit (system) user queries: only users of this context's realm. */
export function realmUserFilter(ctx: RequestContext | null | undefined): { tenantId: mongoose.Types.ObjectId | null } {
    const realm = realmOf(ctx);
    return { tenantId: realm ? oid(realm) : null };
}

/** Is at least one of these users outside the context's realm? (Unknown ids are not judged here.) */
export async function anyOutsideRealm(ctx: RequestContext | null | undefined, userIds: unknown[]): Promise<boolean> {
    const ids = [...new Set(userIds.map(String))].filter((id) => mongoose.isValidObjectId(id));
    if (!ids.length) return false;
    const realm = realmOf(ctx);
    const foreign = await runAsSystem(() => User.exists({
        _id: { $in: ids.map(oid) },
        // null realm: anyone with a home tenant is foreign. App realm: anyone not in exactly this tenant.
        tenantId: realm ? { $ne: oid(realm) } : { $ne: null },
    }), "realm-check");
    return !!foreign;
}

/**
 * Refuse to involve people of another realm. The message is the same as for an unknown person, so
 * ids of another application's users can't be probed.
 */
export async function assertSameRealm(ctx: RequestContext | null | undefined, userIds: unknown[]): Promise<void> {
    if (await anyOutsideRealm(ctx, userIds)) {
        throw new ForbiddenError("Some people could not be found");
    }
}
