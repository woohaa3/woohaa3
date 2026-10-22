/**
 * 可信应用插件清单（共享纯数据）
 * （change: 2026-10-04-add-backend-plugin-extensions，任务 1.1/1.2 / design D1）。
 *
 * 共享清单只声明 extensionId、版本、管理范围、配置 schema identity、宿主与能力摘要；**前端入口
 * 与后端入口分别由各自构建清单静态 import**（见 frontend/backend 侧 trusted-manifest）。本模块
 * 不引用任何前端/后端实现，也不含模块地址、源码或 eval。
 *
 * 生产清单**不含样例/测试插件**：fixture 只在测试清单登记。
 */
import type {
  ApplicationExtensionHost,
  ApplicationExtensionMetadata
} from "./manifest.js";
import { APPLICATION_EXTENSION_HOSTS, decodeApplicationExtensionMetadata } from "./manifest.js";

/** 配置范围：站点插件一律使用服务端权威站点配置，不得写入 browser-local。 */
export const APPLICATION_EXTENSION_CONFIG_SCOPE = "site" as const;
export type ApplicationExtensionConfigScope = typeof APPLICATION_EXTENSION_CONFIG_SCOPE;

/**
 * 可信应用插件条目：共享元数据 + 前后端入口存在性 + 后端宿主。
 *
 * `frontendEntry`/`backendHosts` 只声明**存在性**（布尔/宿主名），真正的可执行入口由两侧
 * 构建清单静态 import；管理数据无法通过本结构加载任意代码。
 */
export type ApplicationExtensionTrustedEntry = ApplicationExtensionMetadata & {
  /** 是否存在可信前端入口（由 frontend 构建清单提供实现）。 */
  frontendEntry: boolean;
  /** 可信后端宿主集合（由对应服务构建清单提供实现）。 */
  backendHosts: ApplicationExtensionHost[];
  configScope: ApplicationExtensionConfigScope;
};

export type ApplicationExtensionCatalog = {
  entries: ApplicationExtensionTrustedEntry[];
};

type DecodeResult<T> = { ok: true; value: T } | { ok: false; code: string; message: string };

/** 校验单个条目：元数据合法、入口存在性一致、config scope 固定为 site。 */
export function validateApplicationExtensionTrustedEntry(
  value: unknown
): DecodeResult<ApplicationExtensionTrustedEntry> {
  const metadata = decodeApplicationExtensionMetadata(value);
  if (!metadata.ok) return metadata;
  const entry = value as Record<string, unknown>;
  if (typeof entry.frontendEntry !== "boolean") {
    return { ok: false, code: "malformed-request", message: "frontendEntry 必须是布尔值" };
  }
  if (
    !Array.isArray(entry.backendHosts) ||
    !entry.backendHosts.every((host) => (APPLICATION_EXTENSION_HOSTS as readonly string[]).includes(host as string))
  ) {
    return { ok: false, code: "malformed-request", message: "backendHosts 必须是受支持宿主数组" };
  }
  if (!entry.frontendEntry && entry.backendHosts.length === 0) {
    return { ok: false, code: "malformed-request", message: "插件必须至少提供一个可信入口" };
  }
  if (entry.configScope !== APPLICATION_EXTENSION_CONFIG_SCOPE) {
    return { ok: false, code: "malformed-request", message: "configScope 必须是 site" };
  }
  return {
    ok: true,
    value: {
      ...metadata.value,
      frontendEntry: entry.frontendEntry,
      backendHosts: [...(entry.backendHosts as ApplicationExtensionHost[])],
      configScope: APPLICATION_EXTENSION_CONFIG_SCOPE
    }
  };
}

/**
 * 校验整份可信清单：逐条合法且 extensionId 全局唯一（重复 identity 稳定拒绝）。
 */
export function validateApplicationExtensionCatalog(entries: readonly unknown[]): DecodeResult<ApplicationExtensionCatalog> {
  if (!Array.isArray(entries)) {
    return { ok: false, code: "malformed-request", message: "可信清单必须是数组" };
  }
  const out: ApplicationExtensionTrustedEntry[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const validated = validateApplicationExtensionTrustedEntry(entry);
    if (!validated.ok) {
      return { ok: false, code: validated.code, message: `entries[${index}]：${validated.message}` };
    }
    if (seen.has(validated.value.extensionId)) {
      return { ok: false, code: "malformed-request", message: `可信清单含重复 extensionId：${validated.value.extensionId}` };
    }
    seen.add(validated.value.extensionId);
    out.push(validated.value);
  }
  return { ok: true, value: { entries: out } };
}

/** 构建一份可信清单（构建时静态调用；重复/非法立即抛错，避免带病清单上线）。 */
export function defineApplicationExtensionCatalog(entries: readonly ApplicationExtensionTrustedEntry[]): ApplicationExtensionCatalog {
  const validated = validateApplicationExtensionCatalog(entries);
  if (!validated.ok) throw new Error(`应用插件可信清单无效：${validated.message}`);
  return validated.value;
}

export function findApplicationExtensionEntry(
  catalog: ApplicationExtensionCatalog,
  extensionId: string
): ApplicationExtensionTrustedEntry | undefined {
  return catalog.entries.find((entry) => entry.extensionId === extensionId);
}

