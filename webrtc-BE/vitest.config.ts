import { defineConfig } from "vitest/config";

// Isolated test environment: in-memory MongoDB (never a real database), Clerk mocked at the
// module boundary (test/setup/env.ts). Files run one at a time; each uses its own database.
export default defineConfig({
    test: {
        include: ["test/**/*.test.ts"],
        globalSetup: ["./test/setup/global-setup.ts"],
        setupFiles: ["./test/setup/env.ts"],
        pool: "forks",
        fileParallelism: false,
        testTimeout: 30_000,
        hookTimeout: 180_000,
    },
});
