import { defineConfig, devices } from "@playwright/test";
import { reviewBaseUrl, reviewProbeUrl, reviewUseOptions, reviewWebServerEnv, reviewWebServerIgnoreHTTPSErrors } from "../../e2e/review-target.js";

/**
 * Showcase Playwright 配置（change: align-showcase-reference-ux / add-showcase-history-model-panels
 * / expand-showcase-execution-ux）。
 *
 * 复用 `pnpm -C web/ui/showcase run build` 的静态产物（Ladle build），用同源静态服务 +
 * 本地字体启动；因此不需要任何后端，操作记录直接渲染在 story 里。
 *
 * 覆盖三类验收：
 * - 参考 UX 响应式视觉（桌面 + 390×844）——无裁切/重叠/页面级横向滚动；
 * - 任务历史 / 模型参数交互与视觉回归（`showcase-*.spec.ts`，视觉基线按 `chromium`；
 *   窄屏用例自行 `test.use({ viewport })`）；
 * - 执行面板生产组合的桌面 + 窄屏布局（`execution-panel.spec.ts`，由两个 project 共用断言）。
 *
 *   pnpm -C web/ui/showcase run build
 *   pnpm -C web/ui/showcase run e2e
 */
const PORT = Number(process.env.SHOWCASE_PORT ?? 5199);

export default defineConfig({
	testDir: "./e2e",
	timeout: 90_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		...reviewUseOptions,
		baseURL: reviewBaseUrl(PORT),
		trace: { mode: "retain-on-failure", snapshots: true },
	},
	projects: [
		// 保持 project 名为 `chromium`：任务历史 / 模型参数的视觉基线以它命名。
		// 壳层验收单独用 1440 桌面 project（spec「桌面 1440」），因此在这里排除。
		{ name: "chromium", testIgnore: /showcase-shell\.spec\.ts$/, use: { ...devices["Desktop Chrome"] } },
		// 壳层桌面验收：1440×900（change: 2026-09-29-refresh-showcase-shell）。
		{
			name: "shell-desktop",
			testMatch: /showcase-shell\.spec\.ts$/,
			use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
		},
		// 390×844 只用于执行面板生产组合的场景（其余 spec 自行控制视口）。
		{
			name: "narrow390",
			testMatch: /execution-panel\.spec\.ts$/,
			use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 780 } },
		},
	],
	webServer: {
		ignoreHTTPSErrors: reviewWebServerIgnoreHTTPSErrors,
		command: `node e2e/serve.mjs --port ${PORT}`,
		env: reviewWebServerEnv,
		url: reviewProbeUrl(PORT),
		reuseExistingServer: !process.env.CI,
		timeout: 60_000,
		stdout: "pipe",
		stderr: "pipe",
	},
});
