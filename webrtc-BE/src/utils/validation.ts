import mongoose from "mongoose";
import { AppError } from "./errors";

/** Validated ObjectId string, or an AppError naming the field. */
export function requireObjectId(value: unknown, field: string): string {
    const id = typeof value === "string" ? value : value != null ? String(value) : "";
    if (!id || !mongoose.isValidObjectId(id)) {
        throw new AppError(`${field} is invalid`);
    }
    return id;
}

export function requireObjectIds(value: unknown, field: string, max = 256): string[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new AppError(`${field} must be a non-empty list`);
    }
    if (value.length > max) {
        throw new AppError(`${field} has too many entries`);
    }
    return [...new Set(value.map((v) => requireObjectId(v, field)))];
}

/** Trimmed string within bounds; undefined when absent and optional. */
export function optionalString(value: unknown, field: string, maxLength: number): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== "string") {
        throw new AppError(`${field} must be text`);
    }
    const trimmed = value.trim();
    if (trimmed.length > maxLength) {
        throw new AppError(`${field} is too long (max ${maxLength} characters)`);
    }
    return trimmed;
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Public user fields — never send password hashes or verification tokens. */
export const PUBLIC_USER_FIELDS = "username email avatar isOnline lastSeen bio status";

export const PUBLIC_USER_PROJECTION = {
    _id: 1,
    username: 1,
    email: 1,
    avatar: 1,
    isOnline: 1,
    lastSeen: 1,
    bio: 1,
    status: 1,
} as const;
