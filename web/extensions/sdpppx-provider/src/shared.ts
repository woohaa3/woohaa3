/**
 * sdpppx 接入的共享身份与线格式。
 *
 * 前后端共用，只放常量、纯类型与解析辅助；不含执行实现、网络调用或任何秘密。
 * 浏览器只看到这里的会话视图（状态 / 昵称 / 头像 / 余额 / 到期时间），令牌永远不进入
 * 这些 DTO。
 */
import type { ApplicationExtensionMetadata } from "@woohaa3/contracts";

export const SDPPPX_PLUGIN_ID = "sdpppx-provider";

export const SDPPPX_PROVIDER_ID = "sdpppx";

export const SDPPPX_CONFIG_PREFIX = `extensions.${SDPPPX_PLUGIN_ID}`;

export const DEFAULT_SDPPPX_BASE_URL = "https://sdpppx.zombee.tech/ppserver";

export const DEFAULT_SDPPPX_AUTHING_HOST = "https://core.authing.cn";

export const DEFAULT_SDPPPX_AUTHING_SCENE = "WXAPP_AUTH";

export const DEFAULT_SDPPPX_PROMPT_FIELD = "prompt";

export const DEFAULT_SDPPPX_UPLOAD_PROVIDER = "grsai";

export const DEFAULT_SDPPPX_TASK_TIMEOUT_MS = 10 * 60 * 1000;

/** 前端 surface 身份：登录与账号管理弹窗。 */
export const SDPPPX_LOGIN_DIALOG_ID = "sdpppx-login";
export const SDPPPX_ACCOUNT_DIALOG_ID = "sdpppx-account";

/** 同源 handler 相对路由（宿主会拼成 `/api/extensions/<id>/handlers/...`）。 */
export const SDPPPX_SESSION_ROUTE = "session";
export const SDPPPX_LOGIN_START_ROUTE = "login/wechat/start";
export const SDPPPX_LOGIN_STATUS_ROUTE = "login/wechat/status";
export const SDPPPX_LOGIN_CANCEL_ROUTE = "login/wechat/cancel";
export const SDPPPX_LOGOUT_ROUTE = "logout";
export const SDPPPX_MODELS_REFRESH_ROUTE = "models/refresh";

export const SDPPPX_ERROR_CODES = {
  configIncomplete: "sdpppx-config-incomplete",
  authingAppMissing: "sdpppx-authing-app-missing",
  wechatUnavailable: "sdpppx-wechat-unavailable",
  serviceUnavailable: "sdpppx-service-unavailable",
  loginFailed: "sdpppx-login-failed",
  sessionExpired: "sdpppx-session-expired",
  catalogUnavailable: "sdpppx-catalog-unavailable",
  templateDescribeFailed: "sdpppx-template-describe-failed",
  taskFailed: "sdpppx-task-failed",
  taskCancelled: "sdpppx-task-cancelled",
  taskTimeout: "sdpppx-task-timeout",
  uploadFailed: "sdpppx-upload-failed",
  /** 临时图床专用（change: 2026-11-09-add-sdpppx-media-temporary-hosting）。 */
  mediaUnsupported: "sdpppx-media-unsupported",
  mediaInvalidResponse: "sdpppx-media-invalid-response",
  mediaForbidden: "sdpppx-media-forbidden",
  mediaRateLimited: "sdpppx-media-rate-limited",
  mediaUploadFailed: "sdpppx-media-upload-failed",
  mediaUploadUnavailable: "sdpppx-media-unavailable",
  mediaNotReadable: "sdpppx-media-not-readable",
  mediaCancelled: "sdpppx-media-cancelled",
  mediaStale: "sdpppx-media-stale"
} as const;

export type SdpppxErrorCode = (typeof SDPPPX_ERROR_CODES)[keyof typeof SDPPPX_ERROR_CODES];

/** 余额是只读快照；不可用时前端显示占位，绝不阻塞退出登录。 */
export type SdpppxBalance = {
  totalBalance: number;
  paid?: number;
  monthlyBonus?: number;
  dailyBonus?: number;
};

/** 模板输出类型：模板本身没有类型字段，由部署配置覆盖，未列出时按图片处理。 */
export type SdpppxModelType = "image" | "video";

/** 浏览器可见的会话投影。**没有令牌字段，也不允许新增令牌字段。** */
export type SdpppxSessionView = {
  displayName: string | null;
  avatarUrl: string | null;
  expiresAt: number;
  balance: SdpppxBalance | null;
};

/**
 * 部署参数的安全投影：只含排障需要的非秘密值。
 *
 * Supabase anon key 与 Authing token 不在其中；地址只投影 host，避免把部署路径里的临时
 * 参数带进界面。
 */
export type SdpppxConfigSummary = {
  baseUrl: string;
  tenantId: string | null;
  supabaseHost: string | null;
  authingAppIdConfigured: boolean;
  authingHost: string;
  authingScene: string;
  bridgeHost: string | null;
  templateModelTypes: Record<string, "image" | "video">;
  promptField: string;
  uploadProvider: string;
  taskTimeoutMs: number;
};

export type SdpppxSessionStatus = "authenticated" | "anonymous" | "unconfigured";

export type SdpppxSessionSnapshot = {
  status: SdpppxSessionStatus;
  /** 配置或 appId 缺失时的稳定码；正常为 null。 */
  degradedCode: SdpppxErrorCode | null;
  missing: string[];
  config: SdpppxConfigSummary;
  session: SdpppxSessionView | null;
  /** 会话被明确拒绝后的稳定提示，例如 `sdpppx-session-expired`。 */
  notice: SdpppxErrorCode | null;
};

export type SdpppxLoginPhase =
  | "pending"
  | "scanned"
  | "authorized"
  | "cancelled"
  | "expired"
  | "error";

export type SdpppxLoginStart = {
  loginId: string;
  qrDataUrl: string;
  phase: "pending";
  expiresAt: number;
};

export type SdpppxLoginStatus = {
  phase: SdpppxLoginPhase;
  nickname?: string | null;
  avatarUrl?: string | null;
  session?: SdpppxSessionView;
  error?: string;
};

export type SdpppxFailure = {
  ok: false;
  code: SdpppxErrorCode;
  message: string;
  missing?: string[];
};

export type SdpppxSuccess<T> = { ok: true } & T;

export type SdpppxResult<T> = SdpppxSuccess<T> | SdpppxFailure;

export type SdpppxModelRefreshResult = {
  available: boolean;
  modelCount: number;
  catalogRevision: number;
  error: string | null;
};

/** 会话快照的初值：未问过宿主时显示未登录，不伪造已连接。 */
export const EMPTY_SDPPPX_CONFIG_SUMMARY: SdpppxConfigSummary = {
  baseUrl: DEFAULT_SDPPPX_BASE_URL,
  tenantId: null,
  supabaseHost: null,
  authingAppIdConfigured: false,
  authingHost: DEFAULT_SDPPPX_AUTHING_HOST,
  authingScene: DEFAULT_SDPPPX_AUTHING_SCENE,
  bridgeHost: null,
  templateModelTypes: {},
  promptField: DEFAULT_SDPPPX_PROMPT_FIELD,
  uploadProvider: DEFAULT_SDPPPX_UPLOAD_PROVIDER,
  taskTimeoutMs: DEFAULT_SDPPPX_TASK_TIMEOUT_MS
};

export const EMPTY_SDPPPX_SNAPSHOT: SdpppxSessionSnapshot = {
  status: "anonymous",
  degradedCode: null,
  missing: [],
  config: EMPTY_SDPPPX_CONFIG_SUMMARY,
  session: null,
  notice: null
};

export const SDPPPX_PLUGIN_METADATA: ApplicationExtensionMetadata = {
  extensionId: SDPPPX_PLUGIN_ID,
  name: "SDPPPX",
  description: "sdpppx 微信扫码登录与租户模板生成。登录后把当前租户的模板投影为生成模型。",
  version: "0.1.1",
  managementScope: "site",
  host: "backend",
  configSchema: { schemaId: "sdpppx-provider-config", schemaVersion: 1 },
  dependencies: [],
  capabilities: [
    { id: "sdpppx.session", kind: "handler", description: "登录状态、余额与部署参数读模型", auth: "authenticated" },
    { id: "sdpppx.login-start", kind: "handler", description: "发起微信扫码登录", auth: "authenticated" },
    { id: "sdpppx.login-status", kind: "handler", description: "轮询扫码登录状态", auth: "authenticated" },
    { id: "sdpppx.login-cancel", kind: "handler", description: "取消进行中的扫码登录", auth: "authenticated" },
    { id: "sdpppx.logout", kind: "handler", description: "清除本地会话与模型目录", auth: "authenticated" },
    { id: "sdpppx.models-refresh", kind: "handler", description: "刷新租户模板模型目录", auth: "authenticated" }
  ],
  defaultEnabled: true
};

/** 从任意 JSON 里读一个普通对象（数组与 null 不算）。 */
export function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 读一个非空字符串并去掉首尾空白。 */
export function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** 只保留 http(s) URL；其它协议一律丢弃。 */
export function httpUrlOf(value: unknown): string | undefined {
  const text = textOf(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** 只投影 host，避免把路径与查询参数带进界面。 */
export function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
