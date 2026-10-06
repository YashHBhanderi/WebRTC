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
