/**
 * 参考素材上传。
 *
 * 走 sdpppx 的 `POST /tasks/upload`（原始字节 + `X-Tenant-ID`），返回可写入模板 payload 的
 * URL。上传通道优先取最近一次 `describe` 的 `recommendUploadProvider`，缺省用
 * `SDPPPX_UPLOAD_PROVIDER`。
 *
 * **允许名单**：Task Service 对 `uploadReference` 抛错是「记日志后回落到宿主签名 URL」，
 * 不会直接中止提交。为了不让一次上传失败静默变成「把本机签名地址发给远端」，这里记住所有
 * 由本扩展上传成功返回的 URL；`prepareInput` 遇到名单外的参考地址就拒绝提交。
 */
import type { SdpppxConfig } from "./config.js";
import { SdpppxHttpError } from "./http.js";
import type { SessionManager } from "./session.js";

export const SDPPPX_UPLOAD_TIMEOUT_MS = 60_000;
export const SDPPPX_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;
/** 服务端 `POST /tasks/upload` 当前只接受 `grsai`；其它推荐值回落到配置默认值。 */
const SUPPORTED_UPLOAD_PROVIDERS = new Set(["grsai"]);
const ALLOWED_URL_LIMIT = 256;

export type SdpppxReferenceUploadInput = {
  bytes: Uint8Array;
  contentType: string;
  role?: string;
  storageKey?: string;
};

export type SdpppxReferenceUploaderOptions = {
  config: () => SdpppxConfig;
  session: SessionManager;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  /** 最近一次 describe 的推荐上传通道；没有时回落配置默认值。 */
  recommendUploadProvider?: () => string | null;
  log?: (event: Record<string, unknown>) => void;
};

export type SdpppxReferenceUploader = ReturnType<typeof createSdpppxReferenceUploader>;

function extensionOf(contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/gif") return ".gif";
  if (type === "video/mp4") return ".mp4";
  if (type === "video/webm") return ".webm";
  if (type === "video/quicktime") return ".mov";
  return "";
}

function safeFilename(input: SdpppxReferenceUploadInput): string {
  const fromKey = input.storageKey?.split(/[\\/]/).pop()?.trim() ?? "";
  const base = (fromKey || input.role || "reference").replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  const withExtension = /\.[A-Za-z0-9]+$/.test(base) ? base : `${base}${extensionOf(input.contentType) || ".bin"}`;
  return withExtension || "reference.bin";
}

function urlOf(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function createSdpppxReferenceUploader(options: SdpppxReferenceUploaderOptions) {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  /** 插入顺序即最旧→最新；超过上限时删最旧，不无限增长。 */
  const uploadedUrls = new Set<string>();

  function remember(url: string): void {
    uploadedUrls.delete(url);
    uploadedUrls.add(url);
    while (uploadedUrls.size > ALLOWED_URL_LIMIT) {
      const oldest = uploadedUrls.values().next().value;
      if (typeof oldest !== "string") break;
      uploadedUrls.delete(oldest);
    }
  }

  function isUploaded(url: string): boolean {
    return uploadedUrls.has(url);
  }

  async function upload(input: SdpppxReferenceUploadInput): Promise<{ url: string }> {
    const config = options.config();
    if (config.degradedCode !== null) {
      throw new SdpppxHttpError("SDPPPX 部署参数不完整", 0, config.degradedCode);
    }
    if (!config.tenantId) {
      throw new SdpppxHttpError("缺少租户", 0, "sdpppx-config-incomplete");
    }
    if (input.bytes.byteLength === 0) {
      throw new SdpppxHttpError("参考素材为空", 0, "sdpppx-upload-failed");
    }
    if (input.bytes.byteLength > SDPPPX_UPLOAD_MAX_BYTES) {
      throw new SdpppxHttpError("参考素材超过大小上限", 0, "sdpppx-upload-failed");
    }
    const token = await options.session.accessToken();
    const recommended = options.recommendUploadProvider?.() ?? null;
    const provider =
      recommended && SUPPORTED_UPLOAD_PROVIDERS.has(recommended) ? recommended : config.uploadProvider;
    if (recommended && !SUPPORTED_UPLOAD_PROVIDERS.has(recommended)) {
      log({ event: "sdpppx-upload-provider-unsupported", provider: recommended });
    }
    const url =
      `${config.baseUrl}/tasks/upload?provider=${encodeURIComponent(provider)}` +
      `&filename=${encodeURIComponent(safeFilename(input))}`;
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SDPPPX_UPLOAD_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": input.contentType || "application/octet-stream",
          "X-Tenant-ID": config.tenantId,
          Accept: "application/json"
        },
        body: input.bytes as unknown as BodyInit,
        signal: controller.signal
      });
      if (response.status === 401 || response.status === 403) {
        await options.session.clear("sdpppx-session-expired");
        throw new SdpppxHttpError("登录已过期", 401, "sdpppx-session-expired");
      }
      if (!response.ok) {
        log({ event: "sdpppx-upload-failed", status: response.status, code: "sdpppx-upload-failed" });
        throw new SdpppxHttpError("参考素材上传失败", response.status, "sdpppx-upload-failed");
      }
      const payload: unknown = await response.json().catch(() => undefined);
      const record = payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : undefined;
      const uploaded = urlOf(record?.url);
      if (!uploaded) {
        log({ event: "sdpppx-upload-failed", status: response.status, code: "sdpppx-upload-failed" });
        throw new SdpppxHttpError("上传端点未返回地址", response.status, "sdpppx-upload-failed");
      }
      remember(uploaded);
      log({ event: "sdpppx-reference-uploaded", provider, at: now() });
      return { url: uploaded };
    } catch (error) {
      if (error instanceof SdpppxHttpError) throw error;
      log({ event: "sdpppx-upload-failed", status: 0, code: "sdpppx-upload-failed" });
      throw new SdpppxHttpError("参考素材上传失败", 0, "sdpppx-upload-failed");
    } finally {
      clearTimeout(timer);
    }
  }

  function clear(): void {
    uploadedUrls.clear();
  }

  return {
    upload,
    isUploaded,
    clear,
    /** 仅测试用：模拟「Task Service 绕过了上传」。 */
    size: () => uploadedUrls.size
  };
}
