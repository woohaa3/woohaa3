/** 任务监控页面的查询编解码与展示标签。 */
import { parseTaskHistoryQuery, type TaskExecutionState, type TaskHistoryQuery } from "@woohaa3/contracts";

/**
 * 已应用查询（类型化 URL）。**不含**草稿、prompt、parameters 或媒体 URL。
 *
 * `cursor` 是 Task 生成的 opaque 页游标；`taskKey` 选中详情。与 Task 领域查询共享字段。
 */
export type TaskMonitorAppliedQuery = TaskHistoryQuery;

export type TaskMonitorDecoded = {
  query: TaskMonitorAppliedQuery;
  taskKey?: string;
  /** 深层链接带 cursor 时无法就地伪造前页栈，页面据此禁用「上一页」。 */
  opaqueCursor: boolean;
};

export type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/**
 * 从 URLSearchParams 解码监控查询：未知/无效参数规范化（忽略）而非报错，未知状态/模型类型
 * 显式拒绝（`parseTaskHistoryQuery` 的稳定错误码）。绝不读取 prompt/parameters/media URL。
 */
export function decodeTaskMonitorSearch(search: URLSearchParams): DecodeResult<TaskMonitorDecoded> {
  const input: Record<string, unknown> = {};
  // 先做旧深链接白名单转换（含 tab→state/states），未知/旧参数被规范化丢弃。
  for (const [key, value] of convertLegacyTaskHistorySearch(search).entries()) {
    if (value === "") continue;
    input[key] = value;
  }
  // 允许参数白名单之外的键被忽略（规范化），只消费已知键。
  const parsed = parseTaskHistoryQuery(input);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };
  const taskKey = typeof input.taskKey === "string" && input.taskKey.trim() !== "" ? input.taskKey.trim() : undefined;
  const query: TaskMonitorAppliedQuery = {
    ...parsed.query
  };
  delete (query as { taskKey?: string }).taskKey;
  return {
    ok: true,
    value: { query, ...(taskKey ? { taskKey } : {}), opaqueCursor: parsed.query.cursor !== undefined }
  };
}

/** 把已应用查询编码为规范 URLSearchParams（稳定顺序；不含草稿/prompt/媒体）。 */
export function encodeTaskMonitorSearch(input: { query: TaskMonitorAppliedQuery; taskKey?: string }): URLSearchParams {
  const params = new URLSearchParams();
  const { query } = input;
  if (query.state) params.set("state", query.state);
  if (query.states && query.states.length > 0) params.set("states", [...query.states].join(","));
  if (query.providerId) params.set("providerId", query.providerId);
  if (query.modelType) params.set("modelType", query.modelType);
  if (query.modelKey) params.set("modelKey", query.modelKey);
  if (query.canvasId) params.set("canvasId", query.canvasId);
  if (query.nodeId) params.set("nodeId", query.nodeId);
  if (query.source) params.set("source", query.source);
  if (query.extensionId) params.set("extensionId", query.extensionId);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.cursor) params.set("cursor", query.cursor);
  if (input.taskKey) params.set("taskKey", input.taskKey);
  return params;
}

/** 旧 `/task-history` 白名单转换：只保留受支持参数，其余丢弃。 */
export function convertLegacyTaskHistorySearch(search: URLSearchParams): URLSearchParams {
  const known = ["state", "states", "providerId", "modelType", "modelKey", "canvasId", "nodeId", "source", "extensionId", "from", "to", "cursor", "taskKey"];
  const out = new URLSearchParams();
  for (const key of known) {
    const value = search.get(key);
    if (value) out.set(key, value);
  }
  // 旧 `?tab=` 深链接迁移（change: 2026-10-13-...，任务 9.1）：映射为新监控的状态筛选，
  // 仅在未显式给出 state/states 时生效，避免覆盖新参数。
  if (!out.has("state") && !out.has("states")) {
    const legacy = legacyTabStates(search.get("tab"));
    if (legacy.state) out.set("state", legacy.state);
    if (legacy.states) out.set("states", legacy.states.join(","));
  }
  return out;
}

/** 旧 tab（all/active/succeeded/failed/cancelled）→ 新 state/states；未知 tab 忽略。 */
function legacyTabStates(tab: string | null): { state?: TaskExecutionState; states?: TaskExecutionState[] } {
  switch (tab) {
    case "active":
      return { states: ["queued", "pending", "running"] };
    case "succeeded":
    case "failed":
    case "cancelled":
      return { state: tab };
    default:
      return {};
  }
}

/**
 * 页面用的状态中文标签（状态文字不只依赖颜色）。
 *
 * 权威定义在 `shared/task-trace/format.ts`（独立页面与画布内「生成溯源」浮窗共用）；此处
 * 保留 re-export 以稳定既有页面 import（change: 生成溯源改为画布内浮窗）。
 */
export { TASK_STATE_LABELS } from "../../shared/task-trace/format.js";
