/**
 * Extension Host 子进程协议（change: 2026-10-21-isolate-extension-host-process，design D3/D4/D6）。
 *
 * 宿主与每个受管扩展的子进程之间用 JSON-RPC 2.0 over Node IPC（`serialization: "advanced"`，
 * `Uint8Array` 直接过 IPC）。这里只有**纯类型与常量**：帧形状、方法名、错误码与限额，宿主与子进程
 * 共用同一份定义，避免两侧各写一套字符串。
 *
 * 幂等：RPC 层**不自动重试**任何请求；只有 `EXTENSION_HOST_IDEMPOTENT_METHODS` 里的方法允许上层重试。
 */

/** 协议版本：子进程第一帧 `$/hello` 携带；宿主不认识的版本直接终止子进程。 */
export const EXTENSION_HOST_PROTOCOL_VERSION = 1;

/** JSON-RPC 请求帧（带 id）或通知帧（不带 id）。 */
export type ExtensionHostRequestFrame = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
};

export type ExtensionHostNotificationFrame = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

export type ExtensionHostRpcError = {
  code: ExtensionHostErrorCode | string;
  message: string;
  data?: unknown;
};

export type ExtensionHostResponseFrame =
  | { jsonrpc: "2.0"; id: number; result: unknown }
  | { jsonrpc: "2.0"; id: number; error: ExtensionHostRpcError };

export type ExtensionHostFrame = ExtensionHostRequestFrame | ExtensionHostNotificationFrame | ExtensionHostResponseFrame;

/** 方法名常量（宿主 ⇄ 子进程共用）。 */
export const EXTENSION_HOST_METHODS = {
  // 控制
  hello: "$/hello",
  ping: "$/ping",
  cancel: "$/cancel",
  // 流帧（D3）
  streamOpen: "stream.open",
  streamChunk: "stream.chunk",
  streamEnd: "stream.end",
  streamAbort: "stream.abort",
  streamCredit: "stream.credit",
  // 子进程 → 宿主：ctx 代理
  ctxLog: "ctx.log",
  ctxHealth: "ctx.health",
  ctxDiagnostic: "ctx.diagnostic",
  ctxReady: "ctx.ready",
  ctxGenerationRegister: "ctx.generation.register",
  ctxGenerationUnregister: "ctx.generation.unregister",
  ctxGatewayRoute: "ctx.gateway.route",
  ctxGatewayUnroute: "ctx.gateway.unroute",
  /** 子进程处理 gateway 请求时，按该请求的真实 principal 让宿主执行具名 action 授权。 */
  ctxAccessAssert: "ctx.access.assertAction",
  // 子进程 → 宿主：存储（按 storageNamespaces）
  storageHead: "storage.head",
  storageGet: "storage.get",
  storagePut: "storage.put",
  storageDelete: "storage.delete",
  storagePresign: "storage.presign",
  storageExpose: "storage.expose",
  // 宿主 → 子进程：Provider 桩
  providerDescribe: "provider.describe",
  providerDescribeModel: "provider.describeModel",
  providerPrepareInput: "provider.prepareInput",
  providerResolveModel: "provider.resolveProviderModel",
  providerUploadReference: "provider.uploadReference",
  providerModelCall: "provider.model.call",
  providerJobsCall: "provider.jobs.call",
  providerUpload: "provider.upload",
  // 宿主 → 子进程：gateway 转发
  gatewayRequest: "gateway.request",
  // 宿主 → 子进程：生命周期
  hostStop: "host.stop"
} as const;

export type ExtensionHostMethod = (typeof EXTENSION_HOST_METHODS)[keyof typeof EXTENSION_HOST_METHODS];

/** 允许上层重试的幂等方法（D3）；其余方法超时或崩溃一律以错误收尾。 */
export const EXTENSION_HOST_IDEMPOTENT_METHODS: readonly string[] = [
  EXTENSION_HOST_METHODS.providerDescribe,
  EXTENSION_HOST_METHODS.providerDescribeModel,
  EXTENSION_HOST_METHODS.ping
];

/** 稳定错误码。 */
export const EXTENSION_HOST_ERROR_CODES = [
  "permission-denied",
  "rpc-timeout",
  "rpc-busy",
  "rpc-cancelled",
  "rpc-protocol-error",
  "frame-too-large",
  "method-not-found",
  "extension-crashed",
  "extension-replaced",
  "extension-unavailable",
  "extension-host-limit",
  "extension-host-unsupported",
  "EXTENSION_NETWORK_DENIED"
] as const;

export type ExtensionHostErrorCode = (typeof EXTENSION_HOST_ERROR_CODES)[number];

export function isExtensionHostErrorCode(value: unknown): value is ExtensionHostErrorCode {
  return typeof value === "string" && (EXTENSION_HOST_ERROR_CODES as readonly string[]).includes(value);
}

/** 限额常量（D3/D8）。 */
export const EXTENSION_HOST_LIMITS = {
  /** 单帧序列化后估算上限。 */
  maxFrameBytes: 1024 * 1024,
  /** 流帧单块上限。 */
  maxChunkBytes: 256 * 1024,
  /** 流初始信用（块数）。 */
  initialStreamCredit: 8,
  /** 单次请求缺省超时。 */
  requestTimeoutMs: 30_000,
  /** 生成执行类调用超时上限。 */
  maxExecutionTimeoutMs: 15 * 60_000,
  /** 每方向在途请求上限。 */
  maxInFlight: 256,
  /** 宿主心跳间隔与判死时限。 */
  heartbeatIntervalMs: 5_000,
  heartbeatTimeoutMs: 15_000,
  /** 子进程健康主动上报间隔。 */
  healthReportIntervalMs: 10_000,
  /** stdout/stderr 单行截断与每秒行数。 */
  logLineMaxBytes: 4 * 1024,
  logLinesPerSecond: 50
} as const;

/** `$/hello`：子进程 → 宿主的第一帧。 */
export type ExtensionHostHello = {
  protocol: number;
  sdkAbi: number;
  pid: number;
};

/** 宿主授予子进程的能力清单（按 permissions 裁剪，D4）。 */
export type ExtensionHostCapabilities = {
  extensionId: string;
  /** 允许登记的路由前缀（含 `/api/extensions/<id>/` 与 modelRefresh.path，publicRoutes 时追加声明路径）。 */
  routePrefixes: readonly string[];
  /** 允许访问的存储命名空间；空表示 `ctx.storage` 不存在。 */
  storageNamespaces: readonly string[];
  /** 出网白名单（`permissions.network`）。 */
  network: readonly string[];
};

/** 宿主 → 子进程的启动参数（`$/hello` 的响应）。 */
export type ExtensionHostStartParams = {
  instanceId: string;
  entry: string;
  factory: string;
  kind: "provider";
  values: Record<string, unknown>;
  capabilities: ExtensionHostCapabilities;
};

/** 子进程登记 Provider 的可序列化部分（函数成员由宿主远程桩实现，D6）。 */
export type ExtensionHostProviderRegistration = {
  providerId: string;
  available: boolean;
  models: readonly unknown[];
  selectionAuthority?: "local" | "server";
  catalogRevision?: number;
  /** 子进程实际实现了哪些可选函数成员；宿主只为存在的成员装桩。 */
  members: readonly ("describe" | "describeModel" | "prepareInput" | "uploadReference" | "resolveProviderModel")[];
  /**
   * 每个模型实现对象上实际存在的方法（键 `${modelType}:${providerModelId}`）。pptask job 引擎按模型对象上
   * 有没有 doStart / doStatus 决定走 operation 还是 doGenerate，宿主的模型工厂是同步的，只能用这份快照。
   * 不在表里的模型宿主按 `["doGenerate"]` 处理。
   */
  modelInfo?: Readonly<Record<string, ExtensionHostModelInfo>>;
};

export const EXTENSION_HOST_MODEL_METHODS = ["doGenerate", "doStream", "doStart", "doStatus", "doCancel", "doDescribe"] as const;
export type ExtensionHostModelMethod = (typeof EXTENSION_HOST_MODEL_METHODS)[number];
export type ExtensionHostModelInfo = {
  methods: readonly ExtensionHostModelMethod[];
  maxImagesPerCall?: number;
};

/** 子进程登记的路由。 */
export type ExtensionHostRouteRegistration = {
  routeId: string;
  prefix: string;
  methods?: readonly string[];
};

/** 健康快照（与 `ApplicationBackendExtensionHealth` 同形，`null` 表示健康）。 */
export type ExtensionHostHealthSnapshot = {
  state: "degraded";
  diagnostics: readonly { code: string; message: string }[];
} | null;

/** 流帧参数。 */
export type ExtensionHostStreamOpen = { streamId: string; kind: string; meta?: unknown };
export type ExtensionHostStreamChunk = { streamId: string; seq: number; bytes: Uint8Array };
export type ExtensionHostStreamEnd = { streamId: string };
export type ExtensionHostStreamAbort = { streamId: string; reason: string };
export type ExtensionHostStreamCredit = { streamId: string; n: number };

/** 设置面：受管扩展的隔离方式。 */
export type ExtensionIsolation = "process" | "in-process";

/**
 * Extension Host 本机设置（D1/D8/D10）。定义在这里由 `settings/index.ts` 的 `SETTING_DEFINITIONS` 展开，
 * 使 settings 文件保持在源码规模门禁内。
 */
export const EXTENSION_HOST_SETTING_DEFINITIONS = {
  "extensions.host.isolation": {
    kind: "boolean",
    default: true,
    reload: "restart",
    label: "受管扩展进程隔离",
    description: "受管扩展的后端在独立子进程中运行；关闭后退回同进程装配（仅用于降级排障，设置面标注「未隔离」）"
  },
  "extensions.host.maxOldSpaceMb": {
    kind: "integer",
    default: 256,
    min: 64,
    max: 2048,
    reload: "hot",
    label: "扩展子进程堆上限（MiB）",
    description: "每个扩展子进程的 V8 堆上限；下次启动子进程时生效"
  },
  "extensions.host.maxProcesses": {
    kind: "integer",
    default: 16,
    min: 1,
    max: 64,
    reload: "hot",
    label: "扩展子进程数上限",
    description: "同时存活的扩展子进程数；超限的扩展激活失败（extension-host-limit），不影响已运行的"
  },
  "extensions.host.drainTimeoutMs": {
    kind: "integer",
    default: 600000,
    min: 1000,
    max: 3600000,
    reload: "hot",
    label: "蓝绿切换排空时限（毫秒）",
    description: "升级时旧实例等待在途调用完成的最长时间；超时的调用以 extension-replaced 失败"
  }
} as const satisfies Record<string, import("../settings/index.js").SettingDefinition>;
