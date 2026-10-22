import { defineConfig } from "vitest/config";

/**
 * Game Furnace extension 测试配置
 * （change: 2026-10-10-add-game-furnace-extension，按 integration 新架构重实现）。
 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "tests/**/*.test.ts", "tests/**/*.test.tsx"]
  }
});
