import { defineConfig } from "vitest/config";

/**
 * Prompt Snippets extension 测试配置
 * （change: 2026-10-10-extract-optional-feature-extensions，任务 4.1）。
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
