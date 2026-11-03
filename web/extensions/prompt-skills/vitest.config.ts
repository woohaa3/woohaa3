import { defineConfig } from "vitest/config";

/** prompt-skills 扩展：纯函数与任务编排测试（node 环境，不加载浏览器运行时）。 */
export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"]
  }
});
