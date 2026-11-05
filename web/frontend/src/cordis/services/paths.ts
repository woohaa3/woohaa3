/**
 * 三大后端服务的同源 API path（change: adopt-frontend-cordis-plugin-runtime）。
 *
 * **唯一**路径常量所在地：只有 `runtime/remote/**` 可以 import 本模块。feature/plugin
 * 生产代码不得再拼三大服务 path（架构审计强制）。
 */
export const CANVAS_API_BASE_PATH = "/api/canvases";
export const MEDIA_BASE_PATH = "/api/media";
export const MEDIA_PROJECT_BASE_PATH = "/api/media-projects";
export const PPTASK_BASE_PATH = "/api/pptask";
export const TASK_HISTORY_BASE_PATH = "/api/pptask/history";
export const MODEL_MCP_REPORT_PATH = "/api/model-mcp/scripts/report";
/** 提示词片段目录（由 Canvas Service 承载；change: add-prompt-snippet-library）。 */
export const PROMPT_SNIPPETS_BASE_PATH = "/api/prompt-snippets";
/** 节点生成历史（由 Canvas Service 承载；change: add-canvas-node-generation-history）。 */
export const NODE_HISTORY_BASE_PATH = "/api/canvas-node-history";
/** 画布任务活动（由 Canvas Service 承载；change: 2026-09-29-add-canvas-task-activity-feed）。 */
export const TASK_ACTIVITY_BASE_PATH = "/api/canvas-task-activity";
/**
 * 外部画布来源目录（由 Canvas Service 承载）
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 5.1）。
 * 受认证；浏览器只拿到来源摘要/分页，不接触路径/URI/旧格式。
 */
export const CANVAS_SOURCES_BASE_PATH = "/api/canvas-sources";
/**
 * Application Service 健康/就绪（change: 2026-10-05-extract-application-plugin-host）。
 * 站点插件控制面由 Application 承载；浏览器只经同源 ingress 访问。
 */
export const APPLICATION_HEALTH_BASE_PATH = "/api/application/health";
/**
 * 站点应用插件控制面（由 Application Service 承载）
 * （change: 2026-10-04-add-backend-plugin-extensions；change: 2026-10-05 迁入独立 Application）。
 */
export const APPLICATION_EXTENSION_BASE_PATH = "/api/extensions";
/**
 * 生成模型管理（由统一后端生成模块承载）
 * （change: 2026-10-04-add-runninghub-and-extensionize-litellm，任务 5.1）。
 */
export const GENERATION_MODELS_BASE_PATH = "/api/generation-models";

/**
 * 宿主 Agent 会话（由 Application Service 承载）
 * （change: 2026-10-12-add-agent-conversation-panel）。同源、owner+canvas 隔离；浏览器只读写
 * 会话/回合/事件，不接触 provider token。
 */
export const AGENT_CONVERSATION_BASE_PATH = "/api/agent-conversations";

/** 后端统一配置（由统一后端 SettingsService 承载；仅管理员可读写）。 */
export const SETTINGS_BASE_PATH = "/api/settings";

/**
 * 本机遥测事件 intake（由统一后端 Telemetry 能力承载）
 * （change: 2026-10-20-add-local-client-telemetry，design D7）。
 *
 * 浏览器只写这一条同源路径；读面（查询/聚合/异常/清空）由复盘页直接调用，不经采集客户端。
 */
export const TELEMETRY_EVENTS_PATH = "/api/telemetry/events";

/** 媒体读写归属的画布查询参数（与后端 `/api/media?canvas=<id>` 约定一致）。 */
export const MEDIA_CANVAS_QUERY_KEY = "canvas";

/**
 * 跨画布图片库（从各画布的已发布投影抽图片；由 Canvas Service 承载）。
 *
 * 见 canvas-service 的 `image-index.ts`。图库面板的「全部画布」与跨画布放置共用这一条路径，
 * 只在 `cordis/install-services.ts` 里拼查询串。
 */
export const CANVAS_IMAGES_PATH = "/api/canvases/images";

/**
 * 给已构造的媒体逻辑 URL 追加画布提示（`?canvas=<id>`）。
 *
 * 持久化引用**不含**画布提示；只有已知画布上下文的渲染/上传出口才附加，让本机宿主按画布
 * 把读写路由到远端存储。无 `canvasId` 时原样返回：独立页/扩展素材的 URL 字节级不变。
 */
export function withMediaCanvasHint(logicalUrl: string, canvasId?: string | null): string {
  if (typeof canvasId !== "string" || canvasId === "") return logicalUrl;
  const separator = logicalUrl.includes("?") ? "&" : "?";
  return `${logicalUrl}${separator}${MEDIA_CANVAS_QUERY_KEY}=${encodeURIComponent(canvasId)}`;
}

/**
 * 由稳定 storageKey 构造同源读取地址。签名 URL 绝不进入画布。
 *
 * `canvasId` 只在画布上下文的渲染出口传入；持久化引用必须调用不带 `canvasId` 的形式。
 */
export function mediaUrlFor(storageKey: string, canvasId?: string): string {
  return withMediaCanvasHint(`${MEDIA_BASE_PATH}/${storageKey}`, canvasId);
}

/** 节点生成历史的受控预览地址（canvas/node/entry 归属；同源）。 */
export function nodeHistoryUrlFor(input: {
  canvasId: string;
  nodeId: string;
  entryId: string;
  variant: "preview" | "poster";
}): string {
  return `${NODE_HISTORY_BASE_PATH}/${encodeURIComponent(input.canvasId)}/${encodeURIComponent(input.nodeId)}/${encodeURIComponent(input.entryId)}/${input.variant}`;
}
