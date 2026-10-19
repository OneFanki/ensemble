import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Real-browser suite. Kept out of the default run because it launches installed
 * browsers and needs a few seconds per case; opt in with `pnpm test:e2e`.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@core": resolve("src/core"),
      "@shared": resolve("src/shared"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/e2e-autofill.test.ts", "tests/e2e-instance-exit.test.ts"],
    globalSetup: ["tests/e2e-global-setup.ts"],
    testTimeout: 90_000,
    hookTimeout: 30_000,
    env: { ENSEMBLE_E2E: "1" },
  },
});
