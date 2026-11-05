import { defineConfig, devices } from "@playwright/test";
import { webTarget } from "./e2e/target";

/**
 * Yjs 协作同步的专用 E2E 配置（change: add-yjs-canvas-sync，任务 9.1–9.3）。
 *
 * 这些用例直接驱动同步协议 / run-cancel / 任务历史，因此用独立端口与独立 server 实例。
 * 画布存储 + Yjs 同步在所有配置里都启用（frontend 唯一持久化路径）。
 *
 *   pnpm exec playwright test -c playwright.yjs.config.ts
 */
const PORT = Number(process.env.E2E_YJS_PORT ?? 4373);
const target = webTarget({
	port: PORT,
	server: {
		command: `node e2e/server.mjs --port ${PORT}`,
		url: `http://127.0.0.1:${PORT}/`,
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		stdout: "pipe",
		stderr: "pipe"
	}
});

export default defineConfig({
  testDir: "./e2e",
  testMatch: /yjs-(sync|perf|godot|double-tab)\.spec\.ts|yjs-canvas-workflow\.spec\.ts|run-cancel\.spec\.ts|task-history\.spec\.ts|task-chain\.spec\.ts|canvas-session-single-connection\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // 与默认配置一致：全屏 Canvas 用例不需要逐动作 DOM 快照，失败仍保留截图与 sources。
    trace: { mode: "retain-on-failure", snapshots: false }
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `node e2e/server.mjs --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe"
  }
});
