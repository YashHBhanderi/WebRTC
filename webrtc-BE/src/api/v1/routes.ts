import mongoose from "mongoose";
import Conversation from "../../models/conversationModel";
import User from "../../models/userModel";
import MessageService from "../../services/message.service";
import callHistory from "../../services/call-history.service";
import recordingService from "../../services/recording.service";
import { runAsSystem } from "../../tenancy/context";
import {
    DIRECTORY_FIELDS, createExternalConversation, directoryFilter, myWorkspaces, tenantSummary,
} from "../../tenancy/tenant.service";
import { NotFoundError } from "../../utils/errors";
import { updateWorkspacePolicies } from "../../organizations/workspace-policies";
import { defineRoute } from "./registry";
import { S } from "./schema";

/**
 * /v1 endpoints. Conventions (see docs/api/v1.md):
 *   - lists: `?limit=` (1–100, default 20) and `?cursor=` (opaque, from page.nextCursor)
 *   - ids: 24-character hex; malformed ids are 400, ids you can't see are 404 (never 403, so
 *     existence of other workspaces' resources is not revealed)
 *   - the workspace is always the session's active organization; no endpoint takes a tenant id
 */
const oid = (id: string) => new mongoose.Types.ObjectId(id);
const limitQuery = S.int({ optional: true, min: 1, max: 100, default: 20, description: "Page size" });
const cursorQuery = S.objectId({ optional: true, description: "Opaque cursor from page.nextCursor" });

const person = S.doc({
    type: "object",
    properties: {
        _id: { type: "string" }, username: { type: "string" }, avatar: { type: "string" },
        isOnline: { type: "boolean" }, status: { type: "string" }, statusMessage: { type: "string" },
    },
});

const policies = S.doc({
    type: "object",
    properties: {
        allowExternalChat: { type: "boolean" }, allowExternalCalls: { type: "boolean" },
        allowExternalFiles: { type: "boolean" }, membersCanStartExternal: { type: "boolean" },
    },
});

defineRoute({
    method: "get", path: "/me", scope: "profile:read", tag: "Account", summary: "The signed-in user and active context",
    response: S.doc({
        type: "object",
        properties: {
            user: { type: "object", properties: { _id: { type: "string" }, username: { type: "string" }, email: { type: "string" }, avatar: { type: "string" }, globalDiscoverable: { type: "boolean" } } },
            context: { type: "object", properties: { tenantId: { type: "string", nullable: true }, role: { type: "string", nullable: true, enum: ["owner", "admin", "member"] } } },
        },
    }),
    handler: async ({ ctx }) => {
        const user = await User.findById(ctx.userId).select("username email avatar globalDiscoverable").lean();
        if (!user) throw new NotFoundError("Account not found");
        return { user: { ...user, _id: String(user._id) }, context: { tenantId: ctx.tenantId, role: ctx.role } };
    },
});

defineRoute({
    method: "get", path: "/workspace", tag: "Workspace", workspace: true,
    summary: "Active workspace: name, my role, policies and my permissions",
    response: S.doc({
        type: "object",
        properties: {
            _id: { type: "string" }, name: { type: "string" }, slug: { type: "string" }, status: { type: "string" },
            role: { type: "string", enum: ["owner", "admin", "member"] }, policies: policies.openapi(),
            permissions: { type: "object", properties: { updatePolicies: { type: "boolean" }, startExternal: { type: "boolean" } } },
        },
    }),
    handler: ({ ctx }) => tenantSummary(ctx),
});

defineRoute({
    method: "patch", path: "/workspace/policies", tag: "Workspace", workspace: true, sensitive: true,
    summary: "Change workspace policies (owner / admin only)",
    body: S.object({
        allowExternalChat: S.bool({ optional: true }),
        allowExternalCalls: S.bool({ optional: true }),
        allowExternalFiles: S.bool({ optional: true }),
        membersCanStartExternal: S.bool({ optional: true }),
    }, { minProperties: 1 }),
    response: S.doc({ type: "object", description: "Same shape as GET /workspace" }),
    handler: ({ ctx, body }) => updateWorkspacePolicies(ctx, body),
});

defineRoute({
    method: "get", path: "/workspaces", tag: "Workspace", summary: "Workspaces I have used (switching happens in Clerk)",
    response: S.doc({
        type: "array",
        items: { type: "object", properties: { tenantId: { type: "string" }, clerkOrgId: { type: "string" }, name: { type: "string" }, slug: { type: "string" }, role: { type: "string" }, active: { type: "boolean" } } },
    }),
    handler: ({ ctx }) => myWorkspaces(ctx),
});

defineRoute({
    method: "get", path: "/directory", scope: "directory:read", tag: "People", paginated: true,
    summary: "People I can start a conversation with in the active context",
    description: "Workspace context: active members of the workspace. Global context: users listed in the global directory. Never includes emails.",
    query: S.object({ q: S.string({ optional: true, max: 100, description: "Name filter" }), limit: limitQuery, cursor: cursorQuery }),
    response: person,
    handler: async ({ ctx, query }) => {
        const filter = await directoryFilter(ctx, query.q);
        if (query.cursor) {
            // _id already holds $ne / $in from the audience filter; add the cursor to the same operator object
            filter._id = { ...(filter._id as Record<string, unknown>), $gt: oid(query.cursor) };
        }
        const rows = await runAsSystem(() => User.find(filter).select(DIRECTORY_FIELDS).sort({ _id: 1 }).limit(query.limit + 1).lean(), "directory");
        const page = rows.slice(0, query.limit);
        return {
            items: page.map((u: any) => ({ _id: String(u._id), username: u.username, avatar: u.avatar || "", isOnline: !!u.isOnline, status: u.status, statusMessage: u.statusMessage || "" })),
            nextCursor: rows.length > query.limit ? String(page[page.length - 1]._id) : null,
        };
    },
});

defineRoute({
    method: "get", path: "/conversations", scope: "conversations:read", tag: "Conversations", paginated: true,
    summary: "My conversations in the active context, newest first",
    query: S.object({ limit: limitQuery, cursor: cursorQuery }),
    response: S.doc({
        type: "object",
        properties: {
            _id: { type: "string" }, isGroup: { type: "boolean" }, name: { type: "string" },
            scope: { type: "string", enum: ["global", "tenant", "external"] }, external: { type: "boolean" },
            memberCount: { type: "integer" }, createdAt: { type: "string", format: "date-time" },
        },
    }),
    handler: async ({ ctx, query }) => {
        const filter: Record<string, unknown> = { members: oid(ctx.userId) };
        if (query.cursor) filter._id = { $lt: oid(query.cursor) };
        const rows = await Conversation.find(filter).select("isGroup groupName scope members createdAt").sort({ _id: -1 }).limit(query.limit + 1).lean();
        const page = rows.slice(0, query.limit);
        return {
            items: page.map((c: any) => ({
                _id: String(c._id), isGroup: !!c.isGroup, name: c.groupName || "", scope: c.scope || "global",
                external: c.scope === "external", memberCount: (c.members || []).length, createdAt: c.createdAt,
            })),
            nextCursor: rows.length > query.limit ? String(page[page.length - 1]._id) : null,
        };
    },
});

defineRoute({
    method: "get", path: "/conversations/:conversationId/messages", scope: "messages:read", tag: "Conversations", paginated: true,
    summary: "Messages of a conversation I belong to, newest first", errors: [404],
    params: S.object({ conversationId: S.objectId() }),
    query: S.object({ limit: limitQuery, cursor: cursorQuery }),
    response: S.doc({
        type: "object",
        properties: {
            _id: { type: "string" }, conversationId: { type: "string" }, type: { type: "string" }, content: { type: "string" },
            author: { type: "object", properties: { _id: { type: "string" }, username: { type: "string" }, avatar: { type: "string" } } },
            replyToId: { type: "string", nullable: true }, editedAt: { type: "string", nullable: true, format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
        },
    }),
    handler: async ({ ctx, params, query }) => {
        try {
            const page: any = await MessageService.historyPage(params.conversationId, ctx.userId, { before: query.cursor, limit: query.limit });
            // Developer apps can't take part in end-to-end encryption: they see that a message is
            // encrypted, never its ciphertext. First-party clients get the ciphertext to decrypt.
            if (ctx.app && Array.isArray(page?.items)) {
                page.items = page.items.map((m: any) => (m?.e2ee ? { ...m, e2ee: undefined, content: null, encrypted: true } : m));
            }
            return page;
        } catch (error: any) {
            // Not a member / not visible in this context: same answer as "doesn't exist"
            if (error?.status === 403) throw new NotFoundError("Conversation not found");
            throw error;
        }
    },
});

defineRoute({
    method: "post", path: "/conversations/external", tag: "Conversations", workspace: true, sensitive: true,
    summary: "Start (or reopen) an external 1:1 chat with someone outside the workspace", errors: [404],
    description: "Requires the workspace policy allowExternalChat, and admin role unless membersCanStartExternal.",
    body: S.object({ userId: S.objectId({ description: "The outside person" }) }),
    response: S.doc({ type: "object", properties: { conversationId: { type: "string" }, scope: { type: "string", enum: ["external"] } } }),
    handler: async ({ ctx, body }) => {
        const conversation = await createExternalConversation(ctx, body.userId);
        return { conversationId: String(conversation._id), scope: "external" };
    },
});

defineRoute({
    method: "get", path: "/calls", scope: "calls:read", tag: "Calls", paginated: true,
    summary: "My call history in the active context",
    query: S.object({
        limit: limitQuery,
        cursor: S.string({ optional: true, max: 40, pattern: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, description: "Opaque cursor from page.nextCursor" }),
        filter: S.enum(["missed", "incoming", "outgoing"] as const, { optional: true }),
    }),
    response: S.doc({ type: "object", description: "Call history entry (same fields as GET /calls)" }),
    handler: async ({ ctx, query }) => {
        const res: any = await callHistory.list(ctx.userId, { before: query.cursor, filter: query.filter, limit: query.limit });
        return { items: res.items, nextCursor: res.nextCursor };
    },
});

defineRoute({
    method: "get", path: "/recordings/:recordingId", scope: "recordings:read", tag: "Recordings", errors: [404],
    summary: "Recording details with short-lived private playback / download links",
    params: S.object({ recordingId: S.objectId() }),
    response: S.doc({ type: "object", description: "Recording metadata; playbackUrl/downloadUrl are short-lived signed links or null" }),
    handler: ({ ctx, params }) => recordingService.get(params.recordingId, ctx.userId),
});
