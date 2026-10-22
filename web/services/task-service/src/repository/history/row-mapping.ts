/**
 * Task 历史 repository：行 DTO 映射
 * （自 `history-repository.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R04）。
 */
import {
  toCanvasTaskActivity,
  type CanvasTaskActivity,
  type TaskAdmissionVersions,
  type TaskErrorSummary,
  type TaskExecutionEvent,
  type TaskExecutionSource,
  type TaskExecutionState,
  type TaskExecutionSummary,
  type TaskModelType,
  type TaskResultSummary
} from "@woohaa3/contracts";
import type { EventRow, RecordRow } from "./types.js";

export function notNull<T>(value: T | null): value is T {
  return value !== null;
}

export function toSummary(row: RecordRow): TaskExecutionSummary {
  const admission: TaskAdmissionVersions = {
    ...(row.catalog_revision !== null ? { catalogRevision: row.catalog_revision } : {}),
    ...(row.schema_revision !== null ? { schemaRevision: row.schema_revision } : {}),
    ...(row.config_version !== null ? { configVersion: row.config_version } : {}),
    ...(row.extension_config_version !== null ? { extensionConfigVersion: row.extension_config_version } : {})
  };
  return {
    taskKey: row.task_key,
    state: row.state as TaskExecutionState,
    providerId: row.provider_id,
    ...(row.provider_name ? { providerName: row.provider_name } : {}),
    ...(row.model_type ? { modelType: row.model_type as TaskModelType } : {}),
    ...(row.model_key ? { modelKey: row.model_key } : {}),
    ...(row.model_title ? { modelTitle: row.model_title } : {}),
    ...(row.canvas_id ? { canvasId: row.canvas_id } : {}),
    ...(row.canvas_title ? { canvasTitle: row.canvas_title } : {}),
    ...(row.node_id ? { nodeId: row.node_id } : {}),
    ...(row.node_title ? { nodeTitle: row.node_title } : {}),
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.upstream_task_id ? { upstreamTaskId: row.upstream_task_id } : {}),
    ...(row.progress !== null ? { progress: row.progress } : {}),
    ...(row.attempt !== null ? { attempt: row.attempt } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) as TaskResultSummary } : {}),
    ...(row.error_json ? { error: JSON.parse(row.error_json) as TaskErrorSummary } : {}),
    // 来源只来自持久化受理事实；旧记录缺失即不猜测（页面显示未知来源）。
    ...(row.source ? { source: row.source as TaskExecutionSource } : {}),
    ...(row.extension_id ? { extensionId: row.extension_id } : {}),
    ...(Object.keys(admission).length > 0 ? { admission } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    updatedAt: row.updated_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    durationMs: row.duration_ms,
    recordRevision: row.cursor
  };
}

export function eventRowsToEvents(rows: EventRow[]): TaskExecutionEvent[] {
  return rows.map((row) => ({
    sequence: row.sequence,
    occurredAt: row.occurred_at,
    kind: row.kind === "scheduling" ? "scheduling" : "execution",
    stage: row.stage,
    ...(row.detail_json ? { detail: JSON.parse(row.detail_json) as Record<string, unknown> } : {})
  }));
}

/**
 * 从持久化行投影安全活动项
 * （change: 2026-09-29-add-canvas-task-activity-feed）。
 *
 * 缺 runId/nodeId 返回 null（非画布运行任务不得进入画布活动面）。
 */
export function rowToActivity(row: RecordRow): CanvasTaskActivity | null {
  return toCanvasTaskActivity(toSummary(row));
}
