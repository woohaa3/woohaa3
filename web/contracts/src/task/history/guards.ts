/**
 * Task execution history DTO：类型守卫与状态谓词
 * （自 `history.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R20）。
 */
import {
  isBoundedId,
  isFiniteNumber,
  isJsonObject,
  isNonEmptyString,
  isNonNegativeInteger
} from "../../validation.js";
import {
  ACTIVE_TASK_STATES,
  TASK_EXECUTION_SOURCES,
  TASK_EXECUTION_STATES,
  type TaskAdmissionVersions,
  type TaskErrorSummary,
  type TaskExecutionDetail,
  type TaskExecutionEvent,
  type TaskExecutionSource,
  type TaskExecutionState,
  type TaskExecutionSummary,
  type TaskHistoryCandidates,
  type TaskHistoryEventMessage,
  type TaskHistoryPage,
  type TaskModelType,
  type TaskRequestSummary,
  type TaskResultSummary
} from "./types.js";

export function isTaskExecutionState(value: unknown): value is TaskExecutionState {
  return typeof value === "string" && (TASK_EXECUTION_STATES as readonly string[]).includes(value);
}

export function isTaskModelType(value: unknown): value is TaskModelType {
  return value === "language" || value === "image" || value === "video" || value === "audio";
}

export function isActiveTaskState(state: TaskExecutionState): boolean {
  return ACTIVE_TASK_STATES.includes(state);
}

/** 终态判定。 */
export function isTerminalTaskState(state: TaskExecutionState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

export function isTaskExecutionSource(value: unknown): value is TaskExecutionSource {
  return typeof value === "string" && (TASK_EXECUTION_SOURCES as readonly string[]).includes(value);
}

function isTaskResultSummary(value: unknown): value is TaskResultSummary {
  if (!isJsonObject(value)) return false;
  if (
    value.mediaKind !== "text" &&
    value.mediaKind !== "image" &&
    value.mediaKind !== "video" &&
    value.mediaKind !== "audio"
  ) {
    return false;
  }
  if (value.text !== undefined && typeof value.text !== "string") return false;
  if (value.textTruncated !== undefined && typeof value.textTruncated !== "boolean") return false;
  if (value.mediaState !== undefined && value.mediaState !== "materializing") return false;
  if (value.storageKey !== undefined && typeof value.storageKey !== "string") return false;
  if (value.locator !== undefined && typeof value.locator !== "string") return false;
  if (value.contentType !== undefined && typeof value.contentType !== "string") return false;
  if (value.size !== undefined && !isNonNegativeInteger(value.size)) return false;
  if (value.checksum !== undefined && typeof value.checksum !== "string") return false;
  if (value.durationSeconds !== undefined && !isFiniteNumber(value.durationSeconds)) return false;
  if (value.poster !== undefined) {
    if (!isJsonObject(value.poster)) return false;
    if (!isNonEmptyString(value.poster.storageKey)) return false;
    if (value.poster.contentType !== undefined && typeof value.poster.contentType !== "string") return false;
    if (value.poster.size !== undefined && !isNonNegativeInteger(value.poster.size)) return false;
    if (value.poster.checksum !== undefined && typeof value.poster.checksum !== "string") return false;
  }
  return true;
}

function isTaskErrorSummary(value: unknown): value is TaskErrorSummary {
  if (!isJsonObject(value)) return false;
  return (
    (value.name === undefined || typeof value.name === "string") &&
    typeof value.message === "string"
  );
}

function isTaskAdmissionVersions(value: unknown): value is TaskAdmissionVersions {
  if (!isJsonObject(value)) return false;
  return (
    (value.catalogRevision === undefined || isNonNegativeInteger(value.catalogRevision)) &&
    (value.schemaRevision === undefined || isNonNegativeInteger(value.schemaRevision)) &&
    (value.configVersion === undefined || isNonNegativeInteger(value.configVersion)) &&
    (value.extensionConfigVersion === undefined || isNonNegativeInteger(value.extensionConfigVersion))
  );
}

function isTaskExecutionEvent(value: unknown): value is TaskExecutionEvent {
  if (!isJsonObject(value)) return false;
  return (
    isNonNegativeInteger(value.sequence) &&
    isNonEmptyString(value.occurredAt) &&
    (value.kind === "scheduling" || value.kind === "execution") &&
    isNonEmptyString(value.stage) &&
    (value.detail === undefined || isJsonObject(value.detail))
  );
}

export function isTaskExecutionSummary(value: unknown): value is TaskExecutionSummary {
  if (!isJsonObject(value)) return false;
  if (!isBoundedId(value.taskKey)) return false;
  if (!isTaskExecutionState(value.state)) return false;
  if (!isNonEmptyString(value.providerId)) return false;
  if (value.providerName !== undefined && typeof value.providerName !== "string") return false;
  if (value.modelType !== undefined && !isTaskModelType(value.modelType)) return false;
  if (value.modelKey !== undefined && typeof value.modelKey !== "string") return false;
  if (value.modelTitle !== undefined && typeof value.modelTitle !== "string") return false;
  if (value.canvasId !== undefined && typeof value.canvasId !== "string") return false;
  if (value.canvasTitle !== undefined && typeof value.canvasTitle !== "string") return false;
  if (value.nodeId !== undefined && typeof value.nodeId !== "string") return false;
  if (value.nodeTitle !== undefined && typeof value.nodeTitle !== "string") return false;
  if (value.runId !== undefined && typeof value.runId !== "string") return false;
  if (value.progress !== undefined && !isFiniteNumber(value.progress)) return false;
  if (value.attempt !== undefined && !isNonNegativeInteger(value.attempt)) return false;
  if (value.result !== undefined && !isTaskResultSummary(value.result)) return false;
  if (value.error !== undefined && !isTaskErrorSummary(value.error)) return false;
  if (value.source !== undefined && !isTaskExecutionSource(value.source)) return false;
  if (value.extensionId !== undefined && typeof value.extensionId !== "string") return false;
  if (value.admission !== undefined && !isTaskAdmissionVersions(value.admission)) return false;
  if (!isNonEmptyString(value.createdAt) || !isNonEmptyString(value.updatedAt)) return false;
  if (value.startedAt !== undefined && typeof value.startedAt !== "string") return false;
  if (value.finishedAt !== undefined && typeof value.finishedAt !== "string") return false;
  if (!isNonNegativeInteger(value.durationMs)) return false;
  if (!isNonNegativeInteger(value.recordRevision)) return false;
  return true;
}

export function isTaskRequestSummary(value: unknown): value is TaskRequestSummary {
  if (!isJsonObject(value)) return false;
  return (
    typeof value.prompt === "string" &&
    isJsonObject(value.parameters) &&
    (value.promptTruncated === undefined || typeof value.promptTruncated === "boolean") &&
    (value.parametersTruncated === undefined || typeof value.parametersTruncated === "boolean")
  );
}

export function isTaskExecutionDetail(value: unknown): value is TaskExecutionDetail {
  if (!isTaskExecutionSummary(value)) return false;
  const detail = value as TaskExecutionDetail;
  if (!Array.isArray(detail.events) || !detail.events.every(isTaskExecutionEvent)) return false;
  if (detail.eventsTruncated !== undefined && typeof detail.eventsTruncated !== "boolean") return false;
  if (detail.request !== undefined && !isTaskRequestSummary(detail.request)) return false;
  return true;
}

export function isTaskHistoryPage(value: unknown): value is TaskHistoryPage {
  if (!isJsonObject(value)) return false;
  if (!Array.isArray(value.items) || !value.items.every(isTaskExecutionSummary)) return false;
  if (value.nextCursor !== undefined && !isNonEmptyString(value.nextCursor)) return false;
  if (!isNonNegativeInteger(value.watermark)) return false;
  return true;
}

export function isTaskHistoryEventMessage(value: unknown): value is TaskHistoryEventMessage {
  if (!isJsonObject(value)) return false;
  return isTaskExecutionSummary(value.record) && isNonNegativeInteger(value.cursor);
}

export function isTaskHistoryCandidates(value: unknown): value is TaskHistoryCandidates {
  if (!isJsonObject(value)) return false;
  if (
    !Array.isArray(value.providers) ||
    !value.providers.every(
      (entry) =>
        isJsonObject(entry) &&
        isNonEmptyString(entry.providerId) &&
        (entry.providerName === undefined || typeof entry.providerName === "string")
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(value.models) ||
    !value.models.every(
      (entry) =>
        isJsonObject(entry) &&
        isNonEmptyString(entry.providerId) &&
        isTaskModelType(entry.modelType) &&
        isNonEmptyString(entry.modelKey) &&
        (entry.modelTitle === undefined || typeof entry.modelTitle === "string") &&
        (entry.providerName === undefined || typeof entry.providerName === "string")
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(value.plugins) ||
    !value.plugins.every((entry) => isJsonObject(entry) && isNonEmptyString(entry.extensionId))
  ) {
    return false;
  }
  return true;
}
