import { defineConfig } from "vitest/config";

/**
 * ChatGPT extension 测试配置
 * （change: 2026-10-10-unify-extension-frontend-entry，任务 5.3）。
 *
 * node 环境为默认；需要的组件测试在文件内用 `@vitest-environment jsdom` 指令。
 * TSX 用 esbuild 的 automatic JSX runtime 变换，无需额外 react 插件依赖。
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
