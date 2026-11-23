import mongoose from "mongoose";
import { AppError } from "../../utils/errors";

/**
 * Minimal validation schemas for the /v1 API. One definition drives both request validation and
 * the generated OpenAPI document (no extra dependency, no drift between docs and behaviour).
 */
export interface FieldIssue {
    path: string;
    message: string;
}

export class ValidationError extends AppError {
    constructor(public readonly details: FieldIssue[]) {
        super("The request is invalid", 400);
        this.name = "ValidationError";
    }
}

export interface Schema<T = unknown> {
    /** Returns the parsed value or pushes issues */
    parse(value: unknown, path: string, issues: FieldIssue[]): T | undefined;
    openapi(): Record<string, unknown>;
    optional?: boolean;
    description?: string;
}

type Opt = { optional?: boolean; description?: string };

const withMeta = <S extends Schema>(schema: S, opt?: Opt): S => Object.assign(schema, { optional: !!opt?.optional, description: opt?.description });

export const S = {
    string(opt: Opt & { min?: number; max?: number; pattern?: RegExp; trim?: boolean } = {}): Schema<string> {
        return withMeta({
            parse(v, path, issues) {
                if (typeof v !== "string") return void issues.push({ path, message: "must be a string" });
                const s = opt.trim === false ? v : v.trim();
                if (opt.min !== undefined && s.length < opt.min) return void issues.push({ path, message: `must be at least ${opt.min} characters` });
                if (opt.max !== undefined && s.length > opt.max) return void issues.push({ path, message: `must be at most ${opt.max} characters` });
                if (opt.pattern && !opt.pattern.test(s)) return void issues.push({ path, message: "has an invalid format" });
                return s;
            },
            openapi: () => ({ type: "string", ...(opt.min !== undefined ? { minLength: opt.min } : {}), ...(opt.max !== undefined ? { maxLength: opt.max } : {}), ...(opt.pattern ? { pattern: opt.pattern.source } : {}) }),
        }, opt);
    },
    objectId(opt: Opt = {}): Schema<string> {
        return withMeta({
            parse(v, path, issues) {
                if (typeof v !== "string" || !mongoose.isValidObjectId(v) || !/^[a-f0-9]{24}$/i.test(v)) return void issues.push({ path, message: "must be a 24-character id" });
                return v;
            },
            openapi: () => ({ type: "string", pattern: "^[a-f0-9]{24}$" }),
        }, opt);
    },
    /** Integer; query strings are coerced */
    int(opt: Opt & { min?: number; max?: number; default?: number } = {}): Schema<number> {
        return withMeta({
            parse(v, path, issues) {
                if (v === undefined && opt.default !== undefined) return opt.default;
                const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v;
                if (typeof n !== "number" || !Number.isInteger(n)) return void issues.push({ path, message: "must be an integer" });
                if (opt.min !== undefined && n < opt.min) return void issues.push({ path, message: `must be >= ${opt.min}` });
                if (opt.max !== undefined && n > opt.max) return void issues.push({ path, message: `must be <= ${opt.max}` });
                return n;
            },
            openapi: () => ({ type: "integer", ...(opt.min !== undefined ? { minimum: opt.min } : {}), ...(opt.max !== undefined ? { maximum: opt.max } : {}), ...(opt.default !== undefined ? { default: opt.default } : {}) }),
        }, opt);
    },
    bool(opt: Opt = {}): Schema<boolean> {
        return withMeta({
            parse(v, path, issues) {
                if (typeof v !== "boolean") return void issues.push({ path, message: "must be true or false" });
                return v;
            },
            openapi: () => ({ type: "boolean" }),
        }, opt);
    },
    enum<T extends string>(values: readonly T[], opt: Opt = {}): Schema<T> {
        return withMeta({
            parse(v, path, issues) {
                if (typeof v !== "string" || !values.includes(v as T)) return void issues.push({ path, message: `must be one of: ${values.join(", ")}` });
                return v as T;
            },
            openapi: () => ({ type: "string", enum: [...values] }),
        }, opt);
    },
    /** Object with known keys only (unknown keys are rejected: no mass assignment) */
    object<T extends Record<string, Schema>>(shape: T, opt: Opt & { minProperties?: number } = {}): Schema<{ [K in keyof T]?: unknown }> {
        return withMeta({
            parse(v, path, issues) {
                if (!v || typeof v !== "object" || Array.isArray(v)) return void issues.push({ path, message: "must be an object" });
                const out: Record<string, unknown> = {};
                for (const key of Object.keys(v)) {
                    if (!(key in shape)) issues.push({ path: path ? `${path}.${key}` : key, message: "is not allowed" });
                }
                for (const [key, schema] of Object.entries(shape)) {
                    const value = (v as Record<string, unknown>)[key];
                    const p = path ? `${path}.${key}` : key;
                    if (value === undefined) {
                        // Absent: apply the field's default if it has one (e.g. limit = 20)
                        const fallback = schema.parse(undefined, p, []);
                        if (fallback !== undefined) out[key] = fallback;
                        else if (!schema.optional) issues.push({ path: p, message: "is required" });
                        continue;
                    }
                    const parsed = schema.parse(value, p, issues);
                    if (parsed !== undefined) out[key] = parsed;
                }
                if (opt.minProperties && Object.keys(out).length < opt.minProperties) issues.push({ path: path || "(body)", message: `needs at least ${opt.minProperties} field(s)` });
                return out as any;
            },
            openapi: () => ({
                type: "object",
                additionalProperties: false,
                properties: Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, { ...s.openapi(), ...(s.description ? { description: s.description } : {}) }])),
                ...(Object.entries(shape).some(([, s]) => !s.optional) ? { required: Object.entries(shape).filter(([, s]) => !s.optional).map(([k]) => k) } : {}),
                ...(opt.minProperties ? { minProperties: opt.minProperties } : {}),
            }),
        }, opt);
    },
    array<T>(item: Schema<T>, opt: Opt & { max?: number } = {}): Schema<T[]> {
        return withMeta({
            parse(v, path, issues) {
                if (!Array.isArray(v)) return void issues.push({ path, message: "must be an array" });
                if (opt.max !== undefined && v.length > opt.max) return void issues.push({ path, message: `must have at most ${opt.max} items` });
                return v.map((x, i) => item.parse(x, `${path}[${i}]`, issues)) as T[];
            },
            openapi: () => ({ type: "array", items: item.openapi(), ...(opt.max !== undefined ? { maxItems: opt.max } : {}) }),
        }, opt);
    },
    /**
     * A JSON object whose inner shape is defined elsewhere (e.g. by an encryption protocol): only the
     * kind and serialized size are checked here; the owning service validates the content.
     */
    json(opt: Opt & { maxBytes: number }): Schema<Record<string, unknown>> {
        return withMeta({
            parse(v, path, issues) {
                if (!v || typeof v !== "object" || Array.isArray(v)) return void issues.push({ path, message: "must be an object" });
                if (JSON.stringify(v).length > opt.maxBytes) return void issues.push({ path, message: `must be at most ${opt.maxBytes} bytes` });
                return v as Record<string, unknown>;
            },
            openapi: () => ({ type: "object", additionalProperties: true, description: `JSON object, at most ${opt.maxBytes} bytes` }),
        }, opt);
    },
    /** Response-only: documents a value without validating it */
    doc(openapi: Record<string, unknown>): Schema<unknown> {
        return { parse: (v) => v, openapi: () => openapi };
    },
};

export function validate<T>(schema: Schema<T>, value: unknown, path = ""): T {
    const issues: FieldIssue[] = [];
    const parsed = schema.parse(value, path, issues);
    if (issues.length) {
        throw new ValidationError(issues.slice(0, 20));
    }
    return parsed as T;
}
