import crypto from "crypto";
import mongoose from "mongoose";
import { RequestContext, runAsSystem } from "../tenancy/context";
import { AppAuditEvent } from "../developer/models";
import { managedApp, requireConfirmation } from "../developer/app.service";
import { AppError, ForbiddenError, NotFoundError } from "../utils/errors";
import { encryptSecret, newWebhookSecret } from "./crypto";
import { EVENT_TYPES, WEBHOOK_EVENTS, WebhookEventType, forgetEndpointCache } from "./events";
import { IWebhookDelivery, IWebhookEndpoint, WebhookDelivery, WebhookEndpoint } from "./models";
import { postWebhook } from "./sender";
import { BlockedDestinationError, validateDestination } from "./ssrf";
import { signatureHeaders } from "./worker";

/**
 * Webhook endpoint management. Same authorization as the rest of app management: the owner in
 * the app's own context (managedApp). Endpoint URLs are SSRF-validated when set and on every
 * delivery; an endpoint only becomes active after answering a signed verification challenge
 * (proves the developer controls it).
 */
const sys = <T>(fn: () => T, reason: string) => runAsSystem(fn, reason);
const oid = (id: string | mongoose.Types.ObjectId) => new mongoose.Types.ObjectId(String(id));
export const ENDPOINTS_PER_APP = 5;

function publicEndpoint(e: IWebhookEndpoint) {
    return {
        _id: String(e._id), url: e.url, description: e.description, events: e.events, status: e.status,
        consecutiveFailures: e.consecutiveFailures, disabledReason: e.disabledReason, disabledAt: e.disabledAt, verifiedAt: e.verifiedAt,
        secrets: e.secrets.map((s) => ({ id: s.id, hint: s.hint, createdAt: s.createdAt, expiresAt: s.expiresAt })),
        createdAt: e.createdAt, updatedAt: e.updatedAt,
    };
}

function publicDelivery(d: IWebhookDelivery) {
    return {
        _id: String(d._id), eventId: d.eventId, eventType: d.eventType, status: d.status, attempts: d.attempts,
        lastStatusCode: d.lastStatusCode, lastError: d.lastError, nextAttemptAt: d.status === "retrying" || d.status === "pending" ? d.nextAttemptAt : null,
        deliveredAt: d.deliveredAt, createdAt: d.createdAt,
    };
}

async function audit(appId: unknown, ctx: RequestContext, action: string, details: Record<string, unknown> = {}) {
    await sys(() => AppAuditEvent.create({ appId: oid(String(appId)), actorUserId: oid(ctx.userId), actorKind: "owner", action, details, at: new Date() }), "app-audit");
}

function eventsFrom(value: unknown, appScopes: string[]): WebhookEventType[] {
    if (!Array.isArray(value) || !value.length) throw new AppError("Choose at least one event");
    const out = [...new Set(value)] as string[];
    for (const e of out) {
        if (!EVENT_TYPES.includes(e as WebhookEventType)) throw new AppError(`Unknown event: ${String(e).slice(0, 60)}`);
        const scope = WEBHOOK_EVENTS[e as WebhookEventType].scope;
        if (!appScopes.includes(scope)) throw new ForbiddenError(`${e} needs the ${scope} scope on the app`);
    }
    return out as WebhookEventType[];
}

async function checkedUrl(url: unknown, environment: "development" | "production"): Promise<string> {
    try {
        return (await validateDestination(String(url ?? ""), environment)).url.toString();
    } catch (error) {
        if (error instanceof BlockedDestinationError) throw new AppError(error.message);
        throw error;
    }
}

async function endpointOf(appId: mongoose.Types.ObjectId, endpointId: string) {
    if (!mongoose.isValidObjectId(endpointId)) throw new NotFoundError("Webhook endpoint not found");
    const e = await sys(() => WebhookEndpoint.findOne({ _id: oid(endpointId), appId, status: { $ne: "deleted" } }).lean<IWebhookEndpoint>(), "webhook-endpoint");
    if (!e) throw new NotFoundError("Webhook endpoint not found");
    return e;
}

export function eventCatalog() {
    return EVENT_TYPES.map((type) => ({ type, scope: WEBHOOK_EVENTS[type].scope, description: WEBHOOK_EVENTS[type].description }));
}

export async function listEndpoints(ctx: RequestContext, appId: string) {
    const { app } = await managedApp(ctx, appId);
    const rows = await sys(() => WebhookEndpoint.find({ appId: app._id, status: { $ne: "deleted" } }).sort({ createdAt: -1 }).lean<IWebhookEndpoint[]>(), "webhook-endpoint");
    return rows.map(publicEndpoint);
}

export async function createEndpoint(ctx: RequestContext, appId: string, input: { url: string; events: string[]; description?: string; confirm: unknown }) {
    const { app } = await managedApp(ctx, appId);
    if (app.status !== "active") throw new AppError("Only active apps can add webhook endpoints", 409);
    requireConfirmation(app, ctx, input.confirm);
    const count = await sys(() => WebhookEndpoint.countDocuments({ appId: app._id, status: { $ne: "deleted" } }), "webhook-endpoint");
    if (count >= ENDPOINTS_PER_APP) throw new AppError(`At most ${ENDPOINTS_PER_APP} webhook endpoints per app`, 409);
    const url = await checkedUrl(input.url, app.environment);
    const events = eventsFrom(input.events, app.scopes);
    const secret = newWebhookSecret();
    const endpoint = await sys(() => WebhookEndpoint.create({
        appId: app._id, url, events, description: input.description || "", status: "pending_verification",
        secrets: [{ id: crypto.randomBytes(6).toString("hex"), enc: encryptSecret(secret), hint: secret.slice(-4), createdAt: new Date(), expiresAt: null }],
        createdBy: oid(ctx.userId),
    }), "webhook-endpoint");
    await audit(app._id, ctx, "webhook.endpoint_created", { endpointId: String(endpoint._id), events });
    // Signing secret: shown once
    return { endpoint: publicEndpoint(endpoint.toObject()), secret };
}

export async function updateEndpoint(ctx: RequestContext, appId: string, endpointId: string, patch: { url?: string; events?: string[]; description?: string }) {
    const { app } = await managedApp(ctx, appId);
    const e = await endpointOf(app._id, endpointId);
    const set: Record<string, unknown> = {};
    if (patch.events !== undefined) set.events = eventsFrom(patch.events, app.scopes);
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.url !== undefined && patch.url !== e.url) {
        set.url = await checkedUrl(patch.url, app.environment);
        // A new destination must prove ownership again
        set.status = "pending_verification";
        set.verifiedAt = null;
    }
    const updated = await sys(() => WebhookEndpoint.findByIdAndUpdate(e._id, { $set: set }, { new: true }).lean<IWebhookEndpoint>(), "webhook-endpoint");
    forgetEndpointCache();
    await audit(app._id, ctx, "webhook.endpoint_updated", { endpointId, fields: Object.keys(set) });
    return publicEndpoint(updated!);
}

/** Signed challenge; the endpoint must answer 2xx echoing the challenge. Activates on success. */
export async function verifyEndpoint(ctx: RequestContext, appId: string, endpointId: string) {
    const { app } = await managedApp(ctx, appId);
    const e = await endpointOf(app._id, endpointId);
    if (e.status === "active") return { verified: true, endpoint: publicEndpoint(e) };
    await checkedUrl(e.url, app.environment);
    const challenge = crypto.randomBytes(24).toString("base64url");
    const deliveryId = `verify_${crypto.randomBytes(8).toString("hex")}`;
    const body = JSON.stringify({ id: deliveryId, type: "webhook.verification", createdAt: new Date().toISOString(), appId: String(app._id), data: { challenge } });
    const result = await postWebhook(e.url, app.environment, body, signatureHeaders(e, deliveryId, "webhook.verification", body));
    let echoed = false;
    if (result.ok) {
        try {
            echoed = JSON.parse(result.body)?.challenge === challenge;
        } catch {
            echoed = result.body.trim() === challenge;
        }
    }
    if (!echoed) {
        return { verified: false, error: result.ok ? "challenge_not_echoed" : result.error, statusCode: result.statusCode };
    }
    const updated = await sys(() => WebhookEndpoint.findByIdAndUpdate(e._id, { $set: { status: "active", verifiedAt: new Date(), consecutiveFailures: 0, disabledReason: null, disabledAt: null } }, { new: true }).lean<IWebhookEndpoint>(), "webhook-endpoint");
    forgetEndpointCache();
    await audit(app._id, ctx, "webhook.endpoint_verified", { endpointId });
    return { verified: true, endpoint: publicEndpoint(updated!) };
}

export async function setEndpointEnabled(ctx: RequestContext, appId: string, endpointId: string, enabled: boolean) {
    const { app } = await managedApp(ctx, appId);
    const e = await endpointOf(app._id, endpointId);
    // Re-enabling requires a fresh verification (the destination may have changed hands)
    const set = enabled
        ? { status: "pending_verification", disabledReason: null, disabledAt: null, consecutiveFailures: 0 }
        : { status: "disabled", disabledReason: "disabled_by_owner", disabledAt: new Date() };
    const updated = await sys(() => WebhookEndpoint.findByIdAndUpdate(e._id, { $set: set }, { new: true }).lean<IWebhookEndpoint>(), "webhook-endpoint");
    forgetEndpointCache();
    await audit(app._id, ctx, enabled ? "webhook.endpoint_reenabled" : "webhook.endpoint_disabled", { endpointId });
    return publicEndpoint(updated!);
}

export async function deleteEndpoint(ctx: RequestContext, appId: string, endpointId: string, confirm: unknown) {
    const { app } = await managedApp(ctx, appId);
    requireConfirmation(app, ctx, confirm);
    const e = await endpointOf(app._id, endpointId);
    await sys(() => WebhookEndpoint.updateOne({ _id: e._id }, { $set: { status: "deleted", secrets: [] } }), "webhook-endpoint");
    await sys(() => WebhookDelivery.updateMany({ endpointId: e._id, status: { $in: ["pending", "retrying"] } }, { $set: { status: "cancelled", payload: null, lastError: "endpoint_deleted" } }), "webhook-endpoint");
    forgetEndpointCache();
    await audit(app._id, ctx, "webhook.endpoint_deleted", { endpointId });
    return { deleted: true };
}

/** New secret now (shown once); old ones stay valid for keepOldSeconds (0 = revoke immediately). */
export async function rotateEndpointSecret(ctx: RequestContext, appId: string, endpointId: string, input: { confirm: unknown; keepOldSeconds?: number }) {
    const { app } = await managedApp(ctx, appId);
    requireConfirmation(app, ctx, input.confirm);
    const e = await endpointOf(app._id, endpointId);
    const keep = input.keepOldSeconds ?? 86_400;
    const now = Date.now();
    const old = e.secrets
        .filter((s) => !s.expiresAt || new Date(s.expiresAt).getTime() > now)
        .map((s) => ({ ...s, expiresAt: keep > 0 ? new Date(Math.min(s.expiresAt ? new Date(s.expiresAt).getTime() : Infinity, now + keep * 1000)) : new Date(now) }))
        .filter((s) => new Date(s.expiresAt!).getTime() > now);
    const secret = newWebhookSecret();
    const fresh = { id: crypto.randomBytes(6).toString("hex"), enc: encryptSecret(secret), hint: secret.slice(-4), createdAt: new Date(), expiresAt: null };
    // Compare-and-set on updatedAt so two concurrent rotations can't both win
    const res = await sys(() => WebhookEndpoint.updateOne({ _id: e._id, updatedAt: e.updatedAt }, { $set: { secrets: [...old, fresh] } }), "webhook-endpoint");
    if (!res.modifiedCount) throw new AppError("The endpoint changed meanwhile; try again", 409);
    await audit(app._id, ctx, "webhook.secret_rotated", { endpointId, keepOldSeconds: keep });
    return { secret, keptSecrets: old.length };
}

export async function listDeliveries(ctx: RequestContext, appId: string, endpointId: string, opts: { status?: string; limit: number; cursor?: string }) {
    const { app } = await managedApp(ctx, appId);
    const e = await endpointOf(app._id, endpointId);
    const filter: Record<string, unknown> = { endpointId: e._id };
    if (opts.status) filter.status = opts.status;
    if (opts.cursor) filter._id = { $lt: oid(opts.cursor) };
    const rows = await sys(() => WebhookDelivery.find(filter).sort({ _id: -1 }).limit(opts.limit + 1).select("-payload").lean<IWebhookDelivery[]>(), "webhook-deliveries");
    const page = rows.slice(0, opts.limit);
    return { items: page.map(publicDelivery), nextCursor: rows.length > opts.limit ? String(page[page.length - 1]._id) : null };
}

/** Re-queue a dead delivery (after fixing the endpoint). Idempotent: only dead rows with a payload. */
export async function retryDelivery(ctx: RequestContext, appId: string, endpointId: string, deliveryId: string) {
    const { app } = await managedApp(ctx, appId);
    const e = await endpointOf(app._id, endpointId);
    if (!mongoose.isValidObjectId(deliveryId)) throw new NotFoundError("Delivery not found");
    const res = await sys(() => WebhookDelivery.findOneAndUpdate(
        { _id: oid(deliveryId), endpointId: e._id, status: "dead", payload: { $ne: null } },
        { $set: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lastError: null, lockedUntil: null } },
        { new: true },
    ).select("-payload").lean<IWebhookDelivery>(), "webhook-deliveries");
    if (!res) throw new NotFoundError("Only dead deliveries that still have their payload can be retried");
    await audit(app._id, ctx, "webhook.delivery_retried", { endpointId, deliveryId });
    return publicDelivery(res);
}
