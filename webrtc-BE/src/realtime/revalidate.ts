import mongoose from "mongoose";
import Tenant from "../models/tenantModel";
import TenantMembership from "../models/tenantMembershipModel";
import { runAsSystem } from "../tenancy/context";
import { io, socketContexts } from "./io";
import { verifyUserToken } from "../developer/app.service";

/**
 * Cross-instance revocation for LIVE sockets without shared infrastructure: every
 * SOCKET_REVALIDATE_MS (default 30000; 0 = off) each instance re-checks the workspace sockets it
 * holds against MongoDB (membership tombstones, tenant status) and disconnects those no longer
 * allowed. The webhook disconnects immediately only on the instance that received it; others
 * follow within this interval. New requests / connections are checked on every instance by
 * resolveContext (see MEMBERSHIP_CHECK_CACHE_MS).
 */
export async function revalidateWorkspaceSockets(): Promise<number> {
    let count = await revalidateAppSockets();
    const live = [...socketContexts.entries()].filter(([, ctx]) => !!ctx.tenantId && !ctx.app);
    if (!live.length) return count;
    const tenantIds = [...new Set(live.map(([, c]) => c.tenantId!))];
    const userIds = [...new Set(live.map(([, c]) => c.userId))];
    const { inactiveTenants, removed } = await runAsSystem(async () => {
        const tenants = await Tenant.find({ _id: { $in: tenantIds.map((id) => new mongoose.Types.ObjectId(id)) }, status: { $ne: "active" } }).select("_id").lean();
        const rows = await TenantMembership.find({
            tenantId: { $in: tenantIds.map((id) => new mongoose.Types.ObjectId(id)) },
            userId: { $in: userIds.map((id) => new mongoose.Types.ObjectId(id)) },
            status: "removed",
        }).select("tenantId userId").lean();
        return { inactiveTenants: new Set(tenants.map((t) => String(t._id))), removed: new Set(rows.map((r) => `${r.tenantId}:${r.userId}`)) };
    }, "socket-revalidation");
    for (const [socketId, ctx] of live) {
        if (inactiveTenants.has(ctx.tenantId!) || removed.has(`${ctx.tenantId}:${ctx.userId}`)) {
            io().sockets.sockets.get(socketId)?.disconnect(true);
            count++;
        }
    }
    return count;
}

/** App sockets: re-verify their token against live state (suspension, revoked grant, removed member...). */
async function revalidateAppSockets(): Promise<number> {
    let count = 0;
    for (const [socketId, ctx] of [...socketContexts.entries()]) {
        if (!ctx.app) continue;
        const socket = io().sockets.sockets.get(socketId);
        const token = (socket?.data as any)?.appToken;
        try {
            if (!token) throw new Error("no token");
            await verifyUserToken(token);
        } catch {
            socket?.disconnect(true);
            count++;
        }
    }
    return count;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startSocketRevalidation(): void {
    const ms = process.env.SOCKET_REVALIDATE_MS === undefined ? 30_000 : Number(process.env.SOCKET_REVALIDATE_MS);
    if (!Number.isFinite(ms) || ms <= 0 || timer) return;
    timer = setInterval(() => {
        revalidateWorkspaceSockets().catch((error) => console.error("[revalidate] failed:", error instanceof Error ? error.message : error));
    }, Math.max(5_000, ms));
    timer.unref();
}

export function stopSocketRevalidation(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
