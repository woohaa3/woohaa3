import { defineConfig } from "vitest/config";

/** standard-agent-roles：纯角色定义与 prepare 测试（node 环境，不加载执行通道）。 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"]
  }
});
