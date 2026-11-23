import { EVENT_TYPES } from "../../webhooks/events";
import {
    createEndpoint, deleteEndpoint, eventCatalog, listDeliveries, listEndpoints, retryDelivery, rotateEndpointSecret,
    setEndpointEnabled, updateEndpoint, verifyEndpoint,
} from "../../webhooks/service";
import { defineRoute } from "./registry";
import { S } from "./schema";

/** Outbound webhook management (first-party, app owner in the app's context). */
const params = S.object({ appId: S.objectId(), endpointId: S.objectId() });
const confirm = S.string({ max: 80, description: "The app's exact name (confirmation)" });
const endpointDoc = S.doc({
    type: "object",
    properties: {
        _id: { type: "string" }, url: { type: "string" }, description: { type: "string" },
        events: { type: "array", items: { type: "string", enum: [...EVENT_TYPES] } },
        status: { type: "string", enum: ["pending_verification", "active", "disabled"] },
        consecutiveFailures: { type: "integer" }, disabledReason: { type: "string", nullable: true }, verifiedAt: { type: "string", nullable: true },
        secrets: { type: "array", items: { type: "object", properties: { id: { type: "string" }, hint: { type: "string" }, expiresAt: { type: "string", nullable: true } } } },
    },
});
const deliveryDoc = S.doc({
    type: "object",
    properties: {
        _id: { type: "string", description: "Delivery id (SpreeWe-Webhook-Id); de-duplicate on it" }, eventId: { type: "string" }, eventType: { type: "string" },
        status: { type: "string", enum: ["pending", "delivering", "retrying", "succeeded", "dead", "cancelled"] },
        attempts: { type: "integer" }, lastStatusCode: { type: "integer", nullable: true },
        lastError: { type: "string", nullable: true, description: "Safe category: timeout, http_500, blocked_destination, tls_error…" },
        nextAttemptAt: { type: "string", nullable: true }, deliveredAt: { type: "string", nullable: true },
    },
});

defineRoute({
    method: "get", path: "/webhook-events", tag: "Webhooks", auth: "firstParty",
    summary: "Event types an endpoint can subscribe to, and the app scope each needs",
    response: S.doc({ type: "array", items: { type: "object", properties: { type: { type: "string" }, scope: { type: "string" }, description: { type: "string" } } } }),
    handler: async () => eventCatalog(),
});

defineRoute({
    method: "get", path: "/apps/:appId/webhooks", tag: "Webhooks", auth: "firstParty", errors: [404],
    summary: "Webhook endpoints of an app (owner)", params: S.object({ appId: S.objectId() }),
    response: S.doc({ type: "array", items: endpointDoc.openapi() }),
    handler: ({ ctx, params: p }) => listEndpoints(ctx, p.appId),
});

defineRoute({
    method: "post", path: "/apps/:appId/webhooks", tag: "Webhooks", auth: "firstParty", sensitive: true, errors: [404, 409],
    summary: "Add an endpoint (SSRF-checked). The signing secret is shown ONLY in this response; then call /verify",
    description: "https only for production apps; ports 443/8443 (or 80/8080 for development apps); public addresses only. Events must be covered by the app's scopes.",
    params: S.object({ appId: S.objectId() }),
    body: S.object({ url: S.string({ min: 10, max: 500 }), events: S.array(S.enum(EVENT_TYPES), { max: EVENT_TYPES.length }), description: S.string({ optional: true, max: 200 }), confirm }),
    response: S.doc({ type: "object", properties: { endpoint: endpointDoc.openapi(), secret: { type: "string", description: "swh_… — store it; used to verify SpreeWe-Webhook-Signature" } } }),
    handler: ({ ctx, params: p, body }) => createEndpoint(ctx, p.appId, body),
});

defineRoute({
    method: "patch", path: "/apps/:appId/webhooks/:endpointId", tag: "Webhooks", auth: "firstParty", sensitive: true, errors: [404],
    summary: "Change events / description / URL (a new URL must be verified again)", params,
    body: S.object({ url: S.string({ optional: true, min: 10, max: 500 }), events: S.array(S.enum(EVENT_TYPES), { optional: true, max: EVENT_TYPES.length }), description: S.string({ optional: true, max: 200 }) }, { minProperties: 1 }),
    response: endpointDoc,
    handler: ({ ctx, params: p, body }) => updateEndpoint(ctx, p.appId, p.endpointId, body),
});

defineRoute({
    method: "post", path: "/apps/:appId/webhooks/:endpointId/verify", tag: "Webhooks", auth: "firstParty", sensitive: true, errors: [404],
    summary: "Send a signed verification challenge; the endpoint must answer 2xx with {\"challenge\": \"…\"}. Activates the endpoint",
    params, response: S.doc({ type: "object", properties: { verified: { type: "boolean" }, error: { type: "string", nullable: true } } }),
    handler: ({ ctx, params: p }) => verifyEndpoint(ctx, p.appId, p.endpointId),
});

defineRoute({
    method: "post", path: "/apps/:appId/webhooks/:endpointId/disable", tag: "Webhooks", auth: "firstParty", errors: [404],
    summary: "Stop deliveries to this endpoint", params, response: endpointDoc,
    handler: ({ ctx, params: p }) => setEndpointEnabled(ctx, p.appId, p.endpointId, false),
});

defineRoute({
    method: "post", path: "/apps/:appId/webhooks/:endpointId/enable", tag: "Webhooks", auth: "firstParty", errors: [404],
    summary: "Re-enable (back to pending verification; call /verify)", params, response: endpointDoc,
    handler: ({ ctx, params: p }) => setEndpointEnabled(ctx, p.appId, p.endpointId, true),
});

defineRoute({
    method: "post", path: "/apps/:appId/webhooks/:endpointId/rotate-secret", tag: "Webhooks", auth: "firstParty", sensitive: true, errors: [404, 409],
    summary: "New signing secret (shown once); old secrets keep signing for keepOldSeconds (default 86400; 0 = revoke now)",
    params, body: S.object({ confirm, keepOldSeconds: S.int({ optional: true, min: 0, max: 604_800 }) }),
    response: S.doc({ type: "object", properties: { secret: { type: "string" }, keptSecrets: { type: "integer" } } }),
    handler: ({ ctx, params: p, body }) => rotateEndpointSecret(ctx, p.appId, p.endpointId, body),
});

defineRoute({
    method: "post", path: "/apps/:appId/webhooks/:endpointId/delete", tag: "Webhooks", auth: "firstParty", sensitive: true, errors: [404],
    summary: "Delete the endpoint (pending deliveries are cancelled)", params, body: S.object({ confirm }),
    response: S.doc({ type: "object", properties: { deleted: { type: "boolean" } } }),
    handler: ({ ctx, params: p, body }) => deleteEndpoint(ctx, p.appId, p.endpointId, body.confirm),
});

defineRoute({
    method: "get", path: "/apps/:appId/webhooks/:endpointId/deliveries", tag: "Webhooks", auth: "firstParty", paginated: true, errors: [404],
    summary: "Delivery history (status, attempts, response code, safe error; never payloads)", params,
    query: S.object({
        status: S.enum(["pending", "delivering", "retrying", "succeeded", "dead", "cancelled"] as const, { optional: true }),
        limit: S.int({ optional: true, min: 1, max: 100, default: 20 }),
        cursor: S.objectId({ optional: true }),
    }),
    response: deliveryDoc,
    handler: ({ ctx, params: p, query }) => listDeliveries(ctx, p.appId, p.endpointId, query),
});

defineRoute({
    method: "post", path: "/apps/:appId/webhooks/:endpointId/deliveries/:deliveryId/retry", tag: "Webhooks", auth: "firstParty", errors: [404],
    summary: "Re-queue a dead delivery (while its payload is still kept, up to 7 days)",
    params: S.object({ appId: S.objectId(), endpointId: S.objectId(), deliveryId: S.objectId() }), response: deliveryDoc,
    handler: ({ ctx, params: p }) => retryDelivery(ctx, p.appId, p.endpointId, p.deliveryId),
});
