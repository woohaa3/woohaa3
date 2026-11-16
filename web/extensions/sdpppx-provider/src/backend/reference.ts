/**
 * 参考素材上传（`POST /media/upload`）。
 *
 * 与临时图床共用 `media-upload.ts` 适配器：Bearer + 原始二进制 + 真实 MIME；业务上限 20 MiB，
 * 只接受 image/video。旧的 `/tasks/upload`（provider / filename / X-Tenant-ID / 32 MiB /
 * 顶层 url）已删除。
 *
 * **允许名单**：Task Service 对 `uploadReference` 抛错是「记日志后回落到宿主签名 URL」，
 * 不会直接中止提交。为了不让一次上传失败静默变成「把本机签名地址发给远端」，这里记住所有
 * 由本扩展上传成功返回的 URL；`prepareInput` 遇到名单外的参考地址就拒绝提交。
 * 临时图床 `/media/upload` 的回退地址也由 `rememberUrl` 写入同一名单。
 */
import type { SdpppxConfig } from "./config.js";
import { SdpppxHttpError } from "./http.js";
import {
  uploadSdpppxMedia,
  type SdpppxMediaUploadInput,
  type SdpppxMediaUploadResult
} from "./media-upload.js";
import type { SessionManager } from "./session.js";

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
  /** 测试注入；缺省走 `media-upload.ts` 的实现。 */
  upload?: (input: SdpppxMediaUploadInput) => Promise<SdpppxMediaUploadResult>;
  log?: (event: Record<string, unknown>) => void;
};

export type SdpppxReferenceUploader = ReturnType<typeof createSdpppxReferenceUploader>;

export function createSdpppxReferenceUploader(options: SdpppxReferenceUploaderOptions) {
  const log = options.log ?? (() => undefined);
  const uploadMedia = options.upload ?? uploadSdpppxMedia;
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
    const accessToken = await options.session.accessToken();
    const result = await uploadMedia({
      baseUrl: config.baseUrl,
      accessToken,
      bytes: input.bytes,
      contentType: input.contentType,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
    if (!result.ok) {
      if (result.status === 401) {
        await options.session.clear("sdpppx-session-expired");
      }
      log({ event: "sdpppx-upload-failed", status: result.status, code: result.code });
      throw new SdpppxHttpError(result.message, result.status, result.code);
    }
    remember(result.url);
    log({ event: "sdpppx-reference-uploaded", size: result.size });
    return { url: result.url };
  }

  function clear(): void {
    uploadedUrls.clear();
  }

  return {
    upload,
    isUploaded,
    /**
     * 临时图床 `/media/upload` 与模板参考上传共用同一适配器与允许名单；图床成功地址写进来，
     * 避免 Task 回落到宿主图床时被 `prepareInput` 当成「本机签名地址」拒绝。
     */
    rememberUrl: remember,
    clear,
    /** 仅测试用：模拟「Task Service 绕过了上传」。 */
    size: () => uploadedUrls.size
  };
}
