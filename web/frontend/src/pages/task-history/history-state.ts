/**
 * 历史页纯状态/合并逻辑（change: 2026-10-06-improve-task-history-experience，任务 3.1/3.3）。
 *
 * 与 React/DOM 无关，便于单测：已应用筛选谓词、tab→states 映射、按 taskKey + 较新 revision
 * 的幂等合并，以及「新任务」缓冲判定。事件合并只按**完整已应用查询谓词**处理，非匹配记录不
 * 插入；已展示但离开条件的记录保留为明确「已不匹配」占位以保护滚动/焦点。
 */
import type { TaskExecutionSource, TaskExecutionState, TaskExecutionSummary, TaskModelType } from "@woohaa3/contracts";

/** 已应用筛选（不含状态 tab；状态由 tab 独立表达）。 */
export type HistoryFilters = {
  providerId: string;
  modelType: "" | TaskModelType;
  modelKey: string;
  canvasId: string;
  nodeId: string;
  taskKey: string;
  /** 执行来源筛选（阶段二 D1）。 */
  source: "" | TaskExecutionSource;
  /** 受信任插件身份筛选。 */
  extensionId: string;
  /** ISO UTC（含边界）。 */
  from: string;
  to: string;
};

export const EMPTY_HISTORY_FILTERS: HistoryFilters = {
  providerId: "",
  modelType: "",
  modelKey: "",
  canvasId: "",
  nodeId: "",
  taskKey: "",
  source: "",
  extensionId: "",
  from: "",
  to: ""
};

export type HistoryTab = "all" | "active" | "succeeded" | "failed" | "cancelled";

/** tab → 服务端 `states` 查询；all 不限定。 */
export function tabToStates(tab: HistoryTab): TaskExecutionState[] | undefined {
  if (tab === "all") return undefined;
  if (tab === "active") return ["queued", "pending", "running"];
  return [tab];
}

/** 记录是否匹配 tab 状态。 */
export function recordMatchesTab(record: TaskExecutionSummary, tab: HistoryTab): boolean {
  const states = tabToStates(tab);
  return states === undefined || states.includes(record.state);
}

/** 记录是否匹配已应用筛选（完整谓词）。 */
export function recordMatchesFilters(record: TaskExecutionSummary, filters: HistoryFilters): boolean {
  if (filters.providerId && record.providerId !== filters.providerId) return false;
  if (filters.modelType && record.modelType !== filters.modelType) return false;
  if (filters.modelKey && record.modelKey !== filters.modelKey) return false;
  if (filters.canvasId && record.canvasId !== filters.canvasId) return false;
  if (filters.nodeId && record.nodeId !== filters.nodeId) return false;
  if (filters.taskKey && record.taskKey !== filters.taskKey) return false;
  if (filters.source) {
    // 旧记录缺失来源：只有显式 unknown 才匹配；其余来源不匹配未记录记录。
    const recordSource = record.source ?? "unknown";
    if (recordSource !== filters.source) return false;
  }
  if (filters.extensionId && record.extensionId !== filters.extensionId) return false;
  if (filters.from && record.createdAt < filters.from) return false;
  if (filters.to && record.createdAt > filters.to) return false;
  return true;
}

/** 列表项是否为「离开当前查询的占位」。 */
export type HistoryRow = TaskExecutionSummary & {
  /** 该行已不再匹配当前已应用查询，但在刷新前保留以保护滚动/焦点。 */
  unmatched?: boolean;
};

export type MergeResult = {
  rows: HistoryRow[];
  /** 未展示且匹配的新任务（应进入去重新任务缓冲，而不是插入当前页）。 */
  isNew: boolean;
};

/**
 * 按 taskKey + 较新 `recordRevision` 幂等合并一条实时记录。
 *
 * - 已展示项：较新 revision 原位更新；离开查询条件的记录标记 `unmatched`（保护滚动）。
 * - 未展示项：匹配查询的返回 `isNew: true`（进入去重缓冲）；不匹配的忽略。
 * - 重复/乱序（revision 不更大）不修改列表。
 */
export function mergeHistoryRecord(rows: readonly HistoryRow[], record: TaskExecutionSummary, filters: HistoryFilters): MergeResult {
  const index = rows.findIndex((row) => row.taskKey === record.taskKey);
  if (index < 0) {
    const isNew = recordMatchesFilters(record, filters);
    return { rows: rows as HistoryRow[], isNew };
  }
  const current = rows[index]!;
  if (record.recordRevision <= current.recordRevision) {
    return { rows: rows as HistoryRow[], isNew: false };
  }
  const matches = recordMatchesFilters(record, filters);
  const next = [...rows];
  next[index] = { ...record, ...(matches ? {} : { unmatched: true }) };
  return { rows: next, isNew: false };
}

/** 去重新任务缓冲：只按 taskKey 记录，计数代表缓冲，不代表全局总数。 */
export function addBufferedTaskKeys(buffer: readonly string[], taskKey: string): string[] {
  if (buffer.includes(taskKey)) return buffer as string[];
  return [...buffer, taskKey];
}

/** 当前页签选择：命中优先；不在当前页时返回 undefined（深链接详情独立读取）。 */
export function adjacentTaskKeys(rows: readonly HistoryRow[], taskKey: string | undefined): { previous?: string; next?: string } {
  if (!taskKey) return {};
  const index = rows.findIndex((row) => row.taskKey === taskKey);
  if (index < 0) return {};
  return {
    ...(index > 0 ? { previous: rows[index - 1]!.taskKey } : {}),
    ...(index < rows.length - 1 ? { next: rows[index + 1]!.taskKey } : {})
  };
}
