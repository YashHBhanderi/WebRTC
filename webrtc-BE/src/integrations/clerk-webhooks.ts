import { Request, Response } from "express";
import mongoose from "mongoose";
import { verifyWebhook } from "@clerk/express/webhooks";
import ClerkWebhookEvent from "../models/clerkWebhookEventModel";
import Tenant from "../models/tenantModel";
import TenantMembership from "../models/tenantMembershipModel";
import User from "../models/userModel";
import { runAsSystem } from "../tenancy/context";
import { forgetMembership, forgetTenant, mapRole } from "../tenancy/tenant.service";
import { disconnectWorkspaceSockets } from "../realtime/io";

/**
 * Clerk → MongoDB sync for organizations, memberships and users (Svix-signed webhooks).
 *
 * - Signature: verified by Clerk's verifyWebhook (Svix) over the RAW body; anything unsigned,
 *   wrongly signed or too old is refused with 400 before any processing.
 * - Idempotency: the signed `svix-id` is stored in clerk_webhook_events; a delivery already
 *   processed returns 200 without re-applying.
 * - Ordering: each tenant / membership keeps the timestamp of the newest event applied
 *   (`clerkEventAt`); older events are ignored, so out-of-order retries cannot undo newer state.
 * - Trust: webhooks never grant permissions. The role stored from a webhook is display-only;
 *   access decisions use the role in each verified session token.
 * - Failures: a processing error answers 500 so Svix retries; the ledger row is marked failed and
 *   a retry re-runs it. Payloads are never logged.
 */

const SIGNING_SECRET_ENV = "CLERK_WEBHOOK_SIGNING_SECRET";
const STALE_PROCESSING_MS = 2 * 60_000;
const oid = (id: string) => new mongoose.Types.ObjectId(id);

class MalformedEvent extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MalformedEvent";
    }
}

const isOrgId = (v: unknown): v is string => typeof v === "string" && /^org_[A-Za-z0-9]+$/.test(v);
const isUserId = (v: unknown): v is string => typeof v === "string" && /^user_[A-Za-z0-9]+$/.test(v);

/** Applies only if this event is newer than the last one applied to the record. */
const newerThan = (eventAt: number) => ({ $or: [{ clerkEventAt: null }, { clerkEventAt: { $exists: false } }, { clerkEventAt: { $lte: eventAt } }] });

type Outcome = "applied" | "stale" | "ignored" | "skipped:user-not-provisioned" | "skipped:tenant-unknown" | "skipped:managed-in-spreewe";

async function localUserId(clerkUserId: string): Promise<string | null> {
    const user = await User.findOne({ clerkId: clerkUserId }).select("_id").lean();
    return user ? String(user._id) : null;
}

/** Upsert guarded by event time; a duplicate-key on upsert means a newer record exists → stale. */
async function guardedUpsert(model: any, key: Record<string, unknown>, eventAt: number, update: Record<string, unknown>): Promise<Outcome> {
    try {
        const res = await model.updateOne({ ...key, ...newerThan(eventAt) }, update, { upsert: true });
        return res.matchedCount || res.upsertedCount ? "applied" : "stale";
    } catch (error: any) {
        if (error?.code === 11000) {
            return "stale";
        }
        throw error;
    }
}

async function handleOrganization(type: string, data: any, eventAt: number): Promise<Outcome> {
    if (!isOrgId(data?.id)) throw new MalformedEvent("organization id");
    if (type === "organization.deleted") {
        const outcome = await guardedUpsert(Tenant, { clerkOrgId: data.id }, eventAt, {
            $set: { status: "deleted", deletedAt: new Date(eventAt), clerkEventAt: eventAt },
            $setOnInsert: { clerkOrgId: data.id, name: "", slug: "" },
        });
        const tenant = await Tenant.findOne({ clerkOrgId: data.id }).select("_id").lean();
        if (tenant) {
            const tenantId = String(tenant._id);
            // Data is kept (retention decision is the tenant's), access ends now
            await TenantMembership.updateMany({ tenantId: tenant._id, status: "active" }, { $set: { status: "removed", removedAt: new Date(eventAt) } });
            forgetTenant(tenantId);
            forgetMembership(tenantId);
            disconnectWorkspaceSockets(tenantId);
        }
        return outcome;
    }
    // Organizations managed in SpreeWe keep the name / slug set in SpreeWe. The metadata marker covers a
    // "created" event that arrives before SpreeWe has stored the organization.
    const existing = await Tenant.findOne({ clerkOrgId: data.id }).select("managedBy").lean();
    if (existing?.managedBy === "spreewe" || data?.public_metadata?.managedBy === "spreewe") {
        return "skipped:managed-in-spreewe";
    }
    // created / updated: name and slug only — never status or policies from a payload
    const name = typeof data.name === "string" ? data.name.slice(0, 200) : "";
    const slug = typeof data.slug === "string" ? data.slug.slice(0, 200) : "";
    const outcome = await guardedUpsert(Tenant, { clerkOrgId: data.id, status: { $ne: "deleted" } }, eventAt, {
        $set: { name, slug, clerkEventAt: eventAt },
        $setOnInsert: { clerkOrgId: data.id, status: "active" },
    });
    const tenant = await Tenant.findOne({ clerkOrgId: data.id }).select("_id").lean();
    if (tenant) forgetTenant(String(tenant._id));
    return outcome;
}

async function handleMembership(type: string, data: any, eventAt: number): Promise<Outcome> {
    const orgId = data?.organization?.id;
    const clerkUserId = data?.public_user_data?.user_id;
    if (!isOrgId(orgId) || !isUserId(clerkUserId)) throw new MalformedEvent("membership organization / user");
    const tenant = await Tenant.findOne({ clerkOrgId: orgId }).select("_id status managedBy").lean();
    const userId = await localUserId(clerkUserId);
    // Organizations managed in SpreeWe: Clerk can take access away (deleted) but never grant or raise it
    if (tenant?.managedBy === "spreewe" && type !== "organizationMembership.deleted") {
        return "skipped:managed-in-spreewe";
    }
    if (type === "organizationMembership.deleted") {
        if (!tenant) return "skipped:tenant-unknown";
        if (!userId) return "skipped:user-not-provisioned";
        const tenantId = String(tenant._id);
        const outcome = await guardedUpsert(TenantMembership, { tenantId: tenant._id, userId: oid(userId) }, eventAt, {
            $set: { status: "removed", removedAt: new Date(eventAt), clerkEventAt: eventAt },
            $setOnInsert: { role: "member", lastSeenAt: new Date(eventAt) },
        });
        forgetMembership(tenantId, userId);
        disconnectWorkspaceSockets(tenantId, userId);
        return outcome;
    }
    if (!tenant || tenant.status === "deleted") return "skipped:tenant-unknown";
    if (!userId) return "skipped:user-not-provisioned";
    // created / updated. The role is recorded for display; it grants nothing (tokens decide)
    const outcome = await guardedUpsert(TenantMembership, { tenantId: tenant._id, userId: oid(userId) }, eventAt, {
        $set: { role: mapRole(typeof data.role === "string" ? data.role : null), status: "active", removedAt: null, clerkEventAt: eventAt },
        $setOnInsert: { lastSeenAt: new Date(eventAt) },
    });
    forgetMembership(String(tenant._id), userId);
    return outcome;
}

async function handleUser(type: string, data: any, eventAt: number): Promise<Outcome> {
    if (!isUserId(data?.id)) throw new MalformedEvent("user id");
    const userId = await localUserId(data.id);
    if (!userId) return "skipped:user-not-provisioned";
    if (type === "user.deleted") {
        await User.updateOne({ _id: oid(userId) }, { $set: { clerkDeletedAt: new Date(eventAt) } });
        const rows = await TenantMembership.find({ userId: oid(userId), status: "active" }).select("tenantId").lean();
        await TenantMembership.updateMany({ userId: oid(userId), status: "active" }, { $set: { status: "removed", removedAt: new Date(eventAt) } });
        rows.forEach((r) => forgetMembership(String(r.tenantId), userId));
        disconnectWorkspaceSockets(null, userId);
        return "applied";
    }
    if (type === "user.updated") {
        // Only what affects directory visibility; profile fields are owned by the app
        await User.updateOne({ _id: oid(userId) }, { $set: { clerkBanned: data.banned === true } });
        if (data.banned === true) disconnectWorkspaceSockets(null, userId);
        return "applied";
    }
    return "ignored";
}

export async function applyClerkEvent(type: string, data: unknown, eventAt: number): Promise<Outcome> {
    return runAsSystem(async () => {
        if (type.startsWith("organizationMembership.")) return handleMembership(type, data, eventAt);
        if (type.startsWith("organization.")) return handleOrganization(type, data, eventAt);
        if (type === "user.updated" || type === "user.deleted") return handleUser(type, data, eventAt);
        return "ignored";
    }, "clerk-webhook");
}

/** Claim a delivery in the ledger. Returns "new"/"retry" to process, "duplicate"/"busy" to stop. */
async function claim(svixId: string, type: string, eventAt: number): Promise<"new" | "retry" | "duplicate" | "busy"> {
    const now = new Date();
    try {
        await ClerkWebhookEvent.create({ _id: svixId, type, status: "processing", attempts: 1, eventAt, startedAt: now });
        return "new";
    } catch (error: any) {
        if (error?.code !== 11000) throw error;
    }
    const retried = await ClerkWebhookEvent.findOneAndUpdate(
        { _id: svixId, $or: [{ status: "failed" }, { status: "processing", startedAt: { $lt: new Date(now.getTime() - STALE_PROCESSING_MS) } }] },
        { $set: { status: "processing", startedAt: now }, $inc: { attempts: 1 } },
    );
    if (retried) return "retry";
    const existing = await ClerkWebhookEvent.findById(svixId).select("status").lean();
    return existing?.status === "done" ? "duplicate" : "busy";
}

let warnedMissingSecret = false;

/** POST /webhooks/clerk — mounted with express.raw() so the signature covers the exact bytes. */
export async function clerkWebhookHandler(req: Request, res: Response): Promise<void> {
    const signingSecret = process.env[SIGNING_SECRET_ENV];
    if (!signingSecret) {
        if (!warnedMissingSecret) {
            warnedMissingSecret = true;
            console.error(`[clerk-webhook] ${SIGNING_SECRET_ENV} is not set; webhooks are refused`);
        }
        res.status(503).json({ success: false, message: "Webhooks are not configured" });
        return;
    }
    if (!Buffer.isBuffer(req.body)) {
        res.status(400).json({ success: false, message: "Expected a raw body" });
        return;
    }
    let event: { type?: unknown; data?: unknown; timestamp?: unknown };
    try {
        event = (await verifyWebhook(req, { signingSecret })) as any;
    } catch {
        // No details: they would help forging attempts
        res.status(400).json({ success: false, message: "Invalid webhook signature" });
        return;
    }
    const svixId = String(req.headers["svix-id"] || "");
    const type = typeof event?.type === "string" ? event.type.slice(0, 100) : "";
    // Event time for ordering: Clerk's own timestamp, else the signed svix-timestamp header (seconds)
    const headerTs = Number(req.headers["svix-timestamp"]) * 1000;
    const eventAt = typeof event?.timestamp === "number" && Number.isFinite(event.timestamp) ? event.timestamp : headerTs;
    if (!svixId || !type || !Number.isFinite(eventAt) || !event.data || typeof event.data !== "object") {
        res.status(400).json({ success: false, message: "Malformed webhook payload" });
        return;
    }

    try {
        const claimed = await runAsSystem(() => claim(svixId, type, eventAt), "clerk-webhook-ledger");
        if (claimed === "duplicate") {
            res.status(200).json({ success: true, duplicate: true });
            return;
        }
        if (claimed === "busy") {
            // Another worker is processing it right now; Svix will retry later
            res.status(409).json({ success: false, message: "Already processing" });
            return;
        }
        const outcome = await applyClerkEvent(type, event.data, eventAt);
        await runAsSystem(() => ClerkWebhookEvent.updateOne({ _id: svixId }, { $set: { status: "done", processedAt: new Date(), outcome } }), "clerk-webhook-ledger");
        res.status(200).json({ success: true, outcome });
    } catch (error) {
        const malformed = error instanceof MalformedEvent;
        await runAsSystem(() => ClerkWebhookEvent.updateOne(
            { _id: svixId },
            { $set: { status: malformed ? "done" : "failed", outcome: malformed ? "malformed" : (error as Error)?.name || "error" } },
        ), "clerk-webhook-ledger").catch(() => undefined);
        if (malformed) {
            // Signed but unusable: retrying won't help
            res.status(400).json({ success: false, message: "Malformed webhook payload" });
            return;
        }
        console.error(`[clerk-webhook] ${type} ${svixId} failed:`, (error as Error)?.name, (error as Error)?.message?.slice(0, 200));
        res.status(500).json({ success: false, message: "Processing failed; will be retried" });
    }
}
