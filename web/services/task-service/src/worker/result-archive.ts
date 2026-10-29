/**
 * 持久化前的重负载归档：provider 二进制输出 → Media 稳定对象，记录里只留 `{ media }`。
 *
 * 背景（2026-10-28 现场）：dev 的 `task-dev.sqlite` 2.2GB，`task_records` 只 92 行。原因是
 * pptask 把 provider 输出归一成 `Uint8Array`（Media 转存的回退来源），而 SQLite 落库是裸
 * `JSON.stringify`：每个字节展开成 `{"0":137,...}`（约 13 倍），并且 worker 的恢复快照
 * `state.record.result` 与任务 `result` 各存一份 —— 单张 6.99MB 图片 = 93.6MB × 2。
 *
 * 契约本来就写着「`result` 是 display-safe，重负载属于应用存储」（task-store/types.ts），
 * 这里把它落到 SQLite 边界：字节先按内容寻址写进 Media，记录里只留 `storageKey` +
 * metadata。materializer 侧按稳定媒体引用 verify-and-adopt（见 media-materialization.ts），
 * 不再从库里搬字节。
 *
 * 两条硬约束：
 * 1. **宁可大，不可丢**：转存失败原样保留字节（URL 过期/失败时的唯一退路、重启对账也靠它）；
 * 2. **只处理受支持的形状**：单产物的 image/audio；video 仍只走地址路径（大对象不按字节转存）。
 */
import { createHash } from "node:crypto";
import { CANVAS_TASK_LIMITS, isGenerationStableMediaResult } from "@woohaa3/contracts";
import type { MediaClient } from "../clients/media-client.js";
import type { TaskPayloadSnapshot, TaskPayloadTransform } from "../repository/sqlite-task-store.js";
import { readProviderContentType } from "./media-materialization.js";
import { safeProviderMessage } from "./normalize.js";
import type { BinaryModelType } from "./types.js";

/** 归档后写在 `result` 里的稳定引用（形状与 `GenerationStableMediaResult.media` 一致）。 */
export type ArchivedMedia = {
  storageKey: string;
  contentType: string;
  size: number;
  checksum?: string;
};

export type ResultArchiveOptions = {
  /** 未装配 Media（独立部署）时退化为「原样落库」。 */
  mediaClient?: MediaClient;
  logger?: (event: Record<string, unknown>) => void;
  /** 同进程内记住「这份字节已转存」，避免 state 与 result 各上传一次。默认 64 条。 */
  cacheLimit?: number;
};

const DEFAULT_CACHE_LIMIT = 64;

/**
 * 构造 `SqliteTaskStore` 的持久化变换钩子。
 *
 * 只改 `state` / `result`；调度字段（status/lease/attempt）原样保留。
 */
export function createResultArchiver(options: ResultArchiveOptions): TaskPayloadTransform {
  const client = options.mediaClient;
  const cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;
  // taskKey → 已归档内容的摘要与引用。worker 的恢复快照与任务 result 常是同一份字节，
  // 只应产生一次 import；job repository 每次 get 都会 clone，所以按内容摘要而不是对象引用命中。
  const archived = new Map<string, { digest: string; media: ArchivedMedia }>();

  return async function archivePayload(payload: TaskPayloadSnapshot) {
    if (!client) return undefined;

    const stateResult = readStateResult(payload.state);
    const kind = binaryKindOf(payload.params) ?? inferBinaryKind(payload.result) ?? inferBinaryKind(stateResult);
    // 视频大对象只接受地址；按字节归档会把 64MB 上限的对象再放大成 base64。
    if (!kind || kind === "video") return undefined;

    const resultBytes = firstMediaBytes(payload.result, kind);
    const stateBytes = firstMediaBytes(stateResult, kind);
    if (!resultBytes && !stateBytes) return undefined;

    try {
      const media = await archiveBytes(payload, kind, resultBytes ?? stateBytes!);
      return {
        state: stateBytes ? withArchivedState(payload.state, stateResult, media) : payload.state,
        result: resultBytes ? withArchivedResult(payload.result, media) : payload.result
      };
    } catch (error) {
      options.logger?.({
        event: "task-result-archive-failed",
        taskKey: payload.key,
        code: safeProviderMessage(error)
      });
      return undefined;
    }
  };

  async function archiveBytes(
    payload: TaskPayloadSnapshot,
    kind: BinaryModelType,
    bytes: Uint8Array
  ): Promise<ArchivedMedia> {
    if (!client) throw new Error("Media 未装配");
    const digest = digestBytes(bytes);
    const known = archived.get(payload.key);
    if (known && known.digest === digest) return known.media;

    const canvasId = readCanvasId(payload.context);
    const metadata = await client.importBytes({
      bytesBase64: Buffer.from(bytes).toString("base64"),
      contentType: readProviderContentType(payload.result ?? readStateResult(payload.state), kind),
      maxBytes: maxBytesFor(kind),
      ...(canvasId ? { canvasId } : {})
    });
    const media: ArchivedMedia = {
      storageKey: metadata.storageKey,
      contentType: metadata.contentType,
      size: metadata.size,
      ...(metadata.checksum ? { checksum: metadata.checksum } : {})
    };
    // 落库前先确认这份引用能被消费端认出来（isGenerationStableMediaResult）；认不出来就
    // 抛错保留原始字节，绝不能出现「字节删了、引用又不可用」的半成品。
    if (!isGenerationStableMediaResult({ media })) {
      throw new Error(`Media 返回的引用不是稳定键：${media.storageKey}`);
    }
    archived.set(payload.key, { digest, media });
    while (archived.size > cacheLimit) {
      const oldest = archived.keys().next().value;
      if (oldest === undefined) break;
      archived.delete(oldest);
    }
    options.logger?.({
      event: "task-result-archived",
      taskKey: payload.key,
      size: metadata.size,
      modelType: kind
    });
    return media;
  }
}

/** `state` 是 worker 的引擎快照；provider 结果在 `state.record.result`。 */
function readStateResult(state: unknown): unknown {
  if (!isRecord(state)) return undefined;
  const record = state.record;
  return isRecord(record) ? record.result : undefined;
}

/** 引擎快照：只替换 `state.record.result`，jobId / operation / transitions 原样保留（恢复要用）。 */
function withArchivedState(state: unknown, result: unknown, media: ArchivedMedia): unknown {
  const next: Record<string, unknown> = isRecord(state) ? { ...state } : {};
  const record: Record<string, unknown> = isRecord(next.record) ? { ...next.record } : {};
  record.result = withArchivedResult(result, media);
  next.record = record;
  return next;
}

/**
 * 把 `result` 换成稳定媒体引用：删掉二进制数组、保留 providerMetadata 等小字段。
 *
 * `isGenerationStableMediaResult` 只认顶层 `media`，所以 materializer / 重启对账无需改动
 * 判定逻辑就能接住这份记录。
 */
function withArchivedResult(result: unknown, media: ArchivedMedia): unknown {
  const rest: Record<string, unknown> = isRecord(result) ? { ...result } : {};
  delete rest.images;
  delete rest.audios;
  delete rest.videos;
  rest.media = media;
  return rest;
}

/**
 * 取待归档的字节：只认「单产物」形状（`images` / `audios` 长度为 1 且首项是二进制）。
 *
 * 多产物结果不归档 —— 当前执行链路只用第一份，静默丢掉其余产物比多占空间更糟。
 * 旧记录反序列化后的 `{"0":n,...}` 索引对象也不在这里重建：那是历史数据，重存一次不值得
 * 再扫几百万个 key（已归档的记录不会再回到这条路径）。
 */
function firstMediaBytes(result: unknown, kind: BinaryModelType): Uint8Array | undefined {
  if (!isRecord(result)) return undefined;
  const key = kind === "image" ? "images" : kind === "audio" ? "audios" : "videos";
  const list = result[key];
  if (!Array.isArray(list) || list.length !== 1) return undefined;
  return asBytes(list[0]);
}

/** 内容摘要只用于进程内去重（同一任务 state/result 各一份同样字节）。 */
function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asBytes(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

function inferBinaryKind(value: unknown): BinaryModelType | undefined {
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.images)) return "image";
  if (Array.isArray(value.audios)) return "audio";
  if (Array.isArray(value.videos)) return "video";
  return undefined;
}

function binaryKindOf(params: unknown): BinaryModelType | undefined {
  const modelType = isRecord(params) ? params.modelType : undefined;
  return modelType === "image" || modelType === "audio" || modelType === "video" ? modelType : undefined;
}

function readCanvasId(context: unknown): string | undefined {
  if (!isRecord(context)) return undefined;
  const canvasId = context.canvasId;
  return typeof canvasId === "string" && canvasId !== "" ? canvasId : undefined;
}

function maxBytesFor(kind: BinaryModelType): number {
  if (kind === "audio") return CANVAS_TASK_LIMITS.maxAudioOutputBytes;
  if (kind === "video") return CANVAS_TASK_LIMITS.maxVideoOutputBytes;
  return CANVAS_TASK_LIMITS.maxImageOutputBytes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
