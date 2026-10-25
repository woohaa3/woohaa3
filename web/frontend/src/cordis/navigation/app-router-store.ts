import { decodeTaskMonitorSearch, encodeTaskMonitorSearch } from "../../pages/task-monitor/query.js";
import { DEFAULT_TELEMETRY_WINDOW, decodeTelemetrySearch, encodeTelemetrySearch } from "../../pages/telemetry/query.js";
/**
 * App Router store 实现
 * （change: 2026-09-28-unify-canvas-presentation-navigation，task 2.2/2.4 / design D1；
 *  change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.5/8.1 / design D10）。
 *
 * 解析浏览器 pathname 为页面 identity（canvas / task-history / settings / extension page），
 * 维护当前 location 与 page scope 生命周期订阅。extension page 的路径/查询编解码来自通用
 * `AppPageRegistry`；核心不硬编码具体业务 extension pageId。scope 的创建/释放由 composition
 * 层执行，Router 只广播变化。
 *
 * 与 master 的差异（本分支保留设置页与任务历史页为核心页）：核心页**优先**于 extension
 * registry 命中——扩展的旧路径 redirect 不得遮蔽分支的核心页；未注册路径沿用分支既有的
 * Canvas 回退（master 的「稳定不可用」需要 page scope 支持，本批未接通）。
 */
import type {
  AppPageId,
  AppPageLocation,
  AppPageScopeStatus,
  AppRouteResolution,
  AppRouterService,
  AppTaskHistoryQuery
} from "./app-router.js";
import { addAppBasePath, stripAppBasePath } from "@woohaa3/contracts";
import { currentAppBasePath } from "../services/app-base-path.js";
import { createAppPageRegistry, normalizePathname, type AppPageRegistry } from "../extension-entry/app-pages.js";

export const TASK_HISTORY_PAGE_PATH = "/task-history";
export const TASK_MONITOR_PAGE_PATH = "/admin/tasks";
/**
 * 本机遥测复盘页路径（change: 2026-10-20-add-local-client-telemetry，任务 5.1 / design D9）。
 *
 * 独立页面而不是设置弹窗：数据密度高（异常卡 + 聚合表 + 可筛选列表 + 详情），且需要可分享的
 * URL——"我这边 24 小时的失败集中在 sync.reconcile，链接给你"是这一页的主要用法。
 */
export const TELEMETRY_PAGE_PATH = "/telemetry";
/**
 * 旧设置页地址（兼容入口，不是页面身份）
 * （change: 2026-10-17-move-settings-into-canvas-dialog，design D6）。
 */
export const SETTINGS_COMPAT_PATH = "/settings";

/** 无参默认 registry（无 extension page；纯 Router 单测用）。 */
const EMPTY_REGISTRY = createAppPageRegistry([]);

/** Task History 页的规范化查询（有界字段；未知/无效字段丢弃）。 */
function taskHistoryQuery(search: string): AppTaskHistoryQuery {
  const params = new URLSearchParams(search);
  const history: AppTaskHistoryQuery = {};
  const tab = params.get("tab");
  if (tab === "all" || tab === "active" || tab === "succeeded" || tab === "failed" || tab === "cancelled") {
    history.tab = tab;
  }
  const providerId = params.get("providerId");
  if (providerId) history.providerId = providerId;
  const modelType = params.get("modelType");
  if (modelType === "language" || modelType === "image" || modelType === "video" || modelType === "audio") {
    history.modelType = modelType;
  }
  const modelKey = params.get("modelKey");
  if (modelKey) history.modelKey = modelKey;
  const canvasId = params.get("canvasId");
  if (canvasId) history.canvasId = canvasId;
  const nodeId = params.get("nodeId");
  if (nodeId) history.nodeId = nodeId;
  const taskKey = params.get("taskKey");
  if (taskKey) history.taskKey = taskKey;
  const source = params.get("source");
  if (source === "canvas" || source === "extension" || source === "unknown") history.source = source;
  const extensionId = params.get("extensionId");
  if (extensionId) history.extensionId = extensionId;
  const from = params.get("from");
  if (isIsoParam(from)) history.from = from;
  const to = params.get("to");
  if (isIsoParam(to)) history.to = to;
  const cursor = params.get("cursor");
  if (cursor) history.cursor = cursor;
  return history;
}

/** 已登记 extension page 的规范 location（含规范化查询）。 */
function extensionPageLocation(registry: AppPageRegistry, pageId: string, search: string): AppPageLocation {
  const query = registry.decodeQuery(pageId, search);
  return {
    page: "extension",
    extensionPageId: pageId,
    ...(Object.keys(query).length > 0 ? { query } : {})
  };
}

/**
 * 纯解析：pathname + search → 页面解析结果（registry 参与，无副作用）。
 * Canvas 只解析 canvasId/nodeId 目标；panel/menu/focus 不进入 URL。
 */
export function resolveAppRoute(
  pathname: string,
  search: string,
  registry: AppPageRegistry = EMPTY_REGISTRY
): AppRouteResolution {
  const normalized = normalizePathname(pathname);
  // 旧 `/settings` 是**兼容入口**，不是页面身份
  // （change: 2026-10-17-move-settings-into-canvas-dialog，design D6）：
  // 转换为 Canvas 目标 + 一次性 `openSettings` 意图；由页面 scope 的 Canvas 壳消费一次。
  // 该 COMpatibility 优先于 extension registry，扩展 legacy redirect 不得抢占 `/settings`。
  if (normalized === SETTINGS_COMPAT_PATH) {
    return { location: { page: "canvas", openSettings: true }, legacyRedirectPath: normalized };
  }
  if (normalized === TASK_HISTORY_PAGE_PATH) {
    const history = taskHistoryQuery(search);
    return { location: { page: "task-history", ...(Object.keys(history).length > 0 ? { history } : {}) } };
  }
  if (normalized === TASK_MONITOR_PAGE_PATH) {
    const decoded = decodeTaskMonitorSearch(new URLSearchParams(search));
    const query = decoded.ok ? Object.fromEntries(encodeTaskMonitorSearch(decoded.value)) : {};
    return { location: { page: "task-monitor", query } };
  }
  if (normalized === TELEMETRY_PAGE_PATH) {
    // 非法查询值在解码期被规范化丢弃（URL 是用户可编辑的输入，不因此让整页不可用）。
    const telemetry = decodeTelemetrySearch(new URLSearchParams(search));
    const defaultOnly =
      telemetry.window === DEFAULT_TELEMETRY_WINDOW &&
      !telemetry.name &&
      !telemetry.result &&
      // `mode`/`groupBy` 是 URL 承载的筛选与视图口径：漏判会让带它们的链接被规范化成
      // "什么都没有"，刷新后筛选静默消失。
      !telemetry.mode &&
      !telemetry.groupBy &&
      !telemetry.cursor &&
      !telemetry.eventId &&
      !telemetry.canvasId;
    return { location: { page: "telemetry", ...(defaultOnly ? {} : { telemetry }) } };
  }
  const match = registry.match(normalized);
  if (match?.kind === "page") return { location: extensionPageLocation(registry, match.page.pageId, search) };
  if (match?.kind === "legacy-redirect") {
    return {
      location: extensionPageLocation(registry, match.page.pageId, search),
      legacyRedirectPath: match.requestedPath
    };
  }
  const params = new URLSearchParams(search);
  const canvasId = params.get("canvasId") ?? undefined;
  const nodeId = params.get("nodeId") ?? undefined;
  return {
    location: {
      page: "canvas",
      ...(canvasId ? { canvasId } : {}),
      ...(nodeId ? { nodeId } : {})
    }
  };
}

/** 纯解析：pathname + search → 页面 identity（兼容既有调用方；不返回 redirect 元数据）。 */
export function resolvePageLocation(
  pathname: string,
  search: string,
  registry: AppPageRegistry = EMPTY_REGISTRY
): AppPageLocation {
  return resolveAppRoute(pathname, search, registry).location;
}

function isIsoParam(value: string | null): value is string {
  return typeof value === "string" && value !== "" && Number.isFinite(Date.parse(value));
}

/** 把 location 序列化为 pathname（用于 pushState）。 */
export function locationToPath(location: AppPageLocation, registry: AppPageRegistry = EMPTY_REGISTRY): string {
  if (location.page === "task-monitor") {
    const search = new URLSearchParams(location.query).toString();
    return TASK_MONITOR_PAGE_PATH + (search ? `?${search}` : "");
  }
  if (location.page === "telemetry") {
    const search = encodeTelemetrySearch({
      window: location.telemetry?.window ?? DEFAULT_TELEMETRY_WINDOW,
      ...(location.telemetry?.name ? { name: location.telemetry.name } : {}),
      ...(location.telemetry?.result ? { result: location.telemetry.result } : {}),
      ...(location.telemetry?.mode ? { mode: location.telemetry.mode } : {}),
      ...(location.telemetry?.groupBy ? { groupBy: location.telemetry.groupBy } : {}),
      ...(location.telemetry?.cursor ? { cursor: location.telemetry.cursor } : {}),
      ...(location.telemetry?.eventId ? { eventId: location.telemetry.eventId } : {}),
      ...(location.telemetry?.canvasId ? { canvasId: location.telemetry.canvasId } : {})
    }).toString();
    return TELEMETRY_PAGE_PATH + (search ? `?${search}` : "");
  }
  if (location.page === "extension") {
    if (location.unknownPath) return location.unknownPath;
    const path = location.extensionPageId ? registry.pathFor(location.extensionPageId) : undefined;
    if (!path) return "/";
    const query = location.extensionPageId && location.query ? registry.encodeQuery(location.extensionPageId, location.query) : "";
    return query ? `${path}?${query}` : path;
  }
  if (location.page === "task-history") {
    const params = new URLSearchParams();
    const history = location.history;
    if (history) {
      if (history.tab && history.tab !== "all") params.set("tab", history.tab);
      if (history.providerId) params.set("providerId", history.providerId);
      if (history.modelType) params.set("modelType", history.modelType);
      if (history.modelKey) params.set("modelKey", history.modelKey);
      // 注意：canvasId/nodeId 在此页是「筛选画布/节点」，不是 Canvas 目标。
      if (history.canvasId) params.set("canvasId", history.canvasId);
      if (history.nodeId) params.set("nodeId", history.nodeId);
      if (history.taskKey) params.set("taskKey", history.taskKey);
      if (history.source) params.set("source", history.source);
      if (history.extensionId) params.set("extensionId", history.extensionId);
      if (history.from) params.set("from", history.from);
      if (history.to) params.set("to", history.to);
      if (history.cursor) params.set("cursor", history.cursor);
    }
    const query = params.toString();
    return query ? `${TASK_HISTORY_PAGE_PATH}?${query}` : TASK_HISTORY_PAGE_PATH;
  }
  const params = new URLSearchParams();
  if (location.canvasId) params.set("canvasId", location.canvasId);
  if (location.nodeId) params.set("nodeId", location.nodeId);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

export type AppRouterOptions = {
  /** 初始 pathname（测试/SSR 可注入；缺省读 globalThis.location）。 */
  initialPathname?: string;
  initialSearch?: string;
  /** 公开挂载路径（缺省读运行时注入；逻辑路由不含前缀，读写 history 时加/去一次）。 */
  basePath?: string;
  /** History 适配（测试可注入；缺省用 globalThis.history）。 */
  history?: {
    pushState: (data: unknown, title: string, url: string) => void;
    replaceState?: (data: unknown, title: string, url: string) => void;
  };
  /** extension page registry（缺省为空；composition 注入发布目录/测试 fixture 清单）。 */
  appPages?: AppPageRegistry;
  /** 变更通知：Router 要求在 scope 切换完成后再广播，由 composition 调用 commit。 */
  onNavigate?: (location: AppPageLocation) => void;
};

/** History 适配类型（composition/测试共用）。 */
export type AppHistoryAdapter = NonNullable<AppRouterOptions["history"]>;

/** 页面 scope identity key：canvas→canvasId；extension→pageId；核心页按 page 区分。 */
function scopeKeyOf(location: AppPageLocation): string | null {
  if (location.page === "canvas") return location.canvasId ?? null;
  if (location.page === "extension") return location.extensionPageId ?? location.unknownPath ?? null;
  return null;
}

export class AppRouterStore implements AppRouterService {
  private location: AppPageLocation;
  private readonly listeners = new Set<() => void>();
  private readonly scopeListeners = new Set<(status: AppPageScopeStatus) => void>();
  private scopeId = "scope-canvas-0";
  private scopeCounter = 0;
  private currentPage: AppPageId;
  private currentKey: string | null;
  private navigateHandler: ((to: AppPageLocation) => void) | null = null;
  private readonly basePath: string;
  private readonly registry: AppPageRegistry;

  constructor(private readonly options: AppRouterOptions = {}) {
    this.basePath = options.basePath ?? currentAppBasePath();
    this.registry = options.appPages ?? EMPTY_REGISTRY;
    const rawPathname = options.initialPathname ?? globalThis.location?.pathname ?? "/";
    const search = options.initialSearch ?? globalThis.location?.search ?? "";
    this.location = resolveAppRoute(stripAppBasePath(this.basePath, rawPathname) ?? rawPathname, search, this.registry).location;
    this.currentPage = this.location.page;
    this.currentKey = scopeKeyOf(this.location);
    this.scopeId = this.makeScopeId(this.location);
  }

  getLocation = (): AppPageLocation => this.location;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  subscribeScope = (listener: (status: AppPageScopeStatus) => void): (() => void) => {
    this.scopeListeners.add(listener);
    return () => {
      this.scopeListeners.delete(listener);
    };
  };

  resolve(pathname: string, search: string): AppPageLocation {
    return resolvePageLocation(stripAppBasePath(this.basePath, pathname) ?? pathname, search, this.registry);
  }

  navigate(to: AppPageLocation): void {
    const path = addAppBasePath(this.basePath, locationToPath(to, this.registry));
    this.options.history?.pushState?.({}, "", path);
    // 用户主动导航必须经 App Runtime 的同一 scope transition 路径；未安装 handler 时
    // （纯 Router 单测）退化为只更新本地 snapshot。
    if (this.navigateHandler) {
      this.navigateHandler(to);
      return;
    }
    this.commit(to);
  }

  /**
   * 安装导航处理者（composition 层把它接到 `applyLocation`）。返回 true 表示已接管
   * pushState 之后的 scope transition（change: 2026-09-29-add-multi-canvas-workspace）。
   */
  setNavigateHandler(handler: ((to: AppPageLocation) => void) | null): void {
    this.navigateHandler = handler;
  }

  /**
   * 用 replaceState 规范化当前 history entry（change: 2026-09-29-add-multi-canvas-workspace，
   * design D1）：用于缺省 canvasId 解析，避免污染 back stack。
   */
  replace(to: AppPageLocation): void {
    const path = addAppBasePath(this.basePath, locationToPath(to, this.registry));
    this.options.history?.replaceState?.({}, "", path);
    this.commit(to);
  }

  navigatePath(pathname: string): void {
    const [path, search = ""] = pathname.split("?");
    this.navigate(resolvePageLocation(path ?? "/", search, this.registry));
  }

  currentScopeId = (): string => this.scopeId;

  /** 由 composition 在 scope 就绪后调用，广播 location 与 scope 生命周期。 */
  commit(location: AppPageLocation, status?: AppPageScopeStatus): void {
    this.location = location;
    const nextKey = scopeKeyOf(location);
    // canvasId / extensionPageId 是 page scope identity 的一部分：同一页面内目标变化同样
    // 触发完整 scope transition（design D1/D3）。
    if (location.page !== this.currentPage || nextKey !== this.currentKey) {
      this.currentPage = location.page;
      this.currentKey = nextKey;
      this.scopeId = this.makeScopeId(location);
    }
    for (const listener of this.listeners) listener();
    if (status) for (const listener of this.scopeListeners) listener(status);
  }

  /** 供 composition 报告 scope 状态变化（starting/ready/error）。 */
  reportScope(status: AppPageScopeStatus): void {
    for (const listener of this.scopeListeners) listener(status);
  }

  private makeScopeId(location: AppPageLocation): string {
    this.scopeCounter += 1;
    return `scope-${location.page}-${this.scopeCounter}`;
  }
}
