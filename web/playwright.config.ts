import { defineConfig, devices } from "@playwright/test";
import { webTarget } from "./e2e/target";

/**
 * E2E 配置（任务 7.1）。
 *
 * - 复用站点构建产物（`frontend/dist`）。
 * - 服务器由 `e2e/server.mjs` 启动：与生产共用静态服务与媒体 handler，但注入内存媒体存储，
 *   所以 E2E 不需要 COS 凭据。画布存储 + Yjs 同步**始终启用**（frontend 唯一持久化路径）。
 * - `E2E_BASE_URL` 指定宿主可达地址（容器 / WSL 复核）时跳过 `webServer`；
 *   `WOOHAA_E2E_CDP` 让 `e2e/base-test.ts` 改用宿主浏览器，接法与限制见该文件头注释。
 */
const PORT = Number(process.env.E2E_PORT ?? 4273);
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
	// 需要专用后端/多标签页/性能基线的用例在 `playwright.yjs.config.ts` 下运行。
	// `zz-*` 是本地临时探针（用完即删），不属于套件。
	testIgnore: /canvas-session-single-connection\.spec\.ts|yjs-sync\.spec\.ts|yjs-perf\.spec\.ts|yjs-godot\.spec\.ts|yjs-double-tab\.spec\.ts|yjs-canvas-workflow\.spec\.ts|run-cancel\.spec\.ts|task-history\.spec\.ts|task-chain\.spec\.ts|canvas-interaction-perf\.spec\.ts|zz-.*\.spec\.ts/,
	timeout: 90_000,
	expect: { timeout: 20_000 },
	fullyParallel: false,
	// 每个用例共用同一个服务器与同一个 IndexedDB 源，串行执行避免相互污染。
	workers: 1,
	retries: 0,
	reporter: [["list"]],
	use: {
		baseURL: target.baseURL,
		// DOM 快照对全屏 Canvas 用例的价值很低，却占每个动作的固定开销；失败时仍保留
		// 截图 + sources + 网络，足够定位问题。
		trace: { mode: "retain-on-failure", snapshots: false },
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: target.webServer,
});
