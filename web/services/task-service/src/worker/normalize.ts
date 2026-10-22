/**
 * provider 原始结果 → 网关输出（change: add-image-text-node-execution，任务 5.18）。
 *
 * 执行已经托管给服务端运行时（design D14），运行时只存**原始** provider 结果；
 * 「原始结果怎么解释成文本或图片 bytes」是站点自己的输出契约，因此放在网关这一侧，
 * 而不是塞进 provider 适配器里。
 *
 * provider 结果形态（来自 `@sdppp/pptask` 的 shared 输出适配）：
 * - image：`{ images: Uint8Array[] }`（URL/base64 已在 provider 内用受控 fetch 归一到 bytes）
 * - language：`{ content: [{ type: 'text', text }] }`
 */
import { CANVAS_TASK_LIMITS, inferMediaKindFromType, type CanvasTaskModelType } from "@woohaa3/contracts";

export type ProviderRunResult =
  | { kind: "text"; text: string }
  | { kind: "image"; bytes: Uint8Array; contentType?: string }
  | { kind: "audio"; bytes: Uint8Array; contentType?: string }
  | { kind: "video"; bytes: Uint8Array; contentType?: string; durationSeconds?: number; posterUrl?: string };

export type ProviderResultError = { reason: string };

/** 解释 provider 原始结果；失败时返回原因（调用方按 failed 处理）。 */
export function normalizeProviderResult(
  modelType: CanvasTaskModelType,
  result: unknown,
  maxBytes?: number
): ProviderRunResult | ProviderResultError {
  const record = asRecord(result);
  if (!record) return { reason: "provider 返回了无法识别的结果" };

  if (modelType === "image" || modelType === "audio" || modelType === "video") {
    const kind = modelType;
    const limit =
      maxBytes ??
      (kind === "image"
        ? CANVAS_TASK_LIMITS.maxImageOutputBytes
        : kind === "audio"
          ? CANVAS_TASK_LIMITS.maxAudioOutputBytes
          : CANVAS_TASK_LIMITS.maxVideoOutputBytes);
    const media = Array.isArray(record.videos)
      ? record.videos
      : Array.isArray(record.audios)
        ? record.audios
        : record.images;
    if (!Array.isArray(media) || media.length === 0) {
      return { reason: `provider 没有返回${kind === "image" ? "图片" : kind === "audio" ? "音频" : "视频"}` };
    }
    const bytes = toBytes(media[0]);
    if (!bytes || bytes.byteLength === 0) {
      return { reason: `provider 返回的${kind === "image" ? "图片" : kind === "audio" ? "音频" : "视频"}为空` };
    }
    if (bytes.byteLength > limit) {
      return { reason: `provider 返回的媒体超过上限 ${limit} 字节` };
    }
    const contentType = readProviderMediaType(record) ?? defaultContentTypeFor(kind);
    if (kind === "image") return { kind, bytes, contentType };
    if (kind === "audio") return { kind, bytes, contentType };
    return {
      kind,
      bytes,
      contentType,
      durationSeconds: readDurationSeconds(record),
      posterUrl: readPosterUrl(record)
    };
  }

  const text = extractText(record);
  if (text === null || text.trim() === "") return { reason: "provider 没有返回文本内容" };
  if (text.length > CANVAS_TASK_LIMITS.maxTextOutputChars) {
    return { reason: `provider 返回的文本超过 ${CANVAS_TASK_LIMITS.maxTextOutputChars} 字上限` };
  }
  return { kind: "text", text };
}

function defaultContentTypeFor(kind: "image" | "audio" | "video"): string {
  if (kind === "audio") return "audio/mpeg";
  if (kind === "video") return "video/mp4";
  return "image/png";
}

function readDurationSeconds(record: Record<string, unknown>): number | undefined {
  const candidates = [record.durationSeconds, record.duration, asRecord(record.usage)?.durationSeconds];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

/** provider 返回的海报/末帧 URL（只用于 Task→Media 转存，绝不持久化）。 */
function readPosterUrl(record: Record<string, unknown>): string | undefined {
  const candidates = [record.posterUrl, record.poster, record.lastFrameUrl, asRecord(record.providerMetadata)?.posterUrl];
  for (const value of candidates) {
    if (typeof value === "string" && /^https:\/\//i.test(value)) return value;
  }
  return undefined;
}

export function isProviderResultError(
  value: ProviderRunResult | ProviderResultError
): value is ProviderResultError {
  return "reason" in value;
}

/**
 * 构造 provider 调用参数（AI SDK 形态）。
 *
 * - 图片模型：`prompt` + 模型参数 + `urls`（签出的临时 HTTPS 地址）。
 * - 文本模型：`prompt` 必须是消息数组。
 *
 * **刻意不放 `abortSignal`**：input 会被运行时持久化（structuredClone），AbortSignal 克隆后
 * 会退化；超时由运行时与出网守卫各自负责。因此 input 必须是可结构化克隆的纯数据。
 */
export function buildProviderInput(
  request: {
    modelType: CanvasTaskModelType;
    prompt: string;
    parameters: Record<string, unknown>;
    /** 稳定绑定的输入元数据（language 多模态组装用；顺序即提交顺序）。 */
    inputs?: readonly { mediaType: string; mediaKind?: "image" | "video" | "audio" }[];
  },
  referenceUrls: readonly string[]
): Record<string, unknown> {
  if (request.modelType === "image") {
    return {
      prompt: request.prompt,
      ...request.parameters,
      ...(referenceUrls.length > 0 ? { urls: [...referenceUrls] } : {})
    };
  }
  if (request.modelType === "language") {
    // 多模态：文本在前，媒体按稳定输入顺序追加（任务 6.1）。
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: request.prompt }];
    (request.inputs ?? []).forEach((input, index) => {
      const url = referenceUrls[index];
      if (!url) return;
      const mediaKind = input.mediaKind ?? inferMediaKindFromType(input.mediaType);
      if (mediaKind === "image") parts.push({ type: "image_url", image_url: { url } });
      else if (mediaKind === "video") parts.push({ type: "video_url", video_url: { url } });
      else if (mediaKind === "audio") parts.push({ type: "audio_url", audio_url: { url } });
    });
    return {
      prompt: [{ role: "user", content: parts }],
      ...request.parameters
    };
  }
  // audio/video：prompt + 模型参数 + 参考输入（字段名由 provider 适配器按 binding 消费）。
  return {
    prompt: request.prompt,
    ...request.parameters,
    ...(referenceUrls.length > 0 ? { urls: [...referenceUrls] } : {})
  };
}

function extractText(record: Record<string, unknown>): string | null {
  const content = record.content;
  if (Array.isArray(content)) {
    const parts = content.flatMap((entry) => {
      const item = asRecord(entry);
      return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
    });
    if (parts.length > 0) return parts.join("");
  }
  if (typeof record.text === "string") return record.text;
  return null;
}

/** providerMetadata 里记录的原始 mediaType（litellm 会保留首个输出的类型）。 */
function readProviderMediaType(record: Record<string, unknown>): string | undefined {
  const metadata = asRecord(record.providerMetadata);
  if (!metadata) return undefined;
  for (const value of Object.values(metadata)) {
    const entry = asRecord(value);
    const images = entry?.images;
    if (!Array.isArray(images)) continue;
    const first = asRecord(images[0]);
    const mediaType = first?.mediaType;
    if (typeof mediaType === "string" && mediaType !== "") return mediaType;
  }
  return undefined;
}

function toBytes(input: unknown): Uint8Array | null {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(input)) return new Uint8Array(input);
  return null;
}

/**
 * 只保留可诊断、无凭据的信息：绝不回显上游响应头或 provider 配置。
 * 供运行时错误与网关错误共用。
 */
export function safeProviderMessage(error: unknown): string {
  if (error instanceof Error && error.message !== "") return stripSecrets(error.message);
  return "任务执行失败";
}

const SECRET_PATTERNS = [
  /(bearer\s+)[^\s"']+/gi,
  /(authorization["':\s]+)[^\s"',]+/gi,
  /("?(?:api[_-]?key|access[_-]?token|secret[_-]?key)"?\s*[:=]\s*)"?[^"\s,]+"?/gi
];

export function stripSecrets(message: string): string {
  let output = message;
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, "$1***");
  return output.slice(0, 500);
}

function asRecord(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}
