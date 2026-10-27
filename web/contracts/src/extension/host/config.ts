/**
 * 站点插件配置 DTO（change: 2026-10-04-add-backend-plugin-extensions，任务 1.1 / design D3）。
 *
 * 站点插件 enabled 与非秘密配置由后端持久化，影响所有用户；客户端本地偏好不得改写。
 * 秘密只以 **secret reference**（opaque id）形式出现，**绝不**保存秘密值本身。
 */
import { isJsonObject } from "../../validation.js";

/** 持久化 / 管理响应中的站点插件配置（非秘密）。 */
export type ApplicationExtensionConfig = {
  extensionId: string;
  /** 目标启用（desiredEnabled）。开关成功只表示配置已提交，不代表实际 active。 */
  desiredEnabled: boolean;
  /** 非秘密配置值（严格 JSON 对象）。 */
  values: Record<string, unknown>;
  /** 秘密引用（opaque id）；不包含秘密值。 */
  secretRefs: string[];
  /** 该插件配置数据的版本（schema 兼容性由此判定）。 */
  configVersion: number;
};

/** 管理员配置写入请求（先 prepare 候选，再以 expectedRevision 提交）。 */
export type ApplicationExtensionConfigWriteRequest = {
  /** 并发控制：必须等于当前持久化全局 revision，否则返回 revision-conflict。 */
  expectedRevision: number;
  enabled: boolean;
  values: Record<string, unknown>;
  secretRefs: string[];
};

/**
 * 判定一个值是否为受控的非秘密配置对象。
 *
 * 拒绝含嵌套数组/函数/`undefined` 的不可序列化值，且 secret 引用必须是字符串数组。
 */
export function isApplicationExtensionConfigValue(value: unknown): value is Record<string, unknown> {
  if (!isJsonObject(value)) return false;
  return isJsonSafe(value);
}

function isJsonSafe(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean") return true;
  if (type === "number") return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.every((entry) => isJsonSafe(entry));
  if (isJsonObject(value)) return Object.values(value).every((entry) => isJsonSafe(entry));
  return false;
}

/** 秘密引用只允许 opaque 短标识，禁止 URL/data/blob 等值载体。 */
export function isSecretReference(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  const lower = value.toLowerCase();
  return !lower.includes("://") && !lower.startsWith("data:") && !lower.startsWith("blob:");
}
