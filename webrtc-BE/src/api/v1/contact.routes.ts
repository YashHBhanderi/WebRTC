import { defineRoute } from "./registry";
import { S } from "./schema";
import * as contacts from "../../contacts/contact.service";

/**
 * Finding someone to talk to by exact email (no directory browsing). Works in the personal context
 * and in an organization (scope "member" = inside it, "external" = outside it, policy permitting).
 * POST so the address never appears in URLs or access logs. See
 * docs/implementation/contact-discovery-and-organization-navigation.md.
 */
const body = S.object({
    email: S.string({ max: 254, trim: true }),
    scope: S.enum(["member", "external"] as const, { optional: true, description: "Organization context only; default member" }),
});
const person = { _id: { type: "string" }, username: { type: "string" }, avatar: { type: "string" } };

defineRoute({
    method: "post", path: "/contacts/lookup", tag: "People", scope: "directory:read", sensitive: true, errors: [400, 403, 429],
    summary: "Find an eligible person by exact email. Unregistered, blocked or unavailable people all get found=false",
    body,
    response: S.doc({ type: "object", properties: { found: { type: "boolean" }, message: { type: "string" }, user: { type: "object", properties: person }, external: { type: "boolean" }, conversationId: { type: "string", nullable: true } } }),
    handler: ({ ctx, body: b }) => contacts.lookupContact(ctx, b as any),
});

defineRoute({
    method: "post", path: "/contacts/start", tag: "People", scope: "contacts:write", sensitive: true, errors: [400, 403, 404, 429],
    summary: "Open (or reuse) a direct conversation with the person behind this email; external conversations only where the organization allows them",
    body,
    response: S.doc({ type: "object", properties: { conversationId: { type: "string" }, external: { type: "boolean" } } }),
    handler: ({ ctx, body: b }) => contacts.startConversation(ctx, b as any),
});
