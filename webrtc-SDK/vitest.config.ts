import { defineConfig } from "vitest/config";

/**
 * Unit tests (no backend): client edge cases, element wiring, theming. They import the BUILT
 * packages (npm run build first). Backend integration tests live in integration/ (own config).
 */
export default defineConfig({
    test: {
        include: ["packages/*/test/**/*.test.ts"],
        environment: "jsdom",
        testTimeout: 15_000,
    },
});
