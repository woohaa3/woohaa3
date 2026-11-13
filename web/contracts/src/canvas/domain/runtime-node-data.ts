/**
 * 渲染器可移植 nodeData 契约
 * （change: align-godot-canvas-interactions，任务 1.1–1.3；
 *  change: replace-godot-canvas-runtime-with-bevy，任务 3.x/6.x 扩展为 renderer-neutral）。
 *
 * 设计 D7/D10：运行时只能上报**字段级** nodeData 意图，且只允许用户可编辑字段与
 * 渲染器可移植展示配置。任务/结果/资产/provenance/本机路径一律不得由运行时写入。
 *
 * 本模块是纯函数、无状态、JSON-only：
 * - `sanitizeRuntimeNodeConfigPatch`：翻译层 allowlist（越权字段移除，非法值拒绝）。
 * - `sanitizeNodeDataForClipboard`：复制清理（删除运行态/结果/本机路径）。
 * - 有限数值校验：NaN/Infinity/对象引用不得进入文档。
 *
 * 新增字段必须同时更新本 allowlist、spec 与 round-trip 测试（见 tasks 6.1）。
 */
import { sanitizeContentNodeData } from "../content-node-data.js";
import { observeContentResolver, type ContentContributionResolver } from "../content-contribution.js";
import type { CanvasNodeData } from "./types";
import type { Woohaa3CanvasJsonObject } from "./core";
import { normalizeVideoEditIntents } from "../../video/video-edit.js";
import { decodeModel3DNodeData } from "../canvas-node-model.js";
import { model3DNodeDataFields } from "../animation-snapshot.js";
import { decodeWorldInstanceData } from "../shared-world-codec.js";
import { decodeSceneAreaData, decodeWorkflowGroupData } from "../creation-scope-codec.js";
import { decodeWorldCamera } from "../world-camera-codec.js";

/** 首版允许运行时持久化的 nodeData 顶层字段。 */
export const RUNTIME_NODE_CONFIG_FIELDS = [
  "prompt",
  "panelPrompt",
  "agentId",
  "sceneId"
] as const;

/** 首版允许运行时持久化的模型摆放字段。 */
export const RUNTIME_MODEL_PLACEMENT_FIELDS = ["offset", "scale", "yaw", "position", "rotation", "scale3"] as const;

/** 首版允许运行时持久化的机位姿态字段。 */
export const RUNTIME_SHOT_POSE_FIELDS = ["azimuth", "distance", "target"] as const;

/** 向量字段（值为三分量数值数组，而非标量）。 */
const VECTOR_PLACEMENT_FIELDS = new Set(["position", "rotation", "scale3"]);

/**
 * 由运行时对象/runtime-only 数据误泄漏的顶层字段。
 *
 * 这些字段名本就不属于规范 nodeData（它们是渲染细节或本地路径），命中即移除；
 * 真正的越权字段（taskStatus/activeRunId/...）见 `NODE_DATA_TRANSIENT_FIELDS`。
 */
export const NODE_DATA_LOCAL_ONLY_FIELDS = [
  "jsPath",
  "imagePath",
  "localPath",
  "assetPath",
  "path",
  "filePath",
  "storageKey",
  "blob",
  "base64",
  "basis",
  "transform",
  "shotBasis",
  // 镜头 session-only 状态（change: add-model-editor-gizmo-shot-capture，design D2）：
  // 选中、hover、活动 handle、preview URL 与 capture 状态绝不进入 canonical canvas。
  "selectedCameraId",
  "cameraPreviewUrl",
  "cameraPreview",
  "cameraCapture",
  "cameraCaptureBusy"
] as const;

/**
 * 任务/结果/资产/provenance 字段：由服务端任务链路拥有，绝不从运行时或剪贴板写入。
 * （剪贴板复制时删除；运行时 patch 时移除。）
 */
export const NODE_DATA_TRANSIENT_FIELDS = [
  "activeRunId",
  "taskStatus",
  "status",
  "progress",
  "providerTaskId",
  "outputAssetId",
  "error",
  "errorMessage",
  "result",
  "resultPreview",
  "frozenPreview",
  "durationSeconds",
  "resourceKind"
] as const;

/** 已从文档模型删除的展示字段：读取/复制时丢弃，绝不重新写入。 */
export { NODE_DATA_REMOVED_FIELDS } from "./removed-node-data.js";
import { NODE_DATA_REMOVED_FIELDS } from "./removed-node-data.js";
const NODE_DATA_TRANSIENT_SET = new Set<string>([...NODE_DATA_TRANSIENT_FIELDS, ...NODE_DATA_REMOVED_FIELDS]);
const LOCAL_ONLY_SET = new Set<string>(NODE_DATA_LOCAL_ONLY_FIELDS);
const MODEL_PLACEMENT_SET = new Set<string>(RUNTIME_MODEL_PLACEMENT_FIELDS);
const SHOT_POSE_SET = new Set<string>(RUNTIME_SHOT_POSE_FIELDS);

export type RuntimeNodeConfigPatchResult =
  | { ok: true; value: CanvasNodeData }
  | { ok: false; reason: string };

/**
 * 翻译层 allowlist：校验并收敛运行时上报的 nodeData patch（renderer-neutral）。
 *
 * - 只保留 allowlist 内的字段；越权字段（task/结果/路径/运行时对象）被移除。
 * - 值必须是合法有限 JSON：非法类型或非有限数值 → 整条 patch 拒绝，不进协调层。
 * - 移除后为空 → 拒绝（不得提交空补丁）。
 */
export function sanitizeRuntimeNodeConfigPatch(input: unknown, context?: { content?: ContentContributionResolver }): RuntimeNodeConfigPatchResult {
  observeContentResolver(context?.content);
  if (!isRecord(input)) return { ok: false, reason: "nodeData patch 必须是对象" };

  const value: Woohaa3CanvasJsonObject = {};

  for (const [key, decode] of Object.entries({ sharedWorldInstance: decodeWorldInstanceData, workflowGroup2d: decodeWorkflowGroupData, sceneArea: decodeSceneAreaData, worldCamera: decodeWorldCamera })) {
    if (!(key in input)) continue;
    const result = decode(input[key]);
    if (!result.ok) return { ok: false, reason: `Invalid ${key}: ${result.code}` };
    value[key] = result.value as unknown as Woohaa3CanvasJsonObject[string];
  }

  for (const field of RUNTIME_NODE_CONFIG_FIELDS) {
    if (!(field in input)) continue;
    const raw = input[field];
    if (typeof raw !== "string") {
      return { ok: false, reason: `字段 ${field} 必须是字符串` };
    }
    value[field] = raw;
  }

  if ("modelPlacement" in input) {
    const placement = readModelPlacement(input.modelPlacement);
    if (!placement.ok) return placement;
    if (Object.keys(placement.value).length > 0) value.modelPlacement = placement.value;
  }
  if ("shotPose" in input) {
    const pose = readShotPose(input.shotPose);
    if (!pose.ok) return pose;
    if (Object.keys(pose.value).length > 0) value.shotPose = pose.value;
  }

  if (Object.keys(value).length === 0) {
    // 只包含越权/未知字段：运行时不得借此写入任何规范数据。
    return { ok: false, reason: "nodeData patch 不含任何允许字段" };
  }
  return { ok: true, value: value as CanvasNodeData };
}


/**
 * 复制清理：删除任务运行态、结果资产、provenance 与本机路径，保留用户配置。
 *
 * 粘贴后节点必须处于「无 active run 的可编辑状态」；本机路径也不得跨会话复制。
 *
 * `outputAssetId` 会被删除：它既可能是运行中生成任务的结果指针，也可能是上传素材/已结算生成结果
 * 的唯一内容引用，只有拿到画布资产上下文才能区分。剪贴板载荷在清理后按「资产确实存在、`ready`
 * 且 `mediaKind` 匹配」恢复内容引用（见 `canvas-shell/clipboard/payload.ts`），本函数保持保守口径。
 */
function sanitizeClaimedContent(data: Record<string, unknown>, content: ContentContributionResolver): CanvasNodeData | null {
  for (const contribution of content.implementations()) {
    const codec = contribution.nodeData;
    if (!codec?.schemaVersion || typeof codec.schemaVersion(data) !== "number") continue;
    try {
      const value = codec.sanitizeRuntime(structuredClone(data));
      if (!isRecord(value)) throw new Error("content-codec-failed");
      return value as CanvasNodeData;
    } catch (error) {
      if (error instanceof Error && error.message === "content-codec-failed") throw error;
      throw new Error("content-codec-failed");
    }
  }
  return null;
}

export function sanitizeNodeDataForClipboard(input: unknown, context?: { content?: ContentContributionResolver }): CanvasNodeData {
  observeContentResolver(context?.content);
  const original = isRecord(input) ? input : {};
  for (const [key, decode] of Object.entries({ sharedWorldInstance: decodeWorldInstanceData, workflowGroup2d: decodeWorkflowGroupData, sceneArea: decodeSceneAreaData, worldCamera: decodeWorldCamera })) {
    if (key in original && !decode(original[key]).ok) throw new Error(`Invalid ${key}`);
  }
  const owned = context?.content && Object.prototype.hasOwnProperty.call(original, "extensionId");
  const claimed = !owned && context?.content ? sanitizeClaimedContent(original, context.content) : null;
  const source = owned ? sanitizeContentNodeData(original as CanvasNodeData, context!.content!) : claimed ?? original;
  const value: Woohaa3CanvasJsonObject = {};
  for (const [key, raw] of Object.entries(source)) {
    if (NODE_DATA_TRANSIENT_SET.has(key)) continue;
    if (LOCAL_ONLY_SET.has(key)) continue;
    if (isLocalPathValue(raw)) continue;
    if (!isFiniteJsonValue(raw)) continue;
    // 视频编辑 intent：只复制安全收敛后的结构化 intent，危险 preview/URL 被丢弃
    // （change: port-video-editing-dialogs，design D6）。
    if (key === "videoEditIntents") {
      const normalized = normalizeVideoEditIntents(raw);
      if (normalized.ok && normalized.value.length > 0) value[key] = normalized.value as Woohaa3CanvasJsonObject[string];
      continue;
    }
    // 模型镜头：只复制规范化后的安全子集（丢弃未知字段/非法元素），
    // 绝不复制 selection、preview URL、Blob 或 capture 状态
    // （change: add-model-editor-gizmo-shot-capture，design D2）。
    // 自包含 3D 节点：复制时携带完整自身定义，不依赖来源节点。
    if (!owned && key === "modelContentVersion") {
      const model = decodeModel3DNodeData(source);
      if (model.ok) {
        for (const [field, fieldValue] of Object.entries(model3DNodeDataFields(model.value))) {
          if (isFiniteJsonValue(fieldValue)) value[field] = fieldValue as Woohaa3CanvasJsonObject[string];
        }
      }
      continue;
    }
    value[key] = raw as Woohaa3CanvasJsonObject[string];
  }
  return value as CanvasNodeData;
}

/** 值是否是本机路径（`res://`、`user://`、file://、绝对路径、URL）。 */
export function isLocalPathValue(input: unknown): boolean {
  if (typeof input !== "string" || input === "") return false;
  if (input.startsWith("res://") || input.startsWith("user://") || input.startsWith("file://")) {
    return true;
  }
  if (/^[a-zA-Z]:[\\/]/.test(input)) return true; // Windows 绝对路径
  if (input.startsWith("/") && !input.startsWith("//")) return true; // POSIX 绝对路径
  if (input.includes("://")) return true; // 任意 URL（含临时签名 URL）
  if (input.startsWith("data:") || input.startsWith("blob:")) return true;
  return false;
}

/** 是否是合法有限 JSON（无对象引用、无 NaN/Infinity、无函数）。 */
export function isFiniteJsonValue(input: unknown): boolean {
  if (input === null) return true;
  const type = typeof input;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(input as number);
  if (Array.isArray(input)) return input.every(isFiniteJsonValue);
  if (isRecord(input)) return Object.values(input).every(isFiniteJsonValue);
  return false;
}

function readModelPlacement(
  input: unknown
): { ok: true; value: Woohaa3CanvasJsonObject } | { ok: false; reason: string } {
  if (!isRecord(input)) return { ok: false, reason: "modelPlacement 必须是对象" };
  const value: Woohaa3CanvasJsonObject = {};
  for (const key of Object.keys(input)) {
    if (!MODEL_PLACEMENT_SET.has(key)) continue;
    const raw = input[key];
    if (key === "offset") {
      if (!isRecord(raw)) return { ok: false, reason: "modelPlacement.offset 必须是对象" };
      const offset: Woohaa3CanvasJsonObject = {};
      for (const axis of ["x", "y", "z"] as const) {
        if (!(axis in raw)) continue;
        if (!isFiniteNumber(raw[axis])) {
          return { ok: false, reason: `modelPlacement.offset.${axis} 必须是有限数值` };
        }
        offset[axis] = raw[axis] as number;
      }
      value.offset = offset;
      continue;
    }
    if (VECTOR_PLACEMENT_FIELDS.has(key)) {
      const vec = readVec3(raw);
      if (!vec) return { ok: false, reason: `modelPlacement.${key} 必须是三分量有限数值数组` };
      value[key] = vec;
      continue;
    }
    if (!isFiniteNumber(raw)) {
      return { ok: false, reason: `modelPlacement.${key} 必须是有限数值` };
    }
    value[key] = raw as number;
  }
  return { ok: true, value };
}

function readShotPose(
  input: unknown
): { ok: true; value: Woohaa3CanvasJsonObject } | { ok: false; reason: string } {
  if (!isRecord(input)) return { ok: false, reason: "shotPose 必须是对象" };
  const value: Woohaa3CanvasJsonObject = {};
  for (const key of Object.keys(input)) {
    if (!SHOT_POSE_SET.has(key)) continue;
    const raw = input[key];
    if (key === "target") {
      const vec = readVec3(raw);
      if (!vec) return { ok: false, reason: "shotPose.target 必须是三分量有限数值数组" };
      value.target = vec;
      continue;
    }
    if (!isFiniteNumber(raw)) {
      return { ok: false, reason: `shotPose.${key} 必须是有限数值` };
    }
    value[key] = raw as number;
  }
  return { ok: true, value };
}

function readVec3(input: unknown): Woohaa3CanvasJsonObject[string] | null {
  if (!Array.isArray(input) || input.length !== 3) return null;
  if (!input.every(isFiniteNumber)) return null;
  return [input[0] as number, input[1] as number, input[2] as number];
}

function isFiniteNumber(input: unknown): boolean {
  return typeof input === "number" && Number.isFinite(input);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}
