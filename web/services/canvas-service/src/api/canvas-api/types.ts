/**
 * Canvas API：类型与常量
 * （自 `canvas-api.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R23）。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { MediaStorage } from "@woohaa3/contracts";
import type { CanvasApplicationService, CanvasArchiveService, CanvasCatalogService } from "../../storage/core/index.js";

export const DEFAULT_CANVAS_API_BASE_PATH = "/api/canvases";
export const DEFAULT_CANVAS_HEALTH_BASE_PATH = "/api/canvas-storage/health";

/** 请求体上限（JSON body 字节）。命令批次另有 `maxCommands` 限制。 */
export const DEFAULT_CANVAS_MAX_BODY_BYTES = 12 * 1024 * 1024;

export type CanvasRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

/** 片场导入端口（由 FilmSetImportService 实现）。 */
export type CanvasFilmSetImportPort = {
  import(request: {
    canvasId: string;
    nodeId: string;
    requestId: string;
    items: readonly import("@woohaa3/contracts").McpFilmSetImportItem[];
  }): Promise<
    | { ok: true; nodeId: string; commandId: string; duplicate: boolean; noop: boolean; itemCount: number }
    | { ok: false; code: string; message: string }
  >;
};

/**
 * 单节点快捷「转为片场」端口
 * （change: 2026-10-13-add-node-to-film-set-shortcut）。
 *
 * 由 film-set 扩展的 `FilmSetConversionService` 实现；HTTP 边界只做可信主体/画布写权限门禁后转发。
 */
export type CanvasFilmSetConversionPort = import("@woohaa3/contracts").FilmSetConversionServicePort;

/**
 * 原生录制端口（change: 2026-10-17-add-native-offscreen-film-set-recording，任务 7.1）。
 *
 * 未注入时相关路由返回 503 `recording-unavailable`，前端据此显示具体原因，
 * 不静默回退到浏览器录制。
 */
export type CanvasRecordingPort = import("./recording-port.js").CanvasRecordingPort;

/** run/cancel 应用服务的最小接口（由 CanvasRunService 实现；测试可注入假实现）。 */
export type CanvasRunPort = {
  run(request: {
    canvasId: string;
    nodeId: string;
    runId: string;
    jobId: string;
    modelKey: string;
    prompt: string;
    parameters: Record<string, unknown>;
  }, context?: { owner: string }): Promise<{ ok: true; runId: string; jobId: string; workerTaskKey?: string; state: "accepted" } | { ok: false; code: string; message: string }>;
  cancel(request: { canvasId: string; nodeId: string; runId: string }): Promise<
    { ok: true; state: "cancel-requested" } | { ok: false; code: string; message: string }
  >;
};

export type CanvasReadiness = {
  ready: boolean;
  reason?: string;
};

/**
 * 在线迁移访问门（change: 2026-10-12-add-extension-online-canvas-migration，任务 4.9、5.3）。
 *
 * 由 Canvas composition 注入（来自 `CanvasImportService`）：
 * - 未准备/未导入返回 `none`（沿用既有路径）；
 * - 正在准备返回 `preparing`（普通 GET 返回 `PREPARATION_REQUIRED`，不越过 CanvasRoom）；
 * - 已删除 tombstone 返回 `deleted`（返回 410 `DELETED`，不自动复活）；
 * - 已导入 ready 返回 `ready`（DELETE 走导入 tombstone，不直接删 canonical）。
 */
export type CanvasImportGuard = {
  state(canvasId: string): { kind: "none" } | { kind: "deleted" } | { kind: "preparing"; jobId: string } | { kind: "ready" };
  /** 删除导入目标：同事务写 deleted tombstone + 清理 canonical/Yjs/ACL/历史。 */
  deleteImported(canvasId: string): Promise<void>;
  /**
   * 每请求可信主体（宿主认证适配器）；未认证返回 null
   * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.8 / design D4；
   *   change: 2026-10-13-...：统一认证器由 provider 异步解析，故返回 Promise）。
   */
  subject(req: IncomingMessage): Promise<string | null>;
  /**
   * 导入画布 ACL 优先授权（任务 4.8）：
   * - `null` → 非导入画布，沿用既有 native 访问路径；
   * - `true` / `false` → 导入画布按标准 ACL 判定读/写。
   */
  authorize(input: { canvasId: string; subject: string; permission: "read" | "write" }): boolean | null;
};

export type CanvasRequestHandlerOptions = {
  service: CanvasApplicationService;
  catalog?: CanvasCatalogService;
  /**
   * 跨画布图片列表（`GET /api/canvases/images`，图库「全部画布」用）。
   * 缺省时该路由回 503 —— 独立部署没有 Yjs 投影，本来就列不出来。
   */
  imageIndex?: import("./image-index.js").CanvasImageIndexPort;
  serviceToken?: string;
  basePath?: string;
  healthBasePath?: string;
  maxBodyBytes?: number;
  logger?: (event: { event: string; status: number; code?: string; actorId?: string }) => void;
  readiness?: () => Promise<CanvasReadiness>;
  runService?: CanvasRunPort;
  filmSetImport?: CanvasFilmSetImportPort;
  /** 单节点快捷「转为片场」（change: 2026-10-13-add-node-to-film-set-shortcut）。 */
  filmSetConversion?: CanvasFilmSetConversionPort;
  /** 原生录制 submit/cancel/status（缺省时录制路由返回 503）。 */
  recording?: CanvasRecordingPort;
  /**
   * 「转为片场」的 owner 解析（宿主在 HTTP 边界调用提供方的 `resolveOwner`）。
   *
   * 提供时，路由把可信主体 + 本次 Cookie 交给解析器，产出**已解析 owner**（含提供方前缀，如
   * `principal:` / `local:`）与可选的 `Set-Cookie`；解析结果作为 `ownerId` 传给转换服务并冻结在
   * 记录里。省略时转换生成端按自身边界处理（测试/无宿主路径）。
   */
  filmSetConversionOwnerResolver?: (input: {
    subject?: string;
    cookie?: string;
  }) => import("@woohaa3/contracts").FilmSetConversionOwner | null;
  /** 在线迁移访问门（省略时不启用迁移态判定与导入 ACL 判定）。 */
  importGuard?: CanvasImportGuard;
  /**
   * 资源/身份运行时开关（change: 2026-10-13-...，任务 4.4/6.1/6.2）。
   *
   * `{ enabled: true }` 表示由 `authenticate`/`access` 接管入口授权，禁用历史「loopback 即信任」
   * 边界；缺省（undefined）保持独立单元/本机部署的历史行为。
   */
  accessRuntime?: import("@woohaa3/contracts").AccessRuntime;
  /**
   * 资源授权端口（change: 2026-10-13-...，任务 4.4/6.1/6.2/6.5）。缺省 fail closed。
   * 每个画布路由在读取/写入前按可信 principal 判定 read/write/manageSharing/delete。
   */
  access?: import("../../access/resolve-access.js").CanvasAccessPort;
  /** Canvas 入口认证接缝：把 HTTP 请求解析为可信 principal；缺省不启用入口授权。 */
  authenticate?: import("../../access/resolve-access.js").CanvasRequestAuthenticator;
  /** 生命周期端口（delete=beginDelete+tombstone）；缺省按能力拒绝 delete。 */
  lifecycle?: import("../../access/resolve-access.js").CanvasLifecyclePort | null;
  /**
   * 可信主体的**可发现画布 ID 全集**（任务 5.5）：列表在**分页之前**按它过滤。
   *
   * 返回 `null` 表示目录提供者未注入（调用方回退逐项判定）；抛出表示提供者故障（列表 503）。
   */
  discoverableCanvasIds?: (principal: import("@woohaa3/contracts").PrincipalContext) => Promise<string[] | null>;
  /**
   * 关闭某画布的全部实时会话（任务 5.2）：原生删除后必须断开相关 WS/读连接，
   * 使撤权在生效后同步可见。缺省时不断开（独立 Canvas 服务无同步面）。
   */
  closeSessions?: (canvasId: string, reason: string) => void | Promise<void>;
  /**
   * 归档导出/导入（`.woohaa-archive`）。缺省时 `/archive` 路由回 503，不影响其它路由。
   *
   * 只暴露这三个方法：路由层不需要知道 `exportArchive` 之外的能力（列表、构造、依赖装配）。
   */
  archive?: Pick<CanvasArchiveService, "exportArchive" | "importArchive" | "verifyArchive">;
  /**
   * 归档包里带的媒体字节。导出时用来读取、导入时用来写回。
   *
   * 省略时导出仍可用，但包内不会有任何媒体 —— 恢复回来的画布图片全是断链。
   */
  mediaStorage?: MediaStorage;
  /**
   * 远端删除端口（可选）：属于远端来源的画布必须先在远端删掉，否则本机删完，
   * 下一次列目录又会把它拉回来。实现自己判定归属，不属于远端时返回 `skipped`。
   *
   * 删除顺序是**远端在前、本机在后**：远端失败就中止（本机仍完整，可重试），
   * 反序会留下"本机删了、远端还在"的半删状态。
   */
  deleteRemote?: (canvasId: string) => Promise<import("@woohaa3/contracts").CanvasUpstreamDeleteResult>;
};

export type CanvasLogger = CanvasRequestHandlerOptions["logger"];
