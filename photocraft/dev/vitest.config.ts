/**
 * dev 宿主测试配置（change: 2026-10-22-complete-photocraft-webui-editing，任务 4.5）。
 *
 * 只跑纯逻辑回归（A/B 工作区协调），不加载 WASM、不启动 Vite 服务器。
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node"
  }
});
