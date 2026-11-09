/**
 * Authing 微信扫码三接口（纯 fetch，不引入 authing-js-sdk）。
 *
 * 线格式来自 authing-js-sdk `QrCodeAuthenticationClient`：
 * - `POST {host}/api/v2/qrcode/gene`，body `{ autoMergeQrCode: false, scene }`；
 * - `GET  {host}/api/v2/qrcode/check?random=`；
 * - `POST {host}/api/v2/qrcode/userinfo`，body `{ ticket }`；
 * 三个请求都带 `x-authing-app-id`。
 *
 * 返回值只保留调用方需要的字段；二维码地址不会原样交给浏览器，宿主会先取回图片再转 data URL。
 */
import {
  SdpppxHttpError,
  fetchJson,
  type SdpppxHttpOptions
} from "./http.js";

export type AuthingQrTarget = {
  host: string;
  appId: string;
  scene: string;
};

export type AuthingQrCode = {
  random: string;
  /** Authing CDN 上的二维码图片地址；只在宿主内使用。 */
  url: string;
};

export type AuthingQrCheck = {
  /** 0 未使用 / 1 已扫码 / 2 已授权 / 3 取消 / -1 过期。 */
  status: number;
  ticket?: string;
  nickname?: string;
  avatarUrl?: string;
};

export type AuthingUser = {
  token: string;
  nickname?: string;
  avatarUrl?: string;
};

function endpoint(target: AuthingQrTarget, path: string): string {
  return `${target.host.replace(/\/+$/, "")}${path}`;
}

function headers(target: AuthingQrTarget, withJson: boolean): Record<string, string> {
  return {
    // 与 authing-js-sdk 4.23.55 的 HttpClient 默认头对齐；Authing 只强校验 appId。
    "x-authing-app-id": target.appId,
    "x-authing-request-from": "sdk",
    "x-authing-sdk-version": "js:4.23.55",
    "x-authing-lang": "zh-CN",
    ...(withJson ? { "Content-Type": "application/json" } : {})
  };
}

/**
 * Authing v2 一般返回 `{ code, message, data }`。只在 `data` 是对象时解包；裸对象原样返回，
 * 以便兼容网关或测试替身。
 */
function unwrapAuthing(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  const code = record.code;
  if (typeof code === "number" || typeof code === "string") {
    const numeric = Number(code);
    if (Number.isFinite(numeric) && numeric !== 0 && numeric !== 200) {
      // 上游正文与 message 不进稳定响应；排障靠 code/事件日志。
      throw new SdpppxHttpError("Authing 返回错误码", 200, "sdpppx-wechat-unavailable");
    }
    return record.data ?? payload;
  }
  return payload;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function mediaUrlOf(value: unknown): string | undefined {
  const text = textOf(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function userFields(source: unknown): { nickname?: string; avatarUrl?: string } {
  const record = recordOf(source);
  if (!record) return {};
  const nickname =
    textOf(record.nickname) ??
    textOf(record.name) ??
    textOf(record.displayName) ??
    textOf(record.display_name);
  const avatarUrl =
    mediaUrlOf(record.photo) ??
    mediaUrlOf(record.avatar) ??
    mediaUrlOf(record.avatarUrl) ??
    mediaUrlOf(record.avatar_url);
  return {
    ...(nickname ? { nickname } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  };
}

/** 生成二维码（不下载图片）。 */
export async function geneAuthingQr(
  target: AuthingQrTarget,
  options: SdpppxHttpOptions = {}
): Promise<AuthingQrCode> {
  const payload = await fetchJson(
    endpoint(target, "/api/v2/qrcode/gene"),
    {
      method: "POST",
      headers: headers(target, true),
      body: JSON.stringify({ autoMergeQrCode: false, scene: target.scene })
    },
    options
  );
  const data = recordOf(unwrapAuthing(payload));
  const random = textOf(data?.random);
  const url = mediaUrlOf(data?.url);
  if (!random || !url) {
    throw new SdpppxHttpError("Authing 未返回二维码", 502, "sdpppx-service-unavailable");
  }
  return { random, url };
}

/** 查询扫码状态；网络失败由调用方保留 pending 到 TTL。 */
export async function checkAuthingQr(
  target: AuthingQrTarget,
  random: string,
  options: SdpppxHttpOptions = {}
): Promise<AuthingQrCheck> {
  const payload = await fetchJson(
    endpoint(target, `/api/v2/qrcode/check?random=${encodeURIComponent(random)}`),
    { method: "GET", headers: headers(target, false) },
    options
  );
  const data = recordOf(unwrapAuthing(payload));
  if (!data) throw new SdpppxHttpError("Authing 状态响应无效", 502, "sdpppx-service-unavailable");
  const raw = data.status;
  const status = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(status)) {
    throw new SdpppxHttpError("Authing 状态响应缺少 status", 502, "sdpppx-service-unavailable");
  }
  const ticket = textOf(data.ticket);
  const userInfo = recordOf(data.userInfo) ?? recordOf(data.user);
  return {
    status,
    ...(ticket ? { ticket } : {}),
    ...userFields(userInfo)
  };
}

/** 用 ticket 换完整用户信息（含登录令牌）。 */
export async function exchangeAuthingUser(
  target: AuthingQrTarget,
  ticket: string,
  options: SdpppxHttpOptions = {}
): Promise<AuthingUser> {
  const payload = await fetchJson(
    endpoint(target, "/api/v2/qrcode/userinfo"),
    {
      method: "POST",
      headers: headers(target, true),
      body: JSON.stringify({ ticket })
    },
    options
  );
  const data = recordOf(unwrapAuthing(payload));
  const token = textOf(data?.token);
  if (!token) {
    throw new SdpppxHttpError("Authing 未返回登录令牌", 502, "sdpppx-login-failed");
  }
  return { token, ...userFields(data) };
}

/**
 * 把二维码图片取回并转成 data URL。
 *
 * `url` 只在这里出现；浏览器永远拿不到 Authing CDN 地址。限制为 2 MiB 与图片类型，
 * 避免把 HTML/重定向页当作二维码交给渲染进程。
 */
export async function fetchQrImageDataUrl(
  url: string,
  options: SdpppxHttpOptions = {}
): Promise<string> {
  const parsed = mediaUrlOf(url);
  if (!parsed) {
    throw new SdpppxHttpError("二维码地址非法", 502, "sdpppx-service-unavailable");
  }
  return fetchImageAsDataUrl(parsed, options);
}

async function fetchImageAsDataUrl(url: string, options: SdpppxHttpOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      throw new SdpppxHttpError(`二维码图片 HTTP ${response.status}`, 502, "sdpppx-service-unavailable");
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
    if (!type.startsWith("image/")) {
      throw new SdpppxHttpError("二维码响应不是图片", 502, "sdpppx-service-unavailable");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) {
      throw new SdpppxHttpError("二维码图片大小非法", 502, "sdpppx-service-unavailable");
    }
    return `data:${type};base64,${base64Of(bytes)}`;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** 不依赖 Buffer：宿主与测试环境都可能没有 Node 全局。 */
function base64Of(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
