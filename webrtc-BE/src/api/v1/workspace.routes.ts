import mongoose from "mongoose";
import TenantMembership from "../../models/tenantMembershipModel";
import User from "../../models/userModel";
import { AppAuditEvent, AppGrant, DeveloperApp, IDeveloperApp } from "../../developer/models";
import { runAsSystem } from "../../tenancy/context";
import { AppError, ForbiddenError, NotFoundError } from "../../utils/errors";
import { defineRoute } from "./registry";
import { S } from "./schema";

/**
 * Workspace administration views. Members (any member except guests may read; invitations and role changes are
 * done in Clerk, which owns membership), and the workspace's apps (owners / admins only).
 */
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const admin = (role: string | null) => role === "owner" || role === "admin";

defineRoute({
    method: "get", path: "/workspace/members", tag: "Workspace", workspace: true, paginated: true,
    summary: "Members of the active workspace with role and status (roles / invitations are managed in Clerk)",
    query: S.object({ limit: S.int({ optional: true, min: 1, max: 100, default: 50 }), cursor: S.objectId({ optional: true }) }),
    response: S.doc({ type: "object", properties: { userId: { type: "string" }, username: { type: "string" }, avatar: { type: "string" }, role: { type: "string", enum: ["owner", "admin", "member", "guest"] }, status: { type: "string", enum: ["active", "removed"] }, lastSeenAt: { type: "string", format: "date-time" } } }),
    handler: async ({ ctx, query }) => {
        if (ctx.role === "guest") throw new ForbiddenError("Guests can't see the organization's member list");
        const filter: Record<string, unknown> = { tenantId: oid(ctx.tenantId!) };
        // Removed members are only listed to admins
        if (!admin(ctx.role)) filter.status = "active";
        if (query.cursor) filter._id = { $gt: oid(query.cursor) };
        const rows = await runAsSystem(() => TenantMembership.find(filter).sort({ _id: 1 }).limit(query.limit + 1).lean(), "workspace-members");
        const page = rows.slice(0, query.limit);
        const users = await runAsSystem(() => User.find({ _id: { $in: page.map((r) => r.userId) } }).select("username avatar").lean(), "workspace-members");
        const byId = new Map(users.map((u: any) => [String(u._id), u]));
        return {
            items: page.map((r) => ({ userId: String(r.userId), username: (byId.get(String(r.userId)) as any)?.username || "", avatar: (byId.get(String(r.userId)) as any)?.avatar || "", role: r.role, status: r.status, lastSeenAt: r.lastSeenAt })),
            nextCursor: rows.length > query.limit ? String(page[page.length - 1]._id) : null,
        };
    },
});

defineRoute({
    method: "get", path: "/workspace/apps", tag: "Workspace", workspace: true,
    summary: "Apps bound to this workspace, with how many members authorised each (owners / admins)",
    response: S.doc({ type: "array", items: { type: "object", properties: { _id: { type: "string" }, name: { type: "string" }, environment: { type: "string" }, status: { type: "string" }, scopes: { type: "array", items: { type: "string" } }, grants: { type: "integer" } } } }),
    handler: async ({ ctx }) => {
        if (!admin(ctx.role)) throw new ForbiddenError("Only workspace owners and admins can see the workspace's apps");
        const apps = await runAsSystem(() => DeveloperApp.find({ tenantId: oid(ctx.tenantId!) }).sort({ createdAt: -1 }).limit(200).lean<IDeveloperApp[]>(), "workspace-apps");
        const counts = await runAsSystem(() => AppGrant.aggregate([{ $match: { appId: { $in: apps.map((a) => a._id) }, status: "active" } }, { $group: { _id: "$appId", n: { $sum: 1 } } }]), "workspace-apps");
        const byApp = new Map(counts.map((c: any) => [String(c._id), c.n]));
        return apps.map((a) => ({ _id: String(a._id), name: a.name, environment: a.environment, status: a.status, scopes: a.scopes, grants: byApp.get(String(a._id)) || 0 }));
    },
});

defineRoute({
    method: "post", path: "/workspace/apps/:appId/revoke-grants", tag: "Workspace", workspace: true, sensitive: true, errors: [404],
    summary: "Withdraw every member's authorisation for a workspace app (owners / admins; confirmation). Their tokens stop working",
    params: S.object({ appId: S.objectId() }), body: S.object({ confirm: S.string({ max: 80, description: "The app's exact name" }) }),
    response: S.doc({ type: "object", properties: { revoked: { type: "integer" } } }),
    handler: async ({ ctx, params, body }) => {
        if (!admin(ctx.role)) throw new ForbiddenError("Only workspace owners and admins can do this");
        const app = await runAsSystem(() => DeveloperApp.findOne({ _id: oid(params.appId), tenantId: oid(ctx.tenantId!) }).lean<IDeveloperApp>(), "workspace-apps");
        if (!app) throw new NotFoundError("App not found");
        if (body.confirm !== app.name) throw new AppError("Confirm with the app's exact name");
        const res = await runAsSystem(() => AppGrant.updateMany({ appId: app._id, status: "active" }, { $set: { status: "revoked" }, $inc: { version: 1 } }), "workspace-apps");
        await runAsSystem(() => AppAuditEvent.create({ appId: app._id, actorUserId: oid(ctx.userId), actorKind: "owner", action: "grants.revoked_by_workspace_admin", details: { count: res.modifiedCount }, at: new Date() }), "app-audit");
        return { revoked: res.modifiedCount };
    },
});
