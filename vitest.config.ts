import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/**/src/**/*.test.ts",
      "apps/**/src/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/contract/**",
      "apps/mcp-server/src/__tests__/**/*.contract.test.ts",
    ],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
    },
  },
});
