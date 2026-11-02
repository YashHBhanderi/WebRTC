import { afterAll, beforeAll, vi } from "vitest";
import mongoose from "mongoose";

// Never point tests at a real database or real Clerk
process.env.NODE_ENV = "test";
process.env.MONGO_URI = "";
process.env.CLERK_PUBLISHABLE_KEY = "pk_test_dGVzdA";
process.env.CLERK_SECRET_KEY = "sk_test_test";
process.env.RATE_LIMIT_MAX = process.env.RATE_LIMIT_MAX || "100000";
process.env.RATE_LIMIT_SENSITIVE_MAX = process.env.RATE_LIMIT_SENSITIVE_MAX || "100000";
// Test-only Svix secret (base64 of a fixed string); real secrets come from the Clerk dashboard
// Test-only platform secrets (never real values)
process.env.PLATFORM_TOKEN_SECRET = "test-platform-token-secret-0123456789abcdef";
process.env.WEBHOOK_SECRET_KEY = "test-webhook-secret-key-0123456789abcdef";
process.env.LEGACY_FILES_SECRET = "test-legacy-files-secret-0123456789abcdef";
process.env.CLERK_WEBHOOK_SIGNING_SECRET = "whsec_" + Buffer.from("test-signing-secret-0123456789ab").toString("base64");

// Clerk test double: test/support/clerk-double.ts
vi.mock("@clerk/express", async () => (await import("../support/clerk-double")).clerkDouble);

beforeAll(async () => {
    const base = process.env.TEST_MONGO_URI;
    if (!base) {
        throw new Error("TEST_MONGO_URI missing: the in-memory MongoDB did not start");
    }
    const dbName = `t_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    await mongoose.connect(base, { dbName });
});

afterAll(async () => {
    await mongoose.connection.dropDatabase().catch(() => undefined);
    await mongoose.disconnect();
});
