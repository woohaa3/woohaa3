/**
 * MCP 内部协议：模型读取、脚本提交与预览请求解码
 * （自 `mcp-internal.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R08）。
 */
import { isBoundedId, isJsonObject } from "../../validation.js";
import type { CanvasCommand } from "../commands.js";
import type { GetModelNodesInput, ModelScriptBatchRequest } from "../model-script-batch.js";
import {
  fail,
  ok,
  readOptionalId,
  readRequiredId,
  type McpDecodeResult
} from "./common-codec.js";
import type {
  McpApplyCommandsRequest,
  McpGetNodeRequest,
  McpListNodesRequest,
  McpModelStatisticsRequest,
  McpRenderPreviewRequest,
  McpReportScriptRequest,
  McpSubmitScriptRequest
} from "./types.js";

export function decodeMcpListNodesRequest(body: unknown): McpDecodeResult<McpListNodesRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  return ok({ canvasId });
}

export function decodeMcpGetNodeRequest(body: unknown): McpDecodeResult<McpGetNodeRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  if (body.resource !== undefined && body.resource !== "group-appearance") return fail("malformed-request", "resource 不支持");
  if (body.expectedContentHash !== undefined && !isBoundedId(body.expectedContentHash)) return fail("malformed-request", "expectedContentHash 非法");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (body.includeStatistics !== undefined && typeof body.includeStatistics !== "boolean") {
    return fail("malformed-request", "includeStatistics 必须是布尔值");
  }
  return ok({
    canvasId,
    ...(body.resource === "group-appearance" ? { resource: body.resource } : {}),
    ...(typeof body.expectedContentHash === "string" ? { expectedContentHash: body.expectedContentHash } : {}),
    nodeId: body.nodeId,
    ...(typeof body.includeStatistics === "boolean" ? { includeStatistics: body.includeStatistics } : {})
  });
}

export function decodeMcpSubmitScriptRequest(body: unknown): McpDecodeResult<McpSubmitScriptRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  if (body.resource !== undefined && body.resource !== "group-appearance") return fail("malformed-request", "resource 不支持");
  if (body.expectedContentHash !== undefined && !isBoundedId(body.expectedContentHash)) return fail("malformed-request", "expectedContentHash 非法");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (typeof body.source !== "string" || body.source.trim() === "") {
    return fail("malformed-request", "source 必须是非空字符串");
  }
  const version = body.version;
  if (version !== undefined && typeof version !== "string") {
    return fail("malformed-request", "version 必须是字符串");
  }
  const requestId = readOptionalId(body, "requestId");
  if (typeof requestId === "object") return fail("malformed-request", requestId.error);
  const expectedModelContentHash = readOptionalId(body, "expectedModelContentHash");
  if (typeof expectedModelContentHash === "object") return fail("malformed-request", expectedModelContentHash.error);
  return ok({
    canvasId,
    ...(body.resource === "group-appearance" ? { resource: body.resource } : {}),
    ...(typeof body.expectedContentHash === "string" ? { expectedContentHash: body.expectedContentHash } : {}),
    nodeId: body.nodeId,
    source: body.source,
    ...(version === undefined ? {} : { version }),
    ...(requestId === undefined ? {} : { requestId }),
    ...(expectedModelContentHash === undefined ? {} : { expectedModelContentHash })
  });
}

export function decodeMcpReportScriptRequest(body: unknown): McpDecodeResult<McpReportScriptRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  const status = body.status === "ok" ? "ok" : body.status === "failed" ? "failed" : undefined;
  if (status === undefined) return fail("malformed-request", "status 必须是 ok 或 failed");
  const message = body.message;
  if (message !== undefined && typeof message !== "string") {
    return fail("malformed-request", "message 必须是字符串");
  }
  return ok({
    canvasId,
    nodeId: body.nodeId,
    status,
    ...(message === undefined ? {} : { message })
  });
}

export function decodeMcpRenderPreviewRequest(body: unknown): McpDecodeResult<McpRenderPreviewRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  const numeric: Record<string, number> = {};
  if (body.clipId !== undefined) {
    if (typeof body.clipId !== "string" || !body.clipId.trim() || body.clipId.length > 256) return fail("malformed-request", "clipId 非法");
  }
  for (const key of ["width", "height", "timeSeconds"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fail("malformed-request", `${key} 必须是有限数值`);
    }
    numeric[key] = value;
  }
  const background = body.background;
  if (background !== undefined && typeof background !== "string") {
    return fail("malformed-request", "background 必须是字符串");
  }
  const cameraPreset = body.cameraPreset;
  if (cameraPreset !== undefined && typeof cameraPreset !== "string") {
    return fail("malformed-request", "cameraPreset 必须是字符串");
  }
  return ok({
    canvasId,
    nodeId: body.nodeId,
    ...numeric,
    ...(typeof body.clipId === "string" ? { clipId: body.clipId } : {}),
    ...(background === undefined ? {} : { background }),
    ...(cameraPreset === undefined ? {} : { cameraPreset })
  } as McpRenderPreviewRequest);
}

/**
 * 解码模型规模统计请求（change: 2026-10-18-align-model-statistics-with-agent）。
 *
 * `source` 省略时统计当前权威脚本；提供时只统计候选，不写画布。
 */
export function decodeMcpModelStatisticsRequest(body: unknown): McpDecodeResult<McpModelStatisticsRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (body.source !== undefined && (typeof body.source !== "string" || body.source.trim() === "")) {
    return fail("malformed-request", "source 必须是非空字符串");
  }
  return ok({
    canvasId,
    nodeId: body.nodeId,
    ...(typeof body.source === "string" ? { source: body.source } : {})
  });
}

export function decodeMcpApplyCommandsRequest(body: unknown): McpDecodeResult<McpApplyCommandsRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.commandId)) return fail("malformed-request", "commandId 必须是非空字符串");
  if (!Number.isInteger(body.baseRevision) || (body.baseRevision as number) < 0) {
    return fail("malformed-request", "baseRevision 必须是非负整数");
  }
  if (!Array.isArray(body.commands) || body.commands.length === 0) {
    return fail("malformed-request", "commands 必须是非空数组");
  }
  return ok({
    canvasId,
    commandId: body.commandId,
    baseRevision: body.baseRevision as number,
    commands: body.commands as CanvasCommand[]
  });
}

/**
 * 解码批量模型读取请求（model-script-batch）。
 *
 * 只做结构校验；node 是否存在、是否可读与 source 是否返回仍由 Canvas 侧权威裁定。
 */
export function decodeMcpGetModelNodesRequest(body: unknown): McpDecodeResult<GetModelNodesInput> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!Array.isArray(body.nodeIds) || body.nodeIds.length === 0) {
    return fail("malformed-request", "nodeIds 必须是非空数组");
  }
  if (body.nodeIds.some((nodeId) => !isBoundedId(nodeId))) {
    return fail("malformed-request", "nodeIds 必须是非空字符串");
  }
  if (body.includeSource !== undefined && typeof body.includeSource !== "boolean") {
    return fail("malformed-request", "includeSource 必须是布尔值");
  }
  return ok({
    canvasId,
    nodeIds: body.nodeIds as string[],
    ...(typeof body.includeSource === "boolean" ? { includeSource: body.includeSource } : {})
  });
}

/**
 * 解码模型批量作者请求（model-script-batch）：批量读取 / 只校验 / 校验并提交共用同一 body 形状。
 *
 * 只做结构校验；源码解析、几何/镜头 hash 前置条件与幂等仍在 Canvas 侧 `authorModelBatch` 裁定。
 */
export function decodeMcpModelScriptBatchRequest(body: unknown): McpDecodeResult<ModelScriptBatchRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  if (body.version !== undefined && body.version !== "woohaa-model-js-v2") {
    return fail("malformed-request", "version 必须是 woohaa-model-js-v2");
  }
  if (body.commonSource !== undefined && typeof body.commonSource !== "string") {
    return fail("malformed-request", "commonSource 必须是字符串");
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return fail("malformed-request", "items 必须是非空数组");
  }
  for (const item of body.items) {
    if (!isJsonObject(item)) return fail("malformed-request", "items 的每一项必须是对象");
    if (!isBoundedId(item.nodeId)) return fail("malformed-request", "items[].nodeId 必须是非空字符串");
    if (typeof item.source !== "string" || item.source.length === 0) {
      return fail("malformed-request", "items[].source 必须是非空字符串");
    }
    if (item.expectedModelContentHash !== undefined && !isBoundedId(item.expectedModelContentHash)) {
      return fail("malformed-request", "items[].expectedModelContentHash 必须是非空字符串");
    }
    if (item.cameras !== undefined && !Array.isArray(item.cameras)) {
      return fail("malformed-request", "items[].cameras 必须是数组");
    }
    if (item.expectedCamerasHash !== undefined && !isBoundedId(item.expectedCamerasHash)) {
      return fail("malformed-request", "items[].expectedCamerasHash 必须是非空字符串");
    }
  }
  return ok({
    canvasId,
    requestId: body.requestId,
    ...(body.version === "woohaa-model-js-v2" ? { version: "woohaa-model-js-v2" as const } : {}),
    ...(typeof body.commonSource === "string" ? { commonSource: body.commonSource } : {}),
    items: body.items as ModelScriptBatchRequest["items"]
  });
}
