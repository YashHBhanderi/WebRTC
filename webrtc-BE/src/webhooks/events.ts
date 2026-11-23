import crypto from "crypto";
import mongoose from "mongoose";
import Conversation from "../models/conversationModel";
import TenantMembership from "../models/tenantMembershipModel";
import { AppGrant, DeveloperApp, IDeveloperApp } from "../developer/models";
import { runAsSystem } from "../tenancy/context";
import { conversationScope, visibleIn } from "../tenancy/scope";
import { WebhookDelivery, WebhookEndpoint } from "./models";
import { safeError } from "../utils/safe-log";

/**
 * Event catalog. An endpoint may subscribe to an event only if its app has the event's scope; an
 * event is delivered to an app only for users who (1) are members of the conversation, (2) granted
 * the app that scope, (3) can see the conversation in the app's context (workspace app: its
 * workspace, active membership; global app: personal context — external chats only as guest).
 * Payloads carry ids and the minimum fields; never file URLs, signed links, tokens or emails.
 */
export const WEBHOOK_EVENTS = {
    "message.created": { scope: "messages:read", description: "A message was posted in a conversation the user can read (text content for text messages only)" },
    "conversation.members_added": { scope: "conversations:read", description: "People were added to a group conversation" },
    "conversation.members_removed": { scope: "conversations:read", description: "Someone was removed from, or left, a group conversation" },
    "call.started": { scope: "calls:read", description: "A call or meeting started in a conversation" },
    "call.ended": { scope: "calls:read", description: "A call or meeting ended" },
    "recording.available": { scope: "recordings:read", description: "A recording finished processing (metadata only; fetch links via GET /v1/recordings/{id})" },
} as const;

export type WebhookEventType = keyof typeof WEBHOOK_EVENTS;
export const EVENT_TYPES = Object.keys(WEBHOOK_EVENTS) as WebhookEventType[];

export const LIMITS = {
    /** Pending deliveries per app; beyond this new events are dropped (counted) */
    maxPendingPerApp: 10_000,
    maxPayloadBytes: 64 * 1024,
    maxContentChars: 4000,
} as const;

const oid = (id: string) => new mongoose.Types.ObjectId(id);

// Endpoints per event type, cached briefly (most messages have no subscribers)
const endpointCache = new Map<string, { at: number; rows: { _id: mongoose.Types.ObjectId; appId: mongoose.Types.ObjectId }[] }>();
const CACHE_MS = 15_000;

export function forgetEndpointCache(): void {
    endpointCache.clear();
}

async function endpointsFor(type: string) {
    const hit = endpointCache.get(type);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
    const rows = await WebhookEndpoint.find({ status: "active", events: type }).select("_id appId").lean();
    endpointCache.set(type, { at: Date.now(), rows });
    return rows;
}

export interface PublishInput {
    type: WebhookEventType;
    conversationId: string;
    data: Record<string, unknown>;
    /** Members to consider; defaults to the conversation's current members */
    memberIds?: string[];
}

export let droppedCount = 0;

/** Fire-and-forget: never blocks or fails the caller (chat, calls…). */
export function publish(input: PublishInput): void {
    setImmediate(() => {
        runAsSystem(() => fanOut(input), "webhook-publish").catch((error) => console.error("[webhooks] publish failed:", safeError(error)));
    });
}

/** Exposed for tests: the synchronous core of publish(). */
export async function fanOut(input: PublishInput): Promise<number> {
    const endpoints = await endpointsFor(input.type);
    if (!endpoints.length) return 0;
    const info = await conversationScope(input.conversationId);
    if (!info) return 0;
    const members = input.memberIds?.map(String)
        ?? ((await Conversation.findById(input.conversationId).select("members").lean())?.members || []).map(String);
    if (!members.length) return 0;
    const scope = WEBHOOK_EVENTS[input.type].scope;
    const appIds = [...new Set(endpoints.map((e) => String(e.appId)))];
    const apps = await DeveloperApp.find({ _id: { $in: appIds.map(oid) }, status: "active", scopes: scope }).lean<IDeveloperApp[]>();
    const eventId = `evt_${crypto.randomBytes(16).toString("base64url")}`;
    const createdAt = new Date().toISOString();
    let queued = 0;
    for (const app of apps) {
        const appTenant = app.tenantId ? String(app.tenantId) : null;
        const grants = await AppGrant.find({ appId: app._id, status: "active", $or: [{ scopes: scope }, { managed: true }], userId: { $in: members.map(oid) }, tenantId: app.tenantId }).select("userId").lean();
        let audience = grants.map((g) => String(g.userId)).filter((uid) => visibleIn(info, appTenant, uid));
        if (appTenant && audience.length) {
            const active = await TenantMembership.find({ tenantId: oid(appTenant), userId: { $in: audience.map(oid) }, status: "active" }).select("userId").lean();
            const ok = new Set(active.map((m) => String(m.userId)));
            audience = audience.filter((u) => ok.has(u));
        }
        if (!audience.length) continue;
        const payload = JSON.stringify({ id: eventId, type: input.type, createdAt, appId: String(app._id), tenantId: appTenant, data: input.data, audience: { userIds: audience } });
        if (Buffer.byteLength(payload) > LIMITS.maxPayloadBytes) {
            console.warn(`[webhooks] ${input.type} payload too large for app ${app._id}; skipped`);
            continue;
        }
        const pending = await WebhookDelivery.countDocuments({ appId: app._id, status: { $in: ["pending", "retrying", "delivering"] } }, { limit: LIMITS.maxPendingPerApp + 1 });
        if (pending >= LIMITS.maxPendingPerApp) {
            droppedCount++;
            continue;
        }
        const appEndpoints = endpoints.filter((e) => String(e.appId) === String(app._id));
        const now = new Date();
        try {
            await WebhookDelivery.insertMany(appEndpoints.map((e) => ({
                endpointId: e._id, appId: app._id, eventId, eventType: input.type, payload, status: "pending", attempts: 0,
                nextAttemptAt: now, expireAt: new Date(now.getTime() + 7 * 86_400_000),
            })), { ordered: false });
            queued += appEndpoints.length;
        } catch (error: any) {
            if (error?.code !== 11000) throw error; // duplicate (endpoint, event): already queued
        }
    }
    return queued;
}

// ------------------------------------------------------------------ payload builders (minimal fields)

export function messageCreatedData(message: any): Record<string, unknown> {
    const type = String(message?.type || "text");
    return {
        messageId: String(message?._id),
        conversationId: String(message?.conversationId),
        senderId: String(message?.user?._id || message?.userId || ""),
        type,
        // End-to-end encrypted messages: no content (the server can't read it, and apps never get ciphertext).
        // Legacy plaintext text only, bounded; attachments / call / recording entries carry no content or URLs
        encrypted: !!message?.e2ee,
        content: !message?.e2ee && type === "text" && typeof message?.content === "string" ? message.content.slice(0, LIMITS.maxContentChars) : null,
        createdAt: message?.createdAt ? new Date(message.createdAt).toISOString() : new Date().toISOString(),
    };
}
