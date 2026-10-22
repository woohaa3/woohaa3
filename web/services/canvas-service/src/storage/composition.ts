/**
 * 画布存储 composition root（任务 4.1 / 4.8 / 4.10 / design D13、D14）。
 *
 * 按 `WOOHAA3_CANVAS_STORAGE_BACKEND` 动态加载**唯一**一个数据库 adapter，并注入基线
 * COS `MediaStorage`。配置缺失/未知 backend 直接失败，**不存在任何回退**（不回落内存、
 * 本地文件、GridFS 或另一 backend）。
 *
 * 服务端专用：`node:sqlite` / `mongodb` / COS SDK 只允许出现在这条 composition 路径
 * 与其 adapter 包里，绝不进入浏览器 bundle（见 tasks 10.1）。
 */
import type { MediaStorage } from "@woohaa3/contracts";
import { CanvasApplicationService, CanvasCatalogService, type CanvasRepository, type CanvasStorageLimits } from "./core/index.js";
import { createCanvasRequestHandler,
  type CanvasReadiness,
  type CanvasRequestHandler,
  type CanvasRequestHandlerOptions } from "../api/canvas-api.js";

export const CANVAS_STORAGE_BACKEND_ENV = "WOOHAA3_CANVAS_STORAGE_BACKEND";
export const CANVAS_STORAGE_SQLITE_PATH_ENV = "WOOHAA3_CANVAS_STORAGE_SQLITE_PATH";
export const CANVAS_STORAGE_MAX_JSON_BYTES_ENV = "WOOHAA3_CANVAS_STORAGE_MAX_JSON_BYTES";
export const CANVAS_STORAGE_MAX_COMMANDS_ENV = "WOOHAA3_CANVAS_STORAGE_MAX_COMMANDS";
export const CANVAS_STORAGE_SERVICE_TOKEN_ENV = "WOOHAA3_CANVAS_STORAGE_SERVICE_TOKEN";
export const CANVAS_STORAGE_LISTEN_HOST_ENV = "WOOHAA3_CANVAS_STORAGE_LISTEN_HOST";
export const MONGODB_URI_ENV = "MONGODB_URI";
export const MONGODB_DB_ENV = "MONGODB_DB";

export type CanvasStorageBackend = "sqlite" | "mongo";

export type Env = Record<string, string | undefined>;

export type CanvasStorageConfig = {
  backend: CanvasStorageBackend;
  sqlitePath?: string;
  mongoUri?: string;
  mongoDb?: string;
  limits: Partial<CanvasStorageLimits>;
  serviceToken?: string;
  /** 非 loopback 监听时要求的受信任代理令牌。 */
  listenHost?: string;
};

/**
 * 安全诊断信息（任务 7.3 / 7.4）：只含可安全打印/落日志的字段。
 *
 * 绝不包含数据库 URI、绝对路径（只给文件名/是否配置）、COS 凭据或签名 URL。
 */
export type CanvasStorageDiagnostics = {
  backend: CanvasStorageBackend;
  /** `sqlite` 用文件名（不含目录）；`mongo` 只给是否配置，不含 URI。 */
  database: string;
  limits: {
    maxCommands: number;
    maxJsonBytes: number;
  };
  mediaConfigured: boolean;
  serviceTokenConfigured: boolean;
  listenHost: string;
  adapterSchemaVersion: number;
};

/** 从配置派生安全诊断。 */
export function describeCanvasStorageConfig(
  config: CanvasStorageConfig,
  options: { mediaConfigured: boolean; adapterSchemaVersion: number }
): CanvasStorageDiagnostics {
  return {
    backend: config.backend,
    database: config.backend === "sqlite"
      ? basename(config.sqlitePath ?? "")
      : config.mongoDb ?? "<mongo>",
    limits: {
      maxCommands: config.limits.maxCommands ?? DEFAULT_LIMITS_PLACEHOLDER.maxCommands,
      maxJsonBytes: config.limits.maxCanvasJsonBytes ?? DEFAULT_LIMITS_PLACEHOLDER.maxCanvasJsonBytes
    },
    mediaConfigured: options.mediaConfigured,
    serviceTokenConfigured: Boolean(config.serviceToken),
    listenHost: config.listenHost ?? "127.0.0.1",
    adapterSchemaVersion: options.adapterSchemaVersion
  };
}

/**
 * 非敏感容量指标（任务 7.4）。
 *
 * 只包含**数量与聚合**（画布数、总字节、最大/平均字节、资产引用数），不含画布内容、
 * 标题、storageKey 或任何路径/凭据。运维据此观察增长趋势而不泄漏数据。
 */
export type CanvasStorageMetrics = {
  canvasCount: number;
  /** 全部画布规范 JSON 的近似总字节。 */
  totalJsonBytes: number;
  maxCanvasJsonBytes: number;
  averageCanvasJsonBytes: number;
  assetReferenceCount: number;
  databaseReady: boolean;
  mediaReady: boolean;
  capturedAt: string;
};

/** 采集容量指标。分页遍历，避免一次性载入过多画布。 */
export async function collectCanvasStorageMetrics(
  repository: CanvasRepository,
  options: { mediaReady: boolean; now?: () => string }
): Promise<CanvasStorageMetrics> {
  const now = options.now ?? (() => new Date().toISOString());
  let offset = 0;
  let canvasCount = 0;
  let totalJsonBytes = 0;
  let maxCanvasJsonBytes = 0;
  let assetReferenceCount = 0;

  for (;;) {
    const page = await repository.listCanvases({ offset, limit: 100 });
    canvasCount += page.items.length;
    for (const item of page.items) {
      const canvas = await repository.getCanvas(item.id);
      if (!canvas) continue;
      const bytes = Buffer.byteLength(JSON.stringify(canvas));
      totalJsonBytes += bytes;
      if (bytes > maxCanvasJsonBytes) maxCanvasJsonBytes = bytes;
      assetReferenceCount += canvas.assets.length;
    }
    if (page.items.length === 0 || offset + page.items.length >= page.total) break;
    offset += page.items.length;
  }

  const database = await repository.health();
  return {
    canvasCount,
    totalJsonBytes,
    maxCanvasJsonBytes,
    averageCanvasJsonBytes: canvasCount === 0 ? 0 : Math.round(totalJsonBytes / canvasCount),
    assetReferenceCount,
    databaseReady: database.ok,
    mediaReady: options.mediaReady,
    capturedAt: now()
  };
}

/** 与 `DEFAULT_CANVAS_STORAGE_LIMITS` 保持一致；这里复制常量避免循环依赖。 */
const DEFAULT_LIMITS_PLACEHOLDER = { maxCommands: 512, maxCanvasJsonBytes: 8 * 1024 * 1024 };

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || "<sqlite>";
}

export type CanvasStorageConfigResult =
  | { ok: true; config: CanvasStorageConfig }
  | { ok: false; reason: string };

/**
 * 解析并校验配置；任何缺失/非法都返回失败（不静默回退）。
 *
 * `options.backend`（change: 2026-10-15-scan-bootstrap-slots-as-extension-directories，任务 4.2）
 * 供「已启用哪个存储扩展」这一事实作为缺省：`WOOHAA3_CANVAS_STORAGE_BACKEND` 从「必须显式选择」
 * 降级为**一致性校验键**。独立画布服务仍按原样调用（不传该参数 → 仍要求显式选择）。
 *
 * `options.mongo` 是 mongo 连接信息的**唯一**入口（存储槽位读扩展目录的 config.local.json 后传入）；
 * 不传时仍回落到环境变量，保持独立入口既有行为。
 */
export function resolveCanvasStorageConfig(
  env: Env,
  options: { backend?: "sqlite" | "mongo"; mongo?: { uri: string; database: string } } = {}
): CanvasStorageConfigResult {
  const raw = readString(env[CANVAS_STORAGE_BACKEND_ENV]) ?? options.backend;
  if (!raw) {
    return { ok: false, reason: `缺少 ${CANVAS_STORAGE_BACKEND_ENV}（必须显式选择 sqlite 或 mongo）` };
  }
  if (raw !== "sqlite" && raw !== "mongo") {
    return { ok: false, reason: `未知 backend：${raw}（只支持 sqlite | mongo）` };
  }

  const limits: Partial<CanvasStorageLimits> = {};
  const maxJson = readPositiveInt(env[CANVAS_STORAGE_MAX_JSON_BYTES_ENV]);
  if (env[CANVAS_STORAGE_MAX_JSON_BYTES_ENV] !== undefined && maxJson === undefined) {
    return { ok: false, reason: `${CANVAS_STORAGE_MAX_JSON_BYTES_ENV} 必须为正整数` };
  }
  if (maxJson !== undefined) limits.maxCanvasJsonBytes = maxJson;
  const maxCommands = readPositiveInt(env[CANVAS_STORAGE_MAX_COMMANDS_ENV]);
  if (env[CANVAS_STORAGE_MAX_COMMANDS_ENV] !== undefined && maxCommands === undefined) {
    return { ok: false, reason: `${CANVAS_STORAGE_MAX_COMMANDS_ENV} 必须为正整数` };
  }
  if (maxCommands !== undefined) limits.maxCommands = maxCommands;

  const serviceToken = readString(env[CANVAS_STORAGE_SERVICE_TOKEN_ENV]);
  const listenHost = readString(env[CANVAS_STORAGE_LISTEN_HOST_ENV]);

  // 访问边界（design D14）：监听非 loopback 时必须配置服务令牌，否则拒绝启动。
  if (listenHost && !isLoopbackHost(listenHost) && !serviceToken) {
    return {
      ok: false,
      reason: `监听地址 ${listenHost} 不是 loopback，必须配置 ${CANVAS_STORAGE_SERVICE_TOKEN_ENV}`
    };
  }

  if (raw === "sqlite") {
    const sqlitePath = readString(env[CANVAS_STORAGE_SQLITE_PATH_ENV]);
    if (!sqlitePath) {
      return { ok: false, reason: `backend=sqlite 需要 ${CANVAS_STORAGE_SQLITE_PATH_ENV}` };
    }
    return { ok: true, config: { backend: "sqlite", sqlitePath, limits, serviceToken, listenHost } };
  }

  // mongo 连接信息优先取存储槽位传入的部署配置（扩展目录的 config.local.json）；未提供时
  // 回落到环境变量，保持独立画布服务入口的既有行为。
  const mongoUri = options.mongo?.uri ?? readString(env[MONGODB_URI_ENV]);
  const mongoDb = options.mongo?.database ?? readString(env[MONGODB_DB_ENV]);
  if (!mongoUri) return { ok: false, reason: `backend=mongo 需要 ${MONGODB_URI_ENV}` };
  if (!mongoDb) return { ok: false, reason: `backend=mongo 需要 ${MONGODB_DB_ENV}` };
  return { ok: true, config: { backend: "mongo", mongoUri, mongoDb, limits, serviceToken, listenHost } };
}

export type CanvasStorageComposition = {
  repository: CanvasRepository;
  service: CanvasApplicationService;
  /**
   * 目录组合（change: 2026-09-29-add-multi-canvas-workspace）。standalone 组合未注入 Yjs
   * published reader 时为 null，HTTP 层回退结构化列表。
   */
  catalog: CanvasCatalogService | null;
  handler: CanvasRequestHandler;
  /** 媒体子系统 readiness（COS read/write probe）。 */
  mediaReadiness: () => Promise<CanvasReadiness>;
  /** 安全诊断（task 7.4）：backend、非敏感数据库标识、限制、COS ready。 */
  diagnostics: CanvasStorageDiagnostics;
  /** 非敏感容量指标（任务 7.4）；需要时按需采集，不常驻。 */
  metrics: () => Promise<CanvasStorageMetrics>;
  close: () => Promise<void>;
};

export type ComposeCanvasStorageOptions = {
  env: Env;
  /**
   * 已解析的存储配置（bootstrap `storage` 槽位注入）。提供时不再从 `env` 解析：部署侧凭据
   * 可以只放在扩展目录的配置文件里；核心服务不再要求同名环境变量。
   */
  storageConfig?: CanvasStorageConfig;
  /** 基线 COS MediaStorage（必须可用才进入 ready）。 */
  mediaStorage?: MediaStorage;
  /** 媒体探针；默认用 MediaStorage put/get/exists。 */
  mediaProbe?: () => Promise<CanvasReadiness>;
  logger?: (event: { event: string; status: number; code?: string; actorId?: string }) => void;
  /** 测试注入：跳过动态 import 直接给出仓库。 */
  repository?: CanvasRepository;
  /**
   * published projection 只读 reader（change: 2026-09-29-add-multi-canvas-workspace）。
   *
   * 提供时组合出 `CanvasCatalogService` 并交给 HTTP list 路由；省略时 catalog 为 null，
   * list 回退结构化摘要（standalone storage 无 Yjs 依赖的兼容路径）。
   */
  publishedReader?: import("./core/index.js").CanvasPublishedReader;
  /**
   * 追加的远端目录来源（provider 式；省略 = 纯本地）。
   *
   * 传函数时**每次列举**重新求值：扩展后启用、登录后才接上远端的部署必须用这条，
   * 否则实例构造那一刻没有 provider，目录就会永远停在纯本地。
   */
  catalogSources?:
    | readonly import("./core/index.js").CanvasCatalogRemoteSource[]
    | (() => readonly import("./core/index.js").CanvasCatalogRemoteSource[]);
  /** 本机视角的同步状态（由上游链路提供；省略表示没接远端）。 */
  catalogSyncState?: (canvasId: string) => import("@woohaa3/contracts").CanvasSyncState | undefined;
  /**
   * 这张画布是否**属于远端**（持久归属记录，与此刻连没连上无关）。
   *
   * 权限判定用它区分两种"远端查不到"：属于远端却被拒绝 = 当前账号没有访问权限（只读提示）；
   * 纯本地画布 = 本来就不该问远端（按可写处理）。
   */
  catalogRemoteOwned?: (canvasId: string) => boolean;
  generateCanvasId?: () => string;
  handlers?: Partial<Omit<CanvasRequestHandlerOptions, "service" | "readiness">>;
};

/**
 * 构造画布存储组合。调用方负责在进程退出时 `close()`。
 *
 * SQLite adapter 通过动态 import 加载，保证 Mongo-only 部署不会因为静态 import 而
 * 拉进 `node:sqlite`，反之亦然。
 */
export async function composeCanvasStorage(
  options: ComposeCanvasStorageOptions
): Promise<CanvasStorageComposition> {
  const resolved: CanvasStorageConfigResult = options.storageConfig
    ? { ok: true, config: options.storageConfig }
    : resolveCanvasStorageConfig(options.env);
  if (!resolved.ok) {
    throw new Error(`画布存储配置无效：${resolved.reason}`);
  }
  const config = resolved.config;

  // COS 是硬依赖：缺少媒体存储时画布写接口不得可用（spec「COS 配置缺失」）。
  if (!options.mediaStorage && !options.mediaProbe) {
    throw new Error("画布存储需要配置媒体存储（COS）；不接受本地或数据库二进制回退");
  }

  const repository = options.repository ?? await createRepository(config);

  const service = new CanvasApplicationService({
    repository,
    mediaStorage: options.mediaStorage,
    limits: config.limits,
    generateCanvasId: options.generateCanvasId
  });

  const mediaReadiness = options.mediaProbe
    ?? (options.mediaStorage ? () => probeMedia(options.mediaStorage as MediaStorage) : async () => ({ ready: false, reason: "媒体存储未配置" }));

  // 目录组合：结构化分页 + published projection 覆盖（无 reader 时回退结构化）。
  //
  // 来源**原样**转交（数组或函数），不在这里求值/过滤：构造发生在扩展装载之前，
  // 此刻求值等于把"还没接上远端"永久写进实例（见 catalogSources 的说明）。
  const catalog = options.publishedReader
    ? new CanvasCatalogService({
        repository,
        published: options.publishedReader,
        ...(options.catalogSources ? { remoteSources: options.catalogSources } : {}),
        ...(options.catalogSyncState ? { syncStateOf: options.catalogSyncState } : {}),
        ...(options.catalogRemoteOwned ? { isRemoteOwned: options.catalogRemoteOwned } : {})
      })
    : null;

  const handler = createCanvasRequestHandler({
    service,
    ...(catalog ? { catalog } : {}),
    serviceToken: config.serviceToken,
    logger: options.logger,
    ...options.handlers,
    // 数据库 readiness 与媒体 readiness 都必须通过（spec「Liveness 与 readiness 分离」）。
    readiness: async () => {
      const database = await service.health();
      if (!database.ok) return { ready: false, reason: `数据库不可用（${database.backend}）` };
      return mediaReadiness();
    }
  });

  return {
    repository,
    service,
    catalog,
    handler,
    mediaReadiness,
    diagnostics: describeCanvasStorageConfig(config, {
      mediaConfigured: Boolean(options.mediaStorage),
      adapterSchemaVersion: config.backend === "sqlite" ? SQLITE_ADAPTER_SCHEMA_VERSION : MONGO_ADAPTER_SCHEMA_VERSION
    }),
    metrics: async () => collectCanvasStorageMetrics(repository, {
      mediaReady: (await mediaReadiness()).ready
    }),
    close: async () => {
      const closeable = repository as { close?: () => void | Promise<void> };
      await closeable.close?.();
    }
  };
}

/**
 * 各 adapter 的 schema 版本镜像，用于**不含绝对路径**的诊断输出。
 * 与 adapter 常量保持一致（adapter 自身是 server-only 动态依赖，这里不能同步 import）。
 */
const SQLITE_ADAPTER_SCHEMA_VERSION = 1;
const MONGO_ADAPTER_SCHEMA_VERSION = 1;

async function createRepository(config: CanvasStorageConfig): Promise<CanvasRepository> {
  if (config.backend === "sqlite") {
    const { SqliteCanvasRepository } = await import("./sqlite/index.js");
    return new SqliteCanvasRepository({ path: config.sqlitePath as string });
  }
  const { MongoCanvasRepository } = await import("./mongo/index.js");
  const repository = await MongoCanvasRepository.connect({
    uri: config.mongoUri as string,
    database: config.mongoDb as string
  });
  return repository;
}

/**
 * COS read/write probe。
 *
 * 用**固定** key（每个部署一个）而不是时间戳 key：`MediaStorage` 没有 delete 契约，
 * 时间戳 key 会让探测对象**无界累积**。固定 key 每次覆盖写，既验证写路径又不残留垃圾。
 * 探测只关心「能否写且能读回」，不关心内容是否为新。
 */
export async function probeMedia(storage: MediaStorage): Promise<CanvasReadiness> {
  const key = "health-probe";
  const bytes = new Uint8Array([0]);
  try {
    await storage.put(key, bytes, "application/octet-stream");
    const exists = await storage.exists(key);
    if (!exists) return { ready: false, reason: "媒体存储探测对象不可读" };
    if (typeof storage.stat === "function") {
      const stat = await storage.stat(key);
      if (stat.size !== bytes.byteLength) {
        return { ready: false, reason: "媒体存储探测对象 metadata 不一致" };
      }
    }
    return { ready: true };
  } catch {
    return { ready: false, reason: "媒体存储读写探测失败" };
  }
}
function readString(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
