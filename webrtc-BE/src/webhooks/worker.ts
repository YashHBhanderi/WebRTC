import crypto from "crypto";
import mongoose from "mongoose";
import { AppAuditEvent, DeveloperApp, IDeveloperApp } from "../developer/models";
import { runAsSystem } from "../tenancy/context";
import { decryptSecret, sign } from "./crypto";
import { forgetEndpointCache } from "./events";
import { IWebhookDelivery, IWebhookEndpoint, WebhookDelivery, WebhookEndpoint } from "./models";
import { postWebhook } from "./sender";
import { safeError } from "../utils/safe-log";

/**
 * Delivery worker. The queue is the webhook_deliveries collection (MongoDB is already shared by all
 * instances; no new infrastructure): due rows are claimed atomically (findOneAndUpdate + lease), so
 * several instances never deliver the same row concurrently; a crashed worker's lease expires and
 * the row is picked up again. Delivery is at-least-once: receivers de-duplicate by delivery id.
 *
 *   WEBHOOK_WORKER_INTERVAL_MS        poll interval (default 2000; 0 = worker off on this instance)
 *   WEBHOOK_MAX_ATTEMPTS              default 8 → then "dead" (kept 7 days; manual retry possible)
 *   WEBHOOK_DISABLE_AFTER_FAILURES    consecutive failures before an endpoint is disabled (default 15)
 */
const LEASE_MS = 60_000;
const INFLIGHT_PER_APP = 5;
const BATCH = 10;

const num = (v: string | undefined, d: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) && v !== undefined && v !== "" ? Math.min(max, Math.max(min, Math.floor(n))) : d;
};
const maxAttempts = () => num(process.env.WEBHOOK_MAX_ATTEMPTS, 8, 1, 20);
const disableAfter = () => num(process.env.WEBHOOK_DISABLE_AFTER_FAILURES, 15, 1, 1000);

/** Exponential backoff with jitter: 30 s · 2^(n-1), capped at 6 h, randomised to 50–100 %. */
export function backoffMs(attempt: number, random = Math.random()): number {
    const base = Math.min(6 * 3600_000, 30_000 * 2 ** Math.max(0, attempt - 1));
    return Math.round(base * (0.5 + random * 0.5));
}

const inflight = new Map<string, number>();

async function claim(): Promise<IWebhookDelivery | null> {
    const now = new Date();
    return WebhookDelivery.findOneAndUpdate(
        {
            nextAttemptAt: { $lte: now },
            $or: [
                { status: { $in: ["pending", "retrying"] } },
                // lease of a crashed worker expired
                { status: "delivering", lockedUntil: { $lt: now } },
            ],
        },
        { $set: { status: "delivering", lockedUntil: new Date(now.getTime() + LEASE_MS) } },
        { sort: { nextAttemptAt: 1 }, new: true },
    ).lean<IWebhookDelivery>();
}

async function finish(id: mongoose.Types.ObjectId, set: Record<string, unknown>) {
    await WebhookDelivery.updateOne({ _id: id }, { $set: { lockedUntil: null, ...set } });
}

export function signatureHeaders(endpoint: Pick<IWebhookEndpoint, "secrets">, deliveryId: string, eventType: string, body: string, nowMs = Date.now()) {
    const timestamp = Math.floor(nowMs / 1000);
    const valid = endpoint.secrets.filter((s) => !s.expiresAt || new Date(s.expiresAt).getTime() > nowMs);
    const signatures = valid.map((s) => `v1=${sign(decryptSecret(s.enc), deliveryId, timestamp, body)}`).join(" ");
    return {
        "SpreeWe-Webhook-Id": deliveryId,
        "SpreeWe-Webhook-Event": eventType,
        "SpreeWe-Webhook-Timestamp": String(timestamp),
        "SpreeWe-Webhook-Signature": signatures,
    };
}

async function attempt(d: IWebhookDelivery): Promise<void> {
    const endpoint = await WebhookEndpoint.findById(d.endpointId).lean<IWebhookEndpoint>();
    if (!endpoint || endpoint.status === "deleted") {
        return finish(d._id, { status: "cancelled", payload: null, lastError: "endpoint_deleted" });
    }
    if (endpoint.status !== "active") {
        return finish(d._id, { status: "dead", lastError: endpoint.status === "disabled" ? "endpoint_disabled" : "endpoint_not_verified" });
    }
    const app = await DeveloperApp.findById(d.appId).lean<IDeveloperApp>();
    if (!app || app.status === "revoked") {
        return finish(d._id, { status: "cancelled", payload: null, lastError: "app_revoked" });
    }
    if (app.status === "suspended") {
        // Paused while suspended; doesn't consume attempts
        return finish(d._id, { status: "pending", nextAttemptAt: new Date(Date.now() + 10 * 60_000), lastError: "app_suspended" });
    }
    if (!d.payload) {
        return finish(d._id, { status: "dead", lastError: "payload_unavailable" });
    }
    const headers = signatureHeaders(endpoint, String(d._id), d.eventType, d.payload);
    const result = await postWebhook(endpoint.url, app.environment, d.payload, headers);
    const attempts = d.attempts + 1;
    if (result.ok) {
        await finish(d._id, { status: "succeeded", attempts, lastStatusCode: result.statusCode, lastError: null, deliveredAt: new Date(), payload: null });
        await WebhookEndpoint.updateOne({ _id: endpoint._id }, { $set: { consecutiveFailures: 0 } });
        return;
    }
    const dead = attempts >= maxAttempts();
    await finish(d._id, {
        status: dead ? "dead" : "retrying",
        attempts,
        lastStatusCode: result.statusCode,
        lastError: result.error,
        nextAttemptAt: new Date(Date.now() + (dead ? 0 : backoffMs(attempts))),
    });
    const updated = await WebhookEndpoint.findOneAndUpdate({ _id: endpoint._id }, { $inc: { consecutiveFailures: 1 } }, { new: true }).lean<IWebhookEndpoint>();
    if (updated && updated.status === "active" && updated.consecutiveFailures >= disableAfter()) {
        const res = await WebhookEndpoint.updateOne({ _id: endpoint._id, status: "active" }, { $set: { status: "disabled", disabledReason: "too_many_failures", disabledAt: new Date() } });
        if (res.modifiedCount) {
            forgetEndpointCache();
            await AppAuditEvent.create({ appId: d.appId, actorUserId: null, actorKind: "app", action: "webhook.endpoint_disabled", details: { endpointId: String(endpoint._id), reason: "too_many_failures" }, at: new Date() });
        }
    }
}

/** One worker pass (also used by tests). Returns the number of deliveries attempted. */
export async function runWebhookWorkerOnce(): Promise<number> {
    return runAsSystem(async () => {
        const work: Promise<void>[] = [];
        for (let i = 0; i < BATCH; i++) {
            const d = await claim();
            if (!d) break;
            const app = String(d.appId);
            if ((inflight.get(app) || 0) >= INFLIGHT_PER_APP) {
                // Per-app concurrency (per instance): give the row back untouched
                await finish(d._id, { status: d.attempts ? "retrying" : "pending", nextAttemptAt: new Date(Date.now() + 1000) });
                continue;
            }
            inflight.set(app, (inflight.get(app) || 0) + 1);
            work.push(attempt(d)
                .catch(async (error) => {
                    console.error("[webhooks] delivery crashed:", safeError(error));
                    await finish(d._id, { status: "retrying", lastError: "internal_error", nextAttemptAt: new Date(Date.now() + backoffMs(d.attempts + 1)) }).catch(() => undefined);
                })
                .finally(() => inflight.set(app, Math.max(0, (inflight.get(app) || 1) - 1))));
        }
        await Promise.all(work);
        return work.length;
    }, "webhook-worker");
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
export const workerId = crypto.randomBytes(6).toString("hex");

export function startWebhookWorker(): void {
    const ms = num(process.env.WEBHOOK_WORKER_INTERVAL_MS, 2000, 0, 60_000);
    if (!ms || timer) return;
    timer = setInterval(() => {
        if (running) return;
        running = true;
        runWebhookWorkerOnce().catch((error) => console.error("[webhooks] worker failed:", error)).finally(() => (running = false));
    }, Math.max(250, ms));
    timer.unref();
}

export function stopWebhookWorker(): void {
    if (timer) clearInterval(timer);
    timer = null;
}
