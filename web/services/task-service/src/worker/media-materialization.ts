/**
 * Task worker 运行时：provider 二进制输出的 Media 持久化
 * （自 `runtime.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R25）。
 *
 * 不变式：所有二进制生成结果先经 Media Service 转存为稳定对象，之后才写 succeeded；
 * 转存失败记录为 failed，绝不落 succeeded。**受控下载地址只是取字节的一种来源**：本地
 * provider 的输出字节已经落在 durable 记录里，URL 转存失败时先用同一份字节再转存一次
 * （见 materializeBinaryResult），provider 临时地址的抖动不得把已生成的结果判死。
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
import { projectExecutionRecord, readDurationFromRecord } from "./execution-projection.js";
import type { BinaryModelType, MaterializationContext, TaskAssociation } from "./types.js";

/**
 * 转存失败的**安全诊断**：只保留稳定 code 与上游/传输 HTTP 状态。
 *
 * 绝不把 provider 临时 URL、签名地址、凭据或原始异常消息写进任务错误/日志；可行动信息由
 * 状态码或稳定 code 表达（change: 2026-11-06-fix-media-output-readiness）。
 */
export type SafeMediaFailure = {
  code: string;
  status?: number;
  message: string;
};

export function safeMediaFailure(
  error: unknown,
  modelType: BinaryModelType,
  stage: "import" | "adopt" = "import"
): SafeMediaFailure {
  const code = safeMediaCode(error) ?? (stage === "adopt" ? "media-verify-failed" : "media-import-failed");
  const status = safeMediaStatus(error);
  const label = stage === "adopt" ? "结果核验失败" : "结果转存失败";
  const detail = status !== undefined
    ? `HTTP ${status}`
    : code;
  return {
    code,
    ...(status !== undefined ? { status } : {}),
    message: `provider ${modelType} ${label}（${detail}）`
  };
}

function safeMediaCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  const value = (error as { code?: unknown }).code;
  if (typeof value !== "string") return undefined;
  return /^[a-z][a-z0-9._-]{0,60}$/i.test(value) ? value : undefined;
}

function safeMediaStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const value = (error as { status?: unknown }).status;
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}

/**
 * 判断本次成功结果属于哪种二进制媒体。
 *
 * `modelType` 可能缺失（provider 事件历史上并非必填），此时从稳定媒体 contentType、输出
 * 类型回推；回推不出来才按非媒体处理。缺失时直接写 succeeded 正是「先成功后补媒体」窗口的
 * 来源之一（N04）。
 */
export function inferBinaryModelType(record: ExecutionRecord): BinaryModelType | undefined {
  if (record.modelType === "image" || record.modelType === "video" || record.modelType === "audio") {
    return record.modelType;
  }
  const stable = readStableMediaResult(record);
  const stableType = stable?.media.contentType.toLowerCase();
  if (stableType?.startsWith("video/")) return "video";
  if (stableType?.startsWith("audio/")) return "audio";
  if (stableType?.startsWith("image/")) return "image";
  const output = (record.result?.outputs ?? []).find(
    (entry) => entry.kind === "image" || entry.kind === "video" || entry.kind === "audio"
  );
  if (output?.kind === "image" || output?.kind === "video" || output?.kind === "audio") return output.kind;
  return undefined;
}

/**
 * 在开始异步转存前先投影「媒体准备中」。
 *
 * 任务保持非终态（running），结果摘要显式标记 `mediaState: "materializing"`；UI 与画布
 * 补偿据此显示准备态并禁用成功入口，而不会先看到一个没有媒体身份的 succeeded。
 */
export function projectMaterializingRecord(
  options: MaterializationContext,
  record: ExecutionRecord,
  association: Partial<TaskAssociation> | undefined,
  modelType: BinaryModelType
): void {
  projectExecutionRecord(
    options.history,
    record,
    association,
    { mediaKind: modelType, mediaState: "materializing" },
    "running",
    undefined,
    { omitFinishedAt: true, skipEventAppend: true }
  );
  options.logger?.({ event: "media-output-materializing", taskKey: record.id, modelType });
}

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
    // 两条采纳路径，按「Provider 给没给 locator」选：
    // - 给了 locator：结果在别的后端（远端托管存储），必须由存储层按 locator 取字节，
    //   媒体层再内容寻址导入；这是唯一能跨后端读的路径。
    // - 没给：字节本来就在本机存储里，按稳定键核验即可（旧行为，保持不变）。
    const adopt = async (
      key: string,
      locator: string | undefined,
      expected: { contentType: string; size: number; checksum?: string }
    ) =>
      locator
        ? options.mediaClient!.importFromLocator({
            locator,
            ...scope,
            expected: {
              contentType: expected.contentType,
              size: expected.size,
              ...(expected.checksum ? { checksum: expected.checksum } : {})
            }
          })
        : adoptStableObject(options, key, expected, scope);
    const metadata = await adopt(media.storageKey, media.locator, media);
    const poster = media.poster ? await adopt(media.poster.storageKey ?? "", media.poster.locator, media.poster) : undefined;
    const durationSeconds = media.durationSeconds ?? readDurationFromRecord(record);
    options.logger?.({ event: "media-output-adopted", taskKey: record.id, via: media.locator ? "locator" : "storage-key" });
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
    const failure = safeMediaFailure(error, modelType, "adopt");
    options.logger?.({ event: "media-output-adopt-failed", taskKey: record.id, code: failure.code, ...(failure.status !== undefined ? { status: failure.status } : {}) });
    // 与 import 路径同一不变式：核验失败不得落 succeeded（provider 已执行，但产物不可确认）。
    projectExecutionRecord(
      options.history,
      record,
      association,
      { mediaKind: modelType },
      "failed",
      {
        name: "MediaImportError",
        message: failure.message,
        ...(failure.status !== undefined ? { status: failure.status } : {}),
        code: failure.code
      }
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
    // 受控下载失败不等于「结果拿不到」：本地 provider 的输出字节已由 pptask 归一化后落在
    // durable 记录里（`result.images` / `result.audios`）。超时、403、地址过期或 CDN 抖动
    // 都会把「产物已在手」的任务判死（2026-10-22 现场：6.9MB 图片的字节就在记录里、sha256
    // 一致，同一地址二次下载超时 → 任务 failed）。与重启对账的「优先字节，其次地址」对齐：
    // URL 失败后先用同一份字节再转存一次。视频不回退：大对象只接受地址（见
    // materializeBinaryBytesFromStore）。
    if (input.kind === "url" && modelType !== "video") {
      const adopted = await importStoredBytesAfterUrlFailure(options, record, association, modelType, maxBytes, scope, error);
      if (adopted) return;
    }
    const failure = safeMediaFailure(error, modelType);
    options.logger?.({ event: "media-output-import-failed", taskKey: record.id, code: failure.code, ...(failure.status !== undefined ? { status: failure.status } : {}) });
    // 转存失败：succeeded 不得落地，记录为失败（provider 已执行，但结果未持久化）。
    projectExecutionRecord(
      options.history,
      record,
      association,
      { mediaKind: modelType },
      "failed",
      {
        name: "MediaImportError",
        message: failure.message,
        ...(failure.status !== undefined ? { status: failure.status } : {}),
        code: failure.code
      }
    );
  }
}

/**
 * URL 转存失败后用 durable 记录里的字节再转存一次（image / audio）。
 *
 * 单次读取、不轮询：走到这里时 worker 的 `saveTask` 早已落盘（URL 转存本身就要等下载超时），
 * 而一次 93MB 级记录解析的代价不允许按 100ms 轮询重复。
 *
 * 返回 `false` 表示没有可用字节或按字节转存也失败，调用方保持既有 failed 终态。
 */
async function importStoredBytesAfterUrlFailure(
  options: MaterializationContext,
  record: ExecutionRecord,
  association: Partial<TaskAssociation> | undefined,
  modelType: "image" | "audio",
  maxBytes: number,
  scope: { canvasId?: string },
  urlError: unknown
): Promise<boolean> {
  const stored = await readStoredBinarySource(options.taskStore, record.id, modelType).catch(() => undefined);
  if (!stored) {
    options.logger?.({
      event: "media-output-import-bytes-unavailable",
      taskKey: record.id,
      code: safeMediaFailure(urlError, modelType).code
    });
    return false;
  }
  try {
    if (stored.kind === "media") {
      // 落库前已归档（SqliteTaskStore 的负载变换）：按稳定引用 verify-and-adopt，不搬字节。
      await materializeStableMediaResult(options, record, association, stored.media);
      options.logger?.({ event: "media-output-adopted-from-store", taskKey: record.id });
      return true;
    }
    const metadata = await options.mediaClient!.importBytes({
      bytesBase64: stored.bytesBase64,
      contentType: stored.contentType,
      maxBytes,
      ...scope
    });
    options.logger?.({ event: "media-output-imported-from-store", taskKey: record.id });
    projectExecutionRecord(
      options.history,
      record,
      association,
      resultFromMedia(metadata, { durationSeconds: readDurationFromRecord(record) }),
      "succeeded"
    );
    return true;
  } catch (error) {
    options.logger?.({ event: "media-output-import-bytes-failed", taskKey: record.id, code: safeMediaFailure(error, modelType).code });
    return false;
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
    // 视频大对象不允许按字节转存：只接受 URL 路径。provider 只给字节时不伪造成功，
    // 也不落空视频资产；记录可诊断的稳定失败原因（spec「视频结果不可回退字节」）。
    projectExecutionRecord(
      options.history,
      record,
      association,
      { mediaKind: "video" },
      "failed",
      {
        name: "MediaImportError",
        message: "provider video 结果只提供字节，无法转存为稳定视频（只接受受控视频地址）",
        code: "video-bytes-not-supported"
      }
    );
    return;
  }
  const stored = await readStoredBinarySourceWithRetry(options.taskStore, record.id, modelType);
  if (!stored) {
    // 二进制任务既没有可转存来源、也没有稳定结果：不得落「无产物 succeeded」。
    projectExecutionRecord(
      options.history,
      record,
      association,
      { mediaKind: modelType },
      "failed",
      {
        name: "MediaImportError",
        message: `provider ${modelType} 结果缺少可转存来源`,
        code: "media-source-missing"
      }
    );
    return;
  }
  if (stored.kind === "media") {
    // 记录里已是稳定媒体引用（落库前已归档，见 worker/result-archive.ts）：verify-and-adopt。
    // 这条路径就是 2.2GB 那个缺陷的修复落点：字节不再从 SQLite 读回来再 base64 传一遍。
    await materializeStableMediaResult(options, record, association, stored.media);
    return;
  }
  await materializeBinaryResult(options, record, association, {
    kind: "bytes",
    bytesBase64: stored.bytesBase64,
    contentType: stored.contentType,
    modelType
  });
}

/** durable 记录里的二进制来源：真实字节，或已归档的稳定媒体引用。 */
export type StoredBinarySource =
  | { kind: "bytes"; bytesBase64: string; contentType: string; modelType: BinaryModelType }
  | { kind: "media"; media: GenerationStableMediaResult["media"] };

/** 有界重试读取来源：worker 的 `saveTask` 紧随 succeeded 广播之后。 */
async function readStoredBinarySourceWithRetry(
  taskStore: PptaskTaskStore,
  taskKey: string,
  modelType: "image" | "audio" | "video"
): Promise<StoredBinarySource | undefined> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const stored = await readStoredBinarySource(taskStore, taskKey, modelType);
    if (stored) return stored;
    if (Date.now() > deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * 读 durable 记录里的二进制来源。
 *
 * 落地方式有两种：新记录在落库前已把字节归档成 `{ media }`（见 worker/result-archive.ts），
 * 老记录仍可能带原始字节（JSON 往返后是 `{"0":n,...}`）。两条都要认，否则升级后旧任务
 * 无法对账、新任务会走到「没有可转存来源」。
 */
export async function readStoredBinarySource(
  taskStore: PptaskTaskStore,
  taskKey: string,
  modelType: BinaryModelType
): Promise<StoredBinarySource | undefined> {
  const raw = await taskStore.find(taskKey).catch(() => null);
  // pptask persists the execution snapshot and the display result in separate
  // columns.  A terminal notification can race the second save, leaving only
  // `state.record.result` at the first recovery read.  Treat that snapshot as
  // an equally durable source; otherwise a provider byte result is projected
  // without an asset and the retry window cannot recover it once the result
  // column is never written (old worker versions did this on shutdown).
  const result = raw?.result ?? readStateResult(raw?.state);
  if (isGenerationStableMediaResult(result)) return { kind: "media", media: result.media };
  return bytesFromResult(result, modelType);
}

function readStateResult(state: unknown): unknown {
  if (!isRecord(state) || !isRecord(state.record)) return undefined;
  return state.record.result;
}

/** 从 durable task store 的原始 result 恢复首份二进制字节与类型（重启终态对账也用它）。 */
export async function readRawBinaryBytes(
  taskStore: PptaskTaskStore,
  taskKey: string,
  modelType: "image" | "audio" | "video"
): Promise<{ kind: "bytes"; bytesBase64: string; contentType: string; modelType: BinaryModelType } | undefined> {
  const stored = await readStoredBinarySource(taskStore, taskKey, modelType);
  return stored?.kind === "bytes" ? stored : undefined;
}

function bytesFromResult(result: unknown, modelType: BinaryModelType): StoredBinarySource | undefined {
  const container = isRecord(result) ? (result as Record<string, unknown>) : undefined;
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
    contentType: readProviderContentType(result, modelType),
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

/** 从原始 provider result 的 providerMetadata 读取媒体类型（归档时也要用它定 contentType）。 */
export function readProviderContentType(raw: unknown, modelType: BinaryModelType): string {
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
