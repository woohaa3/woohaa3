/**
 * 极小的 HTTP 辅助：超时、JSON 解析与稳定的错误分类。
 *
 * 不记录请求/响应正文：上游正文可能带令牌或租户数据。对外只暴露状态码与稳定字段，
 * 由调用方映射成 `sdpppx-*` 稳定码。
 */

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type SdpppxHttpOptions = {
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
};

export class SdpppxHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "SdpppxHttpError";
    this.status = status;
    this.code = code;
  }
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** 发起请求并读完有界文本；网络失败、超时与非法响应都转成 `SdpppxHttpError`。 */
export async function fetchText(
  url: string,
  init: RequestInit,
  options: SdpppxHttpOptions = {}
): Promise<{ status: number; ok: boolean; text: string; contentType: string }> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new SdpppxHttpError("fetch 不可用", 0, "sdpppx-service-unavailable");
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (text.length > maxBytes) {
      throw new SdpppxHttpError("响应超过大小上限", response.status, "sdpppx-service-unavailable");
    }
    return {
      status: response.status,
      ok: response.ok,
      text,
      contentType: response.headers.get("content-type") ?? ""
    };
  } catch (error) {
    if (error instanceof SdpppxHttpError) throw error;
    throw new SdpppxHttpError(
      timedOut ? "请求超时" : isAbort(error) ? "请求已取消" : "网络请求失败",
      0,
      "sdpppx-service-unavailable"
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** 发起请求并解析 JSON；空响应返回 undefined。 */
export async function fetchJson(
  url: string,
  init: RequestInit,
  options: SdpppxHttpOptions = {}
): Promise<unknown> {
  const response = await fetchText(url, init, options);
  if (!response.ok) {
    throw new SdpppxHttpError(`HTTP ${response.status}`, response.status, statusCodeOf(response.status));
  }
  if (response.text.trim() === "") return undefined;
  try {
    return JSON.parse(response.text) as unknown;
  } catch {
    throw new SdpppxHttpError("响应不是合法 JSON", response.status, "sdpppx-service-unavailable");
  }
}

/** HTTP 状态 → 稳定分类；401 单独成类，供调用方清会话。 */
export function statusCodeOf(status: number): string {
  if (status === 401 || status === 403) return "sdpppx-session-expired";
  return "sdpppx-service-unavailable";
}

export function isUnauthorized(error: unknown): boolean {
  return error instanceof SdpppxHttpError && (error.status === 401 || error.status === 403);
}
