/**
 * Provider 的纯支撑：稳定错误、值解析、结果地址抽取、payload 组装与图片下载。
 *
 * 与 `provider.ts` 分文件只为守住单文件规模门禁；这里不持有会话、目录或缓存，全部由调用方
 * 注入 fetch，便于单测。结果地址只从 `outputs` 结构里取，避免把提示词里的 URL 当媒体。
 */
import type { GenerationPrepareInput } from "@woohaa3/contracts";
import { SDPPPX_RAW_PARAMS_FIELD, type SdpppxInputSchema } from "./schema.js";

export const IMAGE_DOWNLOAD_TIMEOUT_MS = 60_000;
export const IMAGE_MAX_BYTES = 32 * 1024 * 1024;
export const MAX_OUTPUTS = 16;

export class SdpppxProviderError extends Error {
  readonly status?: number;
  readonly code: string;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "SdpppxProviderError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

export type RecordValue = Record<string, unknown>;

export function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function httpUrlOf(value: unknown): string | undefined {
  const text = textOf(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** 从结果体里按顺序抽出输出地址；只认 `outputs` 结构，避免把 prompt 里的 URL 当结果。 */
export function outputUrlsOf(payload: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    const url = httpUrlOf(value);
    if (!url || seen.has(url) || urls.length >= MAX_OUTPUTS) return;
    seen.add(url);
    urls.push(url);
  };
  const visit = (value: unknown, depth: number): void => {
    if (depth > 6 || urls.length >= MAX_OUTPUTS) return;
    if (typeof value === "string" || value instanceof URL) {
      push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ["url", "image_url", "video_url", "output", "outputs", "urls", "images", "videos", "result", "data"]) {
      if (value[key] !== undefined) visit(value[key], depth + 1);
    }
  };
  const container = isRecord(payload) ? payload : {};
  visit(container.outputs ?? container.result ?? container.data ?? payload, 0);
  return urls;
}

function mediaTypeFromBytes(bytes: Uint8Array): string | null {
  if (bytes.byteLength >= 8) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return "image/webp";
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  }
  return null;
}

export function videoMediaTypeOf(url: string): string {
  if (/\.webm(?:$|\?)/i.test(url)) return "video/webm";
  if (/\.mov(?:$|\?)/i.test(url)) return "video/quicktime";
  return "video/mp4";
}

export async function downloadImages(
  fetchImpl: typeof globalThis.fetch,
  urls: readonly string[],
  signal: AbortSignal | undefined
): Promise<{ images: Uint8Array[]; mediaTypes: string[] }> {
  const images: Uint8Array[] = [];
  const mediaTypes: string[] = [];
  for (const url of urls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_DOWNLOAD_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      const response = await fetchImpl(url, { method: "GET", signal: controller.signal });
      if (!response.ok) {
        throw new SdpppxProviderError("结果获取失败", "sdpppx-task-failed", response.status);
      }
      const headerType = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0 || bytes.byteLength > IMAGE_MAX_BYTES) {
        throw new SdpppxProviderError("结果获取失败", "sdpppx-task-failed");
      }
      const detected = mediaTypeFromBytes(bytes);
      if (!detected && !headerType.startsWith("image/")) {
        // 既不是已知图片魔数、响应头也不是图片：把 HTML/JSON 当图片存进画布会产出打不开的节点。
        throw new SdpppxProviderError("结果不是图片", "sdpppx-task-failed");
      }
      images.push(bytes);
      mediaTypes.push(detected ?? headerType);
    } catch (error) {
      if (error instanceof SdpppxProviderError) throw error;
      throw new SdpppxProviderError("结果获取失败", "sdpppx-task-failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  return { images, mediaTypes };
}

export function stableMessage(error: unknown): string {
  if (error instanceof SdpppxProviderError) return error.message;
  return "sdpppx-task-failed";
}

/** 参考素材允许名单：只接受本扩展上传成功后返回的地址。 */
export type ReferenceAllowlist = { isUploaded(url: string): boolean };

/**
 * 把面板输入按模板 schema 组装成远端 payload。
 *
 * - 只透传 schema 声明的字段；
 * - prompt 落在部署配置的字段名上；
 * - 参考素材按 `referenceFields` 的媒体类型与多值能力落位，名单外地址直接拒绝；
 * - `rawParams` 最后覆盖，允许模板的未识别字段逃生。
 */
export function buildSdpppxPayload(
  input: GenerationPrepareInput,
  schema: SdpppxInputSchema,
  promptField: string,
  uploads: ReferenceAllowlist
): RecordValue {
  const properties = isRecord(schema.inputSchema.properties)
    ? (schema.inputSchema.properties as RecordValue)
    : {};
  const payload: RecordValue = {};
  for (const key of Object.keys(properties)) {
    if (key === SDPPPX_RAW_PARAMS_FIELD) continue;
    const value = input.parameters[key];
    if (value !== undefined && value !== null && value !== "") {
      payload[key] = value;
    }
  }
  if (schema.promptRequirement !== "none" && input.prompt.trim() !== "") {
    payload[promptField] = input.prompt.trim();
  }

  if (input.references.length > 0) {
    if (schema.referenceFields.length === 0) {
      throw new SdpppxProviderError(
        "模板未声明参考素材字段，无法提交参考素材",
        "sdpppx-upload-failed"
      );
    }
    const byKind: Record<"image" | "video", string[]> = { image: [], video: [] };
    for (const reference of input.references) {
      const url = textOf(reference.url);
      if (!url || !uploads.isUploaded(url)) {
        // Task Service 在上传失败后会回落到宿主签名地址；那种地址不能发给远端。
        throw new SdpppxProviderError("参考素材上传失败，请重试", "sdpppx-upload-failed");
      }
      byKind[reference.mediaKind === "video" ? "video" : "image"].push(url);
    }
    for (const field of schema.referenceFields) {
      const queue = byKind[field.mediaKind];
      if (queue.length === 0) continue;
      payload[field.key] = field.multiple ? queue.splice(0, queue.length) : queue.shift();
    }
    if (byKind.image.length + byKind.video.length > 0) {
      throw new SdpppxProviderError("模板没有足够的参考素材字段", "sdpppx-upload-failed");
    }
  }

  const raw = textOf(input.parameters[SDPPPX_RAW_PARAMS_FIELD]);
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SdpppxProviderError("原样参数不是合法 JSON", "sdpppx-task-failed");
    }
    if (!isRecord(parsed)) {
      throw new SdpppxProviderError("原样参数必须是 JSON 对象", "sdpppx-task-failed");
    }
    Object.assign(payload, parsed);
  }
  return payload;
}
