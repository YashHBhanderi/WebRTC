import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Integration tests: the built @spreewe/* packages against the REAL backend (webrtc-BE: Express,
 * Socket.IO, /v1 registry, OAuth, E2EE relay) started in-process with the backend's own test
 * harness (in-memory MongoDB, Clerk test double). Nothing on the SpreeWe side is mocked.
 *
 * Run from webrtc-SDK:  npm run test:integration   (builds the packages first)
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const backend = path.resolve(here, "../../webrtc-BE");

export default defineConfig({
    root: backend,
    test: {
        include: [path.join(here, "**/*.test.ts").replace(/\\/g, "/")],
        globalSetup: [path.join(backend, "test/setup/global-setup.ts")],
        setupFiles: [path.join(backend, "test/setup/env.ts")],
        pool: "forks",
        fileParallelism: false,
        testTimeout: 60_000,
        hookTimeout: 180_000,
    },
    server: { fs: { strict: false } },
});
