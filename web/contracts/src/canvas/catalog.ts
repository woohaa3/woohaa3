/**
 * 画布目录（多画布工作区）共享 DTO 与无副作用 decoder
 * （change: 2026-09-29-add-multi-canvas-workspace，任务 1.1 / design D4）。
 *
 * 这些形状固化 `GET /api/canvases` 与 `POST /api/canvases` **已有**字段的含义，不新增
 * 数据库列或响应字段。浏览器 Catalog Service 与 Canvas Service 目录读取共用同一份类型，
 * decoder 只做形态校验（对象/字符串/有限数），不解析或改写业务值。
 */
import { isBoundedId, isFiniteNumber, isJsonObject, isNonNegativeInteger } from "../validation.js";

/**
 * 画布在哪些来源里存在。
 *
 * 目录可以同时接入多个来源（本机存储、远端服务端），**两者都生效**：同一个 id 在两边
 * 都有时只出现一次，`sources` 记着它在哪几边存在。这决定了界面该显示"仅本机"、
 * "仅远端"还是"已同步"。
 */
export type CanvasCatalogOrigin = "local" | "remote";

/**
 * 画布的同步状态（本机视角）。
 *
 * - `local-only`：只在本机存在，尚未同步到任何远端；
 * - `synced`：两边都有且链路已同步完成；
 * - `syncing`：正在连/正在补差；
 * - `offline`：配置了远端但当前连不上（离线编辑仍会落到本机）；
 * - `failed`：远端明确拒绝（如已删除），重连不会自愈；
 * - `remote-only`：只在远端存在，本机还没有内容副本；
 * - `unlinked`：**属于远端、远端此刻也列得到，本机有副本，但本机还没有建立上游链路**
 *   （比如宿主重启后房间在会话就绪之前创建、解析没有得到凭据）。本地改动只落本机，尚未推送。
 *   只在远端存在的画布不算 unlinked：那里没有「改动推不上去」的风险，结论是 `remote-only`。
 *
 * `synced` 的判据是"两边都有内容"，不是"链路此刻在线"；没有链路时必须用 `unlinked`
 * 表态，不能回落成 `synced`——否则界面会在整条上传链路不存在时显示"已同步"。
 */
export type CanvasSyncState = "local-only" | "synced" | "syncing" | "offline" | "failed" | "remote-only" | "unlinked";

/**
 * 调用者在这张画布上的**内容权限**（服务端判定，客户端只渲染）。
 *
 * 与 `sync`（链路状态）是两个维度：同步正常也可能只读（协作者 viewer、链接只读分享），
 * 断线也可能本来可写。界面在进入画布时据此决定是否显示只读提示、是否允许生成/编辑。
 *
 * 省略表示**未知**（没接远端、远端这次没给答案），调用方不得把未知当成只读。
 */
export type CanvasAccess = {
  /** 能否读取这张画布；`false` 表示远端明确拒绝（本机内容可能只是陈旧副本）。 */
  canRead: boolean;
  /** 能否写入这张画布；`false` 表示只读。 */
  canWrite: boolean;
};

/** 画布列表条目的摘要；不含完整 document，避免分页响应过大。 */
export type CanvasSummary = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  createdAt: string;
  nodeCount: number;
  assetCount: number;
  /** 这个 id 在哪些来源里存在；省略表示"只有本机"（旧响应兼容）。 */
  sources?: readonly CanvasCatalogOrigin[];
  /** 本机看到的同步状态；省略表示目录没有接入远端（纯本地部署）。 */
  sync?: CanvasSyncState;
  /** 调用者在这张画布上的内容权限；省略表示未知（按可写处理）。 */
  access?: CanvasAccess;
};

/**
 * 单画布摘要（无 `createdAt`）。
 *
 * `GET /api/canvases/:canvasId` 返回完整画布而不含结构化 `createdAt`；目录按 ID 校验/展示
 * 当前画布时只取这些字段。需要 `createdAt` 的列表场景用 `CanvasSummary`。
 */
export type CanvasDetailSummary = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  nodeCount: number;
  assetCount: number;
  /** 调用者在这张画布上的内容权限；省略表示未知（按可写处理）。 */
  access?: CanvasAccess;
};

/** 稳定分页结果：`offset`/`limit` 回显归一化后的请求参数。 */
export type CanvasListPage = {
  items: CanvasSummary[];
  total: number;
  offset: number;
  limit: number;
};

/**
 * 创建画布结果：只固化目录消费所需的最小身份。
 *
 * 服务端仍返回完整 `{ canvas, revision }`；这里刻意**不**在浏览器契约里承载完整画布，
 * 避免把大对象塞进目录层。
 */
export type CanvasCreateResult = {
  canvasId: string;
  revision: number;
  title: string;
};

export type CanvasCatalogErrorCode =
  | "CANVAS_NOT_FOUND"
  | "CANVAS_ALREADY_EXISTS"
  | "REPOSITORY_FAILURE"
  | "INVALID_COMMAND_BATCH"
  | "LIMIT_EXCEEDED"
  | "NOT_READY";

/** 目录分页默认值与上限；与后端 `normalizeCanvasListQuery` 保持一致。 */
export const DEFAULT_CANVAS_CATALOG_PAGE_SIZE = 20;
export const MAX_CANVAS_CATALOG_PAGE_SIZE = 100;

const CATALOG_ORIGINS: readonly string[] = ["local", "remote"];
const SYNC_STATES: readonly string[] = ["local-only", "synced", "syncing", "offline", "failed", "remote-only", "unlinked"];

/** 可选字段一旦出现就必须合法：坏值不能悄悄变成"没有远端"。 */
function isOptionalSources(value: unknown): boolean {
  if (value === undefined) return true;
  return Array.isArray(value) && value.every((item) => typeof item === "string" && CATALOG_ORIGINS.includes(item));
}

function isOptionalSync(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && SYNC_STATES.includes(value));
}

/** 权限字段一旦出现就必须两个布尔都合法：坏值不能悄悄退化成"可写"。 */
function isOptionalAccess(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isJsonObject(value)) return false;
  return typeof value.canRead === "boolean" && typeof value.canWrite === "boolean";
}

export function isCanvasAccess(value: unknown): value is CanvasAccess {
  return isOptionalAccess(value) && value !== undefined;
}

export function isCanvasSummary(value: unknown): value is CanvasSummary {
  if (!isJsonObject(value)) return false;
  return (
    isBoundedId(value.id) &&
    typeof value.title === "string" &&
    isNonNegativeInteger(value.revision) &&
    typeof value.updatedAt === "string" &&
    typeof value.createdAt === "string" &&
    isNonNegativeInteger(value.nodeCount) &&
    isNonNegativeInteger(value.assetCount) &&
    isOptionalSources(value.sources) &&
    isOptionalSync(value.sync) &&
    isOptionalAccess(value.access)
  );
}

export function decodeCanvasListPage(
  value: unknown
): { ok: true; page: CanvasListPage } | { ok: false; error: string } {
  if (!isJsonObject(value)) return { ok: false, error: "目录响应必须是对象" };
  if (!Array.isArray(value.items)) return { ok: false, error: "目录 items 必须是数组" };
  if (!value.items.every(isCanvasSummary)) return { ok: false, error: "目录条目形态非法" };
  if (!isNonNegativeInteger(value.total)) return { ok: false, error: "目录 total 必须是非负整数" };
  if (!isNonNegativeInteger(value.offset)) return { ok: false, error: "目录 offset 必须是非负整数" };
  if (!isNonNegativeInteger(value.limit)) return { ok: false, error: "目录 limit 必须是非负整数" };
  return {
    ok: true,
    page: {
      items: value.items as CanvasSummary[],
      total: value.total,
      offset: value.offset,
      limit: value.limit
    }
  };
}

export function decodeCanvasCreateResult(
  value: unknown
): { ok: true; result: CanvasCreateResult } | { ok: false; error: string } {
  if (!isJsonObject(value)) return { ok: false, error: "创建响应必须是对象" };
  const canvas = value.canvas;
  if (!isJsonObject(canvas)) return { ok: false, error: "创建响应缺少 canvas" };
  if (!isBoundedId(canvas.id)) return { ok: false, error: "创建响应 canvas.id 非法" };
  if (!isFiniteNumber(value.revision)) return { ok: false, error: "创建响应 revision 非法" };
  const title = typeof canvas.title === "string" ? canvas.title : "";
  return { ok: true, result: { canvasId: canvas.id, revision: value.revision, title } };
}

/**
 * 从 `GET /api/canvases/:canvasId` 的完整画布响应派生稳定摘要。
 *
 * 画布本身是 published projection 的序列化（服务端 `getCanvas` 返回完整 `ServerCanvas`），
 * 因此这里不需要二次权威读取即可得到最新标题。形态非法返回错误（调用方据此判定不存在）。
 */
export function decodeCanvasDetailSummary(
  value: unknown
): { ok: true; summary: CanvasDetailSummary } | { ok: false; error: string } {
  if (!isJsonObject(value)) return { ok: false, error: "画布响应必须是对象" };
  const canvas = isJsonObject(value.canvas) ? value.canvas : value;
  if (!isBoundedId(canvas.id)) return { ok: false, error: "画布 id 非法" };
  if (!isNonNegativeInteger(canvas.revision)) return { ok: false, error: "画布 revision 非法" };
  if (typeof canvas.updatedAt !== "string") return { ok: false, error: "画布 updatedAt 非法" };
  const document = isJsonObject(canvas.document) ? canvas.document : null;
  if (!document || !Array.isArray(document.nodes)) return { ok: false, error: "画布 document 非法" };
  if (!Array.isArray(canvas.assets)) return { ok: false, error: "画布 assets 非法" };
  // 权限可能挂在响应顶层（宿主另行判定）也可能在 canvas 内；坏值直接判非法，不静默当可写。
  const access = value.access ?? canvas.access;
  if (!isOptionalAccess(access)) return { ok: false, error: "画布 access 非法" };
  return {
    ok: true,
    summary: {
      id: canvas.id,
      title: typeof canvas.title === "string" ? canvas.title : "",
      revision: canvas.revision,
      updatedAt: canvas.updatedAt,
      nodeCount: document.nodes.length,
      assetCount: canvas.assets.length,
      ...(access === undefined ? {} : { access: access as CanvasAccess })
    }
  };
}
