import { defineConfig } from "vitest/config";

/**
 * RunningHub provider extension 测试配置
 * （change: 2026-10-10-extract-optional-feature-extensions，任务 3.1）。
 *
 * node 环境为默认；组件测试在文件内用 `@vitest-environment jsdom` 指令。
 * TSX 用 esbuild 的 automatic JSX runtime 变换，无需额外 react 插件依赖。
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"]
  }
});
