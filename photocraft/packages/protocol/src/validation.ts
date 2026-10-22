/**
 * 包内私有 JSON 校验原语（change: 2026-10-21-extract-photocraft-subproject，任务 2.1）。
 *
 * 这些是 PhotoCraft 协议解码需要的**最小纯函数集**，与 Woohaa `contracts/src/validation.ts`
 * 中的同名实现逐字节等价。刻意在包内保留一份而不是依赖宿主包：协议包只允许依赖包内纯数据
 * 与纯函数（design D2），否则核心就无法在不读宿主源码的隔离副本中构建。
 */

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
