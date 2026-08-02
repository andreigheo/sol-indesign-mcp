import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/contract/**/*.test.ts",
      "apps/mcp-server/src/__tests__/**/*.contract.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
