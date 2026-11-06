/**
 * Provider URL 受控转存的重试与错误分类（change: 2026-11-06-fix-media-output-readiness）。
 *
 * `guardedDownload` 只负责一次下载的 SSRF/体积/时限守卫；这里叠加**有界业务重试**：
 * 超时、网络错误与 5xx 可以重试（默认 2 次，300ms/900ms 退避），4xx、地址被拒、
 * 超限与类型不符立即失败。重试只发生在 Media Service 内，Task 侧不再叠一层无限重试。
 *
 * 失败分类只保留稳定 code 与 HTTP 状态，临时 URL、签名参数与上游响应体都不进入错误。
 */
import { GuardedDownloadError, guardedDownload, type GuardedDownloadOptions, type GuardedDownloadResult } from "../security/guarded-fetch.js";

export const DEFAULT_IMPORT_RETRY_DELAYS_MS = [300, 900] as const;

export type ProviderUrlDownloadOptions = Omit<GuardedDownloadOptions, "url" | "maxBytes" | "timeoutMs"> & {
  url: string;
  maxBytes: number;
  timeoutMs: number;
  /** 重试前等待；测试注入零等待。数组长度即重试次数。 */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
};

export type DownloadFailureCode = "unsupported" | "limit-exceeded" | "media-not-found" | "storage-failed";

export type DownloadFailure = {
  /** 对外稳定分类（映射到 MediaApplicationError.code）。 */
  code: DownloadFailureCode;
  /** 媒体服务应返回的 HTTP 状态（不含上游 URL/正文）。 */
  httpStatus: number;
  /** 上游 provider/CDN 的 HTTP 状态（可得时）。 */
  upstreamStatus?: number;
  /** 是否属于瞬时失败（超时/网络/5xx）。 */
  retryable: boolean;
};

/** 下载 provider URL，仅对瞬时失败做有界退避重试。 */
export async function downloadProviderUrl(options: ProviderUrlDownloadOptions): Promise<GuardedDownloadResult> {
  const delays = options.retryDelaysMs ?? DEFAULT_IMPORT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? delay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await guardedDownload({
        url: options.url,
        maxBytes: options.maxBytes,
        timeoutMs: options.timeoutMs,
        ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
        ...(options.allowedMediaTypes !== undefined ? { allowedMediaTypes: options.allowedMediaTypes } : {}),
        ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.resolveHost !== undefined ? { resolveHost: options.resolveHost } : {})
      });
    } catch (error) {
      const failure = classifyDownloadFailure(error);
      if (!failure.retryable || attempt >= delays.length) {
        throw error instanceof GuardedDownloadError
          ? error
          : new GuardedDownloadError("network", "受控下载失败：网络错误或超时");
      }
      await sleep(delays[attempt] ?? 0);
    }
  }
}

/** 把一次下载失败映射成稳定分类；未知异常按网络错误处理（可重试）。 */
export function classifyDownloadFailure(error: unknown): DownloadFailure {
  if (error instanceof GuardedDownloadError) {
    switch (error.code) {
      case "blocked-host":
      case "unsupported-protocol":
        return { code: "unsupported", httpStatus: 400, retryable: false };
      case "too-large":
        return { code: "limit-exceeded", httpStatus: 413, retryable: false };
      case "not-media":
        return { code: "unsupported", httpStatus: 415, retryable: false };
      case "timeout":
        return { code: "storage-failed", httpStatus: 504, retryable: true };
      case "redirect":
        return { code: "storage-failed", httpStatus: 502, retryable: false };
      case "network":
        return { code: "storage-failed", httpStatus: 502, retryable: true };
      case "http-error": {
        const status = error.status ?? 502;
        if (status === 404 || status === 410) {
          return { code: "media-not-found", httpStatus: 404, upstreamStatus: status, retryable: false };
        }
        if (status >= 400 && status < 500) {
          return { code: "unsupported", httpStatus: 422, upstreamStatus: status, retryable: false };
        }
        return { code: "storage-failed", httpStatus: 502, upstreamStatus: status, retryable: true };
      }
    }
  }
  // fetch 抛出的网络/DNS/超时异常没有 HTTP 状态：属于瞬时失败。
  return { code: "storage-failed", httpStatus: 502, retryable: true };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
