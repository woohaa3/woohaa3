/**
 * 版本化 JavaScript 模型脚本契约（change: replace-godot-canvas-runtime-with-bevy，任务 1.2；
 *  change: 2026-10-07-remove-residual-compatibility —— V2-only）。
 *
 * 规范 `nodeData.modelScript` 继续作为模型的唯一权威定义。浏览器用注入的 SceneBuilder API
 * 执行脚本，结果经 Scene IR validator 校验后送给 Bevy；Scene IR 只是运行时 DTO，**绝不**
 * 写回规范 Y.Doc。
 *
 * 本模块无副作用、浏览器与服务端可共用：前端 executor 与 Canvas Service 从这里取版本常量与判定函数。
 */

/** 新写入脚本必须声明的语言。 */
export const MODEL_SCRIPT_LANGUAGE = "javascript" as const;
/** 唯一受支持的脚本版本（V2）。 */
export const MODEL_SCRIPT_V2_VERSION = "woohaa-model-js-v2" as const;
/** V2 Scene IR 的运行时版本（不写规范文档）。 */
export const MODEL_SCRIPT_SCENE_IR_V2_VERSION = "woohaa-model-scene-ir-v2" as const;

export type ModelScriptLanguage = typeof MODEL_SCRIPT_LANGUAGE;
export type ModelScriptVersionV2 = typeof MODEL_SCRIPT_V2_VERSION;
/** 当前受支持的脚本版本。 */
export type SupportedModelScriptVersion = ModelScriptVersionV2;

/** 新提交/新指南的默认（也是唯一）版本。 */
export const PREFERRED_MODEL_SCRIPT_VERSION: SupportedModelScriptVersion = MODEL_SCRIPT_V2_VERSION;
/** 全部可执行/可渲染版本（仅 V2）。 */
export const SUPPORTED_MODEL_SCRIPT_VERSIONS: readonly SupportedModelScriptVersion[] = [
  MODEL_SCRIPT_V2_VERSION
];

/** 模型脚本来源类型：language/version 字段可能缺失。 */
export type ModelScriptDescriptor = {
  language?: unknown;
  version?: unknown;
};

/** 版本是否为当前受支持的脚本版本。 */
export function isSupportedModelScriptVersion(version: unknown): version is SupportedModelScriptVersion {
  return version === MODEL_SCRIPT_V2_VERSION;
}

/** 脚本版本 → 它产出的 Scene IR 版本。 */
export function sceneIrVersionFor(version: SupportedModelScriptVersion): string {
  void version;
  return MODEL_SCRIPT_SCENE_IR_V2_VERSION;
}

/**
 * 记录是否已经是受支持的版本化 JavaScript 脚本（V1 或 V2）。
 *
 * 只有 language 与 version **同时**受支持才视为合法脚本；任一缺失或未知都返回 false。
 */
export function isSupportedModelScript(descriptor: ModelScriptDescriptor): boolean {
  return (
    descriptor.language === MODEL_SCRIPT_LANGUAGE &&
    isSupportedModelScriptVersion(descriptor.version)
  );
}

/**
 * language/version 组合是否合法（写入前校验，配合 spec「拒绝不匹配的语言版本」）。
 *
 * V1 在迁移窗口内仍可写入（旧节点恢复、显式回滚）；V2 是新提交的默认首选版本。
 * 未知版本由 `isSupportedModelScriptVersion` 稳定拒绝。
 */
export function isWritableModelScriptLanguage(language: unknown, version: unknown): boolean {
  return language === MODEL_SCRIPT_LANGUAGE && isSupportedModelScriptVersion(version);
}
