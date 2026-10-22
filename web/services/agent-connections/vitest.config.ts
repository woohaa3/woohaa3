import { defineConfig } from "vitest/config";

/** @woohaa3/agent-connections 测试配置（node 环境；无渲染）。 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
