/**
 * 模型身份与交互描述契约
 * （change: 2026-09-29-add-pluggable-model-interactions，任务 1.1 / 1.2 / design D1 / D2）。
 *
 * 模型身份拆成三层：
 * - `modelKey`：Task Service 发行的 **opaque** catalog 内唯一身份，调用方只做查找，
 *   **不得** 通过分隔符解析出 Provider 或原始模型 id；
 * - `providerId`：Provider 身份（路由用，由 Task Service 权威解析）；
 * - `providerModelId`：Provider 自己的原始模型 id（只传给 Provider adapter）。
 *
 * `interaction` 只是选择一个本地受信任 Cordis Plugin 的 **非执行** identity：
 * catalog / Provider description **绝不能** 携带 module URL、component path、dynamic import、
 * JS 源码或任意 React component。这里只做形态与大小的白名单校验。
 */
import { isBoundedId, isJsonObject } from "../validation.js";

/**
 * modelKey 是 catalog 内唯一的 opaque 字符串；用受限字符集避免注入与不可见字符。
 *
 * 允许 `/`：Provider 原始模型 id 可能含路径段（如 RunningHub `api/<endpoint>`、
 * `bytedance/seedance-2.0-global`），modelKey 是 `<providerId>:<providerModelId>`。
 * 仍然 opaque（调用方只做查找，不解析），且无空白/控制字符/编码绕过。
 */
export const MODEL_KEY_MAX_LENGTH = 200;
export const MODEL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export function isModelKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MODEL_KEY_MAX_LENGTH &&
    MODEL_KEY_PATTERN.test(value)
  );
}

/** Provider 原始模型 id 继续使用受限非空字符串（不要求 modelKey 的字符集）。 */
export function isProviderModelId(value: unknown): value is string {
  return isBoundedId(value);
}

/** interaction id 的允许字符集与长度（catalog 只声明非执行 identity）。 */
export const MODEL_INTERACTION_MAX_ID_LENGTH = 64;
export const MODEL_INTERACTION_MAX_VERSION = 1000;
export const MODEL_INTERACTION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** 内置 generic 交互的稳定 identity（design D9）。 */
export const GENERIC_MODEL_INTERACTION_ID = "generic-model";
export const GENERIC_MODEL_INTERACTION_VERSION = 1;

/**
 * Catalog 模型声明的交互 identity。
 *
 * 精确 `{ id, version }` 匹配：不允许多余字段（防止 Provider 借 descriptor 夹带
 * module URL / 源码），也不允许用较新/较旧版本隐式替代。
 */
export type ModelInteractionDescriptor = {
  id: string;
  version: number;
};

export function isModelInteractionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MODEL_INTERACTION_MAX_ID_LENGTH &&
    MODEL_INTERACTION_ID_PATTERN.test(value)
  );
}

/**
 * 严格校验 interaction descriptor：恰好 `{ id, version }`，id 合法，version 为正整数上限内。
 *
 * 任何额外字段（moduleUrl/componentPath/source/...）都判为非法，调用方必须拒绝整个配置。
 */
export function isModelInteractionDescriptor(value: unknown): value is ModelInteractionDescriptor {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("version")) return false;
  return (
    isModelInteractionId(value.id) &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    value.version >= 1 &&
    value.version <= MODEL_INTERACTION_MAX_VERSION
  );
}

/**
 * 从不可信输入规范化 interaction descriptor；非法（含多余字段）返回 null。
 *
 * `fallback` 用于 operator 未显式配置时的受信任默认（generic）。
 */
export function normalizeModelInteractionDescriptor(
  input: unknown,
  fallback?: ModelInteractionDescriptor
): ModelInteractionDescriptor | null {
  if (input === undefined || input === null) return fallback ? { ...fallback } : null;
  if (!isModelInteractionDescriptor(input)) return null;
  return { id: input.id, version: input.version };
}

/** 两个 descriptor 是否精确一致（id + version）。 */
export function sameModelInteraction(
  left: ModelInteractionDescriptor | undefined,
  right: ModelInteractionDescriptor | undefined
): boolean {
  if (!left || !right) return false;
  return left.id === right.id && left.version === right.version;
}

/** 在 catalog 模型列表里按 modelKey 查找（唯一的权威 lookup 语义）。 */
export function findCatalogModelByKey<T extends { modelKey: string }>(
  models: readonly T[],
  modelKey: string
): T | undefined {
  return models.find((model) => model.modelKey === modelKey);
}
