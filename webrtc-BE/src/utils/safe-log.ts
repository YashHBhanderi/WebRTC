import util from "util";

/**
 * Log redaction, applied to every console.log / info / warn / error call (installSafeConsole()).
 *
 * Why: errors from Mongoose / the MongoDB driver embed document values (a failed message insert
 * carries the message text; a duplicate-key error carries the email), and URLs carry query strings
 * (search text, signed-link signatures). None of that belongs in logs.
 *
 * Primary controls are at the source: safeError() serialises errors by type (values from the
 * database never leave), and logEvent() writes structured lines with an explicit field allowlist.
 * The console filter below is only a backstop for call sites that still pass free text.
 */
const RULES: [RegExp, string][] = [
    // Bearer / JWT / developer secrets / webhook secrets
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
    [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[jwt]"],
    [/\b(sws|whsec|swh)_[A-Za-z0-9_-]{8,}/g, "[secret]"],
    // Query strings (search text, sig=, exp=, tokens) — keep the path
    [/((?:https?:\/\/[^\s/?#]+)?\/[^\s?#"']*)\?[^\s"'<>]*/g, "$1?[query]"],
    // Values echoed by the MongoDB driver / Mongoose validators
    [/dup key: \{[^}]*\}/g, "dup key: {[redacted]}"],
    [/(Path `[^`]+`) \(`[^`]*`\)/g, "$1 ([value])"],
    [/`[^`]{0,200}` is not a valid enum value/g, "[value] is not a valid enum value"],
    [/value "[^"]{0,500}"/g, 'value "[redacted]"'],
    // Cookie headers, and values of secret-named keys (headers / inspected objects)
    [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, "Basic [redacted]"],
    [/\b(set-cookie|cookie)(['"]?\s*[:=]\s*)[^\n]*/gi, "$1$2[redacted]"],
    [/\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)(['"]?\s*[:=]\s*)(['"]?)[^'",\s}]+/gi, "$1$2$3[redacted]"],
    // Email addresses
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
];

export function redact(text: string): string {
    let out = text;
    for (const [re, rep] of RULES) out = out.replace(re, rep);
    return out.length > 2000 ? `${out.slice(0, 2000)}…[truncated]` : out;
}

function describe(value: unknown): unknown {
    if (value instanceof Error) return formatError(safeError(value));
    if (value && typeof value === "object" && (value as any)[SAFE]) return formatError(value as SafeError);
    if (typeof value === "string") return redact(value);
    if (value === null || typeof value !== "object") return value;
    // Objects: shallow inspection only (never dump whole documents), then redact
    return redact(util.inspect(value, { depth: 1, breakLength: Infinity, maxArrayLength: 10, maxStringLength: 200 }));
}

export function sanitizeArgs(args: unknown[]): unknown[] {
    return args.map(describe);
}

export interface SafeError {
    name: string;
    code?: string | number;
    status?: number;
    /** Only for our own errors (written by us, never containing user data) or redacted + capped */
    message?: string;
    /** Validation failures: which fields and why, never the values */
    fields?: { path: string; kind: string }[];
    frames?: string;
}

/** Errors whose messages we wrote ourselves and that never embed user input */
const OWN_ERRORS = new Set(["AppError", "TenantContextError", "BlockedDestinationError"]);

/**
 * Type-aware error serialisation. Mongoose / MongoDB errors carry document values (message text,
 * emails, ids) in their messages and properties, so for those only the structure is kept.
 * Arbitrary properties (axios/AWS request config, headers, keyValue…) are never copied.
 */
export function safeError(error: unknown): SafeError {
    return Object.defineProperty(serialise(error), SAFE, { value: true });
}

const SAFE = Symbol("safeError");

function serialise(error: unknown): SafeError {
    if (!(error instanceof Error)) {
        return { name: typeof error, message: typeof error === "string" ? redact(error).slice(0, 200) : undefined };
    }
    const e = error as any;
    const frames = (e.stack || "").split("\n").slice(1, 4).map((l: string) => l.trim()).join(" | ") || undefined;
    const out: SafeError = { name: String(e.name || "Error"), frames };
    if (typeof e.status === "number") out.status = e.status;
    if (e.code !== undefined && (typeof e.code === "string" || typeof e.code === "number")) out.code = e.code;
    if (OWN_ERRORS.has(out.name)) {
        out.message = redact(String(e.message)).slice(0, 300);
    } else if (out.name === "ValidationError" && e.errors && typeof e.errors === "object") {
        out.fields = Object.entries(e.errors).slice(0, 10).map(([path, v]: [string, any]) => ({ path, kind: String(v?.kind || v?.name || "invalid") }));
    } else if (out.name === "CastError") {
        out.fields = [{ path: String(e.path || "?"), kind: `cast:${String(e.kind || "?")}` }];
    } else if (/^Mongo/.test(out.name)) {
        if (e.codeName) out.message = String(e.codeName);
        if (e.keyPattern && typeof e.keyPattern === "object") out.fields = Object.keys(e.keyPattern).map((path) => ({ path, kind: "duplicate" }));
    } else {
        out.message = redact(String(e.message ?? "")).slice(0, 200);
    }
    return out;
}

function formatError(e: SafeError): string {
    const parts = [e.name];
    if (e.code !== undefined) parts.push(`code=${e.code}`);
    if (e.status !== undefined) parts.push(`status=${e.status}`);
    if (e.fields?.length) parts.push(`fields=${e.fields.map((f) => `${f.path}:${f.kind}`).join(",")}`);
    if (e.message) parts.push(`- ${e.message}`);
    if (e.frames) parts.push(`(${e.frames})`);
    return parts.join(" ");
}

/**
 * Structured log fields that may be written. Anything else is dropped (and counted), so a call site
 * cannot leak a body, header, email or token by passing the wrong object.
 */
const LOG_FIELDS = new Set([
    "userId", "tenantId", "conversationId", "messageId", "appId", "credentialId", "grantId", "endpointId",
    "deliveryId", "eventType", "callId", "recordingId", "socketId", "requestId", "method", "path", "status",
    "durationMs", "reason", "count", "attempt", "code", "kind", "action", "event", "error",
]);

export function logEvent(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): string {
    const record: Record<string, unknown> = { level, event, at: new Date().toISOString() };
    let omitted = 0;
    for (const [key, value] of Object.entries(fields)) {
        if (!LOG_FIELDS.has(key)) { omitted++; continue; }
        if (key === "error") record.error = safeError(value);
        else if (key === "path" && typeof value === "string") record.path = value.split("?")[0].slice(0, 200);
        else if (value === null || ["number", "boolean"].includes(typeof value)) record[key] = value;
        else record[key] = redact(String(value)).slice(0, 120);
    }
    if (omitted) record.omittedFields = omitted;
    const line = JSON.stringify(record);
    const write = level === "info" ? rawConsole.log : level === "warn" ? rawConsole.warn : rawConsole.error;
    write(line);
    return line;
}

// Unfiltered console methods for already-safe structured output (set by installSafeConsole)
const rawConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

let installed = false;

export function installSafeConsole(): void {
    if (installed) return;
    installed = true;
    for (const level of ["log", "info", "warn", "error", "debug"] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => original(...sanitizeArgs(args));
    }
}
