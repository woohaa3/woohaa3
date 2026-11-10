/**
 * Task execution history DTO：敏感字段脱敏白名单与预算
 * （自 `history.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R20）。
 */
import { isJsonObject, isStringArray } from "../../validation.js";

/** 结果摘要里允许出现的字段白名单（供实现侧裁剪时复用）。 */
export const SAFE_RESULT_FIELDS = ["mediaKind", "text", "textTruncated", "storageKey", "locator", "contentType", "size", "checksum", "durationSeconds", "poster"] as const;
/** 错误摘要里允许出现的字段白名单。 */
export const SAFE_ERROR_FIELDS = ["name", "message"] as const;
/** 详情事件里允许出现的字段白名单。 */
export const SAFE_EVENT_FIELDS = ["sequence", "occurredAt", "kind", "stage", "detail"] as const;

export function isSafeDetailKeys(keys: readonly string[]): boolean {
  return keys.every((key) => (SAFE_EVENT_FIELDS as readonly string[]).includes(key));
}

/** 供测试断言「摘要里不会出现敏感键」。 */
export const FORBIDDEN_HISTORY_KEYS = [
  "prompt",
  "input",
  "providerInput",
  "providerOutput",
  "rawInput",
  "rawOutput",
  "bytes",
  "base64",
  "blob",
  "url",
  "signedUrl",
  "annotationImageDataUrl",
  "authorization",
  "apiKey",
  "stack",
  "headers"
] as const;

/** 递归判定对象里是否含任何敏感键（测试与运行时裁剪共用）。 */
export function containsForbiddenHistoryKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenHistoryKey);
  if (!isJsonObject(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if ((FORBIDDEN_HISTORY_KEYS as readonly string[]).includes(key)) return true;
    if (containsForbiddenHistoryKey(nested)) return true;
  }
  return false;
}

export function isStringArrayField(value: unknown): value is string[] {
  return isStringArray(value);
}
