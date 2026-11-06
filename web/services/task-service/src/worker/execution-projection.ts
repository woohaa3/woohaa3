/**
 * Task worker 运行时：execution record → durable history read model 投影
 * （自 `runtime.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R25）。
 */
import type { ExecutionRecord } from "@sdppp/pptask-worker-server/history";
import type { TaskExecutionState, TaskResultSummary } from "@woohaa3/contracts";
import { describeTaskFailure } from "@woohaa3/contracts";
import type { SqliteTaskHistoryRepository } from "../repository/history-repository.js";
import type { TaskAssociation } from "./types.js";

/**
 * 把 execution record 投影进 durable history read model。
 *
 * 这是「history 是唯一事实源」的落点：worker 的 scheduling + execution 事实都合并到
 * 同一 taskKey 记录，并只写安全字段。
 */
export function projectExecutionRecord(
  history: SqliteTaskHistoryRepository,
  record: ExecutionRecord,
  association?: Partial<TaskAssociation>,
  resultOverride?: TaskResultSummary,
  stateOverride?: TaskExecutionState,
  errorOverride?: { name?: string; message: string }
): void {
  const state = stateOverride ?? mapState(record.state);
  const result = resultOverride ?? readSafeResult(record);
  // 完整文本结果单独保存，供 Canvas 节点历史登记；浏览器历史仍只读摘要。
  const fullText = result?.mediaKind === "text" && result.text !== undefined ? result.text : undefined;
  const error =
    errorOverride ??
    (record.error?.message
      ? {
          name: record.error.name,
          message: describeTaskFailure({
            message: record.error.message,
            ...(record.error.status !== undefined ? { status: record.error.status } : {}),
            ...(record.error.code !== undefined ? { code: record.error.code } : {})
          }),
          ...(record.error.status !== undefined ? { status: record.error.status } : {}),
          ...(record.error.code !== undefined ? { code: record.error.code } : {})
        }
      : undefined);
  history.upsertRecord({
    taskKey: record.id,
    state,
    providerId: record.providerId,
    ...(record.modelType ? { modelType: record.modelType } : {}),
    ...(readMetadataString(record, "modelKey") ? { modelKey: readMetadataString(record, "modelKey") as string } : {}),
    canvasId: association?.canvasId ?? readMetadataString(record, "canvasId"),
    nodeId: association?.nodeId ?? readMetadataString(record, "nodeId"),
    runId: association?.runId ?? readMetadataString(record, "runId"),
    jobId: association?.jobId ?? readMetadataString(record, "jobId") ?? record.jobId,
    // 上游 Provider 任务号：execution record 从 job operation 里提取的 taskId。
    ...(record.taskId ? { upstreamTaskId: record.taskId } : {}),
    ...(record.progress !== undefined ? { progress: record.progress } : {}),
    ...(record.attempt !== undefined ? { attempt: record.attempt } : {}),
    ...(result ? { result } : {}),
    ...(fullText !== undefined ? { resultFullText: fullText } : {}),
    ...(error ? { error } : {}),
    createdAt: record.createdAt,
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    updatedAt: record.updatedAt,
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
    durationMs: record.durationMs
  });

  // 事件时间线：增量追加。
  // 之前只写最后一条，导致重试/多次状态变化在历史里看不见；这里按「最后一条已落库事件的时刻 + 该时刻
  // 已落库条数」增量补齐——用时刻定位可以避免事件超上限被裁剪后索引错位，用条数兜住同一毫秒内的
  // 连续状态变化（created/submitting 常落在同一毫秒）。
  const tail = history.lastEventTail(record.id);
  const pendingEvents = tail === undefined
    ? record.events
    : [
        ...record.events.filter((event) => event.at === tail.occurredAt).slice(tail.count),
        ...record.events.filter((event) => event.at > tail.occurredAt)
      ];
  // 进度事件按最小间隔限流：轮询每秒一条 progress，全量落库会很快吃满 200 条上限，
  // 把真正有价值的阶段迁移（入队/受理/失败）挤出保留窗口。只对**连续同一进度阶段**限流，
  // 状态迁移一条不丢。
  let lastPersisted = history.lastEvent(record.id);
  for (const event of pendingEvents) {
    if (lastPersisted && shouldThrottleProgress(event.stage, event.at, lastPersisted)) continue;
    history.appendEvent({
      taskKey: record.id,
      kind: event.kind ?? "execution",
      stage: event.stage,
      detail: asDetail(event.detail),
      occurredAt: event.at
    });
    lastPersisted = { stage: event.stage, occurredAt: event.at };
  }
}

/** 纯进度阶段：这些事件的唯一作用是刷新进度，不需要逐条持久化。 */
const PROGRESS_STAGES = new Set(["pptask.progress", "pptask.running", "provider.progress"]);

/** 连续同一进度阶段的最小落库间隔（毫秒）。 */
const PROGRESS_MIN_INTERVAL_MS = 10_000;

/** 连续同一进度阶段且距上次落库不足最小间隔时跳过（状态迁移不受影响）。 */
function shouldThrottleProgress(
  stage: string,
  at: string,
  last: { stage: string; occurredAt: string }
): boolean {
  if (!PROGRESS_STAGES.has(stage) || last.stage !== stage) return false;
  const current = Date.parse(at);
  const previous = Date.parse(last.occurredAt);
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return false;
  return current - previous < PROGRESS_MIN_INTERVAL_MS;
}

export function mapState(state: ExecutionRecord["state"]): TaskExecutionState {
  switch (state) {
    case "queued":
    case "pending":
    case "running":
    case "succeeded":
    case "failed":
    case "cancelled":
      return state;
    default:
      return "pending";
  }
}

/** 只保留稳定媒体 metadata；绝不写 bytes / provider URL / 签名 URL。 */
export function readSafeResult(record: ExecutionRecord): TaskResultSummary | undefined {
  const outputs = record.result?.outputs ?? [];
  const binary = outputs.find((output) =>
    output.url && (output.kind === "image" || output.kind === "video" || output.kind === "audio")
  );
  if (binary?.url && (binary.kind === "image" || binary.kind === "video" || binary.kind === "audio")) {
    // provider 输出 URL 不落历史：只记录媒体类型占位（真实 storageKey 由 Media import 后写入）。
    return { mediaKind: binary.kind };
  }
  const text = outputs.find((output) => output.kind === "text" && output.text);
  if (text?.text !== undefined) return { mediaKind: "text", text: text.text };
  return undefined;
}

/** 从 execution record 读取时长（若 provider 输出提供）。 */
export function readDurationFromRecord(record: ExecutionRecord): number | undefined {
  const outputs = record.result?.outputs ?? [];
  for (const output of outputs) {
    const candidate = (output as { durationSeconds?: unknown }).durationSeconds;
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return undefined;
}

export function readMetadataString(record: ExecutionRecord, key: string): string | undefined {
  const metadata = record.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function asDetail(detail: unknown): Record<string, unknown> | undefined {
  return detail && typeof detail === "object" && !Array.isArray(detail)
    ? (detail as Record<string, unknown>)
    : detail === undefined
      ? undefined
      : { value: detail };
}

export function isTerminalRecord(record: ExecutionRecord): boolean {
  return record.state === "succeeded" || record.state === "failed" || record.state === "cancelled";
}

/** 投影里若已带受控下载地址，直接用它（少数 provider 返回 URL）。 */
export function readBinaryOutputUrl(
  record: ExecutionRecord,
  modelType: "image" | "video" | "audio"
): string | undefined {
  const outputs = record.result?.outputs ?? [];
  const match = outputs.find(
    (output) => output.kind === modelType && typeof output.url === "string" && output.url !== ""
  );
  return match?.url;
}

/** 投影里已有文本输出时不需要按二进制转存。 */
export function hasTextOutput(record: ExecutionRecord): boolean {
  return (record.result?.outputs ?? []).some(
    (output) => output.kind === "text" && typeof output.text === "string" && output.text !== ""
  );
}
