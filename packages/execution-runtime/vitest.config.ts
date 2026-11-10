import { defineConfig } from "vitest/config";

/** woohaa3-executor：daemon / client / CLI 的进程内集成测试。 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 20_000
  }
});
