/**
 * 本机宿主插件树上的服务。
 *
 * 基础层：log / gateway / access / config；核心层：storage / telemetry / media / generation /
 * task / canvas / mcp / toolGrants / application。扩展层只拿得到 contracts 里声明的那几个服务形状
 * （`HostExtensionContext`）。
 *
 * 插件按 `inject` 声明依赖；只在调用时才需要、又会形成环的引用（canvas 读 application 的
 * 来源注册表等）用 `ctx.get(name)` 懒取，不进 `inject`。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Context } from "@deepseek-ai/cordis";
import type {
  AccessRuntime,
  ApplicationBackendDiagnosticEntry,
  ApplicationBackendExtensionDefinition,
  AssembledFoundationProviders,
  HostGenerationService,
  HostLogService,
  HostStorageService,
  HostTelemetryService,
  RequiredProviderProfiles
} from "@woohaa3/contracts";
import type {
  AccessEnforcer,
  ApplicationRequestAuthenticator,
  ApplicationService,
  ApplicationServiceOptions,
  CanvasSourceRegistry,
  ProviderRegistry,
  createSqliteGenerationModelStore
} from "@woohaa3/application-service";
import type { CanvasService } from "@woohaa3/canvas-service";
import type { McpService } from "@woohaa3/mcp-service";
import type { MediaService } from "@woohaa3/media-service";
import type { TaskService } from "@woohaa3/task-service";
import type { createToolGrantRegistry } from "../ports/authoring-adapters.js";
import type { BackendRuntime } from "../runtime/backend-runtime.js";
import type { RuntimeStorageProvider } from "../extensions/slot-contract.js";
import type { SiteGate } from "./core/site-gate.js";
import type { SettingsService } from "../settings/settings-service.js";

/** Application Service 接受的显式基础提供者集合。 */
export type ApplicationServiceSeedProviders = NonNullable<ApplicationServiceOptions["seedProviders"]>;

/** 启动期槽位装配结果：提供者实例与各 slot 的 owner extensionId。 */
export type FoundationAssembly = {
  providers: AssembledFoundationProviders<RuntimeStorageProvider>;
  owners: Partial<Record<import("@woohaa3/contracts").FoundationSlot, string>> & { storage: string };
};

declare module "@deepseek-ai/cordis" {
  interface Events {
    /** 三层插件都装载完毕（Provider 已注册）。 */
    "host/ready"(): void;
  }
}

export type HttpHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
export type ReadinessResult = { ready: boolean; reason?: string };

/**
 * WebView 与本机宿主之间的入口：插件按顺序登记同源 HTTP 处理器、WebSocket upgrade 与就绪检查。
 * 数字小的先匹配。
 */
export type GatewayService = {
  route(order: number, handler: HttpHandler): () => void;
  upgrade(handler: UpgradeHandler): () => void;
  readiness(order: number, check: () => Promise<ReadinessResult>): () => void;
  handle: HttpHandler;
  handleUpgrade: UpgradeHandler;
  ready(): Promise<ReadinessResult>;
};

/** 部署身份：统一可信认证器、站点/资源授权执行边界与基础提供者槽位（任务 1.1–1.5）。 */
export type AccessService = {
  /** 启动扫描固定的访问装配结果：企业身份为 enabled，本地单实例为 disabled + instance scope。 */
  runtime: AccessRuntime;
  /** 统一请求认证器（企业 identity provider 支撑；本地单实例返回实例 owner，非登录主体）。 */
  authenticator: ApplicationRequestAuthenticator;
  /** 站点/资源授权执行边界（具名 action 与资源检查）。 */
  accessEnforcer: AccessEnforcer;
  /** 类型化基础提供者 registry（identity/site-access/resource-access/resource-lifecycle）。 */
  providers: ProviderRegistry;
  /** 必需基础提供者 profile；无受控提供者时为空。 */
  requiredProviders: RequiredProviderProfiles;
  /** bootstrap 装配出的基础提供者（identity/access/storage）；未声明时为 null。 */
  foundation: FoundationAssembly | null;
  /** 基础 storage 槽位实现（画布存储单元 + 扩展文档/目录/扩展配置）；未声明时为 null。 */
  foundationStorage: RuntimeStorageProvider | null;
  /** 显式注入的 seed 提供者，转交给 Application Service。 */
  seedProviders: ApplicationServiceSeedProviders;
  /** 释放 bootstrap 装配的资源（进程退出时）。 */
  closeFoundation: () => Promise<void>;
};

export type GenerationModelPolicyStore = ReturnType<typeof createSqliteGenerationModelStore>;

export type GenerationService = HostGenerationService & {
  /** 站点级的模型启停与默认值策略。 */
  policy: GenerationModelPolicyStore;
};

export type ApplicationModule = {
  service: ApplicationService;
  /** 在站点插件宿主上激活非站点目录里的后端插件（ChatGPT 等）。 */
  runtime: BackendRuntime;
  definitions: readonly ApplicationBackendExtensionDefinition[];
  sourceRegistry: CanvasSourceRegistry;
  /** 插件管理里的站点开关与扩展层的衔接。 */
  siteGate: SiteGate;
};

/**
 * 宿主诊断缓冲：log 出口写入，站点扩展与调试窗口只读。
 *
 * `record` 只接受白名单事件（remote-server 与画布同步上游），投影时丢弃原始字段；
 * `snapshot` 返回副本，调用方不能改写缓冲。
 */
export type HostDiagnosticsService = {
  /** 缓冲上限（条），用于界面说明。 */
  capacity: number;
  record(event: Record<string, unknown>): void;
  snapshot(input?: { since?: number; limit?: number }): ApplicationBackendDiagnosticEntry[];
};

export type HostServices = {
  log: HostLogService;
  diagnostics: HostDiagnosticsService;
  gateway: GatewayService;
  access: AccessService;
  config: SettingsService;
  media: MediaService;
  generation: GenerationService;
  /** 存储扩展点：后端插件注册，media/task 只用 `bucket(namespace)`。 */
  storage: HostStorageService;
  /**
   * 本机遥测（change: 2026-10-20-add-local-client-telemetry）：采集、查询、聚合与导出注册面。
   * 业务路径只用 `emit`（同步入队、不等待 I/O）；读写面由 `/api/telemetry/*` 暴露。
   */
  telemetry: HostTelemetryService;
  task: TaskService;
  canvas: CanvasService;
  mcp: McpService;
  toolGrants: ReturnType<typeof createToolGrantRegistry>;
  application: ApplicationModule;
  /**
   * 本机录制执行器通道（change: 2026-10-17-add-native-offscreen-film-set-recording）。
   * Windows 等无 Unix socket 的平台上不存在该服务，录制能力据此明确不可用。
   */
  recordingExecutor: import("./core/recording-executor.js").RecordingExecutorChannel;
};

export type HostContext = Context & HostServices & {
  get<K extends keyof HostServices>(name: K): HostServices[K] | undefined;
};

/** 宿主自己的 Cordis 对象插件。 */
export type HostPlugin<C = undefined> = {
  name: string;
  inject?: Array<keyof HostServices>;
  apply(ctx: HostContext, config: C): void | Promise<void>;
};
