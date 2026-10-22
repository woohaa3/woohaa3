/**
 * 统一后端 composition：部署配置读取
 * （自 `composition.ts` 拆出，change: 2026-10-13-add-enterprise-access-and-production-deployment，
 *  规模门禁 ≤500 行）。
 *
 * 纯读取/解析：存储路径、模型配置、隔离秘密仓库目录与主密钥。不持有运行时状态。
 */
import fs from "node:fs";
import path from "node:path";
import { parseModelsConfig, type ModelsConfig } from "@woohaa3/task-service";
import { createApplicationSecretStoreForExtension } from "@woohaa3/application-service";
import type { ApplicationExtensionSecretStore } from "@woohaa3/contracts";

/**
 * 允许的浏览器 Origin（逗号分隔；change: 2026-10-13-...，任务 2.4）。
 *
 * 生产者：Canvas Session WebSocket 的 `allowedOrigins` 校验与浏览器写请求的 Origin/CSRF 判定。
 * 缺省为空——WS 仅本机部署不校验跨源（与历史一致），写请求仍按同源 Host 兜底判定。
 */
export const ALLOWED_ORIGINS_ENV = "WOOHAA3_ALLOWED_ORIGINS";

/** 解析允许的浏览器 Origin；非法/非 http(s)/含路径的条目丢弃（不阻塞启动）。 */
export function parseAllowedOrigins(env: Record<string, string | undefined>): string[] {
  const raw = (env[ALLOWED_ORIGINS_ENV] ?? "").trim();
  if (raw === "") return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw.split(",")) {
    const value = entry.trim();
    if (value === "") continue;
    let origin: string;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (url.pathname !== "/" || url.search !== "" || url.hash !== "") continue;
      origin = url.origin;
    } catch {
      continue;
    }
    if (seen.has(origin)) continue;
    seen.add(origin);
    out.push(origin);
  }
  return out;
}

export function readStorePath(env: Record<string, string | undefined>): string {
  const configured = env.WOOHAA3_TASK_STORE_PATH ?? env.WOOHAA3_APPLICATION_STORE_PATH ?? "";
  return configured === "" ? "." : configured;
}

/**
 * 解析隔离秘密仓库：部署配置提供目录与主密钥。
 *
 * 配置来源（change: 2026-10-16-add-agent-appserver-and-sdk-connections，任务 1.2 / design D4）：
 * - 目录：`WOOHAA3_PLUGIN_SECRET_DIR`（首选）；缺失时兼容 `WOOHAA3_CHATGPT_CREDENTIAL_DIR`。
 * - 主密钥：`WOOHAA3_PLUGIN_SECRET_MASTER_KEY`（独立于 ChatGPT，首选）；缺失时兼容
 *   `WOOHAA3_CHATGPT_MASTER_KEY`。这样即使没有 ChatGPT 部署也能单独启用 SDK 凭据。
 *
 * 两侧都配置且**不一致**时返回 `conflict`：拒绝凭据操作并要求显式迁移，绝不静默换密钥或
 * 覆盖既有密文。缺省（目录或密钥任一缺失）返回 `unconfigured`（插件按能力拒绝，不回退明文）。
 */
export const PLUGIN_SECRET_DIR_ENV = "WOOHAA3_PLUGIN_SECRET_DIR";
export const PLUGIN_SECRET_MASTER_KEY_ENV = "WOOHAA3_PLUGIN_SECRET_MASTER_KEY";
export const CHATGPT_MASTER_KEY_ENV = "WOOHAA3_CHATGPT_MASTER_KEY";
export const CHATGPT_CREDENTIAL_DIR_ENV = "WOOHAA3_CHATGPT_CREDENTIAL_DIR";

export type ResolvedSecretStore = {
  /** 解析出的目录（便于运维核对；不含密钥）。 */
  directory: string;
  /** 主密钥来源（诊断用；不打印值）。 */
  masterKeySource: "plugin" | "chatgpt-compat";
  forExtension: (extensionId: string) => ApplicationExtensionSecretStore;
};

export type HostSecretStoreResolution =
  | { ok: true; store: ResolvedSecretStore }
  | { ok: false; code: "unconfigured" | "conflict"; message: string };

function parseMasterKey(raw: string | undefined): Buffer | null {
  if (raw === undefined || raw.trim() === "") return null;
  let key: Buffer;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    return null;
  }
  return key.byteLength === 32 ? key : null;
}

/**
 * 解析宿主通用秘密仓库。见上方注释的状态语义；调用方据 `ok` 决定是否向插件暴露 secrets。
 */
export function resolveHostSecretStore(env: Record<string, string | undefined>): HostSecretStoreResolution {
  const dir = env[PLUGIN_SECRET_DIR_ENV]
    ?? (env[CHATGPT_CREDENTIAL_DIR_ENV] ? `${env[CHATGPT_CREDENTIAL_DIR_ENV]}/plugin-secrets` : "");
  if (dir === "") return { ok: false, code: "unconfigured", message: "未配置秘密仓库目录" };

  const pluginKey = parseMasterKey(env[PLUGIN_SECRET_MASTER_KEY_ENV]);
  const chatgptKey = parseMasterKey(env[CHATGPT_MASTER_KEY_ENV]);
  if (pluginKey && chatgptKey && !pluginKey.equals(chatgptKey)) {
    return {
      ok: false,
      code: "conflict",
      message: "同时配置了不一致的插件主密钥与 ChatGPT 主密钥；拒绝凭据操作，请显式迁移或只保留一个来源"
    };
  }
  const chosen = pluginKey ?? chatgptKey;
  if (!chosen) return { ok: false, code: "unconfigured", message: "未配置有效的主密钥（需 32 字节 base64）" };

  const masterKeySource = pluginKey ? "plugin" : "chatgpt-compat";
  return {
    ok: true,
    store: {
      directory: dir,
      masterKeySource,
      forExtension: (extensionId: string) => createApplicationSecretStoreForExtension({ directory: dir, masterKey: chosen, extensionId })
    }
  };
}

/**
 * 兼容旧调用点：返回 store 或在不可用时返回 null（冲突/未配置都拒绝凭据操作）。
 *
 * 新代码应直接用 `resolveHostSecretStore` 以区分 `unconfigured` 与 `conflict` 诊断。
 */
export function resolveChatGptSecretStore(env: Record<string, string | undefined>): {
  forExtension: (extensionId: string) => ApplicationExtensionSecretStore;
} | null {
  const resolved = resolveHostSecretStore(env);
  return resolved.ok ? resolved.store : null;
}

export function readModelsConfig(env: Record<string, string | undefined>, explicit?: ModelsConfig): ModelsConfig {
  if (explicit) return explicit;
  const candidate = env.WOOHAA3_MODELS_CONFIG_PATH
    ? path.resolve(env.WOOHAA3_MODELS_CONFIG_PATH)
    : path.resolve(process.cwd(), "web/services/task-service/pptask.models.json");
  if (!fs.existsSync(candidate)) return { version: 1, models: [] };
  const parsed = parseModelsConfig(JSON.parse(fs.readFileSync(candidate, "utf8")), candidate);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.config;
}
