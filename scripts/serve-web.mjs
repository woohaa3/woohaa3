#!/usr/bin/env node
// 生产/预览入口（change: 2026-10-06-unify-backend-runtime-with-cordis，任务 4.1）。
//
// 在**同一进程**内组合前端静态资源与统一后端运行单元：
//   /bevy/* + SPA 静态        -> 本地静态（web/frontend/dist）
//   同源 API/WS（Canvas/Media/Task/Plugins/MCP） -> 统一后端进程内的各模块 handler
//
// 后端已合并为单进程（`@woohaa3/backend`）：不再有服务间 HTTP/WS、服务令牌或多服务 spawn。
// COS / provider 凭据只在后端进程内读取，绝不带 `VITE_` 前缀进浏览器。
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createStaticHandler, send } from "./lib/static-server.mjs";
import { resolveAppPageTitle } from "./lib/app-html.mjs";
import { loadExtensionHost } from "./lib/extension-host.mjs";
import { injectReleaseLinkHtml } from "./lib/extension-release-catalog.mjs";
import { loadServiceEnv } from "./lib/service-env.mjs";
import { describeAppBasePath, resolveAppBasePath } from "./lib/app-base-path.mjs";
import { applyHttpMount, applyUpgradeMount, interceptHttpMount, rejectUpgradeSocket } from "./lib/mount-adapter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const serviceEnv = loadServiceEnv(root, process.env.WOOHAA3_SERVICE_ENV_FILE);

// change: 2026-10-15-support-configurable-app-base-path：在监听前规范化挂载配置；非法配置
// 直接失败（不静默退回根路径）。
let basePath;
try {
	basePath = resolveAppBasePath(serviceEnv);
} catch (error) {
	process.stderr.write(`[serve-web] ${error.message}\n`);
	process.exit(1);
}

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dist = path.resolve(root, arg("dist", "web/frontend/dist"));
const port = Number(serviceEnv.PORT || arg("port", "4173"));
const host = serviceEnv.HOST || "127.0.0.1";

if (!fs.existsSync(path.join(dist, "index.html"))) {
	process.stderr.write(`web/frontend/dist 还不存在。先构建：pnpm -C web run build:units && pnpm -C web --filter @woohaa3/frontend build\n`);
	process.exit(1);
}

// 统一后端进程：导入已构建的组合根，在**本进程内**装配各领域模块。
const backendEntry = path.resolve(root, arg("backend", "web/backend/dist/index.js"));
if (!fs.existsSync(backendEntry)) {
	process.stderr.write(`统一后端尚未构建（${path.relative(root, backendEntry)}）。先运行：pnpm -C web run build:units\n`);
	process.exit(1);
}
const { createBackendService } = await import(pathToFileURL(backendEntry).href);

// 启动期扩展宿主（change: 2026-10-15-add-scannable-extension-directories，任务 4.3）：
// 扫描配置根、校验声明并加载；声明非法时在监听端口前 fail-fast。
// 不传 logger：组合根用内置 sink（stderr 一行 JSON + WOOHAA3_LOG_DIR 或 .woohaa3/logs 下的轮转文件）；
// 宿主日志单独走 stderr，便于定位是哪个扩展目录。
const extensionHost = await loadExtensionHost({
	repoRoot: root,
	env: { ...serviceEnv, ...process.env },
	logger: (event) => process.stderr.write(`[extensions] ${JSON.stringify(event)}\n`)
});
const backend = await createBackendService({ env: serviceEnv, basePath, extensionHost });
if (backend.logDir) process.stderr.write(`[backend] logs → ${backend.logDir}\n`);

// 发布目录 link 在**服务时**注入（change: 2026-10-15-add-scannable-extension-directories，任务 5.3）：
// 运行期 release 由同一宿主生成，构建产物不再被就地改写。
// 每次服务 HTML 时读当前 release：受管扩展热登记后 link 随之切换（change: 2026-10-21-add-extension-marketplace-point，6.1）。
const currentReleaseHref = () => extensionHost?.browserRelease?.href ?? null;
const serveStatic = createStaticHandler(dist, {
	basePath,
	pageTitle: resolveAppPageTitle(serviceEnv),
	...(extensionHost?.browserRelease ? { transformHtml: (html) => { const href = currentReleaseHref(); return href ? injectReleaseLinkHtml(html, href) : html; } } : {})
});

const server = http.createServer((req, res) => {
	if (serviceEnv.WOOHAA_IMAGE_THREADS_ISOLATION === "1") {
		res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
		res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
	}
	// 公开挂载边界：只在一个边界剥离一次前缀；前缀外请求不进入后端或 SPA 回退。
	const action = applyHttpMount(basePath, req);
	if (interceptHttpMount(req, res, action)) return;
	backend
		.handle(req, res)
		.then((handled) => {
			if (!handled) serveStatic(req, res);
		})
		.catch((error) => {
			process.stderr.write(`[serve-web] backend 异常：${error?.message}\n`);
			if (!res.headersSent) send(res, 502, "backend failure");
			else res.end();
		});
});

// WebSocket upgrade（Canvas Session）交给后端进程内的 Canvas 同步面；WS 不进行无尾斜杠重定向。
server.on("upgrade", (req, socket, head) => {
	const action = applyUpgradeMount(basePath, req);
	if (action.kind !== "forward") { rejectUpgradeSocket(socket); return; }
	if (!backend.upgrade || !backend.upgrade(req, socket, head)) socket.destroy();
});

let stopping = false;
const shutdown = () => {
	if (stopping) return;
	stopping = true;
	void backend.close().finally(() => server.close(() => process.exit(0)));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.on("error", (err) => {
	if (err && err.code === "EADDRINUSE") {
		process.stderr.write(`port ${host}:${port} already in use\n`);
		process.exit(0);
	}
	process.stderr.write(`${err}\n`);
	process.exit(1);
});

server.listen(port, host, () => {
	process.stderr.write(`[serve-web] http://${host}:${port}${describeAppBasePath(basePath) === "/（根路径）" ? "" : describeAppBasePath(basePath)}\n`);
});
