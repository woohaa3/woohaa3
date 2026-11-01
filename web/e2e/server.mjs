#!/usr/bin/env node
// E2E 服务器入口 —— **真实三服务拓扑**（change: split-web-runtime-services，任务 8.1–8.3 / 8.5）。
//
//   node e2e/server.mjs [--dist frontend/dist] [--port 4273]
//
// 监听地址默认 127.0.0.1；容器 / WSL 里让宿主浏览器访问时用 `HOST=0.0.0.0`（或经
// `ssh -L` 转发本地端口），并配合配置里的 `E2E_BASE_URL` 指向宿主可达地址。
//
// 与生产（`scripts/serve-web.mjs` / `scripts/dev-orchestrator.mjs`）共用**同一个 ingress**：
//   /api/canvases/*  + WS  -> Canvas Service
//   /api/media/*           -> Media Service
//   /api/pptask/catalog|history* -> Task Service
//   /internal/v1/*         -> 拒绝（不经公网）
//
// 与生产的唯一区别是**依赖注入**（E2E 不需要真实 COS / LiteLLM 凭据）：
//   - Media Service 的 MediaStorage 用内存替身（真实 public/internal handler、SSRF 守卫、
//     内容寻址、签名协议都照常运行）；
//   - Task Service 的 provider 执行用确定性假 worker（真实 durable store、history read model、
//     幂等与 submit/cancel API 都照常运行）；
//   - Canvas Service 用真实 sqlite（临时文件）+ 真实 Yjs room + 真实 projector。
//
// E2E 与生产走同一条 ingress + 三服务路径，因此 E2E 通过即证明真实拓扑可用。
//
//   E2E_MEDIA_FAULT=put|get   启动时注入媒体故障
//
// 画布存储 + Yjs 同步**始终启用**：frontend 只有 Yjs 一条持久化路径，没有它应用无法进入
// ready。旧的 `E2E_ENABLE_CANVAS_STORAGE` 开关（remote-cas 时代的默认/专用两套配置）已移除。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { createStaticHandler, send } from "../../scripts/lib/static-server.mjs";
import { resolveAppPageTitle } from "../../scripts/lib/app-html.mjs";
import { resolveAppBasePath } from "../../scripts/lib/app-base-path.mjs";
import { applyHttpMount, applyUpgradeMount, interceptHttpMount, rejectUpgradeSocket } from "../../scripts/lib/mount-adapter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// change: 2026-10-15-support-configurable-app-base-path：E2E 宿主复用同一公开挂载边界。
const basePath = resolveAppBasePath(process.env);

function arg(name, fallback) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dist = path.resolve(root, "web", arg("dist", "frontend/dist"));
const port = Number(process.env.PORT || arg("port", "4273"));
const host = process.env.HOST || "127.0.0.1";

// 运行时可切换的故障模式（由 /__e2e_fault__ 修改）。
let fault = process.env.E2E_MEDIA_FAULT ?? "";
// 画布存储 + Yjs 同步始终启用（frontend 唯一持久化路径）。
const canvasStorageEnabled = true;

// 构建产物（与生产同源：`build:units` 产出）。
const canvasServiceBundle = path.resolve(root, "web/services/canvas-service/dist/index.js");
const taskServiceBundle = path.resolve(root, "web/services/task-service/dist/index.js");
const mediaServiceBundle = path.resolve(root, "web/services/media-service/dist/index.js");
for (const bundle of [canvasServiceBundle, taskServiceBundle, mediaServiceBundle]) {
	if (!fs.existsSync(bundle)) {
		process.stderr.write(`缺少服务构建产物：${path.relative(root, bundle)}\n先运行：pnpm -C web run build:units\n`);
		process.exit(1);
	}
}

const { createIngress } = await import(pathToFileURL(path.join(here, "..", "..", "scripts", "lib", "ingress.mjs")).href);
const { createCanvasService } = await import(pathToFileURL(canvasServiceBundle).href);
const { createTaskService } = await import(pathToFileURL(taskServiceBundle).href);
const { createMediaService } = await import(pathToFileURL(mediaServiceBundle).href);
// e2e/ 不是 workspace 包，裸包名解析不到；按仓库路径加载（与上面三个服务一致）。
const webDir = path.resolve(root, "web");
const { InMemoryYjsDocumentRepository, SqliteCanvasRepository } = await import(
	pathToFileURL(canvasServiceBundle).href
);
// 共享线格式 codec（映射/协议）位于 `@woohaa3/contracts/canvas-yjs`。
const contractsYjsBundle = path.resolve(root, "web/contracts/dist/canvas-yjs/index.js");
const { serverCanvasToYDoc, YJS_CANVAS_FORMAT_VERSION } = await import(pathToFileURL(contractsYjsBundle).href);
// 与 canvas-service 用**同一个** yjs 实例：从其包目录解析 ESM 入口（不能取 CJS 入口，
// 否则 Node 会加载两份 yjs，构造器检查失败）。
const canvasServiceDir = path.join(webDir, "services", "canvas-service");
const yjsPackageDir = path.dirname(require.resolve("yjs/package.json", { paths: [canvasServiceDir] }));
const Y = await import(pathToFileURL(path.join(yjsPackageDir, "dist/yjs.mjs")).href);

// ---------------------------------------------------------------------------
// 共享内存对象存储（Media Service 的 MediaStorage 替身；契约与 COS adapter 相同）
// ---------------------------------------------------------------------------
const E2E_PNG = Uint8Array.from(
	Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AARQAChgGj2M0AAAAASUVORK5CYII=",
		"base64"
	)
);

/** 最近一次 provider 调用的可观测摘要（仅 E2E 断言用，生产没有这个入口）。 */
let lastProviderCall = null;

function createMemoryStorage() {
	const objects = new Map();
	const notFound = () => {
		const error = new Error("not found");
		error.code = "MEDIA_OBJECT_NOT_FOUND";
		error.name = "MediaObjectNotFoundError";
		return error;
	};
	return {
		async put(key, bytes, contentType) {
			if (fault === "put") throw new Error("E2E injected put failure");
			objects.set(key, { bytes: Uint8Array.from(bytes), contentType });
		},
		async get(key) {
			if (fault === "get") throw new Error("E2E injected get failure");
			const record = objects.get(key);
			if (!record) throw notFound();
			return record;
		},
		async exists(key) {
			return objects.has(key);
		},
		async stat(key) {
			const record = objects.get(key);
			if (!record) throw notFound();
			return { size: record.bytes.byteLength, contentType: record.contentType };
		},
		async getHttpsUrl(key) {
			// 仅服务端内部使用；E2E 给出显式临时地址。
			return `https://cos.invalid/${key}?sign=e2e`;
		}
	};
}

const memoryStorage = createMemoryStorage();

// ---------------------------------------------------------------------------
// Task Service：真实 durable store + history + 假执行（不发真实 provider 请求）
// ---------------------------------------------------------------------------
const CANVAS_TOKEN = "e2e-canvas-token";
const TASK_TOKEN = "e2e-task-token";
const canvasDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "woohaa3-e2e-"));
const taskStorePath = path.join(canvasDbDir, "task.sqlite");
const canvasStorePath = path.join(canvasDbDir, "canvas.sqlite");

/** 假 worker server：submit 立即产生终态 history，供 projector 消费。 */
function fakeWorkerServer() {
	const listeners = new Set();
	const records = new Map();
	const emit = (record) => {
		records.set(record.id, record);
		for (const listener of listeners) listener(record);
	};
	const emitTerminal = ({ key, modelType, input, context }) => {
		const urls = Array.isArray(input?.urls) ? input.urls : [];
		lastProviderCall = { modelType, urls };
		const now = new Date().toISOString();
		emit({
			id: key,
			providerId: "e2e",
			state: "succeeded",
			// `events` 必须是数组：projectExecutionRecord 读 `record.events.at(-1)`
			// （真实 worker 总会带上；替身漏了会让投影抛错、history 不落终态）。
			events: [],
			result:
				modelType === "image"
					? undefined
					: { outputs: [{ kind: "text", text: urls.length > 0 ? "带参考图的回答" : "E2E 文本结果" }] },
			createdAt: now,
			updatedAt: now,
			finishedAt: now,
			durationMs: 1,
			...(context ? { metadata: context } : {})
		});
	};
	return {
		worker: {},
		async submit(input) {
			emitTerminal(input);
			return { created: true, record: { id: input.key, status: "queued" } };
		},
		async status(key) {
			return records.get(key) ?? null;
		},
		async cancel(key) {
			const record = records.get(key);
			if (record) emit({ ...record, state: "cancelled" });
		},
		history: {
			get: async (id) => records.get(id),
			list: async () => [...records.values()],
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			ingestSchedulingEvent() {},
			async flush() {},
			async dispose() {}
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		stop() {},
		async drained() {},
		async close() {}
	};
}

const modelsConfig = JSON.parse(fs.readFileSync(path.resolve(root, "web/services/task-service/pptask.models.json"), "utf8"));

// Test-only generation registration; the fake worker below owns execution.
const fixtureProvider = {
  extensionId: "e2e-provider", providerId: "fixture", available: true, provider: {},
  models: [{ providerId: "fixture", providerModelId: "gemini-2.5-flash", modelType: "language", title: "E2E language", promptRequirement: "required" }]
};

const runningHubPluginBundle = path.resolve(root, "web/extensions/runninghub-provider/dist/backend.js");
const { createRunningHubRegistration } = await import(pathToFileURL(runningHubPluginBundle).href);
const runningHubProvider = createRunningHubRegistration({ apiKey: "e2e-placeholder", apiBaseURL: "https://runninghub.invalid" });

const taskService = createTaskService({
	env: {
	},
	modelsConfig,
	storePath: taskStorePath,
	serviceToken: TASK_TOKEN,
	generationProviders: () => [fixtureProvider, runningHubProvider].filter(Boolean),
	workerServer: fakeWorkerServer(),
	logger: (event) => process.env.E2E_QUIET === "1" ? undefined : process.stderr.write(`[task-service] ${JSON.stringify(event)}\n`)
});

// ---------------------------------------------------------------------------
// Media Service：真实 handler + 内存存储替身
// ---------------------------------------------------------------------------
const mediaService = createMediaService({
	storage: memoryStorage,
	identities: { tokens: { "canvas-service": CANVAS_TOKEN, "task-service": TASK_TOKEN } }
});

// 先把 Media/Task 各自监听到独立端口，再让 Canvas 的 client 指向它们（真实 HTTP 边界）。
function listenService(service) {
	const server = http.createServer((req, res) => {
		service.handle(req, res).then((handled) => {
			// 未命中的路由：与生产入口一致地视为 404，避免 ingress 代理目标不响应而挂起。
			if (!handled && !res.headersSent) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "not-found" }));
			}
		}).catch((error) => {
			process.stderr.write(`[e2e-server] handler failure: ${error?.message ?? error}\n`);
			if (!res.headersSent) {
				res.writeHead(500);
				res.end();
			} else {
				res.end();
			}
		});
	});
	// Canvas Service 需要把 WebSocket upgrade 交给 sync handler（与生产入口一致）。
	if (service.sync) {
		server.on("upgrade", (req, socket, head) => {
			if (service.sync.matches(req.url)) service.sync.handle(req, socket, head);
			else socket.destroy();
		});
	}
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve({ server, port: typeof address === "object" && address ? address.port : 0 });
		});
	});
}

const mediaListener = await listenService(mediaService);
const taskListener = await listenService(taskService);

// ---------------------------------------------------------------------------
// Canvas Service：真实 sqlite + Yjs 仓储；client 指向上面两个真实 HTTP 端点
// ---------------------------------------------------------------------------
const yjsRepository = new InMemoryYjsDocumentRepository();
const canvasRepository = new SqliteCanvasRepository({ path: canvasStorePath });

// ---------------------------------------------------------------------------
// 在线迁移（可选）：`E2E_ONLINE_MIGRATION=1` 时注入一个**确定性的受控来源端口**，
// 让首次打开旧 ID 的真实浏览器用例可运行（change: 2026-10-12-add-extension-online-canvas-migration，
// 任务 6.8）。这不是真实旧 Mongo/COS；真实来源验收另见 verification notes。
// ---------------------------------------------------------------------------
const migrationEnabled = ["1", "true"].includes(process.env.E2E_ONLINE_MIGRATION ?? "");
const contractsBundle = await import(pathToFileURL(path.resolve(root, "web/contracts/dist/index.js")).href);
const { createEmptyWoohaa3ServerCanvas } = contractsBundle;
const MIGRATION_SOURCE_ID = "legacy-source";
/**
 * 受控来源解析任意旧 ID（默认 `legacy-canvas-1`；测试用不同 ID 保证用例互不污染）。
 * 元数据与正文都由测试构造，不读真实样本。
 */
const migrationSourceCanvasId = process.env.E2E_ONLINE_MIGRATION_CANVAS ?? "legacy-canvas-1";
/** 目标画布（当前格式），元数据由测试构造，不读真实样本。 */
const migrationCanvas = (targetCanvasId) => {
  const canvas = createEmptyWoohaa3ServerCanvas(targetCanvasId);
  return {
    ...canvas,
    title: "迁移演练画布",
    document: {
      ...canvas.document,
      nodes: [{ id: "text-1", type: "text", position: { x: 0, y: 0 } }],
      updatedAt: "2026-10-13T00:00:00.000Z"
    },
    nodeData: { "text-1": { title: "迁移节点" } },
    updatedAt: "2026-10-13T00:00:00.000Z"
  };
};
const migrationBinding = (sourceCanvasId) => ({
  extensionId: "legacy-import",
  sourceId: MIGRATION_SOURCE_ID,
  sourceCanvasId,
  cutoverGeneration: "e2e-cutover-1",
  configVersion: 1,
  converterVersion: "legacy-canvas-v1",
  sourceVersion: "e2e-watermark-1"
});
/** `CanvasSourceAccessHandle.binding` 不含 sourceVersion。 */
const migrationHandle = (sourceCanvasId) => {
  const { sourceVersion, ...binding } = migrationBinding(sourceCanvasId);
  return { binding, sourceVersion, targetCanvasId: sourceCanvasId, title: "迁移演练画布" };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const controlledSource = migrationEnabled
  ? {
      listSources: async () => [{ sourceId: MIGRATION_SOURCE_ID, displayName: "LegacyCanvas（E2E）", availability: "available" }],
      listAccessible: async () => ({
        items: [
          {
            ref: { sourceId: MIGRATION_SOURCE_ID, sourceCanvasId: migrationSourceCanvasId, cutoverGeneration: "e2e-cutover-1" },
            targetCanvasId: migrationSourceCanvasId,
            title: "迁移演练画布",
            updatedAt: "2026-10-13T00:00:00.000Z",
            availability: "not-prepared"
          }
        ],
        nextCursor: null
      }),
      resolveAccessible: async ({ sourceCanvasId }) => ({ ok: true, handle: migrationHandle(sourceCanvasId) }),
      prepareCandidate: async ({ handle }) => {
        // 保持“准备中”可见：候选生成耗时（真实实现里是长任务），轮询期间 status 为 preparing。
        await sleep(2_000);
        const sourceCanvasId = handle.binding.sourceCanvasId;
        return {
          ok: true,
          candidate: {
            binding: migrationBinding(sourceCanvasId),
            canvas: migrationCanvas(sourceCanvasId),
            access: {
              ownerSubject: "e2e-user",
              readSubjects: [],
              writeSubjects: [],
              sharingMode: "everyone_view",
              sourceAclVersion: "e2e-acl-1"
            },
            history: [],
            diagnostics: { entries: [], overflow: false, readyMediaCount: 0, restoredHistoryCount: 0, unrecoveredRecordCount: 0 }
          }
        };
      },
      validateSnapshot: async () => ({ ok: true })
    }
  : undefined;

const canvasService = await createCanvasService({
	env: {
		WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
		WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: canvasStorePath,
		// 不设置 `WOOHAA3_CANVAS_STORAGE_SERVICE_TOKEN`：浏览器不持有服务令牌，
		// 浏览器可见的画布路由以 **loopback** 为信任边界（与生产同源部署一致）。
		WOOHAA3_TASK_SERVICE_URL: `http://127.0.0.1:${taskListener.port}`,
		WOOHAA3_MEDIA_SERVICE_URL: `http://127.0.0.1:${mediaListener.port}`,
		WOOHAA3_CANVAS_TO_TASK_TOKEN: TASK_TOKEN,
		WOOHAA3_CANVAS_TO_MEDIA_TOKEN: CANVAS_TOKEN
	},
	repository: canvasRepository,
	yjsRepository,
	enableCanvasStorage: canvasStorageEnabled,
	enableYjsSync: canvasStorageEnabled,
	resolveCatalog: () => taskService.catalog(),
	// 在线迁移（可选）：注入受控来源端口 + 可信主体（E2E 固定用户）。
	...(controlledSource ? { canvasSources: controlledSource } : {}),
	...(controlledSource ? { canvasSubjectResolver: () => "e2e-user" } : {}),
	reconcileIntervalMs: 25,
	logger: (event) => process.env.E2E_QUIET === "1" ? undefined : process.stderr.write(`[canvas-service] ${JSON.stringify(event)}\n`)
});

const canvasListener = await listenService(canvasService);

// Application control routes belong to the unified backend composition (extensions,
// settings and ChatGPT status). Keep them real, with isolated stores and no paid provider.
// Canvas/Task/Media operations continue through the deterministic three-service fixture.
const { createBackendService } = await import(pathToFileURL(path.resolve(root, "web/backend/dist/index.js")).href);
const applicationBackend = await createBackendService({
  // Benchmark profile isolates canvas rendering from optional paid/agent providers.
  // The normal E2E/application profile is unchanged.
  ...(process.env.E2E_BENCHMARK === '1' ? {
    bootstrapExtensions: [], providerPlugins: [], storagePlugins: [],
    applicationBackendExtensions: [], applicationExtensionMetadata: []
  } : {}),
  env: {
    WOOHAA3_TASK_STORE_PATH: path.join(canvasDbDir, "application-task.sqlite"),
    WOOHAA3_APPLICATION_STORE_PATH: path.join(canvasDbDir, "application.sqlite"),
    WOOHAA3_CANVAS_STORAGE_BACKEND: "sqlite",
    WOOHAA3_CANVAS_STORAGE_SQLITE_PATH: path.join(canvasDbDir, "application-canvas.sqlite")
  },
  // e2e fixture：静默宿主日志，避免 JSON 行混进 Playwright 输出；落盘行为由 backend 单元测试覆盖。
  logger: () => {},
  modelsConfig: { version: 1, models: [] },
  mediaStorage: createMemoryStorage(),
  enableYjsSync: false
});
await applicationBackend.modules().application.plugins().reconcile();
const applicationListener = await listenService(applicationBackend);


// ---------------------------------------------------------------------------
// Ingress：与生产同一个路由层
// ---------------------------------------------------------------------------
const ingress = createIngress({
	targets: {
		canvas: `http://127.0.0.1:${canvasListener.port}`,
		task: `http://127.0.0.1:${taskListener.port}`,
		media: `http://127.0.0.1:${mediaListener.port}`,
		application: `http://127.0.0.1:${applicationListener.port}`
	},
	logger: (event) => process.env.E2E_QUIET === "1" ? undefined : process.stderr.write(`[ingress] ${JSON.stringify(event)}\n`)
});

const serveStatic = createStaticHandler(dist, { basePath, pageTitle: resolveAppPageTitle(process.env) });
// showcase（Ladle 构建产物）通过 `/showcase` 前缀访问：视频 dialogs 的浏览器验收直接渲染
// 生产 renderer，不需要完整画布应用（change: port-video-editing-dialogs，任务 5.3/5.4）。
// Ladle 产物内的资源路径是绝对路径（`/assets/...`、`/fixtures/...`），因此这些前缀在
// showcase dist 中存在对应文件时优先从 showcase 提供。
const showcaseDist = path.resolve(root, "web", "ui", "showcase", "dist");
const showcaseAvailable = fs.existsSync(path.join(showcaseDist, "index.html"));
const serveShowcase = showcaseAvailable ? createStaticHandler(showcaseDist, { prefix: "/showcase" }) : null;
const serveShowcaseRoot = showcaseAvailable ? createStaticHandler(showcaseDist) : null;
const SHOWCASE_ASSET_PREFIXES = ["/assets/", "/fixtures/"];

function tryServeShowcase(req, res) {
	if (!serveShowcase || !serveShowcaseRoot) return false;
	const pathname = new URL(req.url || "/", "http://localhost").pathname;
	if (pathname === "/showcase" || pathname.startsWith("/showcase/")) {
		serveShowcase(req, res);
		return true;
	}
	if (SHOWCASE_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
		const file = path.join(showcaseDist, pathname);
		if (fs.existsSync(file) && !fs.statSync(file).isDirectory()) {
			serveShowcaseRoot(req, res);
			return true;
		}
	}
	return false;
}

function readBody(req) {
	return new Promise((resolve) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => resolve(body));
	});
}

const server = http.createServer((req, res) => {
	// 公开挂载边界：只剥离一次前缀；前缀外/非法请求不进入业务或 SPA 回退。
	const mountAction = applyHttpMount(basePath, req);
	if (interceptHttpMount(req, res, mountAction)) return;
	// 测试专用：为某 canvas 建立权威 Yjs 文档（frontend 只有 Yjs 一条路径，必须先有文档
	// 才能进入 ready）。`reset: true` 时先删除已有文档，保证用例从干净状态开始。
	if ((req.url || "").startsWith("/__e2e_enable_yjs__")) {
		void (async () => {
			try {
				const payload = JSON.parse((await readBody(req)) || "{}");
				const canvasId = String(payload.canvasId ?? "");
				const canvas = payload.canvas ?? null;
				if (!canvasId || !canvas) {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "canvasId-and-canvas-required" }));
					return;
				}
				if (payload.reset === true) {
					// 先销毁服务端内存 room，否则它会继续用旧文档服务，删除/重建仓储不生效。
					await canvasService.sync?.registry.destroy(canvasId).catch(() => undefined);
					await yjsRepository.deleteYjsDocument(canvasId);
					await canvasRepository.deleteCanvas(canvasId, (await canvasRepository.getCanvas(canvasId))?.revision ?? 1).catch(() => undefined);
				}
				if (!(await yjsRepository.loadYjsState(canvasId))) {
					const doc = serverCanvasToYDoc(canvas);
					await yjsRepository.createYjsDocument({
						canvasId,
						formatVersion: YJS_CANVAS_FORMAT_VERSION,
						roomEpoch: "e2e-epoch",
						checkpoint: Y.encodeStateAsUpdate(doc),
						projection: canvas,
						revision: canvas.revision ?? 0,
						createdAt: new Date().toISOString()
					});
				}
				if (!(await canvasRepository.getCanvas(canvasId))) {
					await canvasRepository.createCanvas({ ...canvas, revision: 0 }).catch(() => undefined);
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ canvasId, roomEpoch: "e2e-epoch" }));
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: String(error?.message ?? error) }));
			}
		})();
		return;
	}
	// 测试专用：清空全部画布（结构化 + Yjs + room），用于多画布用例从空目录开始。
	if ((req.url || "").startsWith("/__e2e_reset_canvases__")) {
		void (async () => {
			try {
				for (;;) {
					const page = await canvasRepository.listCanvases({ offset: 0, limit: 100 });
					if (page.items.length === 0) break;
					for (const item of page.items) {
						await canvasService.sync?.registry.destroy(item.id).catch(() => undefined);
						await yjsRepository.deleteYjsDocument(item.id).catch(() => undefined);
						const current = await canvasRepository.getCanvas(item.id);
						await canvasRepository
							.deleteCanvas(item.id, current?.revision ?? 1)
							.catch(() => undefined);
					}
				}
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ ok: true }));
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: String(error?.message ?? error) }));
			}
		})();
		return;
	}
	// 测试专用：最近一次 provider 调用摘要。
	if ((req.url || "").startsWith("/__e2e_last_task__")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(lastProviderCall));
		return;
	}
	// 测试专用：直接登记一条节点生成历史（仅真实视频/图片/音频版本链路需要构造历史时使用；
	// 生产由 task projector / 编辑完成 outbox 触发）。走与生产相同的 registerTaskResult。
	if ((req.url || "").startsWith("/__e2e_seed_node_history__")) {
		void (async () => {
			try {
				const payload = JSON.parse((await readBody(req)) || "{}");
				const service = canvasService.nodeHistory?.service;
				if (!service) {
					res.writeHead(503, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "node-history-unavailable" }));
					return;
				}
				const canvasId = String(payload.canvasId ?? "");
				const nodeId = String(payload.nodeId ?? "");
				const kind = payload.kind === "image" || payload.kind === "audio" ? payload.kind : "video";
				const storageKey = String(payload.storageKey ?? "");
				if (!canvasId || !nodeId || !storageKey) {
					res.writeHead(400, { "content-type": "application/json" });
					res.end(JSON.stringify({ error: "canvasId-nodeId-storageKey-required" }));
					return;
				}
				const now = new Date().toISOString();
				const asset = {
					id: `e2e-history-asset-${storageKey}`,
					title: "E2E 历史输出",
					mediaKind: kind,
					source: "generated",
					status: "ready",
					createdAt: now,
					url: `/api/media/${storageKey}`,
					metadata: {
						storageKey,
						checksum: String(payload.checksum ?? storageKey.replace(/^sha256-/, "")),
						contentType: String(payload.contentType ?? (kind === "video" ? "video/webm" : "image/png")),
						size: Number(payload.size ?? 0)
					}
				};
				const posterAsset =
					payload.posterStorageKey
						? {
								id: `e2e-history-poster-${payload.posterStorageKey}`,
								title: "E2E 历史海报",
								mediaKind: "image",
								source: "generated",
								status: "ready",
								createdAt: now,
								url: `/api/media/${payload.posterStorageKey}`,
								metadata: {
									storageKey: String(payload.posterStorageKey),
									checksum: String(payload.posterChecksum ?? String(payload.posterStorageKey).replace(/^sha256-/, "")),
									contentType: "image/png",
									size: Number(payload.posterSize ?? 0)
								}
							}
						: undefined;
				const result = await service.registerTaskResult({
					canvasId,
					nodeId,
					runId: String(payload.runId ?? `e2e-history-run-${storageKey}`),
					kind,
					createdAt: now,
					output: {
						mediaKind: kind,
						asset,
						...(posterAsset ? { posterAsset } : {}),
						...(payload.durationSeconds !== undefined ? { durationSeconds: Number(payload.durationSeconds) } : {})
					}
				});
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify(result));
			} catch (error) {
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: String(error?.message ?? error) }));
			}
		})();
		return;
	}
	// 测试专用：故障注入控制端点。
	if ((req.url || "").startsWith("/__e2e_fault__")) {
		void readBody(req).then((body) => {
			try {
				fault = (JSON.parse(body || "{}").mode ?? "") || "";
			} catch {
				fault = "";
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ fault }));
		});
		return;
	}
	// 同源 ingress：站点 API 路由到三个服务；未命中的继续走静态资源。
	if (tryServeShowcase(req, res)) return;
	ingress
		.handle(req, res)
		.then((handled) => {
			if (!handled) serveStatic(req, res);
		})
		.catch((error) => {
			process.stderr.write(`[e2e-server] ingress failure: ${error?.message ?? error}\n`);
			if (!res.headersSent) send(res, 502, "ingress failure");
			else res.end();
		});
});

// 画布同步 WebSocket upgrade 经 ingress 转发到 Canvas Service。
server.on("upgrade", (req, socket, head) => {
	const mountAction = applyUpgradeMount(basePath, req);
	if (mountAction.kind !== "forward") { rejectUpgradeSocket(socket); return; }
	if (!ingress.upgrade(req, socket, head)) socket.destroy();
});

server.on("error", (err) => {
	process.stderr.write(`${err}\n`);
	process.exit(1);
});

async function shutdown() {
	await applicationBackend.close().catch(() => undefined);
	await canvasService.close().catch(() => undefined);
	await taskService.close().catch(() => undefined);
	await mediaService.close().catch(() => undefined);
	canvasRepository.close();
	for (const listener of [canvasListener, taskListener, mediaListener, applicationListener]) {
		await new Promise((resolve) => listener.server.close(() => resolve()));
	}
	server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(port, host, () => {
	process.stderr.write(
		`[e2e-server] http://${host}:${port}（真实三服务 + ingress${fault ? `，媒体故障 ${fault}` : ""}${canvasStorageEnabled ? "，画布存储开启" : "，画布存储关闭"}）\n`
	);
});
