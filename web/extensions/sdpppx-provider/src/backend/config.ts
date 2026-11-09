/**
 * sdpppx 运行参数：部署身份来自 `deployment-config.ts`，其余可调项读环境变量。
 *
 * 这里不做任何网络请求。内置部署身份不允许为空；万一被改空，仍返回 `degradedCode`
 * 与缺失字段名，由插件 health 暴露，宿主继续启动。
 */
import {
  DEFAULT_SDPPPX_AUTHING_HOST,
  DEFAULT_SDPPPX_AUTHING_SCENE,
  DEFAULT_SDPPPX_BASE_URL,
  DEFAULT_SDPPPX_PROMPT_FIELD,
  DEFAULT_SDPPPX_TASK_TIMEOUT_MS,
  DEFAULT_SDPPPX_UPLOAD_PROVIDER,
  SDPPPX_ERROR_CODES,
  hostOf,
  textOf,
  type SdpppxConfigSummary,
  type SdpppxErrorCode,
} from "../shared.js";
import { SDPPPX_DEPLOYMENT, type SdpppxDeployment } from "./deployment-config.js";

/** 缺失诊断里使用的部署字段名（不是环境变量名）。 */
export const SDPPPX_DEPLOYMENT_TENANT_FIELD = "deployment.tenantId";
export const SDPPPX_DEPLOYMENT_SUPABASE_URL_FIELD = "deployment.supabaseUrl";
export const SDPPPX_DEPLOYMENT_SUPABASE_KEY_FIELD = "deployment.supabaseAnonKey";

/** 插件实际使用的完整配置。**含 anon key，绝不可投影到响应或日志。** */
export type SdpppxConfig = {
  baseUrl: string;
  tenantId: string | null;
  supabaseUrl: string | null;
  supabaseAnonKey: string | null;
  authingAppId: string | null;
  authingHost: string;
  /** `SDPPPX_AUTHING_HOST` 是否显式配置（显式时优先于租户表里的 `authing_url`）。 */
  authingHostExplicit: boolean;
  authingScene: string;
  bridgeUrl: string | null;
  templateModelTypes: Record<string, "image" | "video">;
  promptField: string;
  uploadProvider: string;
  taskTimeoutMs: number;
  /** 缺失的部署字段名（面向排障，不含值）。 */
  missing: string[];
  degradedCode: SdpppxErrorCode | null;
  /** 非致命解析告警（例如模板类型映射不是合法 JSON）。 */
  warnings: string[];
};

export type SdpppxEnv = Record<string, string | undefined>;

/** 空值按未设置处理：空字符串不是有效部署值。 */
function envText(env: SdpppxEnv, key: string): string | null {
  return textOf(env[key]) ?? null;
}

function normalizedUrl(value: string | null, fallback: string): string {
  return (value ?? fallback).replace(/\/+$/, "");
}

/**
 * 解析 `SDPPPX_TEMPLATE_MODEL_TYPES`。
 *
 * 只接受 `{ "<templateId>": "image" | "video" }`；其它值丢弃并记一条告警。解析失败整体
 * 回落到空映射（全部按图片），不让一条坏配置导致插件装载失败。
 */
function parseTemplateModelTypes(value: string | null): {
  map: Record<string, "image" | "video">;
  warning: string | null;
} {
  if (!value) return { map: {}, warning: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { map: {}, warning: "sdpppx-template-map-invalid" };
  }
  const record = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
  if (!record) return { map: {}, warning: "sdpppx-template-map-invalid" };
  const map: Record<string, "image" | "video"> = {};
  let invalid = false;
  for (const [key, item] of Object.entries(record)) {
    if (item === "image" || item === "video") map[key] = item;
    else invalid = true;
  }
  return { map, warning: invalid ? "sdpppx-template-map-invalid-entry" : null };
}

function parseTaskTimeout(value: string | null): number {
  if (!value) return DEFAULT_SDPPPX_TASK_TIMEOUT_MS;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_SDPPPX_TASK_TIMEOUT_MS;
}

export function readSdpppxConfig(
  env: SdpppxEnv = process.env,
  deployment: SdpppxDeployment = SDPPPX_DEPLOYMENT
): SdpppxConfig {
  const tenantId = textOf(deployment.tenantId) ?? null;
  const supabaseUrlRaw = textOf(deployment.supabaseUrl) ?? null;
  const supabaseAnonKey = textOf(deployment.supabaseAnonKey) ?? null;
  const supabaseUrl = supabaseUrlRaw ? normalizedUrl(supabaseUrlRaw, supabaseUrlRaw) : null;
  const bridgeUrlRaw = envText(env, "SDPPPX_BRIDGE_URL");
  const bridgeUrl = bridgeUrlRaw
    ? normalizedUrl(bridgeUrlRaw, bridgeUrlRaw)
    : supabaseUrl
      ? `${supabaseUrl}/functions/v1/authing-bridge3`
      : null;
  const templateTypes = parseTemplateModelTypes(envText(env, "SDPPPX_TEMPLATE_MODEL_TYPES"));
  const authingHost = envText(env, "SDPPPX_AUTHING_HOST");
  const missing: string[] = [];
  if (!tenantId) missing.push(SDPPPX_DEPLOYMENT_TENANT_FIELD);
  if (!supabaseUrl) missing.push(SDPPPX_DEPLOYMENT_SUPABASE_URL_FIELD);
  if (!supabaseAnonKey) missing.push(SDPPPX_DEPLOYMENT_SUPABASE_KEY_FIELD);
  return {
    baseUrl: normalizedUrl(envText(env, "SDPPPX_BASE_URL"), DEFAULT_SDPPPX_BASE_URL),
    tenantId,
    supabaseUrl,
    supabaseAnonKey,
    authingAppId: envText(env, "SDPPPX_AUTHING_APP_ID"),
    authingHost: normalizedUrl(authingHost, DEFAULT_SDPPPX_AUTHING_HOST),
    authingHostExplicit: authingHost !== null,
    authingScene: envText(env, "SDPPPX_AUTHING_SCENE") ?? DEFAULT_SDPPPX_AUTHING_SCENE,
    bridgeUrl,
    templateModelTypes: templateTypes.map,
    promptField: envText(env, "SDPPPX_PROMPT_FIELD") ?? DEFAULT_SDPPPX_PROMPT_FIELD,
    uploadProvider: envText(env, "SDPPPX_UPLOAD_PROVIDER") ?? DEFAULT_SDPPPX_UPLOAD_PROVIDER,
    taskTimeoutMs: parseTaskTimeout(envText(env, "SDPPPX_TASK_TIMEOUT_MS")),
    missing,
    degradedCode: missing.length > 0 ? SDPPPX_ERROR_CODES.configIncomplete : null,
    warnings: templateTypes.warning ? [templateTypes.warning] : []
  };
}

/** 必需项是否齐全（不含 appId：appId 可以查询）。 */
export function isSdpppxConfigured(config: SdpppxConfig): boolean {
  return config.degradedCode === null;
}

/** 安全投影：不含 anon key、不猜 appId 值。 */
export function summarizeSdpppxConfig(config: SdpppxConfig): SdpppxConfigSummary {
  return {
    baseUrl: config.baseUrl,
    tenantId: config.tenantId,
    supabaseHost: hostOf(config.supabaseUrl),
    authingAppIdConfigured: config.authingAppId !== null,
    authingHost: config.authingHost,
    authingScene: config.authingScene,
    bridgeHost: hostOf(config.bridgeUrl),
    templateModelTypes: { ...config.templateModelTypes },
    promptField: config.promptField,
    uploadProvider: config.uploadProvider,
    taskTimeoutMs: config.taskTimeoutMs
  };
}
