/**
 * 应用级 page Router 契约
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 2.1/2.2 / design D1；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.5/8.1 / design D10）。
 *
 * App Router 拥有当前顶层页面 identity，并负责为当前 pathname 创建/释放一个 page scope。
 * 它只解析页面 identity，不把 panel/menu/model-focus 写入 URL。
 *
 * 页面分两类：分支既有的核心页（`canvas` / `task-history` / `settings`）与**通用**
 * extension page（由可信 extension page 贡献提供）。核心 MUST NOT 硬编码具体业务 extension
 * pageId；extension page 的路径、查询编解码与渲染归各自扩展。
 */
import type { Context } from "@deepseek-ai/cordis";
import type {
  AccessAction,
  ExtensionAppPageQuery,
  TelemetryEventName,
  TelemetryResult,
  TelemetryWindow
} from "@woohaa3/contracts";

/** 顶层页面 identity。 */
export type AppPageId = "canvas" | "task-history" | "task-monitor" | "telemetry" | "extension";

/**
 * 本机遥测复盘页的已应用查询（类型化 URL；change: 2026-10-20-add-local-client-telemetry，D9）。
 *
 * 只含有界枚举（窗口/事件名/结果）、不透明游标与记录 id；MUST NOT 包含事件属性、错误消息或
 * 任何其它用户内容——URL 会被复制粘贴给别人看，它是「筛选口径」而不是数据本身。
 */
export type AppTelemetryQuery = {
  window?: TelemetryWindow;
  name?: TelemetryEventName;
  result?: TelemetryResult;
  cursor?: string;
  eventId?: string;
  /**
   * 来源画布：**返回目标**，不是筛选条件。
   *
   * 复盘页是整页路由，没有它「返回画布」只能落到默认画布；带上它才能回到用户刚才那张。
   * 与 task-history 的 `canvasId` 同取向（不透明标识，不属于用户内容）。
   */
  canvasId?: string;
};

/**
 * Task History 已应用查询（类型化 URL；change: improve-task-history-experience，D8）。
 *
 * MUST NOT 包含未应用草稿、prompt、parameters 或媒体 URL。状态用有界 `tab` 表达；
 * `cursor` 是 opaque 页游标；`taskKey` 是选中详情。
 */
export type AppTaskHistoryQuery = {
  tab?: "all" | "active" | "succeeded" | "failed" | "cancelled";
  providerId?: string;
  modelType?: "language" | "image" | "video" | "audio";
  modelKey?: string;
  canvasId?: string;
  nodeId?: string;
  taskKey?: string;
  source?: "canvas" | "extension" | "unknown";
  extensionId?: string;
  from?: string;
  to?: string;
  cursor?: string;
};

export type AppPageLocation = {
  page: AppPageId;
  /** Canvas 目标（从 history 跳转时携带）。 */
  canvasId?: string;
  nodeId?: string;
  /** Task History 类型化查询（仅 task-history 页）。 */
  history?: AppTaskHistoryQuery;
  /** 遥测复盘页类型化查询（仅 telemetry 页；change: 2026-10-20-add-local-client-telemetry）。 */
  telemetry?: AppTelemetryQuery;
  /** extension page 的稳定 pageId（仅 `page: "extension"`）。 */
  extensionPageId?: string;
  /** extension page 的已应用查询（规范化；仅 `page: "extension"` 或 `task-monitor`）。 */
  query?: ExtensionAppPageQuery;
  /** 请求路径未注册/不可用（仅 `page: "extension"`）；页面显示稳定不可用，不回退 Canvas。 */
  unknownPath?: string;
  /**
   * 一次性「打开画布内设置」意图
   * （change: 2026-10-17-move-settings-into-canvas-dialog，design D6）。
   *
   * 只由旧 `/settings` 兼容地址产生：解析结果仍是 `page: "canvas"`，`openSettings` 表示壳就绪后
   * 需要消费一次打开请求。它**不是**页面身份、不进入 URL 序列化，也不参与 scope identity。
   */
  openSettings?: boolean;
};

export type AppPageScopeStatus = {
  id: string;
  page: AppPageId;
  phase: "starting" | "ready" | "error";
  error: string | null;
};

/** 一个可释放的 page scope。 */
export type AppPageScope = {
  id: string;
  page: AppPageId;
  ctx: Context;
  status: AppPageScopeStatus;
  subscribe(listener: () => void): () => void;
  dispose(): Promise<void>;
};

/** 页面解析的纯结果（registry 参与，不产生副作用）。 */
export type AppRouteResolution = {
  /** 规范 location（含 pageId/query）。 */
  location: AppPageLocation;
  /** 请求路径是旧路径，需要 replace 到规范路径。 */
  legacyRedirectPath?: string;
  /** 请求路径未知/未注册（不可用时页面显示稳定反馈，绝不回退 Canvas）。 */
  unknownPath?: string;
};

export interface AppRouterService {
  /** 当前活动 page location。 */
  getLocation(): AppPageLocation;
  subscribe(listener: () => void): () => void;
  /** 解析 pathname 得到页面 identity（纯函数式，无副作用）。 */
  resolve(pathname: string, search: string): AppPageLocation;
  /** 请求导航到目标 location（pushState + 切换 scope）。 */
  navigate(to: AppPageLocation): void;
  /**
   * 用 replaceState 规范化当前 entry（缺省 canvasId 解析 / 旧路径 redirect；change:
   * 2026-09-29-add-multi-canvas-workspace）。不改变 back stack 长度。
   */
  replace(to: AppPageLocation): void;
  /** 直接提交 pathname（Browser History 集成）。 */
  navigatePath(pathname: string): void;
  /** 当前活动 page scope 的稳定 identity。 */
  currentScopeId(): string;
  /** 订阅 scope 生命周期变化（诊断/测试）。 */
  subscribeScope(listener: (status: AppPageScopeStatus) => void): () => void;
}

/** extension page 所需的认证/action 声明（供 Router 呈现资格反馈；服务端仍独立检查）。 */
export type AppPageRequirement = {
  requiresAuth: boolean;
  requiredActions?: readonly AccessAction[];
};

