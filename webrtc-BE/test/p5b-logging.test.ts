import { describe, expect, it, vi } from "vitest";
import mongoose from "mongoose";
import { logEvent, redact, safeError, sanitizeArgs } from "../src/utils/safe-log";
import { AppError } from "../src/utils/errors";

/**
 * Phase 5B: logging must not leak secrets or user data. Source-level controls (safeError, logEvent)
 * are tested first; the console backstop (redact / sanitizeArgs) second.
 */
const SECRET_TEXT = "my very private message about salary";
const EMAIL = "alice.private@example.com";

const line = (...args: unknown[]) => sanitizeArgs(args).join(" ");

describe("safeError: type-aware serialisation at the source", () => {
    it("Mongoose validation errors keep paths and kinds, never values (message bodies)", async () => {
        const M = mongoose.model("P5bLogDoc", new mongoose.Schema({ content: { type: String, maxlength: 5 }, kind: { type: String, enum: ["a", "b"] } }));
        const err = new M({ content: SECRET_TEXT, kind: SECRET_TEXT }).validateSync()!;
        expect(err.message).toContain(SECRET_TEXT); // the raw error does carry the value…
        const safe = safeError(err);
        expect(JSON.stringify(safe)).not.toContain("salary"); // …the serialised one does not
        expect(safe.fields?.map((f) => f.path).sort()).toEqual(["content", "kind"]);
        expect(line(err)).not.toContain("salary");
    });

    it("MongoDB duplicate-key errors keep the field name and code, never the value (emails)", () => {
        const dup = Object.assign(new Error(`E11000 duplicate key error collection: users index: email_1 dup key: { email: "${EMAIL}" }`), {
            name: "MongoServerError", code: 11000, codeName: "DuplicateKey", keyPattern: { email: 1 }, keyValue: { email: EMAIL },
        });
        const safe = safeError(dup);
        expect(safe).toMatchObject({ name: "MongoServerError", code: 11000, fields: [{ path: "email", kind: "duplicate" }] });
        expect(JSON.stringify(safe)).not.toContain(EMAIL);
        expect(line(dup)).not.toContain(EMAIL);
    });

    it("HTTP-client style errors never copy request config or headers (bearer, cookies, signed URLs)", () => {
        const err = Object.assign(new Error("Request failed with status code 500"), {
            name: "AxiosError",
            config: { headers: { Authorization: "Bearer opaque0123456789secret", Cookie: "__session=abc.def.ghi" }, url: "https://s3.example.com/k?X-Amz-Signature=deadbeef" },
            response: { data: { email: EMAIL } },
        });
        const out = JSON.stringify(safeError(err)) + line(err);
        for (const leak of ["opaque0123456789secret", "__session", "X-Amz-Signature", "deadbeef", EMAIL]) expect(out).not.toContain(leak);
    });

    it("our own AppError messages are kept (we wrote them); other free text is redacted and capped", () => {
        expect(safeError(new AppError("Choose at least one permission", 400))).toMatchObject({ name: "AppError", status: 400, message: "Choose at least one permission" });
        const other = safeError(new Error(`failed for ${EMAIL} at /x?token=abc ${"z".repeat(500)}`));
        expect(other.message).not.toContain(EMAIL);
        expect(other.message).not.toContain("token=abc");
        expect(other.message!.length).toBeLessThanOrEqual(200);
    });

    it("non-Error throwables are handled", () => {
        expect(safeError(`Bearer opaque0123456789secret for ${EMAIL}`).message).not.toMatch(/opaque|alice/);
        expect(safeError({ password: "x" })).toEqual({ name: "object", message: undefined });
    });
});

describe("logEvent: structured output with a field allowlist", () => {
    it("drops non-allowlisted fields (bodies, headers, emails) and strips query strings", () => {
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        try {
            const out = logEvent("error", "message.send_failed", {
                userId: "u1", conversationId: "c1", path: "/messages/search?q=salary", error: new Error("boom"),
                body: { content: SECRET_TEXT }, headers: { authorization: "Bearer opaque0123456789secret" }, email: EMAIL,
            });
            const rec = JSON.parse(out);
            expect(rec).toMatchObject({ level: "error", event: "message.send_failed", userId: "u1", conversationId: "c1", path: "/messages/search", omittedFields: 3 });
            expect(out).not.toMatch(/salary|opaque|alice/);
        } finally {
            spy.mockRestore();
        }
    });
});

describe("console backstop (defence in depth only)", () => {
    it.each([
        ["bearer token", "Authorization: Bearer opaque0123456789token", "opaque0123456789token"],
        ["basic credentials", "Authorization: Basic c3dzX2tleTpzd3Nfc2VjcmV0", "c3dzX2tleTpzd3Nfc2VjcmV0"],
        ["cookie header", "Cookie: __session=abc; theme=dark", "__session=abc"],
        ["set-cookie header", "set-cookie: sid=s3cr3t; HttpOnly", "s3cr3t"],
        ["email", `user ${EMAIL} failed`, EMAIL],
        ["query string", "GET /messages/search?q=salary+review", "salary"],
        ["signed URL", "https://bucket.s3.amazonaws.com/a.pdf?X-Amz-Signature=abc123&X-Amz-Credential=AKIA", "X-Amz-Signature"],
        ["legacy signed link", "/uploads/legacy/a.png?exp=1&sig=abcdef", "sig=abcdef"],
        ["webhook secret", "secret swh_abcdefghijklmnopqrst", "swh_abcdefghijklmnopqrst"],
        ["developer secret", "sws_abcdefghijklmnopqrstuvwxyz", "sws_abcdefghijklmnopqrstuvwxyz"],
        ["secret-named key in an object", { password: "hunter2hunter2", client_secret: "cs_123456789" }, "hunter2"],
    ])("%s", (_label, input, leak) => {
        expect(line(input)).not.toContain(leak);
    });

    it("documents the limit: free text with no recognisable pattern is NOT caught by the backstop", () => {
        expect(redact(`note: ${SECRET_TEXT}`)).toContain(SECRET_TEXT);
    });
});
