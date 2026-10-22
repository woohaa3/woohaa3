/**
 * task-monitor 筛选草稿模型与 URL 查询编解码
 * （自 `task-monitor.tsx` 拆出，change: 2026-10-13-add-enterprise-access-and-production-deployment，
 *  规模门禁 ≤500 行；任务 8.4/8.5 / design D11）。
 *
 * 纯逻辑、无 React/DOM 依赖：草稿 ↔ 领域查询的双向映射、是否有筛选、已应用条件标签。
 * 「区分筛选草稿与已应用条件」的语义在此集中，页面与工具栏共用同一事实源。
 */
import type { TaskExecutionState, TaskHistoryQuery, TaskInspectionSnapshot } from "@woohaa3/contracts";
import { formatLocalTime, sourceLabel, stateLabel } from "./format.js";

/** 页面端可见列表项类型（与 snapshot.items 对齐）。 */
export type MonitorItem = TaskInspectionSnapshot["items"][number];

/** 筛选草稿：所有输入都先落到草稿，只有「应用」才转成已应用查询。 */
export type DraftState = {
  state: string;
  providerId: string;
  modelType: string;
  modelKey: string;
  source: string;
  extensionId: string;
  canvasId: string;
  nodeId: string;
  taskKey: string;
  from: string;
  to: string;
  cursor: string;
};

export function emptyDraft(): DraftState {
  return { state: "", providerId: "", modelType: "", modelKey: "", source: "", extensionId: "", canvasId: "", nodeId: "", taskKey: "", from: "", to: "", cursor: "" };
}

export function draftFromQuery(query: TaskHistoryQuery): DraftState {
  return {
    state: query.state ?? "",
    providerId: query.providerId ?? "",
    modelType: query.modelType ?? "",
    modelKey: query.modelKey ?? "",
    source: query.source ?? "",
    extensionId: query.extensionId ?? "",
    canvasId: query.canvasId ?? "",
    nodeId: query.nodeId ?? "",
    taskKey: query.taskKey ?? "",
    from: query.from ?? "",
    to: query.to ?? "",
    cursor: query.cursor ?? ""
  };
}

export function queryFromDraft(draft: DraftState): TaskHistoryQuery {
  const query: TaskHistoryQuery = {};
  if (draft.state) query.state = draft.state as TaskExecutionState;
  if (draft.providerId) query.providerId = draft.providerId;
  if (draft.modelType) query.modelType = draft.modelType as TaskHistoryQuery["modelType"];
  if (draft.modelKey) query.modelKey = draft.modelKey;
  if (draft.source) query.source = draft.source as TaskHistoryQuery["source"];
  if (draft.extensionId) query.extensionId = draft.extensionId;
  if (draft.canvasId) query.canvasId = draft.canvasId;
  if (draft.nodeId) query.nodeId = draft.nodeId;
  if (draft.taskKey) query.taskKey = draft.taskKey;
  if (draft.from) query.from = draft.from;
  if (draft.to) query.to = draft.to;
  if (draft.cursor) query.cursor = draft.cursor;
  return query;
}

export function hasFilters(draft: DraftState): boolean {
  return Object.entries(draft).some(([key, value]) => key !== "cursor" && value !== "");
}

export function draftTags(draft: DraftState): Array<{ key: keyof DraftState; label: string }> {
  const tags: Array<{ key: keyof DraftState; label: string }> = [];
  if (draft.state) tags.push({ key: "state", label: `状态：${stateLabel(draft.state as TaskExecutionState)}` });
  if (draft.providerId) tags.push({ key: "providerId", label: `Provider：${draft.providerId}` });
  if (draft.modelType) tags.push({ key: "modelType", label: `类型：${draft.modelType}` });
  if (draft.modelKey) tags.push({ key: "modelKey", label: `模型：${draft.modelKey}` });
  if (draft.source) tags.push({ key: "source", label: `来源：${sourceLabel(draft.source as TaskHistoryQuery["source"])}` });
  if (draft.extensionId) tags.push({ key: "extensionId", label: `插件：${draft.extensionId}` });
  if (draft.canvasId) tags.push({ key: "canvasId", label: `画布：${draft.canvasId}` });
  if (draft.nodeId) tags.push({ key: "nodeId", label: `节点：${draft.nodeId}` });
  if (draft.taskKey) tags.push({ key: "taskKey", label: `任务：${draft.taskKey}` });
  if (draft.from) tags.push({ key: "from", label: `起：${formatLocalTime(draft.from)}` });
  if (draft.to) tags.push({ key: "to", label: `止：${formatLocalTime(draft.to)}` });
  return tags;
}
