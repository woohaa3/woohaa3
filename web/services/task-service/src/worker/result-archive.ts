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
 * 1. **宁可大，不可丢**：任一张转存失败就整体保留原始字节（URL 过期/失败时的唯一退路、
 *    重启对账也靠它）；
 * 2. **只处理受支持的形状**：image/audio/motion 的字节；video 仍只走地址路径（大对象不按
 *    字节转存）。
 *
 * **多产物是必须支持的主路径**（2026-11-17 现场）：图层拆分（Seedream 5.5
 * `layer_decomposition`）一次返回 1 张底图 + N 个图层，早先的「只归档单产物」判断让整条
 * 链路退化成把原始字节写进 SQLite —— 24.2MB 字节 × 13 倍 JSON 膨胀 × state/result 两份
 * = 640MB 单行，`JsonStore.save` 的同步序列化把事件循环卡死 112 秒（前端表现为「正在重连
 * 本地服务器」）。现在逐张归档、写 `outputs`，单行回到 KB 级。
 */
import { createHash } from "node:crypto";
import { CANVAS_TASK_LIMITS, isGenerationStableMediaResult, readImageMediaType } from "@woohaa3/contracts";
import type { MediaClient } from "../clients/media-client.js";
import type { TaskPayloadSnapshot, TaskPayloadTransform } from "../repository/sqlite-task-store.js";
import { bytesFromBase64Descriptor, readProviderContentType } from "./media-materialization.js";
import { safeProviderMessage } from "./normalize.js";
import type { BinaryModelType } from "./types.js";

/** 归档后写在 `result` 里的稳定引用（形状与 `GenerationStableMediaResult.media` 一致）。 */
export type ArchivedMedia = {
  storageKey: string;
  contentType: string;
  size: number;
  checksum?: string;
  /**
   * 结果字节的不透明位置（`media://<backend>/<opaque>`）。
   *
   * **必须与 storageKey 一起保留**：远端托管生成（含 ComfyUI worker 链）公布的
   * `storage_key` 是任务 id 派生的（`generation-outputs/task-<id>.png`），不满足客户端的
   * 内容寻址契约（`generation-outputs/<64hex>.<ext>`），只有 locator 能定位字节。
   * 归档时丢掉它，`isGenerationStableMediaResult` 就会因为没有合法位置而判否，
   * 结果被写成「成功但无产物」（2026-11-10 现场）。
   */
  locator?: string;
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
  // taskKey → (内容摘要 → 引用)。worker 的恢复快照与任务 result 常是同一份字节，只应产生
  // 一次 import；job repository 每次 get 都会 clone，所以按内容摘要而不是对象引用命中。
  // 多产物时同一任务有多份字节，内层按摘要区分。
  const archived = new Map<string, Map<string, ArchivedMedia>>();

  return async function archivePayload(payload: TaskPayloadSnapshot) {
    if (!client) return undefined;

    const stateResult = readStateResult(payload.state);
    const kind = binaryKindOf(payload.params) ?? inferBinaryKind(payload.result) ?? inferBinaryKind(stateResult);
    // 视频大对象只接受地址；按字节归档会把 64MB 上限的对象再放大成 base64。
    if (!kind || kind === "video") return undefined;

    const resultItems = mediaItemsOf(payload.result, kind);
    const stateItems = mediaItemsOf(stateResult, kind);
    if (resultItems.length === 0 && stateItems.length === 0) return undefined;
    // 条目数不一致说明 result 与快照不是同一份输出（旧记录/部分写入）：按大的那份归档，
    // 但只替换条目数一致的一侧，避免凭空造出对方没有的产物。
    const items = resultItems.length > 0 ? resultItems : stateItems;

    try {
      const media = await archiveItems(payload, kind, items);
      const archiveable = media.length > 0;
      if (!archiveable) return undefined;
      return {
        state: stateItems.length === items.length ? withArchivedState(payload.state, stateResult, media) : payload.state,
        result: resultItems.length === items.length ? withArchivedResult(payload.result, media) : payload.result
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

  /** 逐张归档；任一张失败整体抛出（调用方保留原始字节，绝不落半套引用）。 */
  async function archiveItems(
    payload: TaskPayloadSnapshot,
    kind: BinaryModelType,
    items: readonly Uint8Array[]
  ): Promise<ArchivedMedia[]> {
    const archivedMedia: ArchivedMedia[] = [];
    for (const bytes of items) archivedMedia.push(await archiveBytes(payload, kind, bytes));
    if (archivedMedia.length > 0) {
      options.logger?.({
        event: "task-result-archived",
        taskKey: payload.key,
        size: archivedMedia.reduce((total, entry) => total + entry.size, 0),
        modelType: kind,
        ...(archivedMedia.length > 1 ? { outputs: archivedMedia.length } : {})
      });
    }
    return archivedMedia;
  }

  async function archiveBytes(
    payload: TaskPayloadSnapshot,
    kind: BinaryModelType,
    bytes: Uint8Array
  ): Promise<ArchivedMedia> {
    if (!client) throw new Error("Media 未装配");
    const digest = digestBytes(bytes);
    const known = archived.get(payload.key)?.get(digest);
    if (known) return known;

    const canvasId = readCanvasId(payload.context);
    const declaredContentType = readProviderContentType(payload.result ?? readStateResult(payload.state), kind);
    // URL 产出的 providerMetadata 只有地址，类型只能退回默认 image/png；落库前按字节签名
    // 纠正成真实格式，否则后续按记录类型解析图片会失败。
    const sniffedImageType = kind === "image" ? readImageMediaType(bytes) : null;
    const metadata = await client.importBytes({
      bytesBase64: Buffer.from(bytes).toString("base64"),
      contentType: sniffedImageType ?? declaredContentType,
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
    const perTask = archived.get(payload.key) ?? new Map<string, ArchivedMedia>();
    perTask.set(digest, media);
    archived.set(payload.key, perTask);
    while (archived.size > cacheLimit) {
      const oldest = archived.keys().next().value;
      if (oldest === undefined) break;
      archived.delete(oldest);
    }
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
function withArchivedState(state: unknown, result: unknown, media: readonly ArchivedMedia[]): unknown {
  const next: Record<string, unknown> = isRecord(state) ? { ...state } : {};
  const record: Record<string, unknown> = isRecord(next.record) ? { ...next.record } : {};
  record.result = withArchivedResult(result, media);
  next.record = record;
  return next;
}

/**
 * 把 `result` 换成稳定媒体引用：删掉二进制数组、保留 providerMetadata 等小字段。
 *
 * `isGenerationStableMediaResult` 只认顶层 `media`（= 主产物），所以 materializer / 重启
 * 对账无需改动判定逻辑就能接住这份记录；多产物另写在 `outputs`，由画布投影逐张落卡片。
 */
function withArchivedResult(result: unknown, media: readonly ArchivedMedia[]): unknown {
  const primary = media[0];
  if (!primary) return result;
  const rest: Record<string, unknown> = isRecord(result) ? { ...result } : {};
  delete rest.images;
  delete rest.audios;
  delete rest.videos;
  delete rest.motions;
  // pptask mirrors the first audio as a top-level base64 string (`audio`) in addition
  // to `audios`.  Keeping it would retain the full payload in SQLite even after the
  // descriptor is archived, so remove the duplicate together with the list.
  delete rest.audio;
  rest.media = primary;
  if (media.length > 1) {
    rest.outputs = media.map((entry, index) => ({
      index,
      storageKey: entry.storageKey,
      ...(entry.locator !== undefined ? { locator: entry.locator } : {}),
      contentType: entry.contentType,
      size: entry.size,
      ...(entry.checksum !== undefined ? { checksum: entry.checksum } : {})
    }));
  } else {
    delete rest.outputs;
  }
  return rest;
}

/**
 * 取待归档的**全部**字节（provider 输出顺序）。
 *
 * 图层拆分等多产物结果是主路径，不再是「只认长度为 1」的特例。任何一项拿不到字节就整体
 * 放弃归档（返回空数组）：只归档一部分会让落库结果既不是完整字节、也不是完整引用。
 * 旧记录反序列化后的 `{"0":n,...}` 索引对象也不在这里重建：那是历史数据，重存一次不值得
 * 再扫几百万个 key（已归档的记录不会再回到这条路径）。
 */
function mediaItemsOf(result: unknown, kind: BinaryModelType): Uint8Array[] {
  if (!isRecord(result)) return [];
  const key = kind === "image" ? "images" : kind === "audio" ? "audios" : kind === "motion" ? "motions" : "videos";
  const list = result[key];
  if (!Array.isArray(list) || list.length === 0) return [];
  const items: Uint8Array[] = [];
  for (const entry of list) {
    const bytes = asBytes(entry, maxBytesFor(kind));
    if (!bytes || bytes.byteLength === 0) return [];
    items.push(bytes);
  }
  return items;
}

/** 内容摘要只用于进程内去重（同一任务 state/result 各一份同样字节）。 */
function digestBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function asBytes(value: unknown, maxBytes: number): Uint8Array | undefined {
  const descriptor = bytesFromBase64Descriptor(value, maxBytes);
  if (descriptor) return descriptor.bytes;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return undefined;
}

function inferBinaryKind(value: unknown): BinaryModelType | undefined {
  if (!isRecord(value)) return undefined;
  if (Array.isArray(value.motions)) return "motion";
  if (Array.isArray(value.images)) return "image";
  if (Array.isArray(value.audios)) return "audio";
  if (Array.isArray(value.videos)) return "video";
  return undefined;
}

function binaryKindOf(params: unknown): BinaryModelType | undefined {
  const modelType = isRecord(params) ? params.modelType : undefined;
  return modelType === "image" || modelType === "audio" || modelType === "video" || modelType === "motion" ? modelType : undefined;
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
