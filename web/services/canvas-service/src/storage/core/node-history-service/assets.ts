/**
 * 节点生成历史服务：纯资产构造
 * （自 `node-history-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R02）。
 *
 * 从历史 payload 构造稳定资产（不含 bytes/签名 URL）；稳定 ID 由 entryId/base 派生，恢复时
 * 创建/复用同一资产。
 */
import type {
  NodeGenerationHistoryEntry,
  NodeHistoryImageEditBaseMetadata,
  NodeHistoryMediaPayload,
  StoredAsset
} from "@woohaa3/contracts";

/** 媒体稳定资产 ID：由历史 entryId 派生，恢复时创建/复用同一资产。 */
export function mediaAssetIdFor(entry: { entryId: string }, payload: NodeHistoryMediaPayload): string {
  return `ngh-asset-${entry.entryId}-${payload.kind}`;
}

/** 图片编辑版本的稳定原图资产 ID：由 base metadata 派生，跨版本复用同一原图。 */
export function imageEditBaseAssetIdFor(base: NodeHistoryImageEditBaseMetadata): string {
  return `ngh-base-${base.baseAssetId}`;
}

/** 从稳定资产读取 storageKey（缺失返回 null）。 */
export function readAssetStorageKey(asset: StoredAsset | undefined): string | null {
  const value = asset?.metadata && (asset.metadata as { storageKey?: unknown }).storageKey;
  return typeof value === "string" && value !== "" ? value : null;
}

export function readAssetMeta(asset: StoredAsset | undefined, key: string): string | null {
  const value = asset?.metadata && (asset.metadata as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

export function readAssetMetaNumber(asset: StoredAsset | undefined, key: string): number | null {
  const value = asset?.metadata && (asset.metadata as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 由原图 metadata 构造/复用稳定资产（恢复时写回 nodeData 的原图引用）。 */
export function imageEditBaseAssetFor(base: NodeHistoryImageEditBaseMetadata): StoredAsset {
  return {
    id: imageEditBaseAssetIdFor(base),
    title: "编辑原图",
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: new Date(0).toISOString(),
    url: `/api/media/${base.storageKey}`,
    metadata: {
      storageKey: base.storageKey,
      checksum: base.checksum,
      contentType: base.contentType,
      size: base.size
    }
  };
}

/**
 * 恢复产物的 provenance。
 *
 * 恢复出来的资产 id 是历史派生的稳定 id（`ngh-asset-*`），但溯源链必须与在线产物一致：
 * `nodeData.outputAssetId → asset.provenance.runId → jobs[].taskId`。因此把条目 source 上的
 * runId 写回 provenance（change: l0-generation-provenance）。
 *
 * `StoredAsset.provenance` 在契约里只有 taskNodeId/taskKind/runId/outputIndex 四个字段
 * （见 domain/aggregate.ts 的 readProvenance 白名单），taskKey/modelId 无处安放也不应塞进
 * metadata —— 它们留在 node-history 条目的 source 上（条目 id 即资产 id 中段），由 runId 关联。
 * 条目没有 runId（旧条目）时保持缺省，不编造。
 */
function historyProvenance(input: {
  taskNodeId: string;
  taskKind: string;
  outputIndex?: number;
  runId?: string;
}): NonNullable<StoredAsset["provenance"]> {
  return {
    taskNodeId: input.taskNodeId,
    taskKind: input.taskKind,
    ...(input.outputIndex !== undefined ? { outputIndex: input.outputIndex } : {}),
    ...(input.runId ? { runId: input.runId } : {})
  };
}

export function mediaAssetFor(entry: NodeGenerationHistoryEntry, payload: NodeHistoryMediaPayload): StoredAsset {
  return {
    id: mediaAssetIdFor(entry, payload),
    title: entry.source.label,
    mediaKind: payload.kind,
    source: "generated",
    status: "ready",
    createdAt: entry.createdAt,
    url: `/api/media/${payload.storageKey}`,
    ...(payload.durationSeconds !== undefined ? { durationSeconds: payload.durationSeconds } : {}),
    provenance: historyProvenance({
      taskNodeId: entry.nodeId,
      taskKind: `${payload.kind}-generation`,
      outputIndex: 0,
      ...(entry.source.runId ? { runId: entry.source.runId } : {})
    }),
    metadata: {
      storageKey: payload.storageKey,
      checksum: payload.checksum,
      contentType: payload.contentType,
      size: payload.size,
      ...(payload.fps !== undefined ? { fps: payload.fps } : {}),
      ...(payload.motion ? { motion: { ...payload.motion } } : {})
    }
  };
}

export function posterAssetFor(
  entry: NodeGenerationHistoryEntry,
  poster: NonNullable<NodeHistoryMediaPayload["poster"]>
): StoredAsset {
  return {
    id: `ngh-asset-${entry.entryId}-poster`,
    title: "视频海报",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    createdAt: entry.createdAt,
    url: `/api/media/${poster.storageKey}`,
    provenance: historyProvenance({
      taskNodeId: entry.nodeId,
      taskKind: "video-generation",
      outputIndex: 1,
      ...(entry.source.runId ? { runId: entry.source.runId } : {})
    }),
    metadata: {
      storageKey: poster.storageKey,
      checksum: poster.checksum,
      contentType: poster.contentType,
      size: poster.size
    }
  };
}

/** 文本历史用稳定 text asset（正文在 asset.text，不需要媒体对象）。 */
export function textAssetFor(entry: { entryId: string; nodeId: string; source: { runId?: string } }, text: string): StoredAsset {
  return {
    id: `ngh-text-${entry.entryId}`,
    title: "历史文本",
    mediaKind: "text",
    source: "generated",
    status: "ready",
    createdAt: new Date(0).toISOString(),
    // 文本恢复同样产出资产，补同样的溯源（change: l0-generation-provenance）。
    provenance: historyProvenance({
      taskNodeId: entry.nodeId,
      taskKind: "text-generation",
      ...(entry.source.runId ? { runId: entry.source.runId } : {})
    }),
    text
  };
}
