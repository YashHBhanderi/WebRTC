import mongoose, { Schema } from "mongoose";
import { RequestContext, TenantContextError, currentContext, runAsSystem, userContext } from "./context";

/**
 * Tenant isolation at the data layer.
 *
 * Every tenant-aware collection gets `tenantId` (null = global) and `scope`. Queries made while a
 * user context is active are automatically AND-ed with the context's scope filter, so a forgotten
 * filter in a service cannot leak another workspace's data. New documents are stamped with the
 * scope of the context (conversations) or of the conversation they belong to (derived records).
 *
 * FAIL CLOSED: a query or insert on a scoped model with no context at all throws
 * TenantContextError. Unfiltered access needs an explicit runAsSystem(fn, reason) (migrations,
 * startup recovery, reminders, recording pipeline, internal cache lookups).
 */
export type ConversationScope = "global" | "tenant" | "external";

export interface ScopeInfo {
    tenantId: string | null;
    scope: ConversationScope;
    /** Guests from outside the tenant (external conversations only) */
    externalParticipants: string[];
}

const oid = (id: string) => new mongoose.Types.ObjectId(id);

/**
 * External conversations (Phase 4B rule):
 *   - members of the owning workspace see them only while in that workspace;
 *   - invited guests see them only from their personal (global) context — never inside one of
 *     their own organization's workspaces, so another organization's conversation never appears
 *     in a workspace view.
 */

/** Conversations: the active workspace's own, or (global context) global + those I'm a guest of. */
export function conversationFilter(ctx: RequestContext): Record<string, unknown> {
    if (ctx.tenantId) {
        return { tenantId: oid(ctx.tenantId) };
    }
    return {
        $or: [
            { tenantId: null },
            { scope: "external", externalParticipants: oid(ctx.userId) },
        ],
    };
}

/**
 * Records that belong to a conversation (messages, calls, meetings, recordings, notifications,
 * saved messages). Same rule as conversations: external records carry their conversation's guest
 * list (`guestUserIds`) so only those guests see them from the global context.
 */
export function derivedFilter(ctx: RequestContext): Record<string, unknown> {
    if (ctx.tenantId) {
        return { tenantId: oid(ctx.tenantId) };
    }
    return {
        $or: [
            { tenantId: null },
            { scope: "external", guestUserIds: oid(ctx.userId) },
        ],
    };
}

/** Workspace-owned records (teams…): only the active workspace's; nothing in the personal context. */
export function tenantOwnedFilter(ctx: RequestContext): Record<string, unknown> {
    return ctx.tenantId ? { tenantId: oid(ctx.tenantId) } : { _id: { $exists: false } };
}

/** Can a socket / client in context `tenantId` see data of this conversation? */
export function visibleIn(info: ScopeInfo, tenantId: string | null, userId: string): boolean {
    switch (info.scope) {
        case "tenant":
            return !!tenantId && tenantId === info.tenantId;
        case "external":
            return tenantId ? tenantId === info.tenantId : info.externalParticipants.includes(String(userId));
        default:
            return !tenantId;
    }
}

// ------------------------------------------------------------------ conversation scope cache

const MAX_CACHE = 20_000;
const cache = new Map<string, ScopeInfo | null>();
const inFlight = new Map<string, Promise<ScopeInfo | null>>();

function toInfo(doc: any): ScopeInfo {
    return {
        tenantId: doc?.tenantId ? String(doc.tenantId) : null,
        scope: (doc?.scope as ConversationScope) || (doc?.tenantId ? "tenant" : "global"),
        externalParticipants: (doc?.externalParticipants || []).map(String),
    };
}

/** Synchronous hit (null = unknown conversation, undefined = not cached yet). */
export function cachedConversationScope(conversationId: string): ScopeInfo | null | undefined {
    return cache.get(String(conversationId));
}

/**
 * Scope of a conversation, read without tenant filtering. A conversation's scope never changes
 * after creation (external guests are fixed when it is created), so entries are kept until evicted.
 */
export function conversationScope(conversationId: unknown): Promise<ScopeInfo | null> {
    const id = String(conversationId || "");
    if (!mongoose.isValidObjectId(id)) {
        return Promise.resolve(null);
    }
    if (cache.has(id)) {
        return Promise.resolve(cache.get(id) as ScopeInfo | null);
    }
    let pending = inFlight.get(id);
    if (!pending) {
        pending = runAsSystem(() => mongoose.model("Conversation").findById(id).select("tenantId scope externalParticipants").lean())
            .then((doc: any) => {
                const info = doc ? toInfo(doc) : null;
                if (info) {
                    if (cache.size >= MAX_CACHE) {
                        cache.delete(cache.keys().next().value as string);
                    }
                    cache.set(id, info);
                }
                return info;
            })
            .finally(() => inFlight.delete(id));
        inFlight.set(id, pending);
    }
    return pending;
}

export function rememberConversationScope(conversationId: string, info: ScopeInfo): void {
    cache.set(String(conversationId), info);
}

export function forgetConversationScope(conversationId: string): void {
    cache.delete(String(conversationId));
}

// ------------------------------------------------------------------ mongoose plugin

const QUERY_OPS = [
    "countDocuments", "deleteMany", "deleteOne", "distinct", "find", "findOne", "findOneAndDelete",
    "findOneAndReplace", "findOneAndUpdate", "replaceOne", "updateMany", "updateOne",
] as const;

interface PluginOptions {
    /**
     * conversation: conversations; derived: records of a conversation; tenant: records owned by a
     * workspace itself (teams, team memberships), invisible in the personal context.
     */
    kind: "conversation" | "derived" | "tenant";
    /** Derived records: the conversation a new document belongs to */
    conversationIdOf?: (doc: any) => Promise<unknown> | unknown;
}

export function tenantScopePlugin(schema: Schema, options: PluginOptions): void {
    schema.add({
        tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null },
        scope: { type: String, enum: ["global", "tenant", "external"] },
    });
    if (options.kind === "conversation") {
        schema.add({ externalParticipants: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: undefined } });
    } else if (options.kind === "derived") {
        // External records: the conversation's guests (copied on insert; see derivedFilter)
        schema.add({ guestUserIds: { type: [{ type: Schema.Types.ObjectId, ref: "User" }], default: undefined } });
    }
    schema.index({ tenantId: 1 });

    const filter = options.kind === "conversation" ? conversationFilter : options.kind === "tenant" ? tenantOwnedFilter : derivedFilter;

    schema.pre(QUERY_OPS as any, function (this: any) {
        const ctx = currentContext();
        if (!ctx) {
            throw new TenantContextError(String(this.op || "query"), String(this.model?.modelName || "model"));
        }
        if (ctx.kind === "system") {
            return;
        }
        const current = this.getFilter() || {};
        this.setQuery(Object.keys(current).length ? { $and: [current, filter(ctx)] } : filter(ctx));
        // Upserts insert from the filter, not through "validate": stamp workspace-owned records with the
        // verified workspace (otherwise defaults would insert tenantId null, invisible to everyone)
        if (options.kind === "tenant" && this.getOptions()?.upsert) {
            if (!ctx.tenantId) throw new TenantContextError("upsert (workspace record outside a workspace)", String(this.model?.modelName || "model"));
            const update = (this.getUpdate() || {}) as Record<string, any>;
            this.setUpdate({ ...update, $setOnInsert: { ...(update.$setOnInsert || {}), tenantId: oid(ctx.tenantId), scope: "tenant" } });
        }
    });

    schema.pre("aggregate", function (this: any) {
        const ctx = currentContext();
        if (!ctx) {
            throw new TenantContextError("aggregate", String(this._model?.modelName || "model"));
        }
        if (ctx.kind === "user") {
            this.pipeline().unshift({ $match: filter(ctx) });
        }
    });

    // Stamp new documents with their scope (never taken from client input)
    schema.pre("validate", async function (this: any) {
        if (!this.isNew || this.scope) {
            return;
        }
        const modelName = String(this.constructor?.modelName || "model");
        if (options.kind === "tenant") {
            // Always the creating workspace; system code must set tenantId itself
            const ctx = currentContext();
            if (ctx?.kind === "user") {
                if (!ctx.tenantId) throw new TenantContextError("create (workspace record outside a workspace)", modelName);
                this.tenantId = oid(ctx.tenantId);
            } else if (!this.tenantId) {
                throw new TenantContextError("create (tenantId not set)", modelName);
            }
            this.scope = "tenant";
            return;
        }
        if (options.kind === "conversation") {
            const ctx = currentContext();
            if (ctx?.kind !== "user") {
                // System code must say which scope it creates; no context at all is refused
                throw new TenantContextError("create (scope not set)", modelName);
            }
            this.tenantId = ctx.tenantId ? oid(ctx.tenantId) : null;
            this.scope = ctx.tenantId ? "tenant" : "global";
            return;
        }
        const conversationId = options.conversationIdOf ? await options.conversationIdOf(this) : this.conversationId;
        const info = conversationId ? await conversationScope(conversationId) : null;
        if (info) {
            this.tenantId = info.tenantId ? oid(info.tenantId) : null;
            this.scope = info.scope;
            if (info.scope === "external") {
                this.guestUserIds = info.externalParticipants.map(oid);
            }
        } else {
            // No conversation: belongs to the user context it was created in; otherwise refuse
            const ctx = currentContext();
            if (ctx?.kind !== "user") {
                throw new TenantContextError("create (no conversation, no user context)", modelName);
            }
            this.tenantId = ctx.tenantId ? oid(ctx.tenantId) : null;
            this.scope = ctx.tenantId ? "tenant" : "global";
        }
    });

    schema.post("save", function (doc: any) {
        if (options.kind === "conversation" && doc?._id) {
            rememberConversationScope(String(doc._id), toInfo(doc));
        }
    });
}

/** Exposed for tests / diagnostics. */
export function hasActiveUserContext(): boolean {
    return currentContext()?.kind === "user";
}
