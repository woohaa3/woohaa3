/**
 * 占位片场节点上的转换状态契约
 * （change: 2026-10-13-add-node-to-film-set-shortcut，任务 1.3/3.8 / design D4）。
 *
 * 提交时先创建目标片场节点并在其 `nodeData` 上写入转换状态，使**进行中阶段、失败原因与恢复动作**
 * 都能显示在该目标节点上（源节点横条只保留动作按钮与模型名摘要）。状态字段与权威任务状态
 * 同形（`FilmSetConversionStatus`），因此前端复用同一呈现映射，不制造第二份任务事实。
 *
 * 纯函数 / JSON-only 叶子模块：只依赖 validation 原语与同目录类型，不 import 任何 codec 或服务。
 */
import { isJsonObject } from "../../validation.js";
import { decodeAssistantExecutionRef } from "../../extension/assistant/assistant-execution.js";
import {
  FILM_SET_CONVERSION_ERROR_CODES,
  FILM_SET_CONVERSION_STEPS,
  type FilmSetConversionErrorCode,
  type FilmSetConversionStatus,
  type FilmSetConversionStep
} from "./types.js";

/** 目标片场 `nodeData` 上承载转换状态的字段名。 */
export const FILM_SET_CONVERSION_NODE_STATUS_FIELD = "filmSetConversion";

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * 读取目标片场节点上的转换状态；缺失/非法返回 `null`（不写半截状态、不影响片场加载）。
 *
 * 只接受与 `FilmSetConversionStatus` 完全同形的对象：判别字段、requestId、sourceNodeId 与各状态
 * 必填字段都合法才返回，否则整体丢弃。
 */
export function readFilmSetConversionNodeStatus(nodeData: unknown): FilmSetConversionStatus | null {
  if (!isJsonObject(nodeData)) return null;
  const input = nodeData[FILM_SET_CONVERSION_NODE_STATUS_FIELD];
  const status = decodeNodeStatus(input);
  if (!status || !isJsonObject(input) || input.execution === undefined) return status;
  if (!isJsonObject(input.execution) || typeof input.execution.canvasId !== "string") return status;
  const decoded = decodeAssistantExecutionRef(input.execution, input.execution.canvasId);
  return decoded.ok ? { ...status, execution: decoded.value } : status;
}

function decodeNodeStatus(input: unknown): FilmSetConversionStatus | null {
  if (!isJsonObject(input)) return null;
  const requestId = input.requestId;
  const sourceNodeId = input.sourceNodeId;
  if (!isNonEmptyString(requestId) || !isNonEmptyString(sourceNodeId)) return null;
  switch (input.status) {
    case "running": {
      const step = input.step;
      if (typeof step !== "string" || !(FILM_SET_CONVERSION_STEPS as readonly string[]).includes(step)) return null;
      return { status: "running", requestId, sourceNodeId, step: step as FilmSetConversionStep };
    }
    case "completed": {
      const targetNodeId = input.targetNodeId;
      const commandId = input.commandId;
      if (!isNonEmptyString(targetNodeId) || !isNonEmptyString(commandId)) return null;
      const note = isNonEmptyString(input.note) ? input.note : undefined;
      return { status: "completed", requestId, sourceNodeId, targetNodeId, commandId, ...(note ? { note } : {}) };
    }
    case "failed": {
      if (typeof input.code !== "string" || !(FILM_SET_CONVERSION_ERROR_CODES as readonly string[]).includes(input.code)) return null;
      if (typeof input.message !== "string") return null;
      if (typeof input.attempt !== "number" || !Number.isInteger(input.attempt) || input.attempt < 1) return null;
      if (typeof input.retryable !== "boolean") return null;
      return {
        status: "failed",
        requestId,
        sourceNodeId,
        code: input.code as FilmSetConversionErrorCode,
        message: input.message,
        attempt: input.attempt,
        retryable: input.retryable
      };
    }
    case "cancelled":
      return { status: "cancelled", requestId, sourceNodeId };
    case "unknown":
      return { status: "unknown", requestId, sourceNodeId };
    default:
      return null;
  }
}

/**
 * 转换状态映射到目标节点的通用任务状态（`nodeData.taskStatus`）。
 *
 * 让既有卡片 busy 语义与任务边界保护（进行中不可直接删除、终态可删除）对占位节点同样生效。
 */
export function filmSetConversionNodeTaskStatus(
  status: FilmSetConversionStatus
): "processing" | "successed" | "failed" | "cancelled" {
  switch (status.status) {
    case "running":
    case "unknown":
      return "processing";
    case "completed":
      return "successed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}
