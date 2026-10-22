/**
 * Task 历史 repository：查询编译与分页
 * （自 `history-repository.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R04）。
 *
 * 查询函数接受受控 `HistoryQueryContext`（同一 db/transaction），不自行开启新事务；
 * cursor/prune floor 仍由 repository owner 管理。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  decodeCanvasActivityCursor,
  encodeCanvasActivityCursor,
  historyQueryFingerprint,
  TASK_HISTORY_DEFAULT_PAGE_SIZE,
  TASK_HISTORY_MAX_EVENT_BATCH,
  TASK_HISTORY_MAX_PAGE_SIZE,
  type CanvasTaskActivity,
  type CanvasTaskActivityQuery,
  type CanvasTaskActivitySnapshot,
  type TaskExecutionDetail,
  type TaskExecutionEvent,
  type TaskHistoryCandidateModel,
  type TaskHistoryCandidateQuery,
  type TaskHistoryCandidates,
  type TaskHistoryIncrementalBatch,
  type TaskHistoryPage,
  type TaskHistoryQuery,
  type TaskHistoryQueryErrorCode,
  type TaskModelType,
  type TaskRequestSummary,
  type TaskExecutionSummary
} from "@woohaa3/contracts";
import type { EventRow, RecordRow } from "./types.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { TASK_EXECUTION_STATES, type TaskExecutionState } from "@woohaa3/contracts";
import { eventRowsToEvents, notNull, rowToActivity, toSummary } from "./row-mapping.js";

export type HistoryQueryContext = {
  db: DatabaseSync;
  maxEventsPerRecord: number;
  currentCursor: () => number;
  prunedFloor: () => number;
  row: (taskKey: string) => RecordRow | undefined;
  events: (taskKey: string) => TaskExecutionEvent[];
};

/** history 列表查询结果：成功返回分页，失败返回稳定查询错误（含 cursor 错配）。 */
export type HistoryListResult =
  | { ok: true; page: TaskHistoryPage }
  | { ok: false; code: TaskHistoryQueryErrorCode; message: string };

/**
 * 读取单条详情。
 */
export function getHistoryDetail(
  ctx: HistoryQueryContext,
  taskKey: string,
  options: { includeRequest?: boolean; fullText?: boolean } = {}
): TaskExecutionDetail | undefined {
  const row = ctx.row(taskKey);
  if (!row) return undefined;
  const summary = toSummary(row);
  const result = options.fullText && row.full_text !== null && summary.result
    ? { ...summary.result, text: row.full_text }
    : summary.result;
  const events = ctx.events(taskKey);
  const eventsTruncated = (row.last_event_sequence ?? -1) > ctx.maxEventsPerRecord;
  return {
    ...summary,
    ...(result ? { result } : {}),
    events,
    ...(eventsTruncated ? { eventsTruncated: true } : {}),
    ...(options.includeRequest && row.request_json
      ? {
          request: {
            ...(JSON.parse(row.request_json) as TaskRequestSummary),
            ...(row.request_truncated ? { promptTruncated: true, parametersTruncated: true } : {})
          }
        }
      : {})
  };
}

/**
 * 稳定分页：`(createdAt DESC, taskKey DESC)`，cursor 编码排序位置与**规范化查询指纹**。
 */
export function listHistory(ctx: HistoryQueryContext, query: TaskHistoryQuery): HistoryListResult {
  const fingerprint = historyQueryFingerprint(query);
  const limit = Math.min(Math.max(query.limit ?? TASK_HISTORY_DEFAULT_PAGE_SIZE, 1), TASK_HISTORY_MAX_PAGE_SIZE);
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  const states = query.states && query.states.length > 0 ? query.states : query.state ? [query.state] : null;
  if (states && states.length > 0) {
    clauses.push(`state IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
  }
  if (query.providerId) {
    clauses.push("provider_id = ?");
    params.push(query.providerId);
  }
  if (query.modelType) {
    clauses.push("model_type = ?");
    params.push(query.modelType);
  }
  if (query.modelKey) {
    clauses.push("model_key = ?");
    params.push(query.modelKey);
  }
  if (query.canvasId) {
    clauses.push("canvas_id = ?");
    params.push(query.canvasId);
  }
  if (query.nodeId) {
    clauses.push("node_id = ?");
    params.push(query.nodeId);
  }
  if (query.taskKey) {
    clauses.push("task_key = ?");
    params.push(query.taskKey);
  }
  if (query.source) {
    // 旧记录 source 为 NULL：显式 unknown 查询覆盖「未记录」来源。
    if (query.source === "unknown") {
      clauses.push("(source IS NULL OR source = 'unknown')");
    } else {
      clauses.push("source = ?");
      params.push(query.source);
    }
  }
  if (query.extensionId) {
    clauses.push("extension_id = ?");
    params.push(query.extensionId);
  }
  if (query.from) {
    clauses.push("created_at >= ?");
    params.push(query.from);
  }
  if (query.to) {
    clauses.push("created_at <= ?");
    params.push(query.to);
  }

  const decoded = decodeCursor(query.cursor);
  if (query.cursor && !decoded) {
    return { ok: false, code: "invalid-cursor", message: "cursor 非法" };
  }
  if (decoded) {
    if (decoded.fingerprint !== fingerprint) {
      return { ok: false, code: "cursor-mismatch", message: "cursor 与当前查询条件不匹配" };
    }
    clauses.push("(created_at < ? OR (created_at = ? AND task_key < ?))");
    params.push(decoded.createdAt, decoded.createdAt, decoded.taskKey);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = ctx.db
    .prepare(
      `SELECT * FROM task_execution_records ${where}
        ORDER BY created_at DESC, task_key DESC
        LIMIT ?`
    )
    .all(...params, limit + 1) as RecordRow[];
  const items = rows.slice(0, limit).map(toSummary);
  const last = items.at(-1);
  const page: TaskHistoryPage = {
    items,
    watermark: ctx.currentCursor(),
    ...(rows.length > limit && last
      ? { nextCursor: encodeCursor({ createdAt: last.createdAt, taskKey: last.taskKey }, fingerprint) }
      : {})
  };
  return { ok: true, page };
}

/**
 * 自 cursor 起读取变更记录的快照（history 补偿与事件流共用，可重复读取）。
 */
export function listHistorySince(ctx: HistoryQueryContext, cursor: number, limit = TASK_HISTORY_MAX_EVENT_BATCH): TaskHistoryIncrementalBatch {
  const bounded = Math.min(Math.max(limit, 1), TASK_HISTORY_MAX_EVENT_BATCH);
  const floor = ctx.prunedFloor();
  const high = ctx.currentCursor();
  if (cursor < floor || cursor > high) {
    return {
      messages: [],
      cursor: high,
      hasMore: false,
      resync: true
    };
  }
  const rows = ctx.db
    .prepare(
      `SELECT * FROM task_execution_records
        WHERE cursor > ?
        ORDER BY cursor ASC
        LIMIT ?`
    )
    .all(cursor, bounded + 1) as RecordRow[];
  const page = rows.slice(0, bounded);
  const messages = page.map((row) => ({ record: toSummary(row), cursor: row.cursor }));
  const next = messages.length > 0 ? messages[messages.length - 1].cursor : cursor;
  return {
    messages,
    cursor: next,
    hasMore: rows.length > bounded
  };
}

/**
 * 有界筛选候选：保留期内出现过的 Provider 与模型（含已下线模型）。
 */
export function listHistoryCandidates(ctx: HistoryQueryContext, query: TaskHistoryCandidateQuery = {}): TaskHistoryCandidates {
  const limit = Math.min(Math.max(query.limit ?? 200, 1), 500);
  const providerRows = ctx.db
    .prepare(
      `SELECT provider_id AS providerId, MAX(provider_name) AS providerName
         FROM task_execution_records
        GROUP BY provider_id
        ORDER BY provider_id ASC
        LIMIT ?`
    )
    .all(limit) as Array<{ providerId: string; providerName: string | null }>;

  const clauses = ["model_key IS NOT NULL"];
  const params: Array<string | number> = [];
  if (query.providerId) {
    clauses.push("provider_id = ?");
    params.push(query.providerId);
  }
  if (query.modelType) {
    clauses.push("model_type = ?");
    params.push(query.modelType);
  }
  const modelRows = ctx.db
    .prepare(
      `SELECT provider_id AS providerId, model_type AS modelType, model_key AS modelKey,
              MAX(model_title) AS modelTitle, MAX(provider_name) AS providerName
         FROM task_execution_records
        WHERE ${clauses.join(" AND ")}
        GROUP BY provider_id, model_type, model_key
        ORDER BY provider_id ASC, model_key ASC
        LIMIT ?`
    )
    .all(...params, limit) as Array<{
    providerId: string;
    modelType: string | null;
    modelKey: string;
    modelTitle: string | null;
    providerName: string | null;
  }>;

  const extensionRows = ctx.db
    .prepare(
      `SELECT DISTINCT extension_id AS extensionId
         FROM task_execution_records
        WHERE extension_id IS NOT NULL
        ORDER BY extension_id ASC
        LIMIT ?`
    )
    .all(limit) as Array<{ extensionId: string }>;

  return {
    providers: providerRows.map((row) => ({
      providerId: row.providerId,
      ...(row.providerName ? { providerName: row.providerName } : {})
    })),
    models: modelRows.flatMap((row) => {
      if (!row.modelType) return [];
      return [
        {
          providerId: row.providerId,
          modelType: row.modelType as TaskModelType,
          modelKey: row.modelKey,
          ...(row.modelTitle ? { modelTitle: row.modelTitle } : {}),
          ...(row.providerName ? { providerName: row.providerName } : {})
        } satisfies TaskHistoryCandidateModel
      ];
    }),
    plugins: extensionRows.map((row) => ({ extensionId: row.extensionId }))
  };
}

/**
 * Canvas-scoped 活动快照
 * （change: 2026-09-29-add-canvas-task-activity-feed，任务 1.2 / 1.3 / design D3）。
 */
export function listCanvasActivity(ctx: HistoryQueryContext, canvasId: string, query: CanvasTaskActivityQuery = {}): CanvasTaskActivitySnapshot {
  const limit = Math.min(Math.max(query.limit ?? TASK_HISTORY_DEFAULT_PAGE_SIZE, 1), TASK_HISTORY_MAX_PAGE_SIZE);
  const activeRows = ctx.db
    .prepare(
      `SELECT * FROM task_execution_records
        WHERE canvas_id = ? AND state IN ('queued','pending','running')
        ORDER BY created_at ASC, task_key ASC`
    )
    .all(canvasId) as RecordRow[];

  const clauses = ["canvas_id = ?", "state IN ('succeeded','failed','cancelled')"];
  const params: Array<string | number> = [canvasId];
  const cursor = decodeCanvasActivityCursor(query.cursor);
  if (cursor) {
    clauses.push("(created_at < ? OR (created_at = ? AND task_key < ?))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.taskKey);
  }
  const recentRows = ctx.db
    .prepare(
      `SELECT * FROM task_execution_records
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, task_key DESC
        LIMIT ?`
    )
    .all(...params, limit + 1) as RecordRow[];

  const recent = recentRows.slice(0, limit).map(rowToActivity).filter(notNull);
  const last = recent.at(-1);
  return {
    active: activeRows.map(rowToActivity).filter(notNull),
    recent,
    ...(recentRows.length > limit && last
      ? { nextCursor: encodeCanvasActivityCursor({ createdAt: last.createdAt, taskKey: last.taskKey }) }
      : {}),
    cursor: ctx.currentCursor()
  };
}

/**
 * 自 cursor 起的画布活动变更（可恢复事件流与断线补偿共用，可重复读取）。
 */
export function listCanvasActivitySince(
  ctx: HistoryQueryContext,
  canvasId: string,
  cursor: number,
  limit = 200
): { items: CanvasTaskActivity[]; cursor: number } {
  const rows = ctx.db
    .prepare(
      `SELECT * FROM task_execution_records
        WHERE canvas_id = ? AND cursor > ?
        ORDER BY cursor ASC
        LIMIT ?`
    )
    .all(canvasId, cursor, Math.min(Math.max(limit, 1), TASK_HISTORY_MAX_PAGE_SIZE)) as RecordRow[];
  return {
    items: rows.map(rowToActivity).filter(notNull),
    cursor: rows.length > 0 ? rows[rows.length - 1].cursor : cursor
  };
}

/** 画布是否有任何活动/最近记录（用于 ACL 前置判定后的空快照短路，不泄露计数）。 */
export function canvasHasActivity(ctx: HistoryQueryContext, canvasId: string): boolean {
  const row = ctx.db
    .prepare("SELECT 1 AS present FROM task_execution_records WHERE canvas_id = ? LIMIT 1")
    .get(canvasId) as { present: number } | undefined;
  return row !== undefined;
}

/**
 * 列出全部非终态记录（重启后终态对账的候选集）。
 *
 * 与 `listUnsettledBefore` 的区别：这里按 `created_at` 升序取全量（有上限），
 * 不看宽限期——调用方（启动对账）自己用调度侧终态判断该不该补写。
 */
export function listUnsettled(ctx: HistoryQueryContext, limit = 200): TaskExecutionSummary[] {
  const rows = ctx.db
    .prepare(
      `SELECT * FROM task_execution_records
        WHERE state IN ('queued','pending','running')
        ORDER BY created_at ASC, task_key ASC
        LIMIT ?`
    )
    .all(Math.min(Math.max(limit, 1), TASK_HISTORY_MAX_PAGE_SIZE * 5)) as RecordRow[];
  return rows.map(toSummary);
}

/**
 * 列出处于非终态、且处于 `before` 之前的**候选**记录。
 */
export function listUnsettledBefore(ctx: HistoryQueryContext, before: string): TaskExecutionSummary[] {
  const rows = ctx.db
    .prepare(
      `SELECT * FROM task_execution_records
        WHERE state IN ('queued','pending','running') AND created_at < ?
        ORDER BY created_at ASC`
    )
    .all(before) as RecordRow[];
  return rows.map(toSummary);
}

/**
 * 全局状态计数：来自**全局聚合**，不是当前页行数求和
 * （change: 2026-10-13-...，任务 7.4/7.5 / design D9；恢复自迁移前的 `queries.ts`）。
 */
export function countHistoryStates(ctx: HistoryQueryContext): Record<TaskExecutionState, number> {
  const rows = ctx.db
    .prepare(`SELECT state, COUNT(*) AS count FROM task_execution_records GROUP BY state`)
    .all() as Array<{ state: string; count: number }>;
  const counts = Object.fromEntries(TASK_EXECUTION_STATES.map((state) => [state, 0])) as Record<TaskExecutionState, number>;
  for (const row of rows) {
    if ((TASK_EXECUTION_STATES as readonly string[]).includes(row.state)) {
      counts[row.state as TaskExecutionState] = row.count;
    }
  }
  return counts;
}

export { eventRowsToEvents, notNull, rowToActivity, toSummary };
export type { EventRow };
