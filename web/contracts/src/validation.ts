/**
 * 无副作用 JSON 运行时校验原语（change: split-web-runtime-services，任务 1.3）。
 *
 * 用于在**副作用之前**验证 request/response，并生成 contract fixtures。刻意不引入
 * schema 库：这些原语足够覆盖 v1 协议的形态，且保持 `contracts` 依赖图接近零。
 */

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 非空字符串（协议 id 字段统一用它；不做 trim 后改写，只判定）。 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 受限长度的非空字符串，防止超长 id 进入持久层。 */
export function isBoundedId(value: unknown, maxLength = 200): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/** 字符串数组（丢弃空串以匹配既有 normalization 行为）。 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0);
}

/**
 * 内容寻址对象键：`sha256-<64hex>` 或 `generation-outputs/<64hex>.<ext>`。
 *
 * 与 Media Service 的键策略一致；放在 contracts 是因为 Canvas 与 Task 都需要在**发协议
 * 之前**判定键形态，而它们不允许 import Media 实现。
 */
export const MEDIA_STORAGE_KEY_PATTERN = /^sha256-[0-9a-f]{64}$/;
export const GENERATED_OUTPUT_KEY_PATTERN = /^generation-outputs\/[0-9a-f]{64}\.[a-z0-9]+$/;

export function isValidStorageKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (MEDIA_STORAGE_KEY_PATTERN.test(value) || GENERATED_OUTPUT_KEY_PATTERN.test(value))
  );
}

/**
 * 拒绝「看起来像远程 URL」的持久值。
 *
 * 稳定持久层只允许 storageKey；任意 URL / data / blob 都是注入入口。
 */
export function looksLikeRemoteUrl(value: string): boolean {
  const lower = value.toLowerCase();
  return (
    lower.includes("://") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("//")
  );
}
