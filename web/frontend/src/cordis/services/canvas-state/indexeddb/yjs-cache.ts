/**
 * 浏览器 Yjs update cache（任务 6.3 / design D9）。
 *
 * IndexedDB 在 Yjs 模式下**只缓存服务端已发布的 update 与格式元数据**，不再保存规范
 * 快照。cache 是可丢弃的：
 * - 清空 cache 后必须能从服务端 state-vector 同步完整重建；
 * - 损坏 cache 必须能检出并被丢弃（不进入可编辑状态）。
 *
 * 关键不变式：cache 中的 update **只**来自服务端广播；本地 transaction 永不写入这里
 * （否则会把本地未确认状态当成已发布状态）。
 */

/** 一个 canvas 的 Yjs cache 元数据。 */
export type YjsCacheMetadata = {
  canvasId: string;
  /** 共享 Y.Doc 格式版本；与当前格式不匹配的 cache 必须丢弃。 */
  formatVersion: string;
  /** Command/normalization capability that produced this cache. Missing means legacy. */
  protocolVersion?: number;
  /** 服务端 room epoch；不一致说明 cache 属于旧房间，必须丢弃。 */
  roomEpoch: string | null;
  /** cache 覆盖到的业务 revision。 */
  revision: number;
  updatedAt: string;
};

/** 分片存储的 update（避免单条记录过大）。 */
export type YjsCacheUpdate = {
  /** `${canvasId}:${seq}`。 */
  id: string;
  canvasId: string;
  seq: number;
  update: Uint8Array;
  /** 来源标识：始终为服务端广播。 */
  origin: "server";
  createdAt: string;
};

export type YjsCacheLoadResult = {
  metadata: YjsCacheMetadata;
  /** 按 seq 升序的 updates。 */
  updates: YjsCacheUpdate[];
};

export type YjsCacheValidation =
  | { ok: true; load: YjsCacheLoadResult }
  | { ok: false; reason: string };

export class YjsCacheError extends Error {
  readonly code: "CACHE_FORMAT_MISMATCH" | "CACHE_EPOCH_MISMATCH" | "CACHE_CORRUPT";

  constructor(code: YjsCacheError["code"], message: string) {
    super(message);
    this.name = "YjsCacheError";
    this.code = code;
  }
}

/** 校验 cache 是否可用于当前会话；不匹配时调用方必须丢弃 cache。 */
export function validateYjsCache(
  load: YjsCacheLoadResult | null,
  expected: { formatVersion: string; roomEpoch: string | null; protocolVersion?: number }
): YjsCacheValidation {
  if (!load) return { ok: false, reason: "没有本地 Yjs cache" };
  if (load.metadata.formatVersion !== expected.formatVersion) {
    return { ok: false, reason: `cache 格式 ${load.metadata.formatVersion} 与当前 ${expected.formatVersion} 不匹配` };
  }
  if (expected.protocolVersion !== undefined && load.metadata.protocolVersion !== expected.protocolVersion) {
    return { ok: false, reason: "cache 同步能力已过期，须重新同步" };
  }
  // roomEpoch 为 null 表示客户端尚无 epoch（首次连接），此时接受 cache。
  if (
    expected.roomEpoch !== null
    && load.metadata.roomEpoch !== null
    && load.metadata.roomEpoch !== expected.roomEpoch
  ) {
    return { ok: false, reason: `cache room epoch ${load.metadata.roomEpoch} 已过期（当前 ${expected.roomEpoch}）` };
  }
  return { ok: true, load };
}

/**
 * 应用 cache 到本地文档，返回覆盖到的 revision。
 *
 * 逐条按 seq 严格递增应用：非递增视为损坏（与恢复路径同一判据）。
 *
 * **不直接依赖 `yjs`**：`applyUpdate` 由调用方注入（通常是 `Y.applyUpdate`）。这样
 * canvas-state 保持对 Yjs 的中立性，Yjs 依赖只存在于 `@woohaa3/canvas-yjs`。
 */
export function applyYjsCacheToDoc<TDoc>(
  doc: TDoc,
  load: YjsCacheLoadResult,
  applyUpdate: (doc: TDoc, update: Uint8Array) => void
): number {
  let expected = 0;
  for (const entry of load.updates) {
    if (entry.seq <= expected) {
      throw new YjsCacheError("CACHE_CORRUPT", `cache seq 非单调递增：${entry.seq} <= ${expected}`);
    }
    expected = entry.seq;
    applyUpdate(doc, entry.update);
  }
  return load.metadata.revision;
}

/** 生成 cache update 记录 id。 */
export function yjsCacheUpdateId(canvasId: string, seq: number): string {
  return `${canvasId}:${seq}`;
}
