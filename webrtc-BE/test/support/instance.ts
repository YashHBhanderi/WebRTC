/**
 * A second backend instance for multi-instance tests, in its own process (the realtime registries are
 * per process, exactly as in production). Started by test/multi-instance.test.ts with:
 *   node -r ts-node/register/transpile-only test/support/instance.ts
 * Env: INSTANCE_MONGO_URI, INSTANCE_DB. Prints "READY <port>" on stdout, then serves until killed.
 * Uses the same Clerk test double as the Vitest process; never real Clerk or a real database.
 */
import Module from "module";
import http from "http";
import { AddressInfo } from "net";

process.env.NODE_ENV = "test";
process.env.CLERK_PUBLISHABLE_KEY = "pk_test_dGVzdA";
process.env.CLERK_SECRET_KEY = "sk_test_test";
process.env.PLATFORM_TOKEN_SECRET = "test-platform-token-secret-0123456789abcdef";
process.env.WEBHOOK_SECRET_KEY = "test-webhook-secret-key-0123456789abcdef";
process.env.LEGACY_FILES_SECRET = "test-legacy-files-secret-0123456789abcdef";
process.env.RATE_LIMIT_MAX = "100000";
process.env.RATE_LIMIT_SENSITIVE_MAX = "100000";

// Route "@clerk/express" to the shared test double (the Vitest process uses vi.mock for the same thing)
const load = (Module as any)._load;
(Module as any)._load = function (request: string, parent: unknown, isMain: boolean) {
    if (request === "@clerk/express") return require("./clerk-double").clerkDouble;
    return load.call(this, request, parent, isMain);
};

async function main(): Promise<void> {
    const mongoose = (await import("mongoose")).default;
    await mongoose.connect(String(process.env.INSTANCE_MONGO_URI), { dbName: String(process.env.INSTANCE_DB) });
    const { createApp } = await import("../../src/app");
    const { startRealtime } = await import("../../src/realtime");
    const { io } = await import("../../src/realtime/io");
    const { setUpCluster } = await import("../../src/realtime/cluster");
    const server = http.createServer(createApp("*"));
    startRealtime(server, "*");
    await setUpCluster(io());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.stdout.write(`READY ${(server.address() as AddressInfo).port}\n`);
}

main().catch((error) => {
    process.stderr.write(`instance failed: ${error?.message}\n`);
    process.exit(1);
});
