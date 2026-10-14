import { Response } from "express";

/**
 * Expected, user-facing failures (validation, permission, not found).
 * Anything else is treated as an internal error and logged, never echoed to clients.
 */
export class AppError extends Error {
    constructor(message: string, public readonly status = 400) {
        super(message);
        this.name = "AppError";
    }
}

export class ForbiddenError extends AppError {
    constructor(message = "You are not allowed to do this") {
        super(message, 403);
    }
}

export class NotFoundError extends AppError {
    constructor(message = "Not found") {
        super(message, 404);
    }
}

/** Message safe to send to a client. */
export function publicMessage(error: unknown, fallback = "Something went wrong"): string {
    return error instanceof AppError ? error.message : fallback;
}

export type ErrorCode =
    | "VALIDATION_ERROR"
    | "AUTHENTICATION_ERROR"
    | "PERMISSION_ERROR"
    | "NOT_FOUND_ERROR"
    | "CONFLICT_ERROR"
    | "RATE_LIMIT_ERROR"
    | "SERVER_ERROR";

export function errorCodeFor(status: number): ErrorCode {
    switch (status) {
        case 400: case 413: case 415: case 422: return "VALIDATION_ERROR";
        case 401: return "AUTHENTICATION_ERROR";
        case 403: return "PERMISSION_ERROR";
        case 404: return "NOT_FOUND_ERROR";
        case 409: return "CONFLICT_ERROR";
        case 429: return "RATE_LIMIT_ERROR";
        default: return status < 500 ? "VALIDATION_ERROR" : "SERVER_ERROR";
    }
}

/**
 * Standard failure response. Keeps the existing `{ status, data, message }` shape and adds
 * `error: { code, message, actionable }`. Internal errors are logged, never echoed.
 */
export function sendError(res: Response, error: unknown, fallback = "Something went wrong. Please try again."): void {
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500) {
        console.error("[api]", res.req?.method, res.req?.originalUrl, error);
    }
    const message = publicMessage(error, fallback);
    res.status(status).json({
        status: false,
        success: false,
        data: null,
        message,
        error: { code: errorCodeFor(status), message, actionable: status < 500 },
    });
}
