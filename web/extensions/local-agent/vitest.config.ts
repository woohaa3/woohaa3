import { defineConfig } from "vitest/config";

/**
 * local-agent extension 测试配置
 * （change: 2026-10-16-add-agent-appserver-and-sdk-connections）。
 *
 * node 环境为默认（协议/后端测试）；需要组件的测试在文件内用 `@vitest-environment jsdom`。
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
