import { defineConfig, devices } from "@playwright/test";
import { reviewBaseUrl, reviewProbeUrl, reviewUseOptions, reviewWebServerEnv, reviewWebServerIgnoreHTTPSErrors } from "./e2e/review-target.js";

/**
 * 本机遥测复盘页的 E2E 配置（change: 2026-10-20-add-local-client-telemetry）。
 *
 * 单独一份而不是塞进 `playwright.config.ts`：这份只跑 `telemetry-*.spec.ts`，用独立端口与独立
 * 的临时数据目录（`e2e/server.mjs` 自己用 `mkdtemp` 建库，所以两份配置不会互相污染），
 * 也不必挤进主套件的串行队列。
 *
 * 跑法：`pnpm -C web run e2e:telemetry`
 */
const PORT = Number(process.env.E2E_TELEMETRY_PORT ?? 4274);

export default defineConfig({
	testDir: "./e2e",
	// `telemetry-*` 是本 change 的复盘页用例；`zz-*` 仍是本地临时探针，不属于套件。
	testMatch: /telemetry-.*\.spec\.ts$/,
	testIgnore: /zz-.*\.spec\.ts/,
	timeout: 90_000,
	expect: { timeout: 20_000 },
	// 同一服务器 + 同一 SQLite 文件：串行执行，避免用例之间互相看到对方写入的事件。
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		...reviewUseOptions,
		baseURL: reviewBaseUrl(PORT),
		trace: { mode: "retain-on-failure", snapshots: false },
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: {
		ignoreHTTPSErrors: reviewWebServerIgnoreHTTPSErrors,
		command: `node e2e/server.mjs --port ${PORT}`,
		url: reviewProbeUrl(PORT),
    env: reviewWebServerEnv,
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
