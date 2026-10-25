/**
 * Media Remote adapter（change: adopt-frontend-cordis-plugin-runtime，design D4）。
 *
 * **唯一**浏览器 Media Service 协议出口：上传、稳定同源 URL 构造与受控媒体引用校验。
 * 不持有 COS SDK 或凭据。
 */
import { isAllowedMediaType } from "@woohaa3/contracts";
import type { MediaRemoteService, UploadedMedia, UploadMediaResult } from "../contracts.js";
import {
  MEDIA_BASE_PATH,
  MEDIA_PROJECT_BASE_PATH,
  NODE_HISTORY_BASE_PATH,
  mediaUrlFor,
  withMediaCanvasHint
} from "./paths.js";
import { appPublicUrl } from "./app-base-path.js";

export type MediaRemoteOptions = {
  basePath?: string;
  projectBasePath?: string;
  fetchImpl?: typeof globalThis.fetch;
  /**
   * 带上传进度的传输实现；缺省用 `XMLHttpRequest`（浏览器），不可用时回退 `fetchImpl`。
   * 测试可注入以确定性驱动进度/失败。
   */
  uploadImpl?: (input: {
    url: string;
    file: File;
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
  }) => Promise<{ status: number; ok: boolean; body: unknown }>;
};

/** 解析 `POST /api/media` 响应；逐字段校验后使用（不受信任输入）。 */
export function parseUploadResponse(input: unknown): UploadedMedia | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  const storageKey = record.storageKey;
  const checksum = record.checksum;
  const contentType = record.contentType;
  const size = record.size;
  if (typeof storageKey !== "string" || storageKey === "") return null;
  if (typeof checksum !== "string" || checksum === "") return null;
  if (typeof contentType !== "string" || contentType === "") return null;
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return null;
  const url = record.url;
  return {
    storageKey,
    checksum,
    contentType,
    size,
    url: typeof url === "string" && url !== "" ? url : mediaUrlFor(storageKey),
    deduplicated: record.deduplicated === true
  };
}

/** 合规的稳定同源媒体 URL：只接受 `/api/media/...`（站内相对路径）。 */
export function isAllowedMediaUrl(url: string): boolean {
  if (typeof url !== "string" || url === "") return false;
  // 拒绝显式协议 / blob / data（稳定同源引用必须是站内相对路径）。
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  if (url.startsWith("//")) return false;
  return url.startsWith(`${MEDIA_BASE_PATH}/`);
}

/**
 * 合规的节点历史受控预览地址。
 *
 * 与 canonical 资产不同：历史预览由 `canvasRemote.nodeHistoryPreviewUrl` 构造为**已加挂载
 * 前缀**的站内地址（`/api/canvas-node-history/...`），不是 `/api/media/` 下的资产 URL。
 * 只接受这一前缀的同源相对路径，仍然拒绝显式协议、协议相对地址与路径回溯。
 */
export function isAllowedNodeHistoryPreviewUrl(url: string): boolean {
  if (typeof url !== "string" || url === "") return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return false;
  if (url.startsWith("//") || url.includes("..")) return false;
  return url.startsWith(appPublicUrl(`${NODE_HISTORY_BASE_PATH}/`));
}

/**
 * 从 canonical asset 解析媒体 **view URL**：先按逻辑受控路径校验，再加一次公开挂载前缀。
 * 不合规返回 null。返回的 URL 可直接用于 DOM/网络展示；持久化引用仍用逻辑 `mediaUrlFor`。
 *
 * `canvasId` 由调用方在已知画布上下文时传入：只影响本次渲染出口的 `?canvas=` 提示，
 * 不写回资产，也不改变持久化格式。
 */
export function resolveCanonicalMediaUrl(asset: unknown, canvasId?: string | null): string | null {
  if (typeof asset !== "object" || asset === null) return null;
  const record = asset as Record<string, unknown>;
  const url = record.url;
  if (typeof url !== "string" || !isAllowedMediaUrl(url)) return null;
  return appPublicUrl(withMediaCanvasHint(url, canvasId));
}

/** Read original bytes; HTTP failures must never become saved error pages. */
export async function readCanonicalMedia(asset: unknown, signal?: AbortSignal, canvasId?: string | null): Promise<Blob> {
  const url = resolveCanonicalMediaUrl(asset, canvasId);
  if (!url) throw new Error("资源没有可下载的文件地址");
  let response: Response;
  try { response = await globalThis.fetch(url, { signal, credentials: "same-origin" }); }
  catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw new Error("无法连接媒体服务，下载失败，请重试", { cause: error });
  }
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}），请重试`);
  const blob = await response.blob();
  if (!blob.size) throw new Error("资源文件为空，请重试");
  return blob;
}

/** 浏览器 XHR 上传：与 fetch 语义一致，但能上报上传进度。 */
function uploadViaXhr(input: {
  url: string;
  file: File;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}): Promise<{ status: number; ok: boolean; body: unknown }> {
  return new Promise((resolve, reject) => {
    if (input.signal?.aborted) { reject(new Error("abort")); return; }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => input.signal?.removeEventListener("abort", abort);
    xhr.open("POST", input.url, true);
    xhr.setRequestHeader("content-type", input.file.type || "application/octet-stream");
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        input.onProgress?.(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      }
    };
    xhr.onload = () => {
      cleanup();
      let body: unknown = null;
      try {
        body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        body = null;
      }
      input.onProgress?.(100);
      resolve({ status: xhr.status, ok: xhr.status >= 200 && xhr.status < 300, body });
    };
    xhr.onerror = () => { cleanup(); reject(new Error("network")); };
    xhr.onabort = () => { cleanup(); reject(new Error("abort")); };
    input.signal?.addEventListener("abort", abort, { once: true });
    xhr.send(input.file);
  });
}

export function createMediaRemote(options: MediaRemoteOptions = {}): MediaRemoteService {
  const basePath = (options.basePath ?? MEDIA_BASE_PATH).replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  // 上传目标：逻辑路径加一次公开挂载前缀（XHR/fetch 出口都在此处映射一次）。
  const uploadUrl = appPublicUrl(basePath);
  const projectUploadUrl = appPublicUrl(options.projectBasePath ?? MEDIA_PROJECT_BASE_PATH);

  const transport =
    options.uploadImpl ??
    (typeof XMLHttpRequest !== "undefined"
      ? uploadViaXhr
      : // 无 XHR 的环境（部分测试）：退回 fetch，无进度。
        (async (input: { url: string; file: File; onProgress?: (percent: number) => void; signal?: AbortSignal }) => {
          const response = await fetchImpl(input.url, {
            method: "POST",
            headers: { "content-type": input.file.type || "application/octet-stream" },
            body: input.file,
            signal: input.signal
          });
          const body = await response.json().catch(() => null);
          input.onProgress?.(100);
          return { status: response.status, ok: response.ok, body };
        }));

  return {
    async upload({ file, canvasId, onProgress, signal }): Promise<UploadMediaResult> {
      if (signal?.aborted) return { ok: false, error: "上传已取消" };
      // 画布提示只加在上传目标的 query 上：写入落在该画布对应的存储后端。
      const targetUrl = withMediaCanvasHint(
        !isAllowedMediaType(file.type) && file.type.startsWith("application/") ? projectUploadUrl : uploadUrl,
        canvasId
      );
      let result: { status: number; ok: boolean; body: unknown };
      try {
        result = await transport({ url: targetUrl, file, ...(onProgress ? { onProgress } : {}), ...(signal ? { signal } : {}) });
      } catch {
        return { ok: false, error: signal?.aborted ? "上传已取消" : "无法连接媒体服务，上传失败" };
      }
      if (!result.ok) {
        const body = result.body;
        const message =
          typeof body === "object" && body !== null && typeof (body as { message?: unknown }).message === "string"
            ? String((body as { message?: unknown }).message)
            : `上传失败（HTTP ${result.status}）`;
        return { ok: false, error: message };
      }
      const media = parseUploadResponse(result.body);
      if (!media) return { ok: false, error: "媒体服务返回了无法识别的响应" };
      return { ok: true, media };
    },

    urlFor: (storageKey, canvasId) => appPublicUrl(mediaUrlFor(storageKey, canvasId)),

    isAllowedUrl: isAllowedMediaUrl,

    resolveCanonicalUrl: resolveCanonicalMediaUrl
  };
}
