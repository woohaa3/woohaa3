/**
 * SDPPPX 独立媒体上传（`POST /media/upload`，change: 2026-11-09-add-sdpppx-media-temporary-hosting）。
 *
 * 与模板任务的 `reference.ts`（`/tasks/upload`、`X-Tenant-ID`、32 MiB、顶层 `url`）严格分开：
 * - 路径固定为 `${baseUrl}/media/upload`，不重复追加部署前缀；
 * - 原始二进制 + 真实 MIME，只带 Bearer，不带 provider / filename / 租户头；
 * - 业务上限 20 MiB，MIME 只接受 image/video；
 * - 成功响应只认 `{ code: 0, data: { url, media_type, size } }`；顶层 url、内部 key、字段缺失、
 *   类型/大小不符一律失败。
 *
 * 错误分类只暴露状态码与稳定码，不记录响应正文或令牌。401 由调用方按既有会话失效路径处理；
 * 403 是权限拒绝，**不**在这里清会话（匿名下载 403 更不能影响登录态）。
 */
import { assertPublicHttpsUrl } from "@woohaa3/provider-sdk";
import { SDPPPX_ERROR_CODES, recordOf, textOf, type SdpppxErrorCode } from "../shared.js";

/** 上游 handler 的单文件业务上限（Express 的 25 MB 不是业务上限）。 */
export const SDPPPX_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** 与既有参考上传一致的超时；不复用旧接口的 32 MiB 上限。 */
export const SDPPPX_MEDIA_UPLOAD_TIMEOUT_MS = 60_000;
/** 匿名读取核验：只验可读性与类型，不整段下载视频。 */
export const SDPPPX_MEDIA_PROBE_TIMEOUT_MS = 15_000;
export const SDPPPX_MEDIA_PROBE_MAX_BYTES = 64 * 1024;
const SDPPPX_MEDIA_PROBE_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SdpppxMediaKind = "image" | "video";

export type SdpppxMediaUploadSuccess = {
  ok: true;
  url: string;
  mediaType: string;
  size: number;
};

export type SdpppxMediaUploadFailure = {
  ok: false;
  status: number;
  code: SdpppxErrorCode;
  message: string;
};

export type SdpppxMediaUploadResult = SdpppxMediaUploadSuccess | SdpppxMediaUploadFailure;

export type SdpppxMediaUploadInput = {
  baseUrl: string;
  accessToken: string;
  bytes: Uint8Array;
  contentType: string;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** 去掉参数、转小写；空值按未知处理。 */
export function baseMediaType(value: string | undefined): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** `image` / `video` / 其它（audio 与未知都返回 undefined，调用方据此拒绝）。 */
export function mediaKindOf(contentType: string): SdpppxMediaKind | undefined {
  const type = baseMediaType(contentType);
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  return undefined;
}

/**
 * 上传前的实际字节校验：空、超限、audio/未知都不发请求。
 *
 * 只看实际字节和 MIME；请求声明的 size/contentType 不参与判定。
 */
export function validateSdpppxMedia(bytes: Uint8Array, contentType: string): SdpppxMediaUploadFailure | null {
  if (bytes.byteLength === 0) {
    return failure(0, SDPPPX_ERROR_CODES.mediaUnsupported, "素材为空，未上传");
  }
  if (bytes.byteLength > SDPPPX_MEDIA_MAX_BYTES) {
    return failure(0, SDPPPX_ERROR_CODES.mediaUnsupported, "素材超过 20 MiB 上限，未上传");
  }
  if (!mediaKindOf(contentType)) {
    return failure(0, SDPPPX_ERROR_CODES.mediaUnsupported, "只支持图片或视频，未上传");
  }
  return null;
}

/**
 * 解析成功响应。只接受数值 `code === 0` 与形状完整的 `data`。
 *
 * `expected` 来自本次实际上传的文件；不一致就是失败，不从 key 拼地址。
 */
export function parseSdpppxMediaUploadResponse(
  payload: unknown,
  expected: { contentType: string; size: number }
): SdpppxMediaUploadResult {
  const record = recordOf(payload);
  if (!record) return failure(200, SDPPPX_ERROR_CODES.mediaInvalidResponse, "上传响应不是 JSON 对象");
  if (record.code !== 0) {
    return failure(
      200,
      SDPPPX_ERROR_CODES.mediaInvalidResponse,
      `上传失败（code ${String(record.code ?? "missing")}）`
    );
  }
  const data = recordOf(record.data);
  if (!data) return failure(200, SDPPPX_ERROR_CODES.mediaInvalidResponse, "上传响应缺少 data");
  const rawUrl = textOf(data.url);
  if (!rawUrl) return failure(200, SDPPPX_ERROR_CODES.mediaInvalidResponse, "上传响应缺少 data.url");
  let url: string;
  try {
    assertPublicHttpsUrl(rawUrl);
    url = rawUrl;
  } catch (error) {
    return failure(
      200,
      SDPPPX_ERROR_CODES.mediaInvalidResponse,
      error instanceof Error ? error.message : "上传地址不符合网络边界"
    );
  }
  const mediaType = baseMediaType(textOf(data.media_type));
  if (!mediaType) {
    return failure(200, SDPPPX_ERROR_CODES.mediaInvalidResponse, "上传响应缺少 data.media_type");
  }
  if (mediaType !== baseMediaType(expected.contentType)) {
    return failure(
      200,
      SDPPPX_ERROR_CODES.mediaInvalidResponse,
      `上传返回的类型是 ${mediaType}，与本次 ${baseMediaType(expected.contentType)} 不符`
    );
  }
  const size = data.size;
  if (typeof size !== "number" || !Number.isFinite(size) || size !== expected.size) {
    return failure(200, SDPPPX_ERROR_CODES.mediaInvalidResponse, "上传返回的大小与本次素材不符");
  }
  return { ok: true, url, mediaType, size };
}

/** 调 `POST /media/upload`：Bearer + 原始二进制 + 实际 Content-Type。 */
export async function uploadSdpppxMedia(input: SdpppxMediaUploadInput): Promise<SdpppxMediaUploadResult> {
  const invalid = validateSdpppxMedia(input.bytes, input.contentType);
  if (invalid) return invalid;
  if (!input.accessToken.trim()) {
    return failure(401, SDPPPX_ERROR_CODES.sessionExpired, "未登录，未上传");
  }
  if (input.signal?.aborted) {
    return failure(0, SDPPPX_ERROR_CODES.mediaCancelled, "上传已取消");
  }
  const endpoint = `${input.baseUrl.replace(/\/+$/, "")}/media/upload`;
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? SDPPPX_MEDIA_UPLOAD_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  const caller = input.signal;
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": baseMediaType(input.contentType),
        accept: "application/json"
      },
      body: input.bytes as unknown as BodyInit,
      signal: controller.signal,
      redirect: "error"
    });
    if (response.status === 401) {
      return failure(401, SDPPPX_ERROR_CODES.sessionExpired, "SDPPPX 会话已失效");
    }
    if (!response.ok) {
      return failure(response.status, statusCodeOf(response.status), `SDPPPX 上传失败（HTTP ${response.status}）`);
    }
    const text = await response.text();
    if (text.length > 64 * 1024) {
      return failure(response.status, SDPPPX_ERROR_CODES.mediaInvalidResponse, "上传响应过大");
    }
    let payload: unknown;
    try {
      payload = text.trim() === "" ? undefined : JSON.parse(text);
    } catch {
      return failure(response.status, SDPPPX_ERROR_CODES.mediaInvalidResponse, "上传返回非 JSON 响应");
    }
    return parseSdpppxMediaUploadResponse(payload, {
      contentType: input.contentType,
      size: input.bytes.byteLength
    });
  } catch (error) {
    if (caller?.aborted) {
      return failure(0, SDPPPX_ERROR_CODES.mediaCancelled, "上传已取消");
    }
    if (timedOut || (error instanceof Error && error.name === "AbortError")) {
      return failure(0, SDPPPX_ERROR_CODES.mediaUploadUnavailable, "上传超时");
    }
    return failure(
      0,
      SDPPPX_ERROR_CODES.mediaUploadUnavailable,
      `连接 SDPPPX 上传接口失败：${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onAbort);
  }
}

export type SdpppxMediaProbeInput = {
  url: string;
  mediaType: string;
  fetchImpl?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
};

export type SdpppxMediaProbeResult = { ok: true } | { ok: false; message: string };

/**
 * 匿名有界读取核验：不带 Authorization / Cookie，逐跳走同一套出网守卫。
 *
 * Range 只取前 64 KiB，读够即取消上游，避免为了验证把整段视频下载一遍。这里只证明
 * 「此刻可匿名读取」；上游没有 TTL，不能扩展成未来窗口的保证。
 */
export async function probeSdpppxMediaReadable(input: SdpppxMediaProbeInput): Promise<SdpppxMediaProbeResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const expectedKind = mediaKindOf(input.mediaType);
  if (!expectedKind) return { ok: false, message: "匿名读取核验缺少已知的图片/视频类型" };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? SDPPPX_MEDIA_PROBE_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  const caller = input.signal;
  if (caller) {
    if (caller.aborted) controller.abort();
    else caller.addEventListener("abort", onAbort, { once: true });
  }
  try {
    let current: URL;
    try {
      current = assertPublicHttpsUrl(input.url);
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : "地址不符合网络边界" };
    }
    for (let hop = 0; hop <= SDPPPX_MEDIA_PROBE_MAX_REDIRECTS; hop += 1) {
      const response = await fetchImpl(current, {
        method: "GET",
        // 只带这两个头：任何凭据都不能证明外部可读。
        headers: { accept: "image/*,video/*", range: `bytes=0-${(input.maxBytes ?? SDPPPX_MEDIA_PROBE_MAX_BYTES) - 1}` },
        redirect: "manual",
        signal: controller.signal
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) return { ok: false, message: "匿名读取重定向缺少 Location" };
        try {
          current = assertPublicHttpsUrl(new URL(location, current).toString());
        } catch (error) {
          return { ok: false, message: error instanceof Error ? error.message : "重定向目标不符合网络边界" };
        }
        continue;
      }
      if (!response.ok) return { ok: false, message: `匿名读取失败（HTTP ${response.status}）` };
      const contentType = baseMediaType(response.headers.get("content-type") ?? "");
      if (!mediaKindOf(contentType)) {
        return { ok: false, message: `匿名读取返回的不是图片/视频（${contentType || "未知类型"}）` };
      }
      if (mediaKindOf(contentType) !== expectedKind) {
        return { ok: false, message: `匿名读取返回的 ${contentType} 与本次 ${expectedKind} 不符` };
      }
      const bytes = await readBounded(response, input.maxBytes ?? SDPPPX_MEDIA_PROBE_MAX_BYTES);
      if (bytes === 0) return { ok: false, message: "匿名读取返回空内容" };
      return { ok: true };
    }
    return { ok: false, message: "匿名读取重定向次数过多" };
  } catch (error) {
    if (caller?.aborted) return { ok: false, message: "匿名读取已取消" };
    if (timedOut || (error instanceof Error && error.name === "AbortError")) {
      return { ok: false, message: "匿名读取超时" };
    }
    return { ok: false, message: error instanceof Error ? error.message : "匿名读取失败" };
  } finally {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onAbort);
  }
}

/** 流式读够上限即取消：返回实际读到的字节数。 */
async function readBounded(response: Response, maxBytes: number): Promise<number> {
  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return Math.min(buffer.byteLength, maxBytes);
  }
  const reader = body.getReader();
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Math.min(total, maxBytes);
}

function statusCodeOf(status: number): SdpppxErrorCode {
  switch (status) {
    case 401:
      return SDPPPX_ERROR_CODES.sessionExpired;
    case 403:
      return SDPPPX_ERROR_CODES.mediaForbidden;
    case 413:
      return SDPPPX_ERROR_CODES.mediaUnsupported;
    case 415:
      return SDPPPX_ERROR_CODES.mediaUnsupported;
    case 429:
      return SDPPPX_ERROR_CODES.mediaRateLimited;
    case 400:
      return SDPPPX_ERROR_CODES.mediaUploadFailed;
    default:
      return status >= 500 ? SDPPPX_ERROR_CODES.mediaUploadUnavailable : SDPPPX_ERROR_CODES.mediaUploadFailed;
  }
}

function failure(status: number, code: SdpppxErrorCode, message: string): SdpppxMediaUploadFailure {
  return { ok: false, status, code, message };
}
