/**
 * MCP 内部协议：镜头变更请求解码
 * （自 `mcp-internal.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R08）。
 *
 * 只做结构校验；字段级语义（正 distance、已知 aspect、三分量 focusOffset）在 Canvas 侧由
 * `decodeModelCameras` 统一裁定，避免两份漂移。
 */
import { isBoundedId, isFiniteNumber, isJsonObject } from "../../validation.js";
import {
  MAX_MODEL_CAMERA_MUTATIONS,
  MAX_MODEL_CAMERA_NAME_LENGTH,
  MODEL_CAMERA_ASPECTS,
  type ModelCameraAspect,
  type ModelCameraFocusOffset
} from "../model-cameras.js";
import { fail, ok, readRequiredId, type McpDecodeResult } from "./common-codec.js";
import type {
  McpCameraMutation,
  McpMutateCamerasBatchRequest,
  McpMutateCamerasRequest
} from "./types.js";

/**
 * 解码单条镜头变更请求（change: add-model-camera-mcp-crud）。
 *
 * 只做结构校验；字段级语义（正 distance、已知 aspect、三分量 focusOffset）在 Canvas 侧
 * 由 `decodeModelCameras` 统一裁定，避免两份漂移。非法结构在触碰画布前拒绝。
 */
export function decodeMcpMutateCamerasRequest(body: unknown): McpDecodeResult<McpMutateCamerasRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  const mutation = decodeCameraMutation(body.mutation);
  if (!mutation.ok) return fail(mutation.code, mutation.message);
  return ok({
    canvasId,
    nodeId: body.nodeId,
    requestId: body.requestId,
    mutation: mutation.value
  });
}

/**
 * 解码批量镜头变更请求（change: 2026-10-08-add-chatgpt-oauth-3d-generation，任务 4.4）。
 *
 * 只做结构校验；字段级语义仍在 Canvas 侧由 `decodeModelCameras` / `applyModelCameraMutationBatch`
 * 统一裁定。空列表、超上限或任一非法条目在触碰画布前拒绝。
 */
export function decodeMcpMutateCamerasBatchRequest(body: unknown): McpDecodeResult<McpMutateCamerasBatchRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  if (!Array.isArray(body.mutations) || body.mutations.length === 0) {
    return fail("malformed-request", "mutations 必须是非空数组");
  }
  if (body.mutations.length > MAX_MODEL_CAMERA_MUTATIONS) {
    return fail("malformed-request", `mutations 数量超过上限 ${MAX_MODEL_CAMERA_MUTATIONS}`);
  }
  const mutations: McpCameraMutation[] = [];
  for (const entry of body.mutations) {
    const mutation = decodeCameraMutation(entry);
    if (!mutation.ok) return fail(mutation.code, mutation.message);
    mutations.push(mutation.value);
  }
  return ok({ canvasId, nodeId: body.nodeId, requestId: body.requestId, mutations });
}

export function decodeCameraMutation(input: unknown): McpDecodeResult<McpCameraMutation> {
  if (!isJsonObject(input)) return fail("malformed-request", "mutation 必须是对象");
  switch (input.kind) {
    case "create": {
      if (!isFiniteNumber(input.azimuth)) return fail("malformed-request", "create.azimuth 必须是有限数值");
      if (!isFiniteNumber(input.distance)) return fail("malformed-request", "create.distance 必须是有限数值");
      if (input.name !== undefined && (typeof input.name !== "string" || input.name.length === 0)) {
        return fail("malformed-request", "create.name 必须是非空字符串");
      }
      const aspect = readCameraAspect(input.aspect);
      if (!aspect.ok) return fail(aspect.code, aspect.message);
      const elevation = readCameraElevation(input.elevation);
      if (!elevation.ok) return fail(elevation.code, elevation.message);
      const focusOffset = readCameraFocusOffset(input.focusOffset);
      if (!focusOffset.ok) return fail(focusOffset.code, focusOffset.message);
      return ok({
        kind: "create",
        azimuth: input.azimuth,
        distance: input.distance,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(aspect.value === undefined ? {} : { aspect: aspect.value }),
        ...(elevation.value === undefined ? {} : { elevation: elevation.value }),
        ...(focusOffset.value === undefined ? {} : { focusOffset: focusOffset.value })
      });
    }
    case "update": {
      if (!isBoundedId(input.id)) return fail("malformed-request", "update.id 必须是非空字符串");
      const update: Extract<McpCameraMutation, { kind: "update" }> = { kind: "update", id: input.id };
      if (input.azimuth !== undefined) {
        if (!isFiniteNumber(input.azimuth)) return fail("malformed-request", "update.azimuth 必须是有限数值");
        update.azimuth = input.azimuth;
      }
      if (input.distance !== undefined) {
        if (!isFiniteNumber(input.distance)) return fail("malformed-request", "update.distance 必须是有限数值");
        update.distance = input.distance;
      }
      const aspect = readCameraAspect(input.aspect);
      if (!aspect.ok) return fail(aspect.code, aspect.message);
      if (aspect.value !== undefined) update.aspect = aspect.value;
      const elevation = readCameraElevation(input.elevation);
      if (!elevation.ok) return fail(elevation.code, elevation.message);
      if (elevation.value !== undefined) update.elevation = elevation.value;
      const focusOffset = readCameraFocusOffset(input.focusOffset);
      if (!focusOffset.ok) return fail(focusOffset.code, focusOffset.message);
      if (focusOffset.value !== undefined) update.focusOffset = focusOffset.value;
      return ok(update);
    }
    case "remove":
      if (!isBoundedId(input.id)) return fail("malformed-request", "remove.id 必须是非空字符串");
      return ok({ kind: "remove", id: input.id });
    case "rename": {
      if (!isBoundedId(input.id)) return fail("malformed-request", "rename.id 必须是非空字符串");
      if (typeof input.name !== "string" || input.name.length === 0 || input.name.length > MAX_MODEL_CAMERA_NAME_LENGTH) {
        return fail("malformed-request", `rename.name 必须是 1-${MAX_MODEL_CAMERA_NAME_LENGTH} 字符`);
      }
      return ok({ kind: "rename", id: input.id, name: input.name });
    }
    case "reset": {
      if (!isBoundedId(input.id)) return fail("malformed-request", "reset.id 必须是非空字符串");
      if (!isFiniteNumber(input.azimuth)) return fail("malformed-request", "reset.azimuth 必须是有限数值");
      if (!isFiniteNumber(input.distance)) return fail("malformed-request", "reset.distance 必须是有限数值");
      const elevation = readCameraElevation(input.elevation);
      if (!elevation.ok) return fail(elevation.code, elevation.message);
      return ok({
        kind: "reset",
        id: input.id,
        azimuth: input.azimuth,
        distance: input.distance,
        ...(elevation.value === undefined ? {} : { elevation: elevation.value })
      });
    }
    default:
      return fail("malformed-request", "未知的镜头变更 kind");
  }
}

/** 可选画幅：缺省/`null` 视为未提供；未知值拒绝。 */
export function readCameraAspect(input: unknown): { ok: true; value: ModelCameraAspect | undefined } | { ok: false; code: string; message: string } {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (MODEL_CAMERA_ASPECTS.includes(input as ModelCameraAspect)) {
    return { ok: true, value: input as ModelCameraAspect };
  }
  return { ok: false, code: "malformed-request", message: `aspect 必须是 ${MODEL_CAMERA_ASPECTS.join(" / ")} 之一` };
}

/**
 * 可选仰角：缺省/`null` 视为未提供。范围校验交给 Canvas 侧的 `decodeModelCameras`
 * （它会把 `[-90°, +90°]` 之外的输入整条拒绝），这里只保证是有限数值。
 */
export function readCameraElevation(input: unknown): { ok: true; value: number | undefined } | { ok: false; code: string; message: string } {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (!isFiniteNumber(input)) return { ok: false, code: "malformed-request", message: "elevation 必须是有限数值" };
  return { ok: true, value: input };
}

/** 可选三分量注视点偏移：缺省/`null` 视为未提供；非法拒绝。 */
export function readCameraFocusOffset(
  input: unknown
): { ok: true; value: ModelCameraFocusOffset | undefined } | { ok: false; code: string; message: string } {
  if (input === undefined || input === null) return { ok: true, value: undefined };
  if (!isJsonObject(input)) return { ok: false, code: "malformed-request", message: "focusOffset 必须是三分量对象" };
  const { x, y, z } = input;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
    return { ok: false, code: "malformed-request", message: "focusOffset 必须是三个有限数值" };
  }
  return { ok: true, value: { x, y, z } };
}
