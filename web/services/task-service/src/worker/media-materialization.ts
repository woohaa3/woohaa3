/**
 * Task worker 运行时：provider 二进制输出的 Media 持久化
 * （自 `runtime.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R25）。
 *
 * 不变式：所有二进制生成结果先经 Media Service 转存为稳定对象，之后才写 succeeded；
 * 转存失败记录为 failed，绝不落 succeeded。
 */
import type { ExecutionRecord } from "@sdppp/pptask-worker-server/history";
import type { PptaskTaskStore } from "@sdppp/pptask-worker-server";
import {
  CANVAS_TASK_LIMITS,
  isGenerationStableMediaResult,
  type GenerationStableMediaResult,
  type TaskResultSummary,
  type MediaMetadata
} from "@woohaa3/contracts";
import { safeProviderMessage } from "./normalize.js";
import { projectExecutionRecord, readDurationFromRecord } from "./execution-projection.js";
import type { BinaryModelType, MaterializationContext, TaskAssociation } from "./types.js";

/** 视频结果：主视频 URL + 从 provider 原始结果读取可选海报（末帧）与时长。 */
export async function materializeVideoResult(
  options: MaterializationContext,
  record: ExecutionRecord,
  association: Partial<TaskAssociation> | undefined,
  videoUrl: string
): Promise<void> {
  const raw = await options.taskStore.find(record.id).catch(() => null);
  const posterUrl = readRawPosterUrl(raw?.result);
  const duration = readRawDurationSeconds(raw?.result);
  await materializeBinaryResult(options, record, association, {
    kind: "url",
    url: videoUrl,
    modelType: "video",
    ...(posterUrl ? { posterUrl } : {})
  }, duration);
}

/** 从 provider 原始结果读取海报/末帧 URL（providerMetadata 或顶层）。 */
export function readRawPosterUrl(raw: unknown): string | undefined {
  if (!isRecord(raw)) return undefined;
  const direct = raw.posterUrl ?? raw.lastFrameUrl ?? raw.last_frame_url;
  if (typeof direct === "string" && /^https:\/\//i.test(direct)) return direct;
  const metadata = raw.providerMetadata;
  if (isRecord(metadata)) {
    for (const entry of Object.values(metadata)) {
      if (!isRecord(entry)) continue;
      const candidate = entry.posterUrl ?? entry.lastFrameUrl ?? entry.last_frame_url;
      if (typeof candidate === "string" && /^https:\/\//i.test(candidate)) return candidate;
    }
  }
  return undefined;
}

/** 从 provider 原始结果读取时长。 */
export function readRawDurationSeconds(raw: unknown): number | undefined {
  if (!isRecord(raw)) return undefined;
  for (const candidate of [raw.durationSeconds, raw.duration, isRecord(raw.usage) ? raw.usage.durationSeconds : undefined]) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return undefined;
}

/**
 * 本次材料化属于哪张画布。
 *
 * 优先取 submit 路径登记的业务关联（`resolveAssociation`）；没有注入解析器时回退到 durable
 * worker task 记录的 `context`——submit 时把 `TaskAssociation` 原样写在那里，重启/恢复后
 * 仍能读到。两者都没有（扩展任务、历史遗留任务）时保持无作用域，Media 走主存储。
 */
async function readCanvasIdForMaterialization(
  options: MaterializationContext,
  record: ExecutionRecord,
  association: Partial<TaskAssociation> | undefined
): Promise<string | undefined> {
  if (association?.canvasId) return association.canvasId;
  const raw = await options.taskStore.find(record.id).catch(() => null);
  const context = raw?.context;
  if (!isRecord(context)) return undefined;
  const canvasId = context.canvasId;
  return typeof canvasId === "string" && canvasId.length > 0 ? canvasId : undefined;
}

/**
 * 识别「已被服务端持久化」的稳定媒体结果（change: 2026-10-20-reserve-remote-generation-provider）。
 *
 * Provider（典型是远端托管生成）直接返回 `{ media: { storageKey, ... } }`，不返回字节或 URL；
 * pptask 的 execution 投影把 provider 原始 JSON 放在 `result.value`（`display` 保留对象形状）。
 * 非法形状一律返回 undefined，调用方回落到既有 URL/bytes 路径。
 */
export function readStableMediaResult(record: ExecutionRecord): GenerationStableMediaResult | undefined {
  const value = record.result?.value;
  return isGenerationStableMediaResult(value) ? value : undefined;
}

/**
 * 采用（verify-and-adopt）已持久化的稳定媒体结果：**不搬字节**。
 *
 * 先用 Media 的 `verify` 按画布作用域确认对象可读且 metadata 一致，命中后直接写
 * `TaskResultSummary`（metadata 以实测为准）；不命中/不可读按 `MediaImportError` 失败，
 * 绝不落「无产物的 succeeded」。
 */
export async function materializeStableMediaResult(
  options: MaterializationContext,
  record: ExecutionRecord,
  association: Partial<TaskAssociation> | undefined,
  media: GenerationStableMediaResult["media"]
): Promise<void> {
  const modelType = stableModelType(record);
  // 画布作用域：远端画布的结果对象只在托管存储里，不带作用域会 stat 到主存储。
  const canvasId = await readCanvasIdForMaterialization(options, record, association);
  const scope = canvasId ? { canvasId } : {};
  try {
    const metadata = await adoptStableObject(options, media.storageKey, media, scope);
    const poster = media.poster
      ? await adoptStableObject(options, media.poster.storageKey, media.poster, scope)
      : undefined;
    const durationSeconds = media.durationSeconds ?? readDurationFromRecord(record);
    options.logger?.({ event: "media-output-adopted", taskKey: record.id });
    projectExecutionRecord(
      options.history,
      record,
      association,
      resultFromMedia(
        { ...metadata, mediaKind: metadata.mediaKind ?? modelType },
        { ...(poster ? { poster } : {}), ...(durationSeconds !== undefined ? { durationSeconds } : {}) }
      ),
      "succeeded"
    );
  } catch (error) {
    options.logger?.({ event: "media-output-adopt-failed", taskKey: record.id, code: safeProviderMessage(error) });
    // 与 import 路径同一不变式：核验失败不得落 succeeded（provider 已执行，但产物不可确认）。
    projectExecutionRecord(
      options.history,
      record,
      association,
      { mediaKind: modelType },
      "failed",
      { name: "MediaImportError", message: `provider ${modelType} 结果核验失败` }
    );
  }
}

/** 稳定媒体对象的预期 metadata（逐项比对；checksum 缺省时不比对）。 */
async function adoptStableObject(
  options: MaterializationContext,
  storageKey: string,
  expected: { contentType: string; size: number; checksum?: string },
  scope: { canvasId?: string }
): Promise<MediaMetadata> {
  const verified = await options.mediaClient!.verify(
    storageKey,
    {
      contentType: expected.contentType,
      size: expected.size,
      ...(expected.checksum ? { checksum: expected.checksum } : {})
    },
    scope
  );
  if (!verified.exists) throw new Error("稳定媒体对象不存在");
  if (!verified.matches || !verified.metadata) throw new Error("稳定媒体对象 metadata 不匹配");
  return verified.metadata;
}

/** 稳定媒体结果的模型类别（record 缺 modelType 时按图片处理，与 resultFromMedia 缺省一致）。 */
function stableModelType(record: ExecutionRecord): BinaryModelType {
  return record.modelType === "video" || record.modelType === "audio" ? record.modelType : "image";
}

/** 受控转存 provider 二进制输出（URL 或 bytes）；成功写稳定 metadata，失败写 failed。 */
export async function materializeBinaryResult(
  options: MaterializationContext,
  record: ExecutionRecord,
  association: Partial<TaskAssociation> | undefined,
  input:
    | { kind: "url"; url: string; modelType: BinaryModelType; posterUrl?: string }
    | { kind: "bytes"; bytesBase64: string; contentType: string; modelType: "image" | "audio" },
  durationSeconds?: number
): Promise<void> {
  const modelType = input.modelType;
  const maxBytes = maxBytesFor(modelType);
  // 画布作用域：同一次材料化的主媒体与视频海报都属于同一张画布。
  const canvasId = await readCanvasIdForMaterialization(options, record, association);
  const scope = canvasId ? { canvasId } : {};
  try {
    const metadata =
      input.kind === "url"
        ? await options.mediaClient!.importFromUrl({ url: input.url, maxBytes, ...scope })
        : await options.mediaClient!.importBytes({
            bytesBase64: input.bytesBase64,
            contentType: input.contentType,
            maxBytes,
            ...scope
          });
    // 视频海报/末帧：作为独立图片对象转存。
    let poster: MediaMetadata | undefined;
    if (input.kind === "url" && input.posterUrl) {
      poster = await options.mediaClient!.importFromUrl({
        url: input.posterUrl,
        maxBytes: maxBytesFor("image"),
        ...scope
      });
    }
    options.logger?.({ event: "media-output-imported", taskKey: record.id });
    projectExecutionRecord(
      options.history,
      record,
      association,
      resultFromMedia(metadata, { poster, durationSeconds: durationSeconds ?? readDurationFromRecord(record) }),
      "succeeded"
    );
  } catch (error) {
    options.logger?.({ event: "media-output-import-failed", taskKey: record.id, code: safeProviderMessage(error) });
    // 转存失败：succeeded 不得落地，记录为失败（provider 已执行，但结果未持久化）。
    projectExecutionRecord(
      options.history,
      record,
      association,
      { mediaKind: modelType },
      "failed",
      { name: "MediaImportError", message: `provider ${modelType} 结果转存失败` }
    );
  }
}

/** provider 以 base64/bytes 返回：从 durable task store 的原始 result 取字节后转存。 */
export async function materializeBinaryBytesFromStore(
  options: MaterializationContext,
  record: ExecutionRecord,
  association: Partial<TaskAssociation> | undefined,
  modelType: "image" | "audio" | "video"
): Promise<void> {
  if (modelType === "video") {
    // 视频大对象不允许按字节转存：只接受 URL 路径；按原样投影，不伪造结果。
    projectExecutionRecord(options.history, record, association);
    return;
  }
  const bytes = await readRawBinaryBytesWithRetry(options.taskStore, record.id, modelType);
  if (!bytes) {
    // 没有可转存的字节（文本任务，或结果始终未落盘）：按原样投影，不伪造结果。
    projectExecutionRecord(options.history, record, association);
    return;
  }
  await materializeBinaryResult(options, record, association, {
    kind: "bytes",
    bytesBase64: bytes.bytesBase64,
    contentType: bytes.contentType,
    modelType
  });
}

/** 有界重试读取原始二进制字节：worker 的 `saveTask` 紧随 succeeded 广播之后。 */
async function readRawBinaryBytesWithRetry(
  taskStore: PptaskTaskStore,
  taskKey: string,
  modelType: "image" | "audio" | "video"
): Promise<{ kind: "bytes"; bytesBase64: string; contentType: string; modelType: "image" | "audio" | "video" } | undefined> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const bytes = await readRawBinaryBytes(taskStore, taskKey, modelType);
    if (bytes) return bytes;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** 从 durable task store 的原始 result 恢复首份二进制字节与类型（重启终态对账也用它）。 */
export async function readRawBinaryBytes(
  taskStore: PptaskTaskStore,
  taskKey: string,
  modelType: "image" | "audio" | "video"
): Promise<{ kind: "bytes"; bytesBase64: string; contentType: string; modelType: "image" | "audio" | "video" } | undefined> {
  const raw = await taskStore.find(taskKey).catch(() => null);
  const container = isRecord(raw?.result) ? (raw.result as Record<string, unknown>) : undefined;
  if (!container) return undefined;
  const list = Array.isArray(container.videos)
    ? container.videos
    : Array.isArray(container.audios)
      ? container.audios
      : container.images;
  if (!Array.isArray(list) || list.length === 0) return undefined;

  const bytes = toUint8Array(list[0]);
  if (!bytes || bytes.byteLength === 0) return undefined;
  if (bytes.byteLength > maxBytesFor(modelType)) return undefined;

  return {
    kind: "bytes",
    bytesBase64: Buffer.from(bytes).toString("base64"),
    contentType: readBinaryContentType(raw?.result, modelType),
    modelType
  };
}

function maxBytesFor(modelType: BinaryModelType): number {
  if (modelType === "audio") return CANVAS_TASK_LIMITS.maxAudioOutputBytes;
  if (modelType === "video") return CANVAS_TASK_LIMITS.maxVideoOutputBytes;
  return CANVAS_TASK_LIMITS.maxImageOutputBytes;
}

function defaultContentTypeFor(modelType: BinaryModelType): string {
  if (modelType === "audio") return "audio/mpeg";
  if (modelType === "video") return "video/mp4";
  return "image/png";
}

/** 从原始 provider result 的 providerMetadata 读取媒体类型。 */
function readBinaryContentType(raw: unknown, modelType: BinaryModelType): string {
  const metadata = isRecord(raw) ? (raw as { providerMetadata?: unknown }).providerMetadata : undefined;
  if (isRecord(metadata)) {
    for (const entry of Object.values(metadata)) {
      if (!isRecord(entry)) continue;
      const list = (entry as { images?: unknown; audios?: unknown; videos?: unknown });
      const candidate = Array.isArray(list.images)
        ? list.images
        : Array.isArray(list.audios)
          ? list.audios
          : list.videos;
      const first = Array.isArray(candidate) ? candidate[0] : undefined;
      const mediaType = isRecord(first) ? first.mediaType : undefined;
      if (typeof mediaType === "string" && mediaType.startsWith(`${modelType}/`)) return mediaType;
    }
  }
  return defaultContentTypeFor(modelType);
}

function toUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  // JSON 往返会把 Uint8Array 变成 `{ "0": n, "1": n, ... }`；按索引重建。
  if (isRecord(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return null;
    if (!keys.every((key) => /^\d+$/.test(key))) return null;
    const bytes = new Uint8Array(keys.length);
    for (const key of keys) bytes[Number(key)] = Number((value as Record<string, unknown>)[key]) & 0xff;
    return bytes;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 供 submit 路径在 Media import 后写稳定结果 metadata 的辅助。 */
export function resultFromMedia(
  metadata: MediaMetadata,
  extras?: { poster?: MediaMetadata; durationSeconds?: number }
): TaskResultSummary {
  const mediaKind =
    metadata.mediaKind === "video" || metadata.mediaKind === "audio" || metadata.mediaKind === "image"
      ? metadata.mediaKind
      : "image";
  return {
    mediaKind,
    storageKey: metadata.storageKey,
    contentType: metadata.contentType,
    size: metadata.size,
    checksum: metadata.checksum,
    ...(extras?.durationSeconds !== undefined ? { durationSeconds: extras.durationSeconds } : {}),
    ...(extras?.poster
      ? {
          poster: {
            storageKey: extras.poster.storageKey,
            contentType: extras.poster.contentType,
            size: extras.poster.size,
            checksum: extras.poster.checksum
          }
        }
      : {})
  };
}
