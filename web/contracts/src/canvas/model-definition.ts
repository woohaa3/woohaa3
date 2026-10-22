/**
 * 自包含 ModelDefinition 契约
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 1.1 / 1.3）。
 *
 * 三维模型节点与三维动画节点都保存**完整本地模型定义**：源码、语言、作者 API 版本、
 * 本地内容版本与摆放。运行时只读取本节点定义，不通过来源节点 ID、连线或历史 entryId
 * 取得模型（design「节点保存什么」）。
 *
 * 本模块无副作用、JSON-only：从 nodeData 派生内容标识、校验不受信任的定义、生成默认放置。
 * `modelScriptLanguage` / `modelScriptVersion` 复用既有 `model-script` 常量，未知版本稳定拒绝。
 * 内容标识（sourceHash / contentHash）由**实际保存内容**派生，客户端不能任意声明。
 */
import { hashModelScript } from "./model-executor.js";
import { fnv1a64Hex } from "./content-hash.js";
import {
  MODEL_SCRIPT_LANGUAGE,
  isWritableModelScriptLanguage,
  type SupportedModelScriptVersion
} from "./model-script.js";
import { isBoundedId, isFiniteNumber, isJsonObject, isNonNegativeInteger } from "../validation.js";

/** 模型摆放：offset 使用固定 64 世界单位嵌入，scale 为等比缩放，yaw 为绕世界 Y 轴角度。 */
export type ModelPlacement = {
  offset: { x: number; y: number; z: number };
  scale: number;
  yaw: number;
};

/** 默认摆放（零偏移、单位缩放、无旋转）。 */
export const DEFAULT_MODEL_PLACEMENT: ModelPlacement = {
  offset: { x: 0, y: 0, z: 0 },
  scale: 1,
  yaw: 0
};

/**
 * 本节点模型内容版本。
 *
 * - `revision`：本节点模型内容的正整数修改版本；新建副本从 1 开始。
 * - `sourceHash`：`modelScript` 源码的内容标识（与既有模型历史 sourceHash 同源）。
 * - `contentHash`：源码、语言、API 版本与 placement 的内容标识；版本匹配以它为准。
 */
export type ModelContentVersion = {
  revision: number;
  sourceHash: string;
  contentHash: string;
};

/** 完整本地模型定义（模型节点与动画节点各存一份，互不引用）。 */
export type ModelDefinition = {
  modelScript: string;
  modelScriptLanguage: typeof MODEL_SCRIPT_LANGUAGE;
  modelScriptVersion: SupportedModelScriptVersion;
  contentVersion: ModelContentVersion;
  placement: ModelPlacement;
};

/** 内容标识 / 版本字段的稳定上限（防止超长身份进入持久层）。 */
export const MODEL_CONTENT_HASH_MAX = 200;
/** 本节点模型内容版本上限，避免无界增长。 */
export const MODEL_CONTENT_REVISION_MAX = 1_000_000;

export type ModelDefinitionDecodeResult =
  | { ok: true; value: ModelDefinition }
  | { ok: false; reason: string };

/**
 * 读取并校验 flat nodeData 上的可选 `modelPlacement`。
 *
 * 缺失/`null` → 默认摆放；未知字段丢弃；非有限数值、非正 scale 拒绝（不静默纠正）。
 */
export function decodeLocalModelPlacement(input: unknown): { ok: true; value: ModelPlacement } | { ok: false; reason: string } {
  if (input === undefined || input === null) return { ok: true, value: clonePlacement(DEFAULT_MODEL_PLACEMENT) };
  if (!isJsonObject(input)) return { ok: false, reason: "modelPlacement 必须是对象" };
  const rawOffset = input.offset;
  let offset = { x: 0, y: 0, z: 0 };
  if (rawOffset !== undefined && rawOffset !== null) {
    if (!isJsonObject(rawOffset)) return { ok: false, reason: "modelPlacement.offset 必须是对象" };
    const { x, y, z } = rawOffset;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(z)) {
      return { ok: false, reason: "modelPlacement.offset 必须是三分量有限数值" };
    }
    offset = { x, y, z };
  }
  const scale = input.scale === undefined || input.scale === null ? 1 : input.scale;
  if (!isFiniteNumber(scale) || scale <= 0) {
    return { ok: false, reason: "modelPlacement.scale 必须是正有限数值" };
  }
  const yaw = input.yaw === undefined || input.yaw === null ? 0 : input.yaw;
  if (!isFiniteNumber(yaw)) return { ok: false, reason: "modelPlacement.yaw 必须是有限数值" };
  return { ok: true, value: { offset, scale, yaw } };
}

/** 校验并读取完整 `ModelContentVersion`；revision 必须为正整数，哈希为非空受限字符串。 */
export function decodeModelContentVersion(
  input: unknown
): { ok: true; value: ModelContentVersion } | { ok: false; reason: string } {
  if (!isJsonObject(input)) return { ok: false, reason: "modelContentVersion 必须是对象" };
  const { revision, sourceHash, contentHash } = input;
  if (!isNonNegativeInteger(revision) || revision < 1 || revision > MODEL_CONTENT_REVISION_MAX) {
    return { ok: false, reason: "modelContentVersion.revision 必须是正整数" };
  }
  if (!isBoundedId(sourceHash, MODEL_CONTENT_HASH_MAX)) {
    return { ok: false, reason: "modelContentVersion.sourceHash 非法" };
  }
  if (!isBoundedId(contentHash, MODEL_CONTENT_HASH_MAX)) {
    return { ok: false, reason: "modelContentVersion.contentHash 非法" };
  }
  return { ok: true, value: { revision, sourceHash, contentHash } };
}

/**
 * 从 flat nodeData 读取并校验完整本地模型定义。
 *
 * 要求源码、语言、受支持作者 API 版本、内容版本齐备；placement 缺失按默认值补齐。
 * 任一字段缺失/非法时返回稳定失败（调用方保留完整数据、阻止播放，见 design 版本提示表）。
 */
export function decodeModelDefinition(input: unknown): ModelDefinitionDecodeResult {
  if (!isJsonObject(input)) return { ok: false, reason: "nodeData 必须是对象" };
  const { modelScript, modelScriptLanguage, modelScriptVersion } = input;
  if (typeof modelScript !== "string") return { ok: false, reason: "modelScript 必须是字符串" };
  if (!isWritableModelScriptLanguage(modelScriptLanguage, modelScriptVersion)) {
    return { ok: false, reason: `不支持的模型脚本语言/版本 ${String(modelScriptLanguage)} / ${String(modelScriptVersion)}` };
  }
  const contentVersion = decodeModelContentVersion(input.modelContentVersion);
  if (!contentVersion.ok) return contentVersion;
  const placement = decodeLocalModelPlacement(input.modelPlacement);
  if (!placement.ok) return placement;
  return {
    ok: true,
    value: {
      modelScript,
      modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
      modelScriptVersion: modelScriptVersion as SupportedModelScriptVersion,
      contentVersion: contentVersion.value,
      placement: placement.value
    }
  };
}

/** 模型源码内容标识：与既有模型历史共用同一算法，保证跨节点可比较。 */
export function modelSourceHash(modelScript: string): string {
  return hashModelScript(modelScript);
}

/**
 * 内容标识：源码、语言、作者 API 版本与 placement 的确定性哈希。
 *
 * 只改来源说明（origin）不改变内容标识；placement 变化会改变内容标识（design「版本提示比较
 * 本节点数据」）。使用固定字段顺序的规范化字符串，保证语义相同的输入得到相同结果。
 */
export function modelContentHash(input: {
  modelScript: string;
  modelScriptLanguage: string;
  modelScriptVersion: string;
  placement: ModelPlacement;
}): string {
  const canonical = [
    "woohaa-model-content-v1",
    input.modelScriptLanguage,
    input.modelScriptVersion,
    input.modelScript,
    placementKey(input.placement)
  ].join("\u0000");
  return fnv1a64Hex(canonical);
}

/**
 * 由实际保存内容派生完整 `ModelContentVersion`。
 *
 * `revision` 由服务端在每次真实变更时推进（同请求重试不重复增加）；本函数只负责派生哈希，
 * 不决定 revision。调用方须传入正整数 revision。
 */
export function deriveModelContentVersion(input: {
  modelScript: string;
  modelScriptLanguage: string;
  modelScriptVersion: string;
  placement: ModelPlacement;
  revision: number;
}): ModelContentVersion {
  return {
    revision: input.revision,
    sourceHash: modelSourceHash(input.modelScript),
    contentHash: modelContentHash(input)
  };
}

/** 摆放的规范化字符串键（offset/scale/yaw 固定顺序），用于内容标识。 */
export function placementKey(placement: ModelPlacement): string {
  const { offset, scale, yaw } = placement;
  return `${offset.x},${offset.y},${offset.z},${scale},${yaw}`;
}

/** 深拷贝摆放，避免调用方共享可变引用。 */
export function clonePlacement(placement: ModelPlacement): ModelPlacement {
  return { offset: { ...placement.offset }, scale: placement.scale, yaw: placement.yaw };
}

/**
 * 按**实际保存内容**归一化完整模型定义
 * （change: 2026-10-06-fix-animation3d-runtime-and-authoring，任务 1.1/1.2）。
 *
 * 客户端声明的 revision/hash 不作为权威值：内容标识始终由实际源码、语言、作者 API 版本与
 * 摆放派生；revision 由调用方给出的 `previousRevision` 与内容是否变化决定
 * （内容不变保持原 revision，变化则 +1）。模型编辑/导入不得自动改写运动的适配关联。
 */
export function normalizeModelDefinition(input: {
  modelScript: unknown;
  modelScriptLanguage: unknown;
  modelScriptVersion: unknown;
  placement?: unknown;
  /** 本节点当前模型内容版本（用于判断是否推进 revision）。 */
  previous?: ModelContentVersion | null;
}): ModelDefinitionDecodeResult {
  if (typeof input.modelScript !== "string") return { ok: false, reason: "modelScript 必须是字符串" };
  if (!isWritableModelScriptLanguage(input.modelScriptLanguage, input.modelScriptVersion)) {
    return {
      ok: false,
      reason: `不支持的模型脚本语言/版本 ${String(input.modelScriptLanguage)} / ${String(input.modelScriptVersion)}`
    };
  }
  const placement = decodeLocalModelPlacement(input.placement);
  if (!placement.ok) return placement;
  const contentHash = modelContentHash({
    modelScript: input.modelScript,
    modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
    modelScriptVersion: input.modelScriptVersion as string,
    placement: placement.value
  });
  const previous = input.previous ?? null;
  const revision = previous && previous.contentHash === contentHash ? previous.revision : (previous?.revision ?? 0) + 1;
  const value: ModelDefinition = {
    modelScript: input.modelScript,
    modelScriptLanguage: MODEL_SCRIPT_LANGUAGE,
    modelScriptVersion: input.modelScriptVersion as SupportedModelScriptVersion,
    contentVersion: {
      revision,
      sourceHash: modelSourceHash(input.modelScript),
      contentHash
    },
    placement: placement.value
  };
  return { ok: true, value };
}

/** 归一化到正整数 revision 的上限内（防御越界历史值）。 */
export function clampModelRevision(revision: number): number {
  if (!Number.isInteger(revision) || revision < 1) return 1;
  return Math.min(revision, MODEL_CONTENT_REVISION_MAX);
}
