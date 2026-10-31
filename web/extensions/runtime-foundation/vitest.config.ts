import { defineConfig } from "vitest/config";

/**
 * 本扩展自己的测试配置。
 *
 * 没有这份文件时 vitest 会一路向上找到外层仓库的 `vite.config.ts`，
 * 那里的 `setupFiles: ["./src/test/setup.ts"]` 会相对本目录解析成一个不存在的文件，
 * 整包测试直接 `Failed to load url`（只有从外层仓库里跑才会复现）。
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
