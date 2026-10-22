/**
 * MCP 内部协议：动画节点、模型快照与适配确认请求解码
 * （自 `mcp-internal.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R08）。
 *
 * 只做结构校验；字段级语义（脚本语言/版本、摆放、时间线、快照内容）在 Canvas 侧由自包含
 * 节点契约统一裁定，避免两份漂移。
 */
import { isBoundedId, isFiniteNumber, isJsonObject } from "../../validation.js";
import { fail, ok, readRequiredId, type McpDecodeResult } from "./common-codec.js";
import type {
  McpCommitAnimationRequest,
  McpConfirmAdaptationRequest,
  McpCreateFilmSetNodeRequest,
  McpImportModelSnapshotRequest
} from "./types.js";

/**
 * 解码创建动画节点请求（change: 2026-10-05-bind-model-animation-to-shots）。
 *
 * 只做结构校验；字段级语义（脚本语言/版本、摆放、时间线）在 Canvas 侧由自包含节点契约统一
 * 裁定，避免两份漂移。
 */
export function decodeMcpCreateFilmSetNodeRequest(body: unknown): McpDecodeResult<McpCreateFilmSetNodeRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  const model = decodeAnimationModelSource(body.model);
  if (!model.ok) return fail(model.code, model.message);
  if (body.title !== undefined && typeof body.title !== "string") {
    return fail("malformed-request", "title 必须是字符串");
  }
  if (body.sourceNodeId !== undefined && !isBoundedId(body.sourceNodeId)) {
    return fail("malformed-request", "sourceNodeId 必须是非空字符串");
  }
  if (body.motionScript !== undefined && typeof body.motionScript !== "string") {
    return fail("malformed-request", "motionScript 必须是字符串");
  }
  const position = readOptionalPosition(body.position);
  if (!position.ok) return fail(position.code, position.message);
  const timeline = readOptionalTimeline(body.timeline);
  if (!timeline.ok) return fail(timeline.code, timeline.message);
  return ok({
    canvasId,
    nodeId: body.nodeId,
    requestId: body.requestId,
    model: model.value,
    ...(position.value ? { position: position.value } : {}),
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.sourceNodeId === undefined ? {} : { sourceNodeId: body.sourceNodeId }),
    ...(body.motionScript === undefined ? {} : { motionScript: body.motionScript }),
    ...(timeline.value ? { timeline: timeline.value } : {})
  });
}

/**
 * 解码完整动画定义提交请求
 * （change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 4.3）。
 */
export function decodeMcpCommitAnimationRequest(body: unknown): McpDecodeResult<McpCommitAnimationRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  if (!isJsonObject(body.animation)) return fail("malformed-request", "animation 必须是对象");
  if (body.expectedSnapshotHash !== undefined && !isBoundedId(body.expectedSnapshotHash)) {
    return fail("malformed-request", "expectedSnapshotHash 必须是字符串");
  }
  if (body.title !== undefined && typeof body.title !== "string") {
    return fail("malformed-request", "title 必须是字符串");
  }
  return ok({
    canvasId,
    nodeId: body.nodeId,
    requestId: body.requestId,
    animation: body.animation,
    ...(typeof body.clipId === "string" ? { clipId: body.clipId } : {}),
    ...(typeof body.expectedClipHash === "string" ? { expectedClipHash: body.expectedClipHash } : {}),
    ...(body.expectedSnapshotHash === undefined ? {} : { expectedSnapshotHash: body.expectedSnapshotHash }),
    ...(body.title === undefined ? {} : { title: body.title })
  });
}

/** 解码确认运动适配请求（items-only：clip + item binding，D10）。 */
export function decodeMcpConfirmAdaptationRequest(body: unknown): McpDecodeResult<McpConfirmAdaptationRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.clipId)) return fail("malformed-request", "clipId 必须是非空字符串");
  if (!isBoundedId(body.itemId)) return fail("malformed-request", "itemId 必须是非空字符串");
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  if (!isBoundedId(body.expectedAdapterHash)) return fail("malformed-request", "expectedAdapterHash 必须是非空字符串");
  if (body.expectedSnapshotHash !== undefined && !isBoundedId(body.expectedSnapshotHash)) {
    return fail("malformed-request", "expectedSnapshotHash 必须是字符串");
  }
  return ok({
    canvasId,
    nodeId: body.nodeId,
    clipId: body.clipId,
    itemId: body.itemId,
    expectedAdapterHash: body.expectedAdapterHash,
    requestId: body.requestId,
    ...(body.expectedSnapshotHash === undefined ? {} : { expectedSnapshotHash: body.expectedSnapshotHash })
  });
}

/**
 * 解码导入模型快照请求
 * （change: 2026-10-05-bind-model-animation-to-shots）。
 */
export function decodeMcpImportModelSnapshotRequest(body: unknown): McpDecodeResult<McpImportModelSnapshotRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.itemId)) return fail("malformed-request", "itemId 必须是非空字符串");
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  if (typeof body.modelScript !== "string" || body.modelScript.trim() === "") {
    return fail("malformed-request", "modelScript 必须是非空字符串");
  }
  if (!isBoundedId(body.modelScriptVersion)) return fail("malformed-request", "modelScriptVersion 必须是字符串");
  if (body.expectedSourceHash !== undefined && !isBoundedId(body.expectedSourceHash)) {
    return fail("malformed-request", "expectedSourceHash 必须是字符串");
  }
  const placement = readOptionalPlacement(body.placement);
  if (!placement.ok) return fail(placement.code, placement.message);
  return ok({
    canvasId,
    nodeId: body.nodeId,
    itemId: body.itemId,
    requestId: body.requestId,
    modelScript: body.modelScript,
    modelScriptVersion: body.modelScriptVersion,
    ...(placement.value ? { placement: placement.value } : {}),
    ...(body.expectedSourceHash === undefined ? {} : { expectedSourceHash: body.expectedSourceHash })
  });
}

function decodeAnimationModelSource(input: unknown): McpDecodeResult<McpCreateFilmSetNodeRequest["model"]> {
  if (!isJsonObject(input)) return fail("malformed-request", "model 必须是对象");
  if (typeof input.modelScript !== "string" || input.modelScript.trim() === "") {
    return fail("malformed-request", "model.modelScript 必须是非空字符串");
  }
  if (!isBoundedId(input.modelScriptVersion)) {
    return fail("malformed-request", "model.modelScriptVersion 必须是字符串");
  }
  const placement = readOptionalPlacement(input.placement);
  if (!placement.ok) return fail(placement.code, placement.message);
  return ok({
    modelScript: input.modelScript,
    modelScriptVersion: input.modelScriptVersion,
    ...(placement.value ? { placement: placement.value } : {})
  });
}

export function readOptionalPosition(
  input: unknown
): { ok: true; value?: { x: number; y: number } } | { ok: false; code: string; message: string } {
  if (input === undefined || input === null) return { ok: true };
  if (!isJsonObject(input) || !isFiniteNumber(input.x) || !isFiniteNumber(input.y)) {
    return { ok: false, code: "malformed-request", message: "position 必须是 { x, y } 有限数值" };
  }
  return { ok: true, value: { x: input.x, y: input.y } };
}

export function readOptionalTimeline(
  input: unknown
): { ok: true; value?: { duration: number; loop: boolean } } | { ok: false; code: string; message: string } {
  if (input === undefined || input === null) return { ok: true };
  if (!isJsonObject(input) || !isFiniteNumber(input.duration) || typeof input.loop !== "boolean") {
    return { ok: false, code: "malformed-request", message: "timeline 必须是 { duration, loop }" };
  }
  return { ok: true, value: { duration: input.duration, loop: input.loop } };
}

export function readOptionalPlacement(
  input: unknown
): { ok: true; value?: { offset: { x: number; y: number; z: number }; scale: number; yaw: number } } | { ok: false; code: string; message: string } {
  if (input === undefined || input === null) return { ok: true };
  if (!isJsonObject(input)) return { ok: false, code: "malformed-request", message: "placement 必须是对象" };
  const offset = input.offset;
  if (offset !== undefined) {
    if (!isJsonObject(offset) || !isFiniteNumber(offset.x) || !isFiniteNumber(offset.y) || !isFiniteNumber(offset.z)) {
      return { ok: false, code: "malformed-request", message: "placement.offset 必须是三分量有限数值" };
    }
  }
  const scale = input.scale;
  if (scale !== undefined && !isFiniteNumber(scale)) {
    return { ok: false, code: "malformed-request", message: "placement.scale 必须是有限数值" };
  }
  const yaw = input.yaw;
  if (yaw !== undefined && !isFiniteNumber(yaw)) {
    return { ok: false, code: "malformed-request", message: "placement.yaw 必须是有限数值" };
  }
  return {
    ok: true,
    value: {
      offset: offset ? { x: offset.x as number, y: offset.y as number, z: offset.z as number } : { x: 0, y: 0, z: 0 },
      scale: (scale as number | undefined) ?? 1,
      yaw: (yaw as number | undefined) ?? 0
    }
  };
}
