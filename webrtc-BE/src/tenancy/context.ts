import { AsyncLocalStorage } from "async_hooks";

/**
 * Who is acting, and in which workspace. Resolved on the server from the verified Clerk session
 * (never from client-supplied ids) for every HTTP request and Socket.IO connection.
 *
 *   tenantId === null  → global (personal) context: global + explicitly shared external data
 *   tenantId === <id>  → that organization's workspace (Clerk active organization)
 */
export type TenantRole = "owner" | "admin" | "member" | "guest";

export interface RequestContext {
    kind: "user";
    /** App (MongoDB) user id */
    userId: string;
    /** Tenant document id, or null for the global context */
    tenantId: string | null;
    /** Clerk organization id of the active workspace (null in the global context) */
    clerkOrgId: string | null;
    /** Role in the active workspace (null in the global context) */
    role: TenantRole | null;
    /** Platform super admin (PLATFORM_ADMIN_CLERK_IDS); grants nothing inside tenant data by itself */
    isPlatformAdmin: boolean;
    /** Minutes since the user last verified a first factor (Clerk fva), when the session carries it */
    authAgeMinutes?: number | null;
    /** Set when the request is made with a developer-app user token (never for first-party sessions) */
    app?: AppIdentity;
}

export interface AppIdentity {
    appId: string;
    environment: "development" | "production";
    /** Effective scopes: token ∩ grant ∩ app (re-evaluated on every request) */
    scopes: string[];
    jti: string;
    quotas: { rateLimitPerMinute: number; maxConnections: number; messagesPerDay: number };
}

/**
 * Explicitly authorised internal work that must see every scope: migrations, startup recovery,
 * scheduled reminders, the recording / transcription pipeline, internal cache lookups.
 * Never created from request input; every use names its reason (logged on failures, greppable).
 */
export interface SystemContext {
    kind: "system";
    reason: string;
}

export type Context = RequestContext | SystemContext;

const storage = new AsyncLocalStorage<Context>();

/**
 * Mongoose queries are lazy: `Model.find()` only runs when awaited, which would be AFTER run()
 * returned — i.e. outside the context. Start such queries inside the context instead.
 */
function startInside<T>(fn: () => T): T {
    const result: any = fn();
    return result && typeof result.exec === "function" && typeof result.then === "function" ? result.exec() : result;
}

export function runWithContext<T>(context: Context, fn: () => T): T {
    return storage.run(context, () => startInside(fn));
}

/**
 * Run `fn` as explicitly authorised internal work (no tenant filter). Tenant-scoped models refuse
 * to run without either a user context or this; there is no silent fallback.
 */
export function runAsSystem<T>(fn: () => T, reason = "internal-lookup"): T {
    return storage.run({ kind: "system", reason }, () => startInside(fn));
}

/** Thrown when a tenant-scoped model is used with no context at all (fail closed). */
export class TenantContextError extends Error {
    constructor(operation: string, model: string) {
        super(`Tenant context required for ${model}.${operation} (no user or system context)`);
        this.name = "TenantContextError";
    }
}

export function currentContext(): Context | undefined {
    return storage.getStore();
}

/** The acting user's context, or undefined outside a user request (system / no context). */
export function userContext(): RequestContext | undefined {
    const ctx = storage.getStore();
    return ctx && ctx.kind === "user" ? ctx : undefined;
}

/** Key of a context for socket routing / caches: "global" or the tenant id. */
export function contextKey(tenantId: string | null | undefined): string {
    return tenantId ? `t:${tenantId}` : "global";
}
