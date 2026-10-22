/**
 * 应用插件受控 HTTP handler 契约（纯类型）
 * （change: 2026-10-08-unlock-plugin-contracts-and-extensionize-chatgpt，任务 1.1/1.2 / design D4）。
 *
 * 在纯 DTO handler 之外声明受控 HTTP handler 的**注册形状与预算**。本模块不依赖 Node
 * driver：真正持有 `IncomingMessage`/`ServerResponse` 的处理函数类型只出现在后端入口契约。
 *
 * 关键点：
 * - 注册 identity 含 extensionId（由宿主封闭）、method、相对 route；
 * - 可信清单可声明固定公开映射（如 `/api/oauth-agent/*`）到同一 registration，但不得第二套 handler；
 * - 新工作与在途控制使用不同用途（`purpose`），draining 时在途控制仍可访问。
 */
import { isBoundedId, isJsonObject, isNonEmptyString } from "../validation.js";

export const APPLICATION_EXTENSION_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type ApplicationExtensionHttpMethod = (typeof APPLICATION_EXTENSION_HTTP_METHODS)[number];

export function isApplicationExtensionHttpMethod(value: unknown): value is ApplicationExtensionHttpMethod {
  return typeof value === "string" && (APPLICATION_EXTENSION_HTTP_METHODS as readonly string[]).includes(value);
}

/**
 * handler 用途：区分新工作入口与在途工作控制，使 draining 只拒绝新工作。
 *
 * - `read`：只读状态/快照；
 * - `auth-transaction`：授权事务（start/complete/cancel/disconnect）；
 * - `new-work`：受理新的生成/提交工作；
 * - `work-control`：查询、取消、回执等对已受理工作的控制（draining 仍可用）。
 */
export const APPLICATION_EXTENSION_HANDLER_PURPOSES = ["read", "auth-transaction", "new-work", "work-control"] as const;
export type ApplicationExtensionHandlerPurpose = (typeof APPLICATION_EXTENSION_HANDLER_PURPOSES)[number];

/** 流式响应预算（仅对声明 stream 的 handler 生效）。 */
export type ApplicationExtensionStreamBudget = {
  /** 心跳间隔（毫秒）。 */
  heartbeatMs: number;
  /** 执行 deadline（毫秒）；正数到达后产生实际取消信号，0 表示不限时。 */
  deadlineMs: number;
  /** 单连接最大事件数。 */
  maxEvents: number;
  /** 单连接最大累计字节。 */
  maxBytes: number;
};

export const DEFAULT_PLUGIN_STREAM_BUDGET: ApplicationExtensionStreamBudget = {
  heartbeatMs: 15_000,
  deadlineMs: 900_000,
  maxEvents: 2_000,
  maxBytes: 8 * 1024 * 1024
};

/** 一次 HTTP handler 注册（纯描述；可执行 handler 由后端入口契约提供）。 */
export type ApplicationExtensionHttpRegistration = {
  route: string;
  method: ApplicationExtensionHttpMethod;
  auth: import("./manifest.js").ApplicationExtensionAuthLevel;
  purpose: ApplicationExtensionHandlerPurpose;
  /** 声明为流式 handler（SSE 等）时启用流预算。 */
  stream?: boolean;
};

/** 可信清单中声明的固定公开路径映射（如 `/api/oauth-agent/*` → 某 registration）。 */
export type ApplicationExtensionPublicRouteMapping = {
  /** 拥有该映射的插件（宿主据此定位 registration owner）。 */
  extensionId: string;
  /** 公开路径前缀，必须以 `/` 开头且不含模板变量。 */
  publicPath: string;
  /** 目标 registration 的 route（相对宿主 base path）。 */
  route: string;
  methods: readonly ApplicationExtensionHttpMethod[];
};

const PURPOSE_SET = new Set<string>(APPLICATION_EXTENSION_HANDLER_PURPOSES);

/** 校验公开路径映射（纯数据；可信清单构建时调用）。 */
export function validatePublicRouteMapping(value: unknown): { ok: true; value: ApplicationExtensionPublicRouteMapping } | { ok: false; code: string; message: string } {
  if (!isJsonObject(value)) return { ok: false, code: "malformed-request", message: "公开映射必须是对象" };
  if (!isBoundedId(value.extensionId)) return { ok: false, code: "malformed-request", message: "extensionId 非法" };
  if (!isNonEmptyString(value.publicPath) || !value.publicPath.startsWith("/")) {
    return { ok: false, code: "malformed-request", message: "publicPath 必须以 / 开头" };
  }
  if (!isBoundedId(value.route)) return { ok: false, code: "malformed-request", message: "route 非法" };
  if (!Array.isArray(value.methods) || value.methods.length === 0 || !value.methods.every(isApplicationExtensionHttpMethod)) {
    return { ok: false, code: "malformed-request", message: "methods 非法" };
  }
  return {
    ok: true,
    value: {
      extensionId: value.extensionId,
      publicPath: value.publicPath.replace(/\/$/, ""),
      route: value.route,
      methods: [...(value.methods as ApplicationExtensionHttpMethod[])]
    }
  };
}

/** 判定一个字符串是否为受支持的 handler 用途。 */
export function isApplicationExtensionHandlerPurpose(value: unknown): value is ApplicationExtensionHandlerPurpose {
  return typeof value === "string" && PURPOSE_SET.has(value);
}

/**
 * 结构化的原始 HTTP 请求（**不 import `node:http`**，保持 contracts 浏览器安全）。
 *
 * 真实的 Node `IncomingMessage` 在结构上满足本形状；后端入口契约据此声明"原始 req/res 扩展点"
 * （design D4 允许"原始 req/res 访问或等价 facade"），插件可在 backend 入口按需 cast 回 Node 类型。
 */
export type ApplicationExtensionRawRequest = {
  readonly method?: string;
  readonly url?: string;
  readonly headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  destroy(error?: Error): unknown;
};

/** 结构化的原始 HTTP 响应（同上：Node `ServerResponse` 结构兼容）。 */
export type ApplicationExtensionRawResponse = {
  statusCode: number;
  setHeader(name: string, value: string | readonly string[]): unknown;
  writeHead(statusCode: number, headers?: Record<string, string | readonly string[]>): unknown;
  write(chunk: unknown): unknown;
  end(chunk?: unknown): unknown;
  flushHeaders?(): void;
  readonly writableEnded: boolean;
  readonly headersSent?: boolean;
  on(event: string, listener: (...args: never[]) => void): unknown;
};

/**
 * 抽象 HTTP 请求/响应 facade（**不依赖 Node**）。
 *
 * 后端入口契约提供把 `IncomingMessage`/`ServerResponse` 适配到本形状的实现；纯契约层不 import
 * `node:http`。这允许插件在自己的 backend 入口持有 Node 类型，而公共 DTO 保持浏览器安全。
 */
export type ApplicationExtensionHttpRequest = {
  method: ApplicationExtensionHttpMethod;
  /** 相对路径 + query（同源）。 */
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** 读取请求体（有上限；超出抛错）。 */
  readBody: (maxBytes: number) => Promise<Uint8Array>;
  /** 请求取消信号（连接断开/超时）；执行层必须据此中止未完成工作。 */
  signal: AbortSignal;
  /** 可信身份（由宿主在进入插件前建立）。 */
  principal?: import("./principal.js").PrincipalContext;
  accessControl?: boolean;
  dataScope?: import("./data-scope.js").DataScope;
  /** 会话绑定（存在时）。 */
  sessionId?: string;
  /** 审计 actor（不参与授权）。 */
  auditActor?: string;
};

export type ApplicationExtensionHttpResponse = {
  setHeader: (name: string, value: string | readonly string[]) => void;
  writeHead: (status: number) => void;
  /** 写入并立即 flush（流式）。 */
  write: (chunk: string | Uint8Array) => void;
  /** 结束并 flush。 */
  end: (chunk?: string | Uint8Array) => void;
  /** 是否已结束/连接已关闭。 */
  readonly writableEnded: boolean;
  /** 连接关闭回调（断开清理）。 */
  onClose: (listener: () => void) => void;
};

/**
 * 一个受控 HTTP handler：插件在 backend 入口实现，宿主在 method/route/认证/预算校验后调用。
 *
 * 返回 `true` 表示已处理并结束响应；`false` 表示未匹配（不应发生，宿主已按 registration 分派）。
 */
export type ApplicationExtensionHttpHandler = (
  req: ApplicationExtensionHttpRequest,
  res: ApplicationExtensionHttpResponse
) => Promise<void>;

