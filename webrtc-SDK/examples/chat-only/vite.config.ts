import { defineConfig } from "vite";

export default defineConfig({
    // matrix-sdk-crypto-wasm loads its .wasm next to its module; don't pre-bundle it
    optimizeDeps: { exclude: ["@matrix-org/matrix-sdk-crypto-wasm"] },
    build: { target: "es2022" },
});
