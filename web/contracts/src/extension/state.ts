/**
 * 站点插件公开状态 DTO（change: 2026-10-04-add-backend-plugin-extensions，任务 1.1 / design D4）。
 *
 * 公开状态**不含秘密**：只含目标启用、实际状态、配置版本、全局单调 revision 与安全诊断。
 * 实际状态为有限值，绝不能从开关布尔值推断后端已经 active（design D4）。
 */
import { isJsonObject, isNonNegativeInteger, isBoundedId } from "../validation.js";

/** 实际执行状态（有限值；draining 与 failed 必须可区分）。 */
export const APPLICATION_EXTENSION_ACTUAL_STATES = [
  "disabled",
  "unconfigured",
  "configuring",
  "active",
  "degraded",
  "failed",
  "draining"
] as const;
export type ApplicationExtensionActualState = (typeof APPLICATION_EXTENSION_ACTUAL_STATES)[number];

export function isApplicationExtensionActualState(value: unknown): value is ApplicationExtensionActualState {
  return (
    typeof value === "string" &&
    (APPLICATION_EXTENSION_ACTUAL_STATES as readonly string[]).includes(value)
  );
}

/** 不含秘密、可供普通用户读取的诊断。 */
export type ApplicationExtensionSafeDiagnostic = {
  code: string;
  message: string;
  /** 安全附加字段（只允许稳定标量；脱敏层已剔除敏感键）。 */
  detail?: string;
};

/** 单个插件的公开状态。 */
export type ApplicationExtensionStatus = {
  extensionId: string;
  desiredEnabled: boolean;
  actualState: ApplicationExtensionActualState;
  /** 实际生效的配置版本；未配置时为 null。 */
  configVersion: number | null;
  /** 全局单调 revision（所有插件共享同一序列）。 */
  extensionRevision: number;
  /** 在途工作引用数（work-handle 计数；重启后由 durable 状态重建）。 */
  activeWorkCount: number;
  diagnostics: ApplicationExtensionSafeDiagnostic[];
};

/** 公开可信元数据摘要（站点插件分区展示；可含展示目录，不含可执行入口与秘密）。 */
export type ApplicationExtensionMetadataSummary = {
  /** 部署侧提供的所在目录，仅用于展示。 */
  directory?: string;
  extensionId: string;
  name: string;
  description: string;
  version: string;
};

/** 站点插件公开状态 snapshot（权威恢复来源）。 */
export type ApplicationExtensionSnapshot = {
  /** 全局单调 revision。客户端只接受不早于当前 revision 的状态。 */
  revision: number;
  /** 服务端可信清单的公开元数据摘要（名称/说明；不含代码位置）。 */
  catalog: ApplicationExtensionMetadataSummary[];
  plugins: ApplicationExtensionStatus[];
};

/** 有界增量项：要么是完整状态，要么是删除通知。 */
export type ApplicationExtensionChange = {
  revision: number;
  extensionId: string;
  status: ApplicationExtensionStatus;
};

export type ApplicationExtensionChangeBatch = {
  revision: number;
  changes: ApplicationExtensionChange[];
  /** 增量不可用（cursor 过旧/丢失）时为 true，客户端必须重取 snapshot。 */
  resyncRequired: boolean;
};

/** 递归剔除敏感键与秘密载体后的安全值（永不回显配置秘密）。 */
const SENSITIVE_PLUGIN_KEYS = new Set([
  "secret",
  "secretValue",
  "secretRef",
  "secretRefs",
  "token",
  "apiKey",
  "password",
  "credential",
  "authorization",
  "value",
  "values",
  "config"
]);

const FORBIDDEN_VALUE_FRAGMENTS = ["data:", "blob:", "://", "base64"];

/**
 * 把任意诊断 detail 收敛为安全字符串；含秘密载体片段的一律丢弃。
 * 公开状态响应必须经过该函数（spec/design：公开响应不得包含秘密）。
 */
export function safeDiagnosticDetail(value: unknown): string | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const lower = value.toLowerCase();
  if (FORBIDDEN_VALUE_FRAGMENTS.some((fragment) => lower.includes(fragment))) return undefined;
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

/** 递归检测对象中是否含敏感/秘密字段（公开响应脱敏测试复用）。 */
export function containsSensitiveExtensionKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveExtensionKey(entry));
  if (!isJsonObject(value)) return false;
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_PLUGIN_KEYS.has(key)) return true;
    if (containsSensitiveExtensionKey(nested)) return true;
  }
  return false;
}

export function isApplicationExtensionStatus(value: unknown): value is ApplicationExtensionStatus {
  if (!isJsonObject(value)) return false;
  return (
    isBoundedId(value.extensionId) &&
    typeof value.desiredEnabled === "boolean" &&
    isApplicationExtensionActualState(value.actualState) &&
    (value.configVersion === null || isNonNegativeInteger(value.configVersion)) &&
    isNonNegativeInteger(value.extensionRevision) &&
    isNonNegativeInteger(value.activeWorkCount) &&
    Array.isArray(value.diagnostics)
  );
}

export function isApplicationExtensionSnapshot(value: unknown): value is ApplicationExtensionSnapshot {
  if (!isJsonObject(value)) return false;
  if (!isNonNegativeInteger(value.revision)) return false;
  if (!Array.isArray(value.catalog)) return false;
  if (!Array.isArray(value.plugins)) return false;
  return value.plugins.every((entry) => isApplicationExtensionStatus(entry));
}

export function isApplicationExtensionChangeBatch(value: unknown): value is ApplicationExtensionChangeBatch {
  if (!isJsonObject(value)) return false;
  return (
    isNonNegativeInteger(value.revision) &&
    typeof value.resyncRequired === "boolean" &&
    Array.isArray(value.changes) &&
    value.changes.every((entry) => isJsonObject(entry) && isApplicationExtensionStatus(entry.status))
  );
}
