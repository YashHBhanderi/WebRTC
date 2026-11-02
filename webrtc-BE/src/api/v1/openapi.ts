import fs from "fs";
import path from "path";
import { RouteDef, authModeOf, routes } from "./registry";
import { APP_SCOPES } from "../../developer/scopes";
import "./routes";
import "./developer.routes";
import "./webhook.routes";
import "./workspace.routes";
import "./organization.routes";
import "./team.routes";
import "./contact.routes";
import "./e2ee.routes";

/**
 * OpenAPI 3.0 document generated from the /v1 route registry (the same definitions the router
 * uses for validation), so the documentation cannot describe routes or fields that don't exist.
 */
const errorBody = {
    type: "object",
    required: ["error"],
    properties: {
        error: {
            type: "object",
            required: ["code", "message"],
            properties: {
                code: { type: "string", enum: ["VALIDATION_ERROR", "AUTHENTICATION_ERROR", "PERMISSION_ERROR", "NOT_FOUND_ERROR", "CONFLICT_ERROR", "RATE_LIMIT_ERROR", "SERVER_ERROR"] },
                message: { type: "string" },
                details: { type: "array", items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } } },
            },
        },
    },
};

const errorResponse = (description: string) => ({ description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } });

const COMMON_ERRORS: Record<number, string> = {
    400: "Invalid request (see error.details) or no active workspace when one is required",
    401: "Missing or invalid session token",
    403: "Not allowed (role, policy, removed membership, suspended or deleted workspace)",
    429: "Rate limit exceeded",
    500: "Unexpected server error (details are logged, never returned)",
};

function parameters(def: RouteDef) {
    const out: Record<string, unknown>[] = [];
    const add = (where: "path" | "query", schema: any) => {
        const spec = schema?.openapi?.();
        for (const [name, prop] of Object.entries<any>(spec?.properties || {})) {
            const { description, ...rest } = prop;
            out.push({ name, in: where, required: where === "path" || (spec.required || []).includes(name), ...(description ? { description } : {}), schema: rest });
        }
    };
    add("path", def.params);
    add("query", def.query);
    return out;
}

/** Who may call a route: session only, session or an app token with the scope, or an app credential. */
export function securityFor(def: RouteDef): Record<string, string[]>[] {
    const mode = authModeOf(def);
    if (mode === "appCredential") return [{ appCredential: [] }];
    if (mode === "user" && def.scope) return [{ clerkSession: [] }, { appUserToken: [def.scope] }];
    return [{ clerkSession: [] }];
}

/** Default description: who may call the operation (every operation then documents its access rules). */
function describeAccess(def: RouteDef): string {
    const who: Record<string, string> = {
        user: "Signed-in user (Clerk session) or an app user token",
        firstParty: "Signed-in user in a first-party SpreeWe client (Clerk session only; app tokens are refused)",
        appCredential: "App server credential (HTTP Basic keyId:secret); never from a browser or mobile app",
    };
    const parts = [`${def.summary}.`, `Access: ${who[authModeOf(def)] || authModeOf(def)}.`];
    if (def.scope) parts.push(`App tokens need the \`${def.scope}\` scope.`);
    if (def.workspace) parts.push("Requires an active workspace (organization) in the session.");
    return parts.join(" ");
}

export function buildOpenApi(defs: RouteDef[] = routes): Record<string, unknown> {
    const paths: Record<string, Record<string, unknown>> = {};
    for (const def of defs) {
        const p = "/v1" + def.path.replace(/:([A-Za-z]+)/g, "{$1}");
        const success = def.method === "post" ? "201" : "200";
        const data = def.paginated
            ? { type: "object", required: ["data", "page"], properties: { data: { type: "array", items: def.response.openapi() }, page: { $ref: "#/components/schemas/Page" } } }
            : { type: "object", required: ["data"], properties: { data: def.response.openapi() } };
        const statuses = [...new Set([400, 401, 403, 429, 500, ...(def.errors || [])])].sort();
        paths[p] = paths[p] || {};
        paths[p][def.method] = {
            tags: [def.tag],
            summary: def.summary,
            description: def.description || describeAccess(def),
            operationId: `${def.method}${def.path.replace(/[:/]+(\w)/g, (_m, c) => c.toUpperCase())}`,
            security: securityFor(def),
            ...(def.scope ? { "x-required-scope": def.scope } : {}),
            "x-auth": authModeOf(def),
            ...(parameters(def).length ? { parameters: parameters(def) } : {}),
            ...(def.body ? { requestBody: { required: true, content: { "application/json": { schema: def.body.openapi() } } } } : {}),
            responses: {
                [success]: { description: "Success", content: { "application/json": { schema: data } } },
                ...Object.fromEntries(statuses.map((s) => [String(s), errorResponse(COMMON_ERRORS[s] || (s === 404 ? "Not found, or not visible in the active context" : "Error"))])),
            },
            "x-rate-limit": def.sensitive ? "sensitive" : "default",
            ...(def.workspace ? { "x-requires-workspace": true } : {}),
        };
    }
    return {
        openapi: "3.0.3",
        info: {
            title: "SpreeWe API",
            version: "1.0.0",
            contact: { name: "SpreeWe platform team" },
            description: "Generated from webrtc-BE/src/api/v1 (npm run openapi). Do not edit by hand. See docs/api/v1.md for conventions.",
        },
        servers: [{ url: "/api", description: "Behind nginx (also served without the /api prefix)" }],
        tags: [...new Set(defs.map((d) => d.tag))].map((name) => ({ name })),
        paths,
        components: {
            securitySchemes: {
                clerkSession: { type: "http", scheme: "bearer", bearerFormat: "JWT", description: "Clerk session token (first-party SpreeWe apps). The active organization in the token selects the workspace." },
                appUserToken: {
                    type: "oauth2",
                    description: "Short-lived developer-app user token (Authorization: Bearer). Obtained by the app's SERVER from POST /v1/app-tokens for a user who authorised the app. Routes list the scope they need (x-required-scope).",
                    flows: { clientCredentials: { tokenUrl: "/api/v1/app-tokens", scopes: { ...APP_SCOPES } } },
                },
                appCredential: { type: "http", scheme: "basic", description: "Developer app server credential: base64(keyId:secret). Server-to-server only; never ship it to browsers or mobile apps." },
            },
            schemas: {
                Error: errorBody,
                Page: { type: "object", properties: { nextCursor: { type: "string", nullable: true, description: "Pass as ?cursor= for the next page; null when there are no more" } } },
            },
        },
    };
}

// ------------------------------------------------------------------ YAML (no dependency)

function scalar(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "boolean" || typeof v === "number") return String(v);
    const s = String(v);
    return /^[A-Za-z0-9_./{}-][A-Za-z0-9 _./{}()-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|\d.*)$/i.test(s) && !s.endsWith(" ")
        ? s
        : JSON.stringify(s);
}

export function toYaml(value: unknown, indent = 0): string {
    const pad = " ".repeat(indent);
    if (Array.isArray(value)) {
        if (!value.length) return "[]";
        return value.map((item) => {
            if (item && typeof item === "object") {
                const inner = toYaml(item, indent + 2);
                return `${pad}- ${inner.trimStart()}`;
            }
            return `${pad}- ${scalar(item)}`;
        }).join("\n");
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>);
        if (!entries.length) return "{}";
        return entries.map(([k, v]) => {
            const key = scalar(k);
            if (v && typeof v === "object" && (Array.isArray(v) ? v.length : Object.keys(v).length)) {
                return `${pad}${key}:\n${toYaml(v, indent + 2)}`;
            }
            return `${pad}${key}: ${v && typeof v === "object" ? (Array.isArray(v) ? "[]" : "{}") : scalar(v)}`;
        }).join("\n");
    }
    return pad + scalar(value);
}

export const OPENAPI_FILE = path.resolve(__dirname, "../../../../docs/api/openapi.yaml");

export function renderOpenApi(): string {
    return `# Generated by webrtc-BE (npm run openapi). Do not edit by hand.\n${toYaml(buildOpenApi())}\n`;
}

/** `node dist/api/v1/openapi.js` (npm run openapi) writes the document. */
if (require.main === module) {
    fs.mkdirSync(path.dirname(OPENAPI_FILE), { recursive: true });
    fs.writeFileSync(OPENAPI_FILE, renderOpenApi());
    console.log(`Wrote ${OPENAPI_FILE}`);
}
