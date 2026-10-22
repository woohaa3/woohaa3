/**
 * MCP 内部协议：片场导入与对象级变更请求解码
 * （自 `mcp-internal.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R08）。
 *
 * 结构校验；字段级语义（来源/资产身份、就绪状态、对象存在与 kind、precondition）在 Canvas 侧
 * 按权威画布裁定。
 */
import { isBoundedId, isFiniteNumber, isJsonObject } from "../../validation.js";
import { isFilmSetExportProfile } from "../film-set-export-profile.js";
import type { FilmSetLocalTransform, FilmSetPlayback } from "../film-set-content.js";
import { fail, ok, readRequiredId, type McpDecodeResult } from "./common-codec.js";
import type {
  McpAddFilmSetMediaRequest,
  McpExportFilmSetClipRequest,
  McpFilmSetImportItem,
  McpGetFilmSetExportRequest,
  McpImportFilmSetContentRequest,
  McpMutateFilmSetItemRequest
} from "./types.js";

/**
 * 解码复制导入片场内容请求（change: 2026-10-08-make-film-set-model-only）。
 *
 * 只做结构校验；文本、音频、片场与其他类型因 `kind` 不在允许集合内而整批拒绝，不会
 * 静默过滤部分来源。字段级语义（来源/资产身份、就绪状态）在 Canvas 侧按权威画布裁定。
 */
export function decodeMcpImportFilmSetContentRequest(body: unknown): McpDecodeResult<McpImportFilmSetContentRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return fail("malformed-request", "items 必须是非空数组");
  }
  const items: McpFilmSetImportItem[] = [];
  const seen = new Set<string>();
  for (const raw of body.items) {
    if (!isJsonObject(raw)) return fail("malformed-request", "items 元素必须是对象");
    const kind = raw.kind;
    if (kind !== "model" && kind !== "image" && kind !== "video") {
      return fail("unsupported-source", "仅普通模型、图片和视频可导入片场");
    }
    if (!isBoundedId(raw.itemId)) return fail("malformed-request", "itemId 必须是非空字符串");
    if (seen.has(raw.itemId)) return fail("malformed-request", `导入对象 id 重复：${raw.itemId}`);
    seen.add(raw.itemId);
    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      return fail("malformed-request", "name 必须是非空字符串");
    }
    if (!isBoundedId(raw.sourceNodeId)) return fail("malformed-request", "sourceNodeId 必须是非空字符串");
    if (kind === "model") {
      if (raw.expectedSourceHash !== undefined && !isBoundedId(raw.expectedSourceHash)) {
        return fail("malformed-request", "expectedSourceHash 必须是字符串");
      }
      items.push({
        kind: "model",
        itemId: raw.itemId,
        name: raw.name,
        sourceNodeId: raw.sourceNodeId,
        ...(raw.expectedSourceHash === undefined ? {} : { expectedSourceHash: raw.expectedSourceHash })
      });
      continue;
    }
    if (!isBoundedId(raw.assetId)) return fail("malformed-request", "assetId 必须是非空字符串");
    if (!isFiniteNumber(raw.aspectRatio) || (raw.aspectRatio as number) <= 0) {
      return fail("malformed-request", "aspectRatio 必须是正有限数值");
    }
    if (raw.durationSeconds !== undefined && (!isFiniteNumber(raw.durationSeconds) || (raw.durationSeconds as number) <= 0)) {
      return fail("malformed-request", "durationSeconds 必须是正有限数值");
    }
    if (raw.expectedChecksum !== undefined && !isBoundedId(raw.expectedChecksum)) {
      return fail("malformed-request", "expectedChecksum 必须是字符串");
    }
    items.push({
      kind,
      itemId: raw.itemId,
      name: raw.name,
      sourceNodeId: raw.sourceNodeId,
      assetId: raw.assetId,
      aspectRatio: raw.aspectRatio as number,
      ...(raw.durationSeconds === undefined ? {} : { durationSeconds: raw.durationSeconds as number }),
      ...(raw.expectedChecksum === undefined ? {} : { expectedChecksum: raw.expectedChecksum })
    });
  }
  return ok({ canvasId, nodeId: body.nodeId, requestId: body.requestId, items });
}

/**
 * 解码片场对象级变更请求
 * （change: 2026-10-09-add-film-set-object-motion-and-editing；
 * change: 2026-10-11-extract-film-set-extension，D8/D10 —— items-only）。
 *
 * 结构执行：op.kind 必须是受支持集合之一，字段类型正确。items 只保存几何与基础变换；
 * 对象动作/播放配置/适配确认一律走 `mutate_film_set_clip` 的 binding，故这里只有 transform/delete。
 * 字段级语义（对象存在、kind、precondition）在 Canvas 侧 reducer 按权威画布裁定。
 */
export function decodeMcpMutateFilmSetItemRequest(body: unknown): McpDecodeResult<McpMutateFilmSetItemRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.itemId)) return fail("malformed-request", "itemId 必须是非空字符串");
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  const op = decodeFilmSetItemPatchOp(body.op);
  if (!op.ok) return op;
  return ok({ canvasId, nodeId: body.nodeId, itemId: body.itemId, requestId: body.requestId, op: op.value });
}

export function decodeFilmSetItemPatchOp(
  input: unknown
): McpDecodeResult<import("../commands.js").FilmSetItemPatchOp> {
  if (!isJsonObject(input)) return fail("malformed-request", "op 必须是对象");
  const kind = input.kind;
  if (kind === "delete") return ok({ kind: "delete" });
  if (kind === "transform") {
    const localTransform = decodeMcpLocalTransform(input.localTransform);
    if (!localTransform.ok) return localTransform;
    const expected =
      input.expectedLocalTransform === undefined
        ? undefined
        : decodeMcpLocalTransform(input.expectedLocalTransform);
    if (expected && !expected.ok) return expected;
    return ok({
      kind: "transform",
      localTransform: localTransform.value,
      ...(expected && expected.ok ? { expectedLocalTransform: expected.value } : {})
    });
  }
  return fail("malformed-request", "未知 op.kind");
}

export function decodeMcpLocalTransform(input: unknown): McpDecodeResult<FilmSetLocalTransform> {
  if (!isJsonObject(input)) return fail("malformed-request", "localTransform 必须是对象");
  const offset = input.offset;
  if (!isJsonObject(offset) || !isFiniteNumber(offset.x) || !isFiniteNumber(offset.y) || !isFiniteNumber(offset.z)) {
    return fail("malformed-request", "localTransform.offset 必须是三分量有限数值");
  }
  if (!isFiniteNumber(input.scale) || (input.scale as number) <= 0) {
    return fail("malformed-request", "localTransform.scale 必须是正有限数值");
  }
  if (!isFiniteNumber(input.yaw)) return fail("malformed-request", "localTransform.yaw 必须是有限数值");
  return ok({
    offset: { x: offset.x as number, y: offset.y as number, z: offset.z as number },
    scale: input.scale as number,
    yaw: input.yaw as number
  });
}

export function decodeMcpPlayback(input: unknown): McpDecodeResult<FilmSetPlayback> {
  if (!isJsonObject(input)) return fail("malformed-request", "playback 必须是对象");
  const startTime = input.startTime ?? 0;
  const duration = input.duration ?? 0;
  const timeScale = input.timeScale ?? 1;
  const loop = input.loop ?? false;
  if (!isFiniteNumber(startTime) || (startTime as number) < 0) {
    return fail("malformed-request", "playback.startTime 必须是非负有限数值");
  }
  if (!isFiniteNumber(duration) || (duration as number) < 0) {
    return fail("malformed-request", "playback.duration 必须是非负有限数值");
  }
  if (!isFiniteNumber(timeScale) || (timeScale as number) <= 0) {
    return fail("malformed-request", "playback.timeScale 必须是正有限数值");
  }
  if (typeof loop !== "boolean") return fail("malformed-request", "playback.loop 必须是布尔值");
  return ok({
    startTime: startTime as number,
    duration: duration as number,
    timeScale: timeScale as number,
    loop
  });
}

/**
 * 解码片场媒体条目导入请求（D5）。
 *
 * 结构校验只做字段形态；来源节点是否 ready、资产身份与 precondition 由 Canvas 侧按权威画布
 * 裁定。`itemId` / `name` / `transform` 都是可选的调用方偏好。
 */
export function decodeMcpAddFilmSetMediaRequest(body: unknown): McpDecodeResult<McpAddFilmSetMediaRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  if (!isBoundedId(body.sourceNodeId)) return fail("malformed-request", "sourceNodeId 必须是非空字符串");
  if (body.expectedContentHash !== undefined && !isBoundedId(body.expectedContentHash)) {
    return fail("malformed-request", "expectedContentHash 必须是字符串");
  }
  if (body.itemId !== undefined && !isBoundedId(body.itemId)) {
    return fail("malformed-request", "itemId 必须是非空字符串");
  }
  if (body.name !== undefined && (typeof body.name !== "string" || body.name.trim() === "")) {
    return fail("malformed-request", "name 必须是非空字符串");
  }
  let transform: import("../film-set-content.js").FilmSetLocalTransform | undefined;
  if (body.transform !== undefined) {
    const decoded = decodeMcpLocalTransform(body.transform);
    if (!decoded.ok) return decoded;
    transform = decoded.value;
  }
  return ok({
    canvasId,
    nodeId: body.nodeId,
    requestId: body.requestId,
    sourceNodeId: body.sourceNodeId,
    ...(body.expectedContentHash === undefined ? {} : { expectedContentHash: body.expectedContentHash }),
    ...(body.itemId === undefined ? {} : { itemId: body.itemId }),
    ...(body.name === undefined ? {} : { name: body.name.trim() }),
    ...(transform ? { transform } : {})
  });
}

/**
 * 解码 agent 发起的显式导出请求（D8）。
 *
 * `profile` 必须是受支持档位；未知档位在这里拒绝，而不是悄悄降到 720p。像素、播放状态与
 * 浏览器句柄都不会出现在这个请求里。
 */
export function decodeMcpExportFilmSetClipRequest(body: unknown): McpDecodeResult<McpExportFilmSetClipRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.nodeId)) return fail("malformed-request", "nodeId 必须是非空字符串");
  if (!isBoundedId(body.clipId)) return fail("malformed-request", "clipId 必须是非空字符串");
  if (!isBoundedId(body.requestId)) return fail("malformed-request", "requestId 必须是非空字符串");
  if (!isFilmSetExportProfile(body.profile)) {
    return fail("malformed-request", "profile 必须是 standard / hd / hd60");
  }
  if (body.expectedContentHash !== undefined && !isBoundedId(body.expectedContentHash)) {
    return fail("malformed-request", "expectedContentHash 必须是字符串");
  }
  return ok({
    canvasId,
    nodeId: body.nodeId,
    clipId: body.clipId,
    requestId: body.requestId,
    profile: body.profile,
    ...(body.expectedContentHash === undefined ? {} : { expectedContentHash: body.expectedContentHash })
  });
}

/** 解码导出任务查询请求。 */
export function decodeMcpGetFilmSetExportRequest(body: unknown): McpDecodeResult<McpGetFilmSetExportRequest> {
  if (!isJsonObject(body)) return fail("malformed-request", "请求体必须是对象");
  const canvasId = readRequiredId(body, "canvasId");
  if (typeof canvasId === "object") return fail("malformed-request", canvasId.error);
  if (!isBoundedId(body.jobId)) return fail("malformed-request", "jobId 必须是非空字符串");
  return ok({ canvasId, jobId: body.jobId });
}
