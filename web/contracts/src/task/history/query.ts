/**
 * Task execution history DTO：查询解析与 fingerprint
 * （自 `history.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R20）。
 */
import { isBoundedId, isNonEmptyString } from "../../validation.js";
import {
  TASK_HISTORY_MAX_PAGE_SIZE,
  type TaskExecutionState,
  type TaskHistoryQuery,
  type TaskHistoryQueryParse
} from "./types.js";
import { isTaskExecutionSource, isTaskExecutionState, isTaskModelType } from "./guards.js";

function boundedId(input: unknown, maxLength = 200): string | undefined {
  return isBoundedId(input, maxLength) ? input : undefined;
}

/**
 * 严格解析不可信查询参数为受控 history query。
 *
 * 与实现无关的校验：limit 夹到上限；时间用 `Date.parse` 判定且要求 from <= to；
 * `state` 与 `states` 同时出现、未知状态、未知 modelType、非法时间 MUST 返回稳定错误。
 * 返回规范化 fingerprint（不含 cursor/limit），供服务端绑定 opaque page cursor。
 */
export function parseTaskHistoryQuery(input: Record<string, unknown>): TaskHistoryQueryParse {
  const query: TaskHistoryQuery = {};
  if (isNonEmptyString(input.cursor)) {
    if (input.cursor.length > 1024) return { ok: false, code: "invalid-cursor", message: "cursor 非法" };
    query.cursor = input.cursor;
  }

  const hasState = input.state !== undefined && input.state !== "";
  const hasStates = input.states !== undefined && input.states !== "";
  if (hasState && hasStates) {
    return { ok: false, code: "state-conflict", message: "state 与 states 不能同时出现" };
  }
  if (hasState) {
    if (!isTaskExecutionState(input.state)) return { ok: false, code: "invalid-state", message: "未知执行状态" };
    query.state = input.state;
  }
  if (hasStates) {
    const raw = Array.isArray(input.states)
      ? input.states
      : typeof input.states === "string"
        ? input.states.split(",")
        : [];
    const states: TaskExecutionState[] = [];
    for (const entry of raw) {
      const value = typeof entry === "string" ? entry.trim() : entry;
      if (value === "") continue;
      if (!isTaskExecutionState(value)) return { ok: false, code: "invalid-state", message: "未知执行状态" };
      if (!states.includes(value)) states.push(value);
    }
    if (states.length === 0) return { ok: false, code: "invalid-state", message: "states 不能为空" };
    query.states = states;
  }

  const providerId = boundedId(input.providerId);
  if (providerId) query.providerId = providerId;
  if (input.modelType !== undefined && input.modelType !== "") {
    if (!isTaskModelType(input.modelType)) return { ok: false, code: "invalid-model-type", message: "未知模型类型" };
    query.modelType = input.modelType;
  }
  const modelKey = boundedId(input.modelKey);
  if (modelKey) query.modelKey = modelKey;
  const canvasId = boundedId(input.canvasId);
  if (canvasId) query.canvasId = canvasId;
  const nodeId = boundedId(input.nodeId);
  if (nodeId) query.nodeId = nodeId;
  const taskKey = boundedId(input.taskKey);
  if (taskKey) query.taskKey = taskKey;
  if (input.source !== undefined && input.source !== "") {
    if (!isTaskExecutionSource(input.source)) return { ok: false, code: "invalid-source", message: "未知执行来源" };
    query.source = input.source;
  }
  const extensionId = boundedId(input.extensionId);
  if (extensionId) query.extensionId = extensionId;

  const hasFrom = input.from !== undefined && input.from !== "";
  const hasTo = input.to !== undefined && input.to !== "";
  if (hasFrom) {
    if (!isValidIso(input.from)) return { ok: false, code: "invalid-time-range", message: "from 非法" };
    query.from = input.from as string;
  }
  if (hasTo) {
    if (!isValidIso(input.to)) return { ok: false, code: "invalid-time-range", message: "to 非法" };
    query.to = input.to as string;
  }
  if (query.from && query.to && Date.parse(query.from) > Date.parse(query.to)) {
    return { ok: false, code: "invalid-time-range", message: "from 必须不晚于 to" };
  }

  const limit = Number(input.limit);
  if (Number.isInteger(limit) && limit > 0) query.limit = Math.min(limit, TASK_HISTORY_MAX_PAGE_SIZE);

  return { ok: true, query, fingerprint: historyQueryFingerprint(query) };
}

/**
 * 规范化查询指纹：不含 cursor/limit，条件顺序稳定（states 排序）。
 *
 * 服务端把它绑定进 opaque page cursor；换条件复用旧 cursor 会被拒绝。
 */
export function historyQueryFingerprint(query: TaskHistoryQuery): string {
  const parts: string[] = [];
  if (query.state) parts.push(`state=${query.state}`);
  if (query.states && query.states.length > 0) parts.push(`states=${[...query.states].sort().join(",")}`);
  if (query.providerId) parts.push(`providerId=${query.providerId}`);
  if (query.modelType) parts.push(`modelType=${query.modelType}`);
  if (query.modelKey) parts.push(`modelKey=${query.modelKey}`);
  if (query.canvasId) parts.push(`canvasId=${query.canvasId}`);
  if (query.nodeId) parts.push(`nodeId=${query.nodeId}`);
  if (query.taskKey) parts.push(`taskKey=${query.taskKey}`);
  if (query.source) parts.push(`source=${query.source}`);
  if (query.extensionId) parts.push(`extensionId=${query.extensionId}`);
  if (query.from) parts.push(`from=${query.from}`);
  if (query.to) parts.push(`to=${query.to}`);
  return parts.join("&");
}

function isValidIso(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
