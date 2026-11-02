import { defineConfig, devices } from "@playwright/test";
import { reviewBaseUrl, reviewProbeUrl, reviewUseOptions, reviewWebServerEnv, reviewWebServerIgnoreHTTPSErrors } from "./e2e/review-target.js";

/**
 * 画布交互热路径的**测试专用**性能采集配置
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，任务 6.3）。
 *
 * 与生产/正常 preview 分离：不启用开发采集写接口，使用浏览器标准 `PerformanceObserver`
 * （event timing + longtask）与确定性 `window.__canvasSceneDiagnostics` 计数器，做同一计时
 * 定义的优化前后对照。`E2E_DIST` 允许把同一套用例指向另一份构建产物（例如优化前 dist），
 * 同时保持场景、DPR 与服务拓扑一致。
 *
 *   E2E_DIST=<dist> PERF_DPR=2 PERF_LABEL=pre \
 *     pnpm exec playwright test -c playwright.canvas-perf.config.ts
 */
const PORT = Number(process.env.E2E_PERF_PORT ?? 4381);
const dpr = Number(process.env.PERF_DPR ?? 1);
const dist = process.env.E2E_DIST ?? "frontend/dist";

export default defineConfig({
	testDir: "./e2e",
	testMatch: /canvas-interaction-perf\.spec\.ts/,
	// 软件渲染环境（swiftshader）下 DPR=2 的 Bevy 帧周期可达数百毫秒，`settleCounters` 需多轮
	// 等待结算；固定场景 + 多轮基准可能远超 10 分钟。放宽到 40 分钟保证 DPR=2 组可完成，
	// 不通过减少轮次或删尾样本来“通过”。
	timeout: 2_400_000,
	expect: { timeout: 30_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		...reviewUseOptions,
		baseURL: reviewBaseUrl(PORT),
		deviceScaleFactor: dpr,
		trace: { mode: "off", snapshots: false }
	},
	projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], deviceScaleFactor: dpr } }],
	webServer: {
		ignoreHTTPSErrors: reviewWebServerIgnoreHTTPSErrors,
		command: `node e2e/server.mjs --port ${PORT} --dist ${dist}`,
		url: reviewProbeUrl(PORT),
    env: reviewWebServerEnv,
		reuseExistingServer: false,
		timeout: 60_000,
		stdout: "pipe",
		stderr: "pipe"
	}
});
