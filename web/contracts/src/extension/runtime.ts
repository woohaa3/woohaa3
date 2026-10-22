/**
 * 应用插件后端宿主与受限服务 facade 的**纯类型契约**
 * （change: 2026-10-05-extract-application-plugin-host，任务 1.2 / design D2/D3）。
 *
 * 宿主契约从 Task 内部实现移入公共契约：插件只依赖这里声明的纯类型，不得导入任何宿主
 * 内部实现。本模块不包含 HTTP client、Node driver 或 SDK，也不含秘密。
 *
 * 受限服务 facade（`ctx.tasks` / `ctx.media` / `ctx.canvas`）只声明**协议形状**；实现由
 * Application 宿主通过受认证、版本化的网络协议提供，插件拿不到原始服务令牌、数据库或
 * 任意目标 URL。
 */
import type {
  ApplicationExtensionAuthLevel,
  ApplicationExtensionCapabilitySummary,
  ApplicationExtensionHostIdentity
} from "./manifest.js";
import type { ApplicationExtensionSecretStore } from "./secrets.js";
import type { AccessAction } from "./access.js";
import type {
  ApplicationExtensionTaskResult,
  ApplicationExtensionMediaResourcesFacade,
  ApplicationExtensionMediaVerifyResult
} from "./services.js";
import type {
  ApplicationAuthoringServices,
  ApplicationPersonalGenerationFacade
} from "./authoring.js";
import type {
  ApplicationExtensionHttpHandler,
  ApplicationExtensionHttpMethod,
  ApplicationExtensionHandlerPurpose,
  ApplicationExtensionStreamBudget,
  ApplicationExtensionRawRequest,
  ApplicationExtensionRawResponse
} from "./http.js";

/**
 * 认证等级强弱：插件不能弱化宿主要求（design D2）。
 *
 * change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 3.3：删除 `admin`
 * 等级。旧 `auth: admin` 迁移为 `authenticated` + 具名 `requiredActions`；核心 MUST NOT
 * 依赖管理员等级放行。
 */
export const AUTH_LEVEL_RANK: Readonly<Record<ApplicationExtensionAuthLevel, number>> = {
  public: 0,
  authenticated: 1
};

export function isAuthLevelAtLeast(
  actual: ApplicationExtensionAuthLevel,
  required: ApplicationExtensionAuthLevel
): boolean {
  return AUTH_LEVEL_RANK[actual] >= AUTH_LEVEL_RANK[required];
}

/** 受控请求上下文：由宿主认证后注入，插件不得自报身份。 */
export type ApplicationExtensionRequestContext = {
  extensionId: string;
  authLevel: ApplicationExtensionAuthLevel;
  /** 可信操作者标识（仅审计；不参与授权决策）。 */
  actor?: string;
  correlationId?: string;
  /**
   * 可信应用用户主体（change: 2026-10-13-add-enterprise-access-and-production-deployment）。
   * 由宿主 identity provider 建立并冻结；个人凭据与资源权限的 owner 只来自 `principal.subject`。
   * 个人插件不得以 authLevel、actor 或请求体 userId 代替。不含 `isAdmin`/管理员角色。
   */
  principal?: import("./principal.js").PrincipalContext;
  /** 宿主固定的访问控制装配状态与数据归属；不能由请求自报。 */
  accessControl?: boolean;
  dataScope?: import("./data-scope.js").DataScope;
  /** 会话绑定（本地会话或登录会话）；OAuth 事务用它绑定 owner。 */
  sessionId?: string;
  /**
   * 取消信号（change: 2026-10-08-unlock-...，任务 2.5 / design D4）。
   *
   * 宿主在 client 断连或 deadline 到达时 abort；流式 handler MUST 据此停止等待并收尾。
   */
  signal?: AbortSignal;
};

/** handler 返回：body 必须是有界 JSON；宿主负责序列化与状态码。 */
export type ApplicationExtensionHandlerResult = {
  status?: number;
  body: unknown;
};

/**
 * 插件注册的受控请求处理（命名空间下相对路由；宿主统一分派）。
 *
 * `purpose` 区分新工作与在途控制（design D4/D6）：draining 拒绝 `new-work`/`auth-transaction`
 * 的新准入，但保留 `work-control`/`read` 的 owner/version-bound 访问。
 */
export type ApplicationBackendHandlerRegistration = {
  /** 相对路由（不含宿主 base path）；`/` 之外不允许空。 */
  route: string;
  /** 最低认证等级；插件不能弱化。 */
  auth: ApplicationExtensionAuthLevel;
  /**
   * 具名站点 action（change: 2026-10-13-...，任务 3.3）。宿主在进入插件逻辑前用
   * SiteAccessPolicy 逐项校验；缺失/未知 action 默认拒绝。
   */
  requiredActions?: readonly AccessAction[];
  /** 请求用途；缺省按 `new-work`（保守：draining 会拒绝）。 */
  purpose?: ApplicationExtensionHandlerPurpose;
  handle: (
    input: { body: unknown; context: ApplicationExtensionRequestContext }
  ) => Promise<ApplicationExtensionHandlerResult> | ApplicationExtensionHandlerResult;
};

/**
 * 插件注册的受控 **HTTP** handler（server-only；design D4）。
 *
 * 与纯 DTO handler 并存：HTTP handler 取得 method/query/headers/Cookie 与受控响应，用于
 * OAuth callback、Set-Cookie、HTML、redirect 与有界流式响应。宿主仍在进入前完成认证、
 * Origin/CSRF、体积与预算校验，并在超时/断连时向执行层发出取消信号。
 */
export type ApplicationBackendHttpHandlerRegistration = {
  route: string;
  method: ApplicationExtensionHttpMethod;
  auth: ApplicationExtensionAuthLevel;
  /** 具名站点 action（同 DTO handler；宿主在进入前校验）。 */
  requiredActions?: readonly AccessAction[];
  purpose: ApplicationExtensionHandlerPurpose;
  /** 声明流式（SSE）；宿主按 `streamBudget` 执行 heartbeat/deadline/预算。 */
  stream?: boolean;
  streamBudget?: Partial<ApplicationExtensionStreamBudget>;
  handle: ApplicationExtensionHttpHandler;
};

/**
 * 受控**原始 HTTP** handler 注册（server-only；design D4 允许"原始 req/res 访问或等价 facade"）。
 *
 * 请求/响应用**结构化形状**（`ApplicationExtensionRawRequest/Response`，不 import `node:http`），
 * 使 contracts 保持浏览器安全；后端入口契约把它与真实 Node 实现对接。宿主在进入前完成认证、
 * Origin/CSRF 与预算校验，并把可信 dispatch 上下文作为第三参注入；插件不得自报身份。
 * 用于 OAuth 回调、Cookie、HTML、redirect 与 SSE，允许复用既有 Node handler 实现。
 */
export type ApplicationBackendRawHttpHandlerRegistration = {
  route: string;
  method: ApplicationExtensionHttpMethod;
  auth: ApplicationExtensionAuthLevel;
  /** 具名站点 action（同 DTO handler；宿主在进入前校验）。 */
  requiredActions?: readonly AccessAction[];
  purpose: ApplicationExtensionHandlerPurpose;
  stream?: boolean;
  streamBudget?: Partial<ApplicationExtensionStreamBudget>;
  handle: (
    req: ApplicationExtensionRawRequest,
    res: ApplicationExtensionRawResponse,
    context: ApplicationExtensionRequestContext
  ) => Promise<void>;
};

/** 插件注册的 typed capability（供同宿主其它模块按 id 解析）。 */
export type ApplicationBackendCapabilityRegistration = {
  id: string;
  /** capability 实现；具体形状由 capability owner 约定。 */
  value: unknown;
};

/** 后台资源：拥有 start/stop 生命周期，disposer 必须幂等（design D2）。 */
export type ApplicationBackendResource = {
  id: string;
  start?: () => Promise<void> | void;
  /** 幂等停止；activation 回滚与停用都调用它。 */
  stop: () => Promise<void> | void;
};

/** 宿主提供的配置读写 facade（只读已提交配置；不暴露秘密）。 */
export type ApplicationBackendConfigFacade = {
  /** 当前插件已提交的配置版本；未配置时为 null。 */
  configVersion: () => number | null;
  /** 当前插件非秘密配置值快照。 */
  values: () => Record<string, unknown>;
  /** 秘密引用列表（无秘密值）。 */
  secretRefs: () => readonly string[];
  /** 目标是否启用（真实工作中以它为准）。 */
  desiredEnabled: () => boolean;
};

/** 一条已受理工作的 handle（版本化；draining 期间仍可恢复/终态化）。 */
export type ApplicationBackendWorkHandle = {
  workId: string;
  configVersion: number;
  markRunning: () => void;
  settle: (state: "succeeded" | "failed" | "cancelled") => void;
};

export type ApplicationBackendWorkAdmission =
  | { ok: true; workId: string; configVersion: number }
  | { ok: false; reason: "disabled" | "not-ready" | "version-mismatch" };

export type ApplicationBackendWorkFacade = {
  admit: () => ApplicationBackendWorkAdmission;
  resume: (workId: string) => ApplicationBackendWorkHandle | null;
  activeWorkCount: () => number;
};

/**
 * 插件收到的**可信 delegated principal 与能力范围**（design D3）。
 *
 * 这是宿主注入的不可伪造身份：下游服务据此检查插件身份与操作权限。插件不能改写它，
 * 也不获得原始服务令牌。
 */
export type ApplicationExtensionPrincipal = {
  /** 可信插件 identity（由宿主配置，不接受调用者自报）。 */
  extensionId: string;
  /** 不可变配置版本（工作准入时绑定）。 */
  configVersion: number;
  /** 委托主体（管理员/系统）；用于下游审计，不用于无限授权。 */
  delegatedActor?: string;
  /** 声明能力范围（例如 "tasks:submit"）；facade 在越权时拒绝。 */
  capabilities: readonly string[];
};

/** 插件任务关联 DTO：Task 侧持久化的恢复与查询依据（不含秘密与配置正文）。 */
export type ApplicationExtensionTaskAssociation = {
  extensionId: string;
  configVersion: number;
  /** 稳定幂等 key；同一逻辑工作重试复用。 */
  workerTaskKey: string;
};

/** 非画布插件任务提交结果（accepted 不等待 provider 终态）。 */
export type ApplicationExtensionTaskSubmitResult =
  | { ok: true; workerTaskKey: string; reused: boolean; state: string }
  | { ok: false; code: "unauthorized" | "unavailable" | "unsupported" | "key-reused" | "storage-failed"; message: string };

/** 插件可调用的 Task facade：只提交/查询/取消**自己拥有**的非画布任务。 */
export type ApplicationExtensionTaskFacade = {
  submit(input: {
    workerTaskKey: string;
    modelType: string;
    modelKey: string;
    prompt: string;
    parameters: Record<string, unknown>;
    inputs?: readonly { assetId: string; role: string; storageKey: string; mediaType: string; mediaKind?: string }[];
  }): Promise<ApplicationExtensionTaskSubmitResult>;
  result?(workerTaskKey: string): Promise<ApplicationExtensionTaskResult | null>;
  status(workerTaskKey: string): Promise<{ workerTaskKey: string; state: string } | null>;
  cancel(workerTaskKey: string): Promise<{ workerTaskKey: string; state: string } | null>;
};

/** 插件可调用的 Media facade：只构造稳定引用/上传结果，不接触 COS 凭据。 */
export type ApplicationExtensionMediaFacade = {
  resources?: ApplicationExtensionMediaResourcesFacade;
  stat(storageKey: string): Promise<{ exists: boolean; contentType?: string; size?: number }>;
  /**
   * 完整核验（change: 2026-10-12-add-extension-online-canvas-migration，任务 2.5）。
   *
   * 返回真实 size/checksum/contentType 或 `{ exists: false }`；只读，不接触 COS 凭据。
   * 可选：未实现的宿主下插件 MUST 按能力降级（不得用 stat 冒充已具备完整 metadata）。
   */
  verify?(storageKey: string, canvasId?: string): Promise<ApplicationExtensionMediaVerifyResult>;
};

/** 插件可调用的 Canvas facade：画布节点的 run/cancel 仍由 Canvas 生成权威 run identity。 */
export type ApplicationExtensionCanvasFacade = {
  requestNodeRun(input: {
    canvasId: string;
    nodeId: string;
    modelKey: string;
    prompt: string;
    parameters: Record<string, unknown>;
  }): Promise<{ ok: true; runId: string } | { ok: false; code: string; message: string }>;
  requestNodeCancel(input: { canvasId: string; nodeId: string; runId: string }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /**
   * 通知宿主重新解析画布同步上游凭据（`canvas-upstream:<id>` capability）。
   *
   * 能力交接面只提供 `resolve()`，宿主不会轮询扩展会话；因此扩展在**登录 / 登出 / 会话变化**
   * 后必须显式调用一次，否则宿主仍连着旧上游（或继续纯本地）。宿主侧解析幂等：同一份会话
   * 重复触发不会重建连接。
   *
   * 可选：未实现的宿主下扩展按能力降级（画布仍按静态配置或纯本地同步），不得把缺失当失败。
   */
  refreshSyncUpstream?(): Promise<void>;
  /**
   * 显式启动一次画布**媒体字节**补传（「同步远端」动作在文档链路建立后调用）。
   *
   * 与 `refreshSyncUpstream` 同一件事的两个面：那个把文档接到中继，这个把画布引用的存量资产
   * 对账到服务端托管存储。缺失时插件按能力降级（只同步文档），不得当作失败。
   */
  syncCanvasMedia?(canvasId: string): void;
};

/**
 * 项目读/写权限授权 facade（design D13；change: 2026-10-10-add-game-furnace-extension 任务 6.2）。
 *
 * 受控 DTO handler 不能只凭浏览器自报的 canvasId/nodeId 放行：宿主注入本 facade，插件用
 * **可信 principal.subject** 按画布读写权限判定。与 `extensionNodes` 不同，这里**不**读取/加载
 * 画布 room，只做权威授权判定，因此适用于不返回画布内容的项目元数据 handler。
 *
 * 未配置该能力的宿主下插件 MUST 按能力拒绝（fail closed），不得退回“知道 id 即可写”。
 */
export type ApplicationExtensionCanvasAccessFacade = {
  authorize(input: { subject: string; canvasId: string; permission: "read" | "write" }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
};

/** 公共 Context 暴露给插件的受限服务集合；核心 Context 不属于可关闭插件集合。 */
export type ApplicationExtensionServices = {
  extensionNodes?: ApplicationExtensionNodeFacade;
  tasks: ApplicationExtensionTaskFacade;
  media: ApplicationExtensionMediaFacade;
  canvas: ApplicationExtensionCanvasFacade;
  /**
   * 项目读/写权限授权（design D13；任务 6.2）。
   * 可选：未配置的宿主不提供，插件 MUST fail closed，不得仅凭 canvasId/nodeId 放行。
   */
  canvasAccess?: ApplicationExtensionCanvasAccessFacade;
  /**
   * 受用户委托约束的 authoring/工具/个人生成端口（design D7/D8）。
   * 可选：未配置的宿主不提供，插件须按能力声明回退。
   */
  authoring?: ApplicationAuthoringServices;
  /** 按 plugin/owner/purpose 隔离的加密秘密仓库（design D5）。 */
  secrets?: ApplicationExtensionSecretStore;
  /** 个人生成能力（账户模型目录/可执行性；design D8）。 */
  personalGeneration?: ApplicationPersonalGenerationFacade;
  /**
   * owner-scoped 隔离通用数据存储（change: 2026-10-13-...，任务 0.4）。owner 来自可信
   * registration（extensionId），不来自请求体；facade 拒绝跨 owner 访问。
   */
  documents?: import("./store.js").ExtensionDocumentStore;
  /**
   * 受限任务监控 facade（change: 2026-10-13-...，任务 0.6）：要求 `tasks.inspect` 并在
   * repository 查询前校验；只交给声明该 action 的 extension。
   */
  taskInspection?: import("./app-page.js").TaskInspectionFacade;
};

/**
 * 基础提供者注册面（change: 2026-10-13-...，任务 0.3/1.1）。
 *
 * 扩展通过它登记类型化 identity/site/resource/lifecycle provider；宿主在开放受保护入口前
 * 按可信 profile 校验「每个 slot 恰有一个 owner」。这不是无类型字符串 capability。
 */
export type ApplicationBackendProviderHost = {
  registerIdentityProvider(provider: import("./access.js").IdentityProvider): void;
  registerSiteAccessPolicy(policy: import("./access.js").SiteAccessPolicy): void;
  registerResourceAccessPolicy(policy: import("./access.js").ResourceAccessPolicy): void;
  registerResourceLifecyclePolicy(policy: import("./access.js").ResourceLifecyclePolicy): void;
  /** 可选：资源发现目录（Access）；缺失时不进入必需 profile，消费方 fail closed。 */
  registerResourceDirectory(directory: import("./access.js").ResourceDirectory): void;
};

/**
 * 本机宿主诊断日志的一条记录（已脱敏、有界）。
 *
 * 只由宿主写入：`category` 是模块标识，`event` 是稳定事件名，`message` 是短说明，
 * `attributes` 是有界的键值细节。不含令牌、请求体、响应正文、媒体字节或任意资源名。
 * 浏览器只读，不能伪造或清空。
 */
export type ApplicationBackendDiagnosticEntry = {
  /**
   * 条目自身的稳定标识（UUID v4），**记录那一刻生成、此后不再变**。
   *
   * 它是上报的幂等键：同一条目被重复上报（扩展重载、重试、并发点击、多批重发）时，
   * 服务端按「主体 + id」只落一条。`seq` 只是进程内的读取游标——它随进程重建归零，
   * 也不被服务端看见，因此不能拿它当去重依据。
   */
  id: string;
  /** 单调递增序号，供增量读取。 */
  seq: number;
  /** 采集时刻（epoch 毫秒）。 */
  time: number;
  level: "debug" | "info" | "warn" | "error";
  /** 模块标识（例如 `remote-server`、`canvas`）。 */
  category: string;
  /** 稳定事件名（例如 `remote-probe-ok`）。 */
  event: string;
  /** 稳定结果/错误码；没有时不出现。 */
  code?: string;
  /** 已脱敏的短说明（人类可读主文本，例如失败原因）；没有时不出现。 */
  message?: string;
  /**
   * 有界、已脱敏的键值细节（例如 `status=502`、`server=host:port`、`phase=probe`），用来补充
   * `message` 说不清的结构化事实；没有合法细节时不出现。
   *
   * 这**不是**任意载荷或原始日志行：键形状、值长度与条数都由宿主投影保证（键
   * `[a-z][a-z0-9._-]{0,31}`、值单行 ≤256 字符、≤16 对），令牌式片段已脱敏。管理端按这些
   * 键展示与搜索，因此键必须稳定；新增键等同扩展展示口径，不能由事件字段临时拼出。
   */
  attributes?: Record<string, string>;
};

/**
 * 宿主诊断缓冲的只读视图（交给可信后端扩展）。
 *
 * 与 `logger` 的分工：`logger` 是**写**出口，本接口是**读**出口。读取只返回已脱敏的投影，
 * 扩展拿不到原始日志行，也拿不到宿主内部状态。
 */
export type ApplicationBackendDiagnostics = {
  /**
   * 读取最近的诊断条目（按 `seq` 升序）。
   *
   * `since` 只返回序号大于它的条目；`limit` 截取最新的若干条（有上限，调用方不能要求全量）。
   */
  snapshot(input?: { since?: number; limit?: number }): ApplicationBackendDiagnosticEntry[];
};

/** 宿主注入给插件的运行时接口。 */
export type ApplicationBackendHost = {
  extensionId: string;
  /** 宿主 identity：站点插件生产宿主为 application。 */
  host: ApplicationExtensionHostIdentity;
  /**
   * 只读部署上下文（change: 2026-10-15-support-configurable-app-base-path，design D6）。
   * 插件据此把应用逻辑路径解析为公开 URL（如 game-furnace 入口/CSP 作用域），
   * 不在插件内自持可变的部署配置。
   */
  deployment?: { basePath: string };
  config: ApplicationBackendConfigFacade;
  /** 受控在途工作 facade（admission / 恢复）；停用后 admit 立即被拒绝。 */
  work: ApplicationBackendWorkFacade;
  /** 受限服务 facade（按声明能力裁剪）。 */
  services: ApplicationExtensionServices;
  /** 注册一个 typed capability；重复 id 抛错。 */
  registerCapability: (registration: ApplicationBackendCapabilityRegistration) => void;
  /** 注册一个受控 handler；重复 route 抛错。 */
  registerHandler: (registration: ApplicationBackendHandlerRegistration) => void;
  /** 注册一个受控 HTTP handler（server-only；design D4）；重复 (method, route) 抛错。 */
  registerHttpHandler?: (registration: ApplicationBackendHttpHandlerRegistration) => void;
  /** 注册一个受控**原始** HTTP handler（server-only；design D4）；重复 (method, route) 抛错。 */
  registerRawHttpHandler?: (registration: ApplicationBackendRawHttpHandlerRegistration) => void;
  /** 注册后台资源；activation 回滚时按反序 stop。 */
  registerResource: (resource: ApplicationBackendResource) => void;
  /**
   * 注册一个生成 Provider（change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 1.2）。
   * 只有后端生成能力宿主提供；重复 providerId 抛错。
   */
  registerGeneration?: (provider: import("../backend/generation.js").GenerationProvider) => void;
  /**
   * 注销一个生成 Provider（change: 2026-10-06-add-runninghub-api-models-and-provider-credentials，任务 2.4）。
   * 凭据变更后插件失效/重激活时用于释放旧注册。
   */
  unregisterGeneration?: (providerId: string) => void;
  /**
   * 注册一个存储后端（`ctx.storage` 的扩展点，与 `registerGeneration` 同形）。
   *
   * **只有宿主提供存储扩展点时才有**（本机宿主由 core 层的 `storagePlugin` 提供）；没有这条接缝时
   * 插件必须记日志跳过，不得把「宿主没这个能力」当成激活失败。
   *
   * 为什么要有这条接缝：存储后端是**运行期能力**——它带着会话、连接与在途请求，不是一条可以
   * 写进设置面的静态值。谁注册谁收回，才能保证停用/卸载扩展时 `ctx.storage` 里不残留一个指向
   * 已释放资源的后端（那种残留会让主存储路由到死实现，表现为莫名其妙的字节读写失败）。
   */
  registerStorage?: (backend: import("../backend/storage.js").StorageBackend) => void;
  /**
   * 注销一个存储后端（按 `backendId`）。
   *
   * 扩展卸载/停用必须注销（宿主也会替它按反序调用）。实现须**幂等**：重复注销同一 id 不算错误，
   * 因为「现在没有这个后端」正是调用方想要的终态。
   */
  unregisterStorage?: (backendId: string) => void;
  /**
   * 注册一个遥测出口（可选能力；change: 2026-10-20-add-local-client-telemetry，tasks 7.x）。
   *
   * 与 `registerStorage` 同形：谁注册谁收回，宿主按 owner 记 id 并在停用/回滚时反序注销。
   *
   * 为什么必须有这条接缝：「发到哪、用什么凭据」是出口自己的能力（部署地址、会话、令牌），
   * core 只回答"发不发"。core 若能自己枚举目的地，就等于要知道具体扩展身份，还会造出一个
   * "配了 id 却没人读"的死设置——所以出口只能由扩展在运行期注册进来。
   *
   * 缺失表示宿主没有遥测能力（纯本地宿主/旧版本）：扩展必须记日志跳过，
   * 不得把「宿主没这个能力」当成激活失败。
   */
  registerTelemetryExport?: (provider: import("../backend/telemetry.js").TelemetryExport) => void;
  /** 注销一个遥测出口（按 `exportId`；实现须幂等）。 */
  unregisterTelemetryExport?: (exportId: string) => void;
  /**
   * 基础提供者注册面（change: 2026-10-13-...，任务 0.3/1.1）。只有后端宿主提供；
   * 同一 slot 的重复 owner 在开放入口前拒绝。
   */
  providers?: ApplicationBackendProviderHost;
  /**
   * 只读诊断缓冲（可选）：宿主把已脱敏的服务端接入/同步事件投影给可信扩展。
   *
   * 缺失表示该宿主没有诊断能力（纯本地宿主/旧版本），扩展必须把调试窗口显示为
   * 「不可用」，而不是伪造一份空日志。
   */
  diagnostics?: ApplicationBackendDiagnostics;
  logger: (event: Record<string, unknown>) => void;
};

/**
 * 插件激活返回的可回收贡献。
 *
 * 首版不强制插件使用 Cordis；`dispose` 让宿主统一按 owner 反序释放；资源也可通过
 * `host.registerResource` 登记（二者都会被幂等释放）。
 */
export type ApplicationBackendActivation = {
  dispose?: () => Promise<void> | void;
};

/**
 * 后端插件自报的健康状态：**已装载**但能力没就绪。
 *
 * activation 成功只说明插件进程内装载完成（fiber 起来了、贡献注册了），不代表它的能力当下可用：
 * 生成 Provider 缺凭据时仍要注册（否则管理面看不到它、也无法预填配置），但模型进不了 catalog。
 * 这种「装着但用不了」的稳态用 `degraded` 表达，避免把它混成 activation 失败，也避免伪称「运行中」。
 *
 * 健康状态必须**按需重读**（`health()`）而不是 activation 时快照：管理员补上凭据后，插件本身不用
 * 重启，状态应随之回到 `active`。
 */
export type ApplicationBackendExtensionHealth = {
  state: "degraded";
  /** 公开安全诊断（不得包含秘密）。degraded 时不得为空。 */
  diagnostics: readonly import("./state.js").ApplicationExtensionSafeDiagnostic[];
};

/** 扩展自有 MCP 工具声明；宿主负责认证、schema 与 handler 分派。 */
export type ApplicationExtensionMcpTool = {
  name: string;
  description: string;
  route: string;
  permission: "read" | "write";
  newWork?: boolean;
  parameters?: Record<string, { type: "string" | "strings" | "object"; optional?: boolean; maxLength?: number; description?: string }>;
};

/** 仅操作通用 extension3d 节点，使用 Canvas 现有授权、CAS 与命令提交。 */
export type ApplicationExtensionNodeFacade = {
  read(input: { subject: string; canvasId: string; permission: "read" | "write" }): Promise<import("../canvas/domain/types.js").ServerCanvas>;
  commit(input: { subject: string; canvasId: string; nodeId: string; requestId: string; expectedRevision: number;
    value: Record<string, unknown>; create?: { position: { x: number; y: number } } }): Promise<{ revision: number }>;
};

/** 后端插件定义（构建时静态登记；宿主 activation 前解析依赖）。 */
export type ApplicationBackendExtensionDefinition = {
  extensionId: string;
  mcpTools?: readonly ApplicationExtensionMcpTool[];
  /** 必需依赖的 capability/service id；缺失时不得产生部分可用贡献。 */
  requiredDependencies?: readonly string[];
  /** 可选依赖：缺失不阻塞 activation。 */
  optionalDependencies?: readonly string[];
  /** 声明的贡献摘要（诊断/状态展示用）。 */
  capabilities?: readonly ApplicationExtensionCapabilitySummary[];
  /**
   * 当前健康状态：`undefined` 表示健康（状态投影为 `active`）。
   *
   * 只在插件已装载时返回 degraded；未装载（配置中/已停用）由状态投影自己判断，本钩子不参与。
   * 宿主必须容忍它抛错（按健康处理并记日志），因为它会被状态查询同步调用。
   */
  health?: () => ApplicationBackendExtensionHealth | undefined;
  activate: (
    host: ApplicationBackendHost
  ) => ApplicationBackendActivation | void | Promise<ApplicationBackendActivation | void>;
};
