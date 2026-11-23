/**
 * One error type for everything the SDK reports: REST failures, OAuth errors, socket refusals and
 * client-side preconditions (missing scope, encryption unavailable). `code` is stable and meant for
 * program logic; `message` is human-readable and may change.
 */
export type SpreeWeErrorCode =
    // transport
    | "NETWORK_ERROR"
    | "TIMEOUT"
    | "ABORTED"
    // auth
    | "UNAUTHENTICATED"
    | "SIGNED_OUT"
    | "OAUTH_ERROR"
    | "OAUTH_STATE_MISMATCH"
    | "MISSING_SCOPE"
    // server answers (REST `error.code` values pass through unchanged, e.g. VALIDATION_ERROR)
    | "FORBIDDEN"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "SERVER_ERROR"
    | "REQUEST_FAILED"
    // realtime
    | "SOCKET_UNAVAILABLE"
    | "SOCKET_REFUSED"
    | "ACK_TIMEOUT"
    // features
    | "E2EE_UNAVAILABLE"
    | "E2EE_FAILED"
    | "MESSAGE_REJECTED"
    | "MEDIA_ERROR"
    | "INVALID_ARGUMENT"
    | (string & {});

export interface SpreeWeErrorInit {
    code: SpreeWeErrorCode;
    message: string;
    status?: number;
    details?: unknown;
    retryAfterMs?: number;
    cause?: unknown;
}

export class SpreeWeError extends Error {
    readonly code: SpreeWeErrorCode;
    /** HTTP status when the error came from a REST call */
    readonly status?: number;
    /** Server-provided details (validation errors, OAuth error_description, rejection reason …) */
    readonly details?: unknown;
    /** Set for 429 answers that carried Retry-After */
    readonly retryAfterMs?: number;

    constructor(init: SpreeWeErrorInit) {
        super(init.message);
        this.name = "SpreeWeError";
        this.code = init.code;
        this.status = init.status;
        this.details = init.details;
        this.retryAfterMs = init.retryAfterMs;
        if (init.cause !== undefined) (this as { cause?: unknown }).cause = init.cause;
    }
}

export function isSpreeWeError(e: unknown, code?: SpreeWeErrorCode): e is SpreeWeError {
    return e instanceof SpreeWeError && (code === undefined || e.code === code);
}

const STATUS_CODES: Record<number, SpreeWeErrorCode> = {
    401: "UNAUTHENTICATED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    429: "RATE_LIMITED",
};

/**
 * Map a non-2xx response body to a SpreeWeError. Understands the three formats the backend uses:
 * - /v1 routes:     { error: { code, message, details } }
 * - session routes: { status|success: false, message, data }
 * - OAuth:          { error: "invalid_grant", error_description }
 */
export function errorFromResponse(status: number, body: unknown, retryAfterMs?: number): SpreeWeError {
    const b = (body && typeof body === "object" ? body : {}) as Record<string, any>;
    if (b.error && typeof b.error === "object") {
        return new SpreeWeError({
            code: String(b.error.code || STATUS_CODES[status] || fallbackCode(status)),
            message: String(b.error.message || `Request failed (${status})`),
            status,
            details: b.error.details,
            retryAfterMs,
        });
    }
    if (typeof b.error === "string") {
        return new SpreeWeError({
            code: status === 429 ? "RATE_LIMITED" : "OAUTH_ERROR",
            message: String(b.error_description || b.error),
            status,
            details: { error: b.error, error_description: b.error_description },
            retryAfterMs,
        });
    }
    return new SpreeWeError({
        code: STATUS_CODES[status] || fallbackCode(status),
        message: typeof b.message === "string" && b.message ? b.message : `Request failed (${status})`,
        status,
        details: b.data ?? undefined,
        retryAfterMs,
    });
}

function fallbackCode(status: number): SpreeWeErrorCode {
    return status >= 500 ? "SERVER_ERROR" : "REQUEST_FAILED";
}

/** Human-readable message for any thrown value (for UI error states). */
export function errorMessage(e: unknown, fallback = "Something went wrong."): string {
    if (e instanceof Error && e.message) return e.message;
    if (typeof e === "string" && e) return e;
    return fallback;
}
