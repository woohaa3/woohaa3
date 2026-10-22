import { defineConfig } from "vitest/config";

/**
 * remote-server extension 测试配置。
 *
 * 默认 node 环境（后端协议/状态测试）；需要 DOM 的用例在文件内用 `@vitest-environment jsdom`。
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
