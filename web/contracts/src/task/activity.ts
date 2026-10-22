/**
 * Canvas-scoped task activity read model
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 1.1 / design D3）。
 *
 * 与全局 operator/admin Task History **严格分权**：这是只面向前端画布活动栈的**安全摘要**，
 * 只投影当前 canvas 的记录，字段比 `TaskExecutionSummary` 更少。它刻意不含：
 *
 * - `providerId` / `attempt` / 事件时间线 / 请求摘要（prompt、parameters）；
 * - provider 原始 input/output、URL、签名 URL、Authorization、stack、媒体 bytes；
 * - 其它 canvas 的身份。
 *
 * 关联键：`taskKey`（durable 主键）优先、`runId`（业务关联）兜底；`nodeId` 用于定位节点。
 * 只有同时具备 `runId` 与 `nodeId` 的记录才可进入活动投影（避免内部无画布关联的任务泄漏）。
 */
import { isBoundedId,
  isFiniteNumber,
  isJsonObject,
  isNonEmptyString,
  isNonNegativeInteger } from "../validation.js";
import {
  isTaskExecutionState,
  type TaskErrorSummary,
  type TaskExecutionState,
  type TaskExecutionSummary,
  type TaskResultSummary
} from "./history.js";
import type { CanvasTaskModelType } from "./dto.js";

/** 单页上限与 active 预算（服务端必须夹紧，拒绝超限 page size）。 */
export const CANVAS_TASK_ACTIVITY_LIMITS = {
  defaultPageSize: 50,
  maxPageSize: 100,
  /** 一次快照最多返回的进行中项（active 不由保留期裁剪，但快照仍有界）。 */
  maxActiveItems: 100
} as const;

/**
 * 卡片所需的安全活动项。
 *
 * `taskKey` 与 `runId` 同时存在时，store 先按 taskKey 合并、尚未取得 taskKey 时按 runId 合并。
 */
export type CanvasTaskActivity = {
  /** durable 任务主键。 */
  taskKey: string;
  /** 业务 run 关联键；optimistic 合并兜底。 */
  runId: string;
  /** 权威画布节点身份。 */
  nodeId: string;
  state: TaskExecutionState;
  /** 模型类型摘要（用于卡片与图标）。 */
  modelType?: "language" | "image" | "video" | "audio";
  modelKey?: string;
  /** 权威进度（0..1）；缺失时前端不得伪造百分比。 */
  progress?: number;
  /** 安全结果摘要（只含 storageKey 等白名单字段）。 */
  result?: TaskResultSummary;
  /** 安全错误摘要（只含 name/message）。 */
  error?: TaskErrorSummary;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  finishedAt?: string;
  durationMs: number;
};

/**
 * 有界活动快照。
 *
 * `active` 是当前画布全部 queued/pending/running（不受保留期与分页影响）；`recent` 是保留期内
 * 终态记录，按 `(createdAt DESC, taskKey DESC)` 分页；`cursor` 是快照时刻的事件高水位，
 * 客户端据此启动可恢复事件流或轮询补偿。
 */
export type CanvasTaskActivitySnapshot = {
  active: CanvasTaskActivity[];
  recent: CanvasTaskActivity[];
  /** 更旧 `recent` 的分页 cursor；缺失表示已到末尾。 */
  nextCursor?: string;
  /** 事件高水位（单调）。 */
  cursor: number;
};

/** 快照查询（服务端做上限与校验）。 */
export type CanvasTaskActivityQuery = {
  cursor?: string;
  limit?: number;
};

/** 活动事件消息：只对应已持久化事实，cursor 单调可恢复。 */
export type CanvasTaskActivityEventMessage = {
  record: CanvasTaskActivity;
  cursor: number;
};

/** 事件流批量（Canvas ↔ Task 内部补偿用）。 */
export type CanvasTaskActivityEventBatch = {
  items: CanvasTaskActivity[];
  cursor: number;
};

function isTaskResultSummaryLoose(value: unknown): value is TaskResultSummary {
  if (!isJsonObject(value)) return false;
  if (
    value.mediaKind !== "text" &&
    value.mediaKind !== "image" &&
    value.mediaKind !== "video" &&
    value.mediaKind !== "audio"
  ) {
    return false;
  }
  return true;
}

function isTaskErrorSummaryLoose(value: unknown): value is TaskErrorSummary {
  if (!isJsonObject(value)) return false;
  return typeof value.message === "string" && (value.name === undefined || typeof value.name === "string");
}

export function isCanvasTaskActivity(value: unknown): value is CanvasTaskActivity {
  if (!isJsonObject(value)) return false;
  if (!isBoundedId(value.taskKey)) return false;
  if (!isBoundedId(value.runId)) return false;
  if (!isBoundedId(value.nodeId)) return false;
  if (!isTaskExecutionState(value.state)) return false;
  if (
    value.modelType !== undefined &&
    value.modelType !== "language" &&
    value.modelType !== "image" &&
    value.modelType !== "video" &&
    value.modelType !== "audio"
  ) {
    return false;
  }
  if (value.modelKey !== undefined && typeof value.modelKey !== "string") return false;
  if (value.progress !== undefined && !isFiniteNumber(value.progress)) return false;
  if (value.result !== undefined && !isTaskResultSummaryLoose(value.result)) return false;
  if (value.error !== undefined && !isTaskErrorSummaryLoose(value.error)) return false;
  if (!isNonEmptyString(value.createdAt) || !isNonEmptyString(value.updatedAt)) return false;
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") return false;
  if (value.finishedAt !== undefined && typeof value.finishedAt !== "string") return false;
  if (!isNonNegativeInteger(value.durationMs)) return false;
  return true;
}

export function isCanvasTaskActivitySnapshot(value: unknown): value is CanvasTaskActivitySnapshot {
  if (!isJsonObject(value)) return false;
  if (!Array.isArray(value.active) || !value.active.every(isCanvasTaskActivity)) return false;
  if (!Array.isArray(value.recent) || !value.recent.every(isCanvasTaskActivity)) return false;
  if (value.nextCursor !== undefined && !isNonEmptyString(value.nextCursor)) return false;
  if (!isNonNegativeInteger(value.cursor)) return false;
  return true;
}

export function isCanvasTaskActivityEventMessage(value: unknown): value is CanvasTaskActivityEventMessage {
  if (!isJsonObject(value)) return false;
  return isCanvasTaskActivity(value.record) && isNonNegativeInteger(value.cursor);
}

/** 把不可信查询参数解码为受控查询：limit 夹到上限，cursor 限长。 */
export function decodeCanvasTaskActivityQuery(input: Record<string, unknown>): CanvasTaskActivityQuery {
  const query: CanvasTaskActivityQuery = {};
  if (isNonEmptyString(input.cursor) && input.cursor.length <= 512) query.cursor = input.cursor;
  const limit = Number(input.limit);
  if (Number.isInteger(limit) && limit > 0) query.limit = Math.min(limit, CANVAS_TASK_ACTIVITY_LIMITS.maxPageSize);
  return query;
}

/**
 * 从持久化 summary 投影安全活动项。
 *
 * 缺 `runId` 或 `nodeId` 返回 null（非画布运行任务不得进入画布活动面）。投影只保留卡片所需
 * 白名单字段，绝不携带 provider 身份、attempt、事件或请求摘要。
 */
export function toCanvasTaskActivity(summary: TaskExecutionSummary): CanvasTaskActivity | null {
  if (!summary.runId || !summary.nodeId) return null;
  return {
    taskKey: summary.taskKey,
    runId: summary.runId,
    nodeId: summary.nodeId,
    state: summary.state,
    ...(summary.modelType ? { modelType: summary.modelType } : {}),
    ...(summary.modelKey ? { modelKey: summary.modelKey } : {}),
    ...(summary.progress !== undefined ? { progress: summary.progress } : {}),
    ...(summary.result ? { result: summary.result } : {}),
    ...(summary.error ? { error: summary.error } : {}),
    createdAt: summary.createdAt,
    ...(summary.startedAt ? { startedAt: summary.startedAt } : {}),
    updatedAt: summary.updatedAt,
    ...(summary.finishedAt ? { finishedAt: summary.finishedAt } : {}),
    durationMs: summary.durationMs
  };
}

// ---------------------------------------------------------------------------
// 任务活动前端事件 payload 与分类 helper
// （change: 2026-10-10-extract-optional-feature-extensions：由 host
//  `frontend/src/cordis/events/task-activity.ts` 迁入 contracts，使 task-activity 扩展与
//  Task Execution 共享同一份浏览器安全契约，不互相 import 宿主/扩展实现）。
// ---------------------------------------------------------------------------

/** 本地已生成稳定 id、即将调用 Canvas Remote 的 optimistic 开始。 */
export type TaskActivityStarted = {
  runId: string;
  jobId: string;
  nodeId: string;
  state: "queued";
  modelType?: CanvasTaskModelType;
  modelKey?: string;
  createdAt: string;
};

/** 权威非终态活动（queued/pending/running 及可选 progress）。 */
export type TaskActivityUpdated = {
  source: "snapshot" | "live" | "recovery";
  cursor: number;
  activity: CanvasTaskActivity & { state: "queued" | "pending" | "running" };
};

/** 权威终态活动。 */
export type TaskActivityFinishedRemote = {
  source: "live" | "recovery";
  cursor: number;
  activity: CanvasTaskActivity & { state: "succeeded" | "failed" | "cancelled" };
};

/** 网关在接受前拒绝：只结算匹配的 optimistic run，不伪造 taskKey/产物。 */
export type TaskActivityFinishedLocalRejection = {
  source: "local-rejection";
  cursor?: never;
  activity: {
    runId: string;
    jobId?: string;
    nodeId: string;
    state: "failed";
    error: { message: string };
    updatedAt: string;
  };
};

export type TaskActivityFinished = TaskActivityFinishedRemote | TaskActivityFinishedLocalRejection;

/** 任务活动事件 payload 联合（供 catalog/type guard 复用）。 */
export type TaskActivityEvent =
  | { name: "task.activity.started"; payload: TaskActivityStarted }
  | { name: "task.activity.updated"; payload: TaskActivityUpdated }
  | { name: "task.activity.finished"; payload: TaskActivityFinished };

/** bridge 分类结果：权威记录只可能是 updated 或 finished。 */
export type TaskActivityClassification =
  | { name: "task.activity.updated"; payload: TaskActivityUpdated }
  | { name: "task.activity.finished"; payload: TaskActivityFinishedRemote };

/** 权威终态状态集合（与 terminal 判定一致）。 */
const TERMINAL_ACTIVITY_STATES = new Set(["succeeded", "failed", "cancelled"]);

/**
 * 把一条已验证的权威活动记录分类为 `updated` 或 `finished`。
 *
 * 只有已通过 `isCanvasTaskActivity` 的记录才应进入这里；分类本身不重复做字段校验。
 */
export function classifyTaskActivity(
  record: CanvasTaskActivity,
  source: "snapshot" | "live" | "recovery",
  cursor: number
): TaskActivityClassification {
  if (TERMINAL_ACTIVITY_STATES.has(record.state)) {
    return {
      name: "task.activity.finished",
      payload: {
        source: source === "snapshot" ? "live" : source,
        cursor,
        activity: record as TaskActivityFinishedRemote["activity"]
      }
    };
  }
  return {
    name: "task.activity.updated",
    payload: {
      source,
      cursor,
      activity: record as TaskActivityUpdated["activity"]
    }
  };
}

/** 本地拒绝事件构造器（submit coordinator 用）。 */
export function localRejectionEvent(input: {
  runId: string;
  jobId?: string;
  nodeId: string;
  error: string;
  updatedAt?: string;
}): { name: "task.activity.finished"; payload: TaskActivityFinishedLocalRejection } {
  return {
    name: "task.activity.finished",
    payload: {
      source: "local-rejection",
      activity: {
        runId: input.runId,
        ...(input.jobId ? { jobId: input.jobId } : {}),
        nodeId: input.nodeId,
        state: "failed",
        error: { message: input.error },
        updatedAt: input.updatedAt ?? new Date().toISOString()
      }
    }
  };
}

/** 是否为本地拒绝变体（type guard）。 */
export function isLocalRejection(
  payload: TaskActivityFinished
): payload is TaskActivityFinishedLocalRejection {
  return payload.source === "local-rejection";
}

/** 结果/错误白名单字段（供实现侧裁剪与测试断言复用）。 */
export const SAFE_ACTIVITY_RESULT_FIELDS = [
  "mediaKind",
  "text",
  "storageKey",
  "contentType",
  "size",
  "checksum",
  "durationSeconds",
  "poster"
] as const;

export const SAFE_ACTIVITY_ERROR_FIELDS = ["name", "message"] as const;

// ---------------------------------------------------------------------------
// opaque pagination cursor（`(createdAt, taskKey)` 倒序位置）
// ---------------------------------------------------------------------------

/**
 * 稳定 opaque recent 分页 cursor：`(createdAt DESC, taskKey DESC)` 位置。
 *
 * 不暴露数据库主键；新记录到达不改变既有 cursor 对旧页的顺序语义。
 */
export function encodeCanvasActivityCursor(input: { createdAt: string; taskKey: string }): string {
  return base64UrlEncode(`${input.createdAt}\u0001${input.taskKey}`);
}

export function decodeCanvasActivityCursor(raw: unknown): { createdAt: string; taskKey: string } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  const decoded = base64UrlDecode(raw);
  if (decoded === null) return null;
  const index = decoded.indexOf("\u0001");
  if (index <= 0) return null;
  const createdAt = decoded.slice(0, index);
  const taskKey = decoded.slice(index + 1);
  if (!createdAt || !taskKey) return null;
  return { createdAt, taskKey };
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const base64 = globalThis.btoa ? globalThis.btoa(binary) : Buffer.from(binary, "binary").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
    const binary = globalThis.atob ? globalThis.atob(withPadding) : Buffer.from(withPadding, "base64").toString("binary");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}
