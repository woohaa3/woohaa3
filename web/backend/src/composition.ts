import { createRuntimeComponentsHandler } from "./runtime-components/http.js";
/**
 * 本机宿主的组合根：只启动 Context。
 *
 * 一切皆插件：基础层（log / gateway / access / config）→ 核心层（storage / media / generation /
 * task / canvas / mcp / application）→ 扩展层（Provider 与存储后端，向 `ctx.generation` /
 * `ctx.storage` 注册并声明自己的配置项）。
 * 三层装载完成后发出 `host/ready`。浏览器可见的同源路径都由 `gateway` 按插件登记的顺序分派。
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
  /** Trusted background identity; never sourced from browser request parameters. */
  extensionCanvasPrincipal?: () => Promise<import("@woohaa3/contracts").PrincipalContext | null>;
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
  const sink = options.logger ?? hostLog!.log;
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
        ...(options.extensionCanvasPrincipal ? { extensionCanvasPrincipal: options.extensionCanvasPrincipal } : {}),
        ...(options.applicationBackendExtensions ? { applicationBackendExtensions: options.applicationBackendExtensions } : {}),
        ...(options.chatgptServiceOptions ? { chatgptServiceOptions: options.chatgptServiceOptions } : {}),
        treeExtensions: extensions.map((plugin) => plugin.name)
      })
    );
    for (const extension of await loadExtensionLayer(ctx, [...storageExtensions, ...extensions])) {
      disposers.push(extension.dispose);
    }
    // 站点开关管着的扩展要等控制面的首次 reconcile 才启动。
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
