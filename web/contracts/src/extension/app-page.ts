/**
 * 通用 app/page 扩展贡献与受限任务监控 facade 契约（纯类型）
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 0.5/0.6 / design D10/D11）。
 *
 * 前端新增 `AppPageContribution`：宿主 Router/page-scope 只认识 canvas 与**通用** extension page，
 * 不在核心新增硬编码 业务扩展页面 分支。页面由扩展拥有，宿主负责可信注册、scope
 * 生命周期、typed query 解码与 renderer。
 *
 * 任务监控只通过受限 `TaskInspectionFacade` 读取既有 durable history；公开 reader 与内部 system
 * 恢复能力分开，facade 不交出 worker/store 句柄。
 */
import type { Plugin } from "@deepseek-ai/cordis";
import type { AccessAction, PrincipalContext } from "./access.js";
import type { TaskExecutionDetail, TaskExecutionState, TaskHistoryQuery } from "../task/history/types.js";

/**
 * 规范化后的页面查询（类型化 URL 的通用载体）。
 *
 * 只含稳定、可分享的字段；MUST NOT 含草稿、prompt、parameters 或媒体 URL。字符串值便于
 * 宿主 Router 做白名单转换与序列化；具体页面自行解码为领域查询。
 */
export type ExtensionAppPageQuery = Readonly<Record<string, string>>;

/**
 * 扩展 app/page 的**纯路由元数据**（可 JSON 序列化）
 * （change: 2026-10-13-...，任务 0.5/8.1 / design D10；2026-10-12 发布协议扩展）。
 *
 * 这是发布目录（`/extension-releases/<id>.json` 的 `metadata.appPages`）携带的唯一权威路由
 * 数据：宿主 Router 在扩展实现加载**之前**即可按 pageId/path/旧路径/资格建立 registry。纯数据
 * 不含可执行入口，因此与 `ExtensionFrontendMetadata` 一样只经部署协议传输，不来自管理数据。
 */
export type ExtensionAppPageMetadata = {
  /** 稳定 pageId（宿主据此建立独立 page scope identity）。 */
  pageId: string;
  /** 静态可信路径（必须 `/` 开头）。 */
  path: string;
  /** 可选旧路径受保护 redirect（如 `/task-history`）；宿主只 replace 到 `path`。 */
  legacyRedirectPaths?: readonly string[];
  /** 所需认证等级下限。 */
  requiresAuth: boolean;
  /** 所需站点 action（如 `tasks.inspect`）；服务端仍独立重查。 */
  requiredActions?: readonly AccessAction[];
  /** 页面标题（诊断/导航展示）。 */
  title?: string;
};

/**
 * 扩展 app/page 的**运行时入口**（由发布目录 descriptor 在实现加载后提供）
 * （change: 2026-10-13-...，任务 0.5/8.1 / design D10）。
 *
 * 纯路由元数据进发布目录；`createPlugin` 只会随扩展实现求值出现（`loadDescriptor` 返回的
 * descriptor）。宿主按 pageId 关联两者：Router 用元数据解析，page scope 用本入口装配。
 */
export type ExtensionAppPageRuntime = {
  /** 稳定 pageId（必须与 metadata.appPages 同名项一致）。 */
  pageId: string;
  /** 无副作用构造 page-scope plugin；宿主负责装配与 fiber 生命周期。 */
  createPlugin: () => Plugin;
};

/**
 * 一个扩展 app/page 前端贡献（可信入口/测试 fixture 的内存形状）
 * （change: 2026-10-13-...，任务 0.5/8.1 / design D10）。
 *
 * 宿主 Router/page-scope 只认识 canvas 与**通用** extension page：不在核心硬编码
 * 业务扩展页面 分支。每个页面自带 page-scope plugin 工厂与纯查询编解码。
 *
 * `createPlugin` 是**无副作用工厂**：宿主在目标 page scope 装配并拥有其 fiber 生命周期；
 * 页面渲染由该 plugin 注册的 `app.route` contribution 承担。运行时 registry 也可由发布目录
 * 纯 metadata（`ExtensionAppPageMetadata` + owner）构造，此时 `createPlugin` 缺省并由 descriptor
 * 在挂载时补齐。
 */
export type ExtensionAppPageEntry = ExtensionAppPageMetadata & {
  /** owner extensionId（可信静态清单）。 */
  extensionId: string;
  /** 纯查询编解码：URLSearchParams → 规范化参数；未知/无效字段规范化，不读取资源。 */
  decodeQuery?: (search: URLSearchParams) => ExtensionAppPageQuery;
  /** 纯查询编解码：规范化参数 → URLSearchParams。 */
  encodeQuery?: (query: ExtensionAppPageQuery) => URLSearchParams;
  /** 无副作用构造 page-scope plugin；缺省由 descriptor 在挂载时补齐。 */
  createPlugin?: () => Plugin;
};

/** 一个扩展 app/page 贡献的纯数据描述（不含可执行入口；用于可信清单/管理面）。 */
export type AppPageContribution = {
  /** owner extensionId（可信静态清单）。 */
  extensionId: string;
  /** 稳定 pageId（宿主据此建立独立 page scope identity）。 */
  pageId: string;
  /** 静态可信路径（必须 `/` 开头）。 */
  path: string;
  /** 可选旧路径受保护 redirect（如 `/task-history`）；宿主只 replace 到 `path`。 */
  legacyRedirectPaths?: readonly string[];
  /** 所需认证等级下限。 */
  requiresAuth: boolean;
  /** 所需站点 action（如 `tasks.inspect`）；服务端仍独立重查。 */
  requiredActions?: readonly AccessAction[];
  /** 页面标题（诊断/导航展示）。 */
  title?: string;
};

/** 由扩展提供的 app/page 贡献集合（构建时静态登记）。 */
export type AppPageContributionManifest = {
  pages: readonly AppPageContribution[];
};

/** 任务监控快照（同一次 observedAt；全局计数与过滤列表分开）。
 *
 * `stateCounts` 来自全局聚合，不是当前页行数求和。
 */
export type TaskInspectionSnapshot = {
  observedAt: string;
  stateCounts: Record<TaskExecutionState, number>;
  items: TaskExecutionDetail[];
  nextCursor: string | null;
};

/** 任务监控默认/最大分页（上限 200）。 */
export const TASK_INSPECTION_DEFAULT_LIMIT = 100;
export const TASK_INSPECTION_MAX_LIMIT = 200;

/** 任务监控时间/actor 读模型定义在 Task history DTO 中（列表与详情共用）。 */
export type { TaskExecutionActor, TaskExecutionTiming } from "../task/history/types.js";

/**
 * 受限任务监控 facade（change: 2026-10-13-...，任务 7.4/7.5）。
 *
 * 只交给声明 `tasks.inspect` 的 extension；`principal` 由宿主从请求上下文注入（插件不得自报），
 * 宿主在 repository 查询**之前**校验 site policy。facade 不交出 worker/store 句柄。
 */
export type TaskInspectionFacade = {
  /** 全局一致快照 + 独立过滤列表（同一 observedAt）。 */
  snapshot(input: { principal?: PrincipalContext; query?: TaskHistoryQuery; limit?: number }): Promise<TaskInspectionSnapshot>;
  /** 单条安全详情（可含预算内 request summary）。 */
  detail(input: { principal?: PrincipalContext; taskKey: string }): Promise<TaskExecutionDetail | null>;
};

/** 打开任务检查入口的具名 action（由有 `tasks.inspect` 的扩展注册 openTaskInspection）。 */
export const OPEN_TASK_INSPECTION_ACTION = "openTaskInspection" as const;
