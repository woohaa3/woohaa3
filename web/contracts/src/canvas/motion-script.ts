/**
 * `woohaa-motion-js-v1` 运动脚本契约与版本常量
 * （change: 2026-10-05-bind-model-animation-to-shots，任务 1.2 / 1.4）。
 *
 * 动画节点用一个独立的 motionScript 描述镜头运动与模型动作；它不创建几何、不读取其他
 * 节点，只通过稳定部件 ID 引用本节点模型。脚本在编译/内容变化时执行一次，生成受控
 * `MotionIr`（见 `motion-ir`），播放时由执行器按时间求值，不每帧重跑 JavaScript。
 *
 * 本模块无副作用、JSON-only：定义与校验 `MotionDefinition`，派生运动源码哈希，比较
 * `basedOnModelVersion` 与当前模型内容版本。作者 API 版本与模型 API 版本相互独立。
 */
import { isBoundedId, isFiniteNumber, isJsonObject, isNonNegativeInteger } from "../validation.js";
import type { ModelContentVersion } from "./model-definition.js";

/** motionScript 语言（与模型脚本一致，均为 JavaScript）。 */
export const MOTION_SCRIPT_LANGUAGE = "javascript" as const;
/** 当前受支持的 motionScript 作者 API 版本。 */
export const MOTION_SCRIPT_VERSION = "woohaa-motion-js-v1" as const;
export type MotionScriptLanguage = typeof MOTION_SCRIPT_LANGUAGE;
export type MotionScriptVersion = typeof MOTION_SCRIPT_VERSION;
/** 全部受支持的运动脚本版本。 */
export const SUPPORTED_MOTION_SCRIPT_VERSIONS: readonly MotionScriptVersion[] = [MOTION_SCRIPT_VERSION];

/** motion.revision / 内容标识上限。 */
export const MOTION_REVISION_MAX = 1_000_000;
export const MOTION_HASH_MAX = 200;

/**
 * 运动「最近确认适配过」的本地模型版本。
 *
 * 只保存当时的本地模型 revision（供用户阅读）与 contentHash（判断是否仍为相同模型内容）；
 * 不记录来源模型节点的实时版本（design「版本提示比较本节点数据」）。
 */
export type MotionBasedOnModelVersion = {
  revision: number;
  contentHash: string;
};

/** 完整运动定义（动画节点自身拥有）。 */
export type MotionDefinition = {
  motionScript: string;
  motionScriptLanguage: MotionScriptLanguage;
  motionScriptVersion: MotionScriptVersion;
  /** 本节点运动源码修改次数（正整数）。 */
  revision: number;
  /** 运动源码的内容标识。 */
  sourceHash: string;
  /** 运动最近确认适配过的本地模型内容版本。 */
  basedOnModelVersion: MotionBasedOnModelVersion;
};

/** 版本匹配结果：内容一致即 matched（revision 只用于展示）。 */
export type MotionVersionMatch = "matched" | "changed";

/** 内容校验结果：checking/valid/invalid/unavailable 是本地派生状态，不写入模型定义。 */
export type MotionValidation = "checking" | "valid" | "invalid" | "unavailable";

export type MotionDefinitionDecodeResult =
  | { ok: true; value: MotionDefinition }
  | { ok: false; reason: string };

/** 是否受支持的 motionScript 语言/版本组合。 */
export function isSupportedMotionScript(language: unknown, version: unknown): boolean {
  return language === MOTION_SCRIPT_LANGUAGE && version === MOTION_SCRIPT_VERSION;
}

/**
 * 读取并校验完整 `MotionDefinition`。
 *
 * 要求脚本、语言、受支持 API 版本、revision、sourceHash 与 basedOnModelVersion 齐备；
 * 无运动时 motionScript 可为空字符串。基于旧模型的运动仍可合法保存（data 完整），
 * 是否阻止播放由版本检查派生状态决定，不在这里拒绝。
 */
export function decodeMotionDefinition(input: unknown): MotionDefinitionDecodeResult {
  if (!isJsonObject(input)) return { ok: false, reason: "nodeData 必须是对象" };
  const { motionScript, motionScriptLanguage, motionScriptVersion, motionRevision, motionSourceHash } = input;
  if (typeof motionScript !== "string") return { ok: false, reason: "motionScript 必须是字符串" };
  if (!isSupportedMotionScript(motionScriptLanguage, motionScriptVersion)) {
    return {
      ok: false,
      reason: `不支持的 motionScript 语言/版本 ${String(motionScriptLanguage)} / ${String(motionScriptVersion)}`
    };
  }
  if (!isNonNegativeInteger(motionRevision) || motionRevision < 1 || motionRevision > MOTION_REVISION_MAX) {
    return { ok: false, reason: "motionRevision 必须是正整数" };
  }
  if (!isBoundedId(motionSourceHash, MOTION_HASH_MAX)) {
    return { ok: false, reason: "motionSourceHash 非法" };
  }
  const basedOn = decodeBasedOnModelVersion(input.motionBasedOnModelVersion);
  if (!basedOn.ok) return basedOn;
  return {
    ok: true,
    value: {
      motionScript,
      motionScriptLanguage: MOTION_SCRIPT_LANGUAGE,
      motionScriptVersion: MOTION_SCRIPT_VERSION,
      revision: motionRevision,
      sourceHash: motionSourceHash,
      basedOnModelVersion: basedOn.value
    }
  };
}

function decodeBasedOnModelVersion(
  input: unknown
): { ok: true; value: MotionBasedOnModelVersion } | { ok: false; reason: string } {
  if (!isJsonObject(input)) return { ok: false, reason: "motionBasedOnModelVersion 必须是对象" };
  const { revision, contentHash } = input;
  if (!isNonNegativeInteger(revision) || revision < 1 || revision > MOTION_REVISION_MAX) {
    return { ok: false, reason: "motionBasedOnModelVersion.revision 必须是正整数" };
  }
  if (!isBoundedId(contentHash, MOTION_HASH_MAX)) {
    return { ok: false, reason: "motionBasedOnModelVersion.contentHash 非法" };
  }
  return { ok: true, value: { revision, contentHash } };
}

/** 运动源码内容标识（与模型脚本同算法，便于并发 precondition 与幂等 commandId）。 */
export function hashMotionScript(source: string): string {
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) {
    hash = ((hash << 5) + hash + source.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * 版本匹配：以 contentHash 为准。
 *
 * 源码、API 版本或 placement 变化都会改变模型 contentHash，从而判定 `changed`；
 * revision 只用于展示。来源模型节点的当前版本不参与（design「版本提示比较本节点数据」）。
 */
export function compareMotionToModel(
  motion: MotionDefinition,
  modelContentVersion: ModelContentVersion
): MotionVersionMatch {
  return motion.basedOnModelVersion.contentHash === modelContentVersion.contentHash ? "matched" : "changed";
}

/** 生成「基于当前模型」的适配关联（初次创建或用户显式确认适配时使用）。 */
export function basedOnModel(modelContentVersion: ModelContentVersion): MotionBasedOnModelVersion {
  return { revision: modelContentVersion.revision, contentHash: modelContentVersion.contentHash };
}

/** 校验可选的有限数值（供运动参数读取复用）。 */
export function isFiniteMotionNumber(value: unknown): value is number {
  return isFiniteNumber(value);
}
