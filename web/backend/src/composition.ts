import { createRuntimeComponentsHandler } from "./runtime-components/http.js";
/**
 * 本机宿主的组合根：只启动 Context。
 *
 * 一切皆插件：基础层（log / gateway / access / config）→ 核心层（storage / media / generation /
 * task / canvas / mcp / application）→ 扩展层（Provider 与存储后端，向 `ctx.generation` /
 * `ctx.storage` 注册并声明自己的配置项）。
 * 三层装载完成后发出 `host/ready`。浏览器可见的同源路径都由 `gateway` 按插件登记的顺序分派。
 *
 * 就绪语义（change: 2026-10-21-harden-extension-fault-isolation，D5）：只等基础层、核心层、
 * 主存储后端与必需站点提供者；可选扩展激活已**发起**即可，完成前其站点状态为 configuring。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { Context, type Fiber } from "@deepseek-ai/cordis";
import type {
  AnyHostExtensionPlugin,
  ApplicationBackendExtensionDefinition,
  BootstrapExtension,
  HostGenerationService,
  HostStorageService,
  MediaStorage
} from "@woohaa3/contracts";
import { normalizeAppBasePath } from "@woohaa3/contracts";
import type {
  ApplicationRequestAuthenticator,
  ApplicationService,
  ApplicationServiceOptions
} from "@woohaa3/application-service";
import type { CanvasService } from "@woohaa3/canvas-service";
import type { McpService } from "@woohaa3/mcp-service";
import type { MediaService } from "@woohaa3/media-service";
import type { ModelsConfig, TaskService } from "@woohaa3/task-service";
import type { ChatGptServiceOptions } from "@woohaa3/extension-oauth-agent/backend";
import type { HostContext, HostServices } from "./host/context.js";
import { createHostLogSink } from "./host/log-sink.js";
import { loadBaseLayer } from "./host/base/index.js";
import { loadCoreLayer } from "./host/core/index.js";
import { loadExtensionLayer } from "./host/extensions/loader.js";
import { installExtensionHost } from "./extension-host/host/install.js";
import { ROUTE_ORDER } from "./host/order.js";
import { parseAllowedOrigins } from "./composition/config.js";
import { createOriginGuard } from "./http/origin-guard.js";
import type { RuntimeStorageProvider } from "./extensions/slot-contract.js";
import { loadExtensionHostFromEnv } from "./extensions/host-boot.js";
import { slotImplementationSource } from "./extensions/bootstrap.js";
import type { LoadedExtensionHost } from "./extensions/manifest.js";
import type { BackendRuntime } from "./runtime/backend-runtime.js";
import type { SettingsService } from "./settings/settings-service.js";

/**
 * 启动期结算遗留 provisioning 预留的宽限期（change: 2026-10-13-...，任务 11.2 / D1；恢复自迁移前）。
 * 只结算早于该时刻的预留，避免与在途创建竞争。
 */
const PROVISIONING_RESERVATION_GRACE_MS = 60_000;

export type BackendServiceOptions = {
  env?: Record<string, string | undefined>;
  /** 模型配置（Task catalog）；缺省从仓库文件读取。 */
  modelsConfig?: ModelsConfig;
  /** 媒体存储（测试注入内存替身；缺省从环境构造 COS adapter）。 */
  mediaStorage?: MediaStorage;
  /** 应用插件可信元数据（缺省取可信生产清单）。 */
  applicationExtensionMetadata?: ApplicationServiceOptions["applicationExtensionMetadata"];
  /** 应用插件可信后端入口（缺省取可信生产清单）。 */
  applicationBackendExtensions?: readonly ApplicationBackendExtensionDefinition[];
  /** 扩展层 Provider 插件覆盖（测试注入 fake）；缺省取自启动期扩展宿主的 `hostPlugin` 声明。 */
  providerPlugins?: readonly AnyHostExtensionPlugin[];
  /** 扩展层存储后端插件覆盖（测试注入 fake）；缺省取自启动期扩展宿主的 `hostPlugin` 声明。 */
  storagePlugins?: readonly AnyHostExtensionPlugin[];
  /** 日志出口覆盖；缺省用内置 sink（stderr 一行 JSON + `.woohaa3/logs` 轮转文件）。测试注入空 sink 保持安静。 */
  logger?: (event: Record<string, unknown>) => void;
  /** 是否启动 Yjs 同步面（测试可关）。 */
  enableYjsSync?: boolean;
  /**
   * 启动期槽位实现（storage / identity / access）
   * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 1.1）。
   *
   * 生产由部署目录扫描得到（槽位实现是可信扩展）；缺省不加载任何槽位实现。
   */
  bootstrapExtensions?: readonly BootstrapExtension<RuntimeStorageProvider>[];
  /**
   * 启动期扩展宿主（已扫描并加载）。缺省时本函数按环境加载（`loadExtensionHostFromEnv`）；
   * 进程入口可先加载一次再传入，避免重复扫描。
   */
  extensionHost?: LoadedExtensionHost;
  /**
   * 是否加载启动期扩展宿主（缺省 true）。
   *
   * 只注入 `bootstrapExtensions`（受控回归）时缺省不扫描扩展目录；需要宿主提供扩展层插件、
   * 元数据与公开路由时显式传 `true`。
   */
  loadExtensionHost?: boolean;
  /**
   * 显式注入的基础提供者（测试/受控部署）。生产由可信扩展在 activation 中登记；
   * 这里只允许显式 fake/等价实现，不引入隐式回退（同 change，任务 1.3）。
   */
  seedProviders?: ApplicationServiceOptions["seedProviders"];
  /**
   * 可信请求认证器（测试/部署注入）；缺省由必需 identity provider（或本地开发姿态）支撑。
   */
  authenticator?: ApplicationRequestAuthenticator;
  /**
   * 当前公开挂载路径。缺省从 `env.WOOHAA3_BASE_PATH` 规范化；供后端派生对浏览器可见的公开 URL
   * （MCP 指引、插件 CSP）。
   */
  basePath?: string;
  /** ChatGPT 插件测试注入：服务选项覆盖（fake SDK/fetch 等）。 */
  chatgptServiceOptions?: ChatGptServiceOptions;
  /** 统一配置服务（测试注入）；缺省按 `WOOHAA3_CONFIG_FILE` / `WOOHAA3_SECRETS_FILE` 定位文件并监听。 */
  settings?: SettingsService;
  /**
   * 启动守卫判定的安全模式（change: 2026-10-21-harden-extension-fault-isolation，D7）。进程入口在
   * 扫描前用 `beginBoot` 判定，并以 `safeMode` 扫描扩展宿主；这里只负责把视图交给控制面与设置面。
   */
  safeMode?: { reason: "boot-failures" | "forced"; since: string; suspended: readonly string[]; lastFailure?: string };
  /**
   * 结构化日志旁路（不替换出口）：进程入口用它在就绪前捕获扩展启动失败，写入启动守卫（D7）。
   * 旁路抛错不影响日志与启动。
   */
  logTap?: (event: Record<string, unknown>) => void;
};

export type BackendService = {
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  upgrade?: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  readiness: () => Promise<{ ready: boolean; reason?: string }>;
  close: () => Promise<void>;
  /** 实际生效的结构化日志出口（注入的或内置默认 sink）；进程自己的非结构化行不走这里。 */
  log: (event: Record<string, unknown>) => void;
  /** 内置默认 sink 的落盘目录；调用方注入了 `logger` 或 `WOOHAA3_LOG_DIR` 为空串时为 null。 */
  logDir: string | null;
  /**
   * 订阅受控重启请求（change: 2026-10-21-harden-extension-fault-isolation，D6）。进程入口订阅后
   * 走排空关闭并以 75 退出；未订阅时 `POST /api/host/restart` 回 503、宿主不退出。
   */
  onRestartRequested: (listener: (request: import("./api/host-restart-api.js").HostRestartRequest) => void) => () => void;
  /**
   * 可选扩展（并发激活、不阻塞就绪）与站点控制面首次协调全部结束（D5）。只用于测试与诊断：
   * 就绪本身不等它；失败已在各自的站点状态里，这里不抛错。
   */
  settled: () => Promise<void>;
  modules: () => {
    settings: SettingsService;
    canvas: CanvasService;
    task: TaskService;
    media: MediaService;
    mcp: McpService;
    application: ApplicationService;
    runtime: BackendRuntime;
    generation: HostGenerationService;
    storage: HostStorageService;
    /** 本机录制执行器通道；无 Unix socket 的平台上为 null。 */
    recordingExecutor: import("./host/core/recording-executor.js").RecordingExecutorChannel | null;
  };
};

export async function createBackendService(options: BackendServiceOptions = {}): Promise<BackendService> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const hostLog = options.logger === undefined ? createHostLogSink({ env }) : null;
  const baseSink = options.logger ?? hostLog!.log;
  const tap = options.logTap;
  const sink = tap
    ? (event: Record<string, unknown>) => {
        baseSink(event);
        try {
          tap(event);
        } catch {
          // 旁路只做观察；失败不能影响日志出口或启动。
        }
      }
    : baseSink;
  // 启动期槽位发现（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 3.1/3.2）：
  // 调用方显式注入槽位实现时不再扫目录（测试/受控部署路径）；否则扫描扩展目录，`bootstrapExtensions`
  // 缺省也能发现槽位实现。声明非法、跨根重复 identity、槽位冲突由宿主抛出，启动 fail-fast。
  const extensionHost =
    options.extensionHost ??
    (options.bootstrapExtensions && options.loadExtensionHost !== true ? undefined : await loadExtensionHostFromEnv({ logger: sink, env }));
  const slotSource = options.bootstrapExtensions ? null : slotImplementationSource(extensionHost, env);
  const bootstrapExtensions =
    options.bootstrapExtensions ?? (slotSource ? await slotSource.createDeclarations({}) : undefined);
  const normalizedBase = normalizeAppBasePath(options.basePath ?? env.WOOHAA3_BASE_PATH);
  const basePath = normalizedBase.ok ? normalizedBase.basePath : "/";

  const ctx = new Context() as HostContext;
  // Cordis 卸载同一 fiber 的副作用是并行的；层与层之间要按装载的反序逐个卸载。
  const disposers: Array<() => Promise<void>> = [];
  const track = (fibers: Fiber[]) => {
    for (const fiber of fibers) disposers.push(() => fiber.dispose());
  };
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const dispose of disposers.reverse()) await dispose();
  };

  // 扩展层插件来自扩展目录的 `hostPlugin` 声明（启动期宿主扫描）：宿主不登记具体插件。
  const declaredPlugins = extensionHost?.createHostPlugins ? await extensionHost.createHostPlugins({}) : undefined;
  const extensions = options.providerPlugins ?? declaredPlugins?.provider ?? [];
  const storageExtensions = options.storagePlugins ?? declaredPlugins?.storage ?? [];
  // 市场来源插件（change: 2026-10-21-add-extension-marketplace-point，D1/D3）：只来自内置根，宿主扫描已拒绝其余根。
  const sourceExtensions = (declaredPlugins as { "marketplace-source"?: readonly AnyHostExtensionPlugin[] } | undefined)?.["marketplace-source"] ?? [];
  let layerSettled: Promise<void> = Promise.resolve();
  const isolatedPlugins: AnyHostExtensionPlugin[] = [];
  try {
    track(
      await loadBaseLayer(ctx, {
        env,
        sink,
        directoryControl: extensionHost?.directoryControl,
        ...(options.authenticator ? { authenticator: options.authenticator } : {}),
        ...(options.seedProviders ? { seedProviders: options.seedProviders } : {}),
        ...(bootstrapExtensions ? { bootstrapExtensions } : {}),
        ...(options.settings ? { settings: options.settings } : {})
      })
    );
    // 受管扩展的 Extension Host 子进程（change: 2026-10-21-isolate-extension-host-process，D1）：
    // 代理插件进扩展层；服务先于核心层 provide，Extension Manager 装载时即可取到蓝绿切换入口。
    const isolatedHost = extensionHost
      ? installExtensionHost(ctx, { descriptors: declaredPlugins?.isolated ?? [], env, enabled: extensionHost.isolation !== false })
      : null;
    if (isolatedHost) {
      const unmount = isolatedHost.mountRoutes();
      disposers.push(async () => {
        unmount();
        await isolatedHost.close();
      });
      isolatedPlugins.push(...isolatedHost.plugins);
    }
    // 运行期扩展发布目录（内容寻址资源 + release catalog）：命中即响应，未命中交下游。
    if (extensionHost?.handleReleaseRequest) {
      const releaseRequest = extensionHost.handleReleaseRequest;
      const unroute = ctx.gateway.route(ROUTE_ORDER.releaseCatalog, async (req, res) => releaseRequest(req, res));
      disposers.push(async () => unroute());
    }
    track(
      await loadCoreLayer(ctx, {
        env,
        basePath,
        ...(extensionHost ? { extensionHost } : {}),
        ...(options.modelsConfig ? { modelsConfig: options.modelsConfig } : {}),
        ...(options.mediaStorage ? { mediaStorage: options.mediaStorage } : {}),
        ...(options.enableYjsSync !== undefined ? { enableYjsSync: options.enableYjsSync } : {}),
        ...(options.applicationExtensionMetadata ? { applicationExtensionMetadata: options.applicationExtensionMetadata } : {}),
        ...(options.applicationBackendExtensions ? { applicationBackendExtensions: options.applicationBackendExtensions } : {}),
        ...(options.chatgptServiceOptions ? { chatgptServiceOptions: options.chatgptServiceOptions } : {}),
        treeExtensions: [...extensions, ...isolatedPlugins, ...sourceExtensions].map((plugin) => plugin.name),
        ...(options.safeMode
          ? {
              safeMode: {
                reason: options.safeMode.reason,
                since: options.safeMode.since,
                suspended: [...options.safeMode.suspended],
                suspendedCount: options.safeMode.suspended.length,
                ...(options.safeMode.lastFailure ? { lastFailure: options.safeMode.lastFailure } : {})
              }
            }
          : {})
      })
    );
    // 可选插件并发启动、不阻塞就绪（change: 2026-10-21-harden-extension-fault-isolation，D5）：
    // 只有当前主存储后端（`storage.primary`）是就绪前提，必须等它；其余存储后端与 Provider 并发发起。
    // 判定来自设置值与插件声明，不写死扩展身份（extension-purity）。
    const primaryStorage = String(ctx.config.get("storage.primary") ?? "local");
    const layer = await loadExtensionLayer(ctx, [
      ...storageExtensions.map((plugin) => ({ plugin, optional: !providesStorage(plugin, primaryStorage) })),
      ...extensions,
      ...isolatedPlugins,
      ...sourceExtensions
    ]);
    // 运行期追加入口（change: 2026-10-21-isolate-extension-host-process，任务 8.4）：首次安装的受管后端扩展
    // 由 Extension Manager 追加代理插件；关闭时连同运行期追加的一起卸载（disposeAll 覆盖启动期与运行期）。
    ctx.provide("extensionLayer", layer);
    disposers.push(() => layer.disposeAll());
    layerSettled = layer.settled;
    // 站点开关管着的扩展由控制面的首次 reconcile 启动；就绪只等必需提供者，可选扩展继续在后台协调。
    await ctx.get("application")?.service.ready();
    // 创建崩溃恢复（change: 2026-10-13-...，任务 11.2 / D1；恢复自迁移前的统一后端）：
    // 启动时结算遗留 provisioning 预留（内容已建 → 补 finalize；内容未建 → 清理预留）。只结算早于
    // 宽限期的预留，避免与在途创建竞争；失败不阻断启动（重试路径仍可续作）。
    try {
      const reconciler = ctx.get("canvas")?.reconcileProvisioningReservations;
      const reconciled = await reconciler?.({
        reservedBefore: new Date(Date.now() - PROVISIONING_RESERVATION_GRACE_MS).toISOString()
      });
      if (reconciled && (reconciled.finalized.length > 0 || reconciled.cleaned.length > 0 || reconciled.failed.length > 0)) {
        sink({
          module: "canvas",
          event: "provisioning-reconciled",
          finalized: reconciled.finalized.length,
          cleaned: reconciled.cleaned.length,
          failed: reconciled.failed.length
        });
      }
    } catch (error) {
      sink({ module: "canvas", event: "provisioning-reconcile-failed", message: error instanceof Error ? error.message : String(error) });
    }
  } catch (error) {
    await close();
    throw error;
  }
  ctx.emit("host/ready");

  const service = <K extends keyof HostServices>(name: K): HostServices[K] => {
    const value = ctx.get(name);
    if (value === undefined) throw new Error(`本机宿主缺少服务：${name}`);
    return value;
  };
  const gateway = service("gateway");
  // 浏览器写请求 Origin/CSRF 守卫（change: 2026-10-13-add-enterprise-access-and-production-deployment，
  // 任务 2.4）：在进入任何领域 handler 之前判定。允许列表由 `WOOHAA3_ALLOWED_ORIGINS` 给出；
  // 无 Origin 的非浏览器/服务端调用放行，同源（Host / x-forwarded-host）兜底，跨源写请求 403。
  const originGuard = createOriginGuard(parseAllowedOrigins(env));
  const runtimeComponents = createRuntimeComponentsHandler({ allowedOrigins: parseAllowedOrigins(env) });
  return {
    handle: async (req, res) => {
      const origin = originGuard(req);
      if (!origin.ok) {
        sendOriginForbidden(res, origin.code, origin.message);
        return true;
      }
      if (await runtimeComponents(req, res)) return true;
      return gateway.handle(req, res);
    },
    upgrade: (req, socket, head) => gateway.handleUpgrade(req, socket, head),
    readiness: () => gateway.ready(),
    close,
    log: sink,
    logDir: hostLog?.dir ?? null,
    onRestartRequested: (listener) => service("hostRestart").subscribe(listener),
    settled: async () => {
      await layerSettled.catch(() => undefined);
      await ctx.get("application")?.service.settled?.().catch(() => undefined);
    },
    modules: () => ({
      settings: service("config"),
      canvas: service("canvas"),
      task: service("task"),
      media: service("media"),
      mcp: service("mcp"),
      application: service("application").service,
      runtime: service("application").runtime,
      generation: service("generation"),
      storage: service("storage"),
      recordingExecutor: ctx.get("recordingExecutor") ?? null
    })
  };
}

/**
 * 存储插件是否提供当前主存储后端：声明的 backendId、配置段末段（`storage.local` → `local`）或插件名匹配即视为必需。
 * 匹配不上时按可选处理——主存储缺失本身由 storage 就绪检查报出，不靠装载顺序兜底。
 */
function providesStorage(plugin: AnyHostExtensionPlugin, backendId: string): boolean {
  const declared = (plugin as { backendId?: unknown }).backendId;
  return (
    declared === backendId ||
    plugin.configPrefix.split(".").pop() === backendId ||
    plugin.name === backendId
  );
}

/** 写请求 Origin 校验失败：稳定 403 JSON，不回显请求来源细节。 */
function sendOriginForbidden(res: ServerResponse, code: string, message: string): void {
  if (res.headersSent) {
    if (!res.writableEnded) res.end();
    return;
  }
  const payload = JSON.stringify({ error: code, message });
  res.statusCode = 403;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", String(Buffer.byteLength(payload)));
  res.end(payload);
}
