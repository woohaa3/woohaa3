/**
 * 节点生成历史服务：登记 payload 构造
 * （自 `node-history-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R02）。
 */
import {
  encodeNodeGenerationIdentity,
  modelContentIdentity,
  modelPlacementSnapshotKey,
  nodeHistoryContentIdentity,
  nodeHistoryEntryId,
  type NodeGenerationHistoryEntry,
  type NodeHistoryFailurePayload,
  type NodeHistoryMediaPayload,
  type NodeHistoryModelPayload,
  type NodeHistorySourceSummary,
  type NodeHistoryTextPayload,
  type StoredAsset
} from "@woohaa3/contracts";
import type { RegisterModelEditInput, RegisterTaskFailureInput } from "./types.js";

export function kindLabel(kind: "image" | "video" | "audio"): string {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}

export function mediaPayload(output: {
  mediaKind: "image" | "video" | "audio";
  asset: StoredAsset;
  posterAsset?: StoredAsset;
  durationSeconds?: number;
}): NodeHistoryMediaPayload {
  const metadata = output.asset.metadata as { storageKey?: unknown; checksum?: unknown; contentType?: unknown; size?: unknown } | undefined;
  const posterMetadata = output.posterAsset?.metadata as { storageKey?: unknown; checksum?: unknown; contentType?: unknown; size?: unknown } | undefined;
  return {
    kind: output.mediaKind,
    storageKey: String(metadata?.storageKey ?? ""),
    checksum: String(metadata?.checksum ?? ""),
    contentType: String(metadata?.contentType ?? "application/octet-stream"),
    size: typeof metadata?.size === "number" ? metadata.size : 0,
    ...(output.durationSeconds !== undefined ? { durationSeconds: output.durationSeconds } : {}),
    ...(output.posterAsset && posterMetadata
      ? {
          poster: {
            storageKey: String(posterMetadata.storageKey ?? ""),
            checksum: String(posterMetadata.checksum ?? ""),
            contentType: String(posterMetadata.contentType ?? "image/png"),
            size: typeof posterMetadata.size === "number" ? posterMetadata.size : 0
          }
        }
      : {})
  };
}

/**
 * 任务来源摘要（列表卡片的安全 metadata）。
 *
 * 溯源身份三个字段各自独立，不能互相顶替（change: l0-generation-provenance）：
 * - `runId`：画布侧 run（nodeData.activeRunId / job.runId 同一身份）；
 * - `taskKey`：Task worker key（run-service 由 runId 派生，通常与 runId 相同；单独保留是
 *   因为 `providerTaskId` 历史上填的是 canvas jobId，语义容易误读，溯源一律以本字段为准）；
 * - `modelId`：该次执行使用的模型身份（取自 Task 记录的 modelKey）。
 *
 * 缺失即不写，绝不按当前画布状态反填（历史版本必须描述**当时**那次执行）。
 */
export function taskHistorySource(input: {
  kind: "text" | "image" | "video" | "audio";
  runId: string;
  taskKey?: string;
  modelId?: string;
  jobId?: string;
  payload: NodeHistoryTextPayload | NodeHistoryMediaPayload;
}): NodeHistorySourceSummary {
  return {
    label: input.kind === "text" ? "文本生成" : `${kindLabel(input.kind)}生成`,
    runId: input.runId,
    ...(input.taskKey ? { taskKey: input.taskKey } : {}),
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.jobId ? { providerTaskId: input.jobId } : {}),
    ...(input.payload.kind !== "text" && input.payload.durationSeconds !== undefined
      ? { durationSeconds: input.payload.durationSeconds }
      : {})
  };
}

/**
 * 由失败/取消/中断操作构造一条不可恢复归档条目
 * （change: 2026-10-12-unify-generation-history-strip，design D3）。
 *
 * 保留提交时基线内容引用（用于“恢复执行前内容”）、安全输入摘要与失败详情；不伪造产物，
 * 条目强制 `recoverable: false`、`previewable: false`，`currentIdentity` 置为基线 identity
 * （不参与当前判定，因为失败记录不会成为 recoverable 的成功版本）。
 */
export function buildTaskFailureEntry(input: RegisterTaskFailureInput): NodeGenerationHistoryEntry {
  const identity = { kind: "task-run-failure" as const, runId: input.runId };
  const payload: NodeHistoryFailurePayload = {
    kind: "failure",
    outcome: input.outcome,
    failureKind: input.kind,
    message: input.message,
    ...(input.code ? { code: input.code } : {}),
    baseline: input.baseline
      ? {
          identity: input.baseline.identity,
          nodeType: input.baseline.nodeType,
          ...(input.baseline.entryId ? { entryId: input.baseline.entryId } : {}),
          ...(input.baseline.outputAssetId ? { outputAssetId: input.baseline.outputAssetId } : {})
        }
      : null,
    inputSummary: input.inputSummary
  };
  return {
    version: "woohaa-node-generation-history-v1",
    entryId: nodeHistoryEntryId({ canvasId: input.canvasId, nodeId: input.nodeId, identity }),
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    kind: input.kind,
    createdAt: input.createdAt,
    outcome: input.outcome,
    sourceIdentity: encodeNodeGenerationIdentity(identity),
    // 失败记录的 currentIdentity 只承载基线引用，不参与当前判定。
    currentIdentity: input.baseline?.identity ?? `failure:${input.runId}`,
    recoverable: false,
    previewable: false,
    source: {
      label: input.kind === "text" ? "文本生成" : `${kindLabel(input.kind === "model" ? "image" : input.kind)}生成`,
      runId: input.runId,
      // 失败归档同样填全溯源身份：失败也对应一次具体的 Task 调用与模型。
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      ...(input.modelKey ? { modelId: input.modelKey } : {}),
      ...(input.jobId ? { providerTaskId: input.jobId } : {})
    },
    payload
  };
}

/** 由登记输入构造一条文本/媒体历史条目。 */
export function buildTaskHistoryEntry(input: {
  canvasId: string;
  nodeId: string;
  runId: string;
  /** Task worker key；旧调用方缺失时只在 source 里省略，不伪造。 */
  taskKey?: string;
  /** 该次执行使用的模型身份；写入 source.modelId。 */
  modelKey?: string;
  jobId?: string;
  kind: "text" | "image" | "video" | "audio";
  createdAt: string;
  payload: NodeHistoryTextPayload | NodeHistoryMediaPayload;
}): NodeGenerationHistoryEntry {
  const identity = { kind: "task-run" as const, runId: input.runId };
  return {
    version: "woohaa-node-generation-history-v1",
    entryId: nodeHistoryEntryId({ canvasId: input.canvasId, nodeId: input.nodeId, identity }),
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    kind: input.kind,
    createdAt: input.createdAt,
    sourceIdentity: encodeNodeGenerationIdentity(identity),
    currentIdentity: nodeHistoryContentIdentity(input.payload),
    recoverable: true,
    previewable: true,
    source: taskHistorySource({
      kind: input.kind,
      runId: input.runId,
      ...(input.taskKey ? { taskKey: input.taskKey } : {}),
      ...(input.modelKey ? { modelId: input.modelKey } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
      payload: input.payload
    }),
    payload: input.payload
  };
}

/** 由模型登记输入构造一条模型历史条目。 */
export function buildModelHistoryEntry(input: {
  canvasId: string;
  nodeId: string;
  sourceHash: string;
  modelScript: string;
  language: string;
  version: string;
  createdAt: string;
  placement?: NodeHistoryModelPayload["placement"];
}): NodeGenerationHistoryEntry {
  const identity = { kind: "model-source" as const, sourceHash: input.sourceHash };
  const entryId = nodeHistoryEntryId({ canvasId: input.canvasId, nodeId: input.nodeId, identity });
  const payload: NodeHistoryModelPayload = {
    kind: "model",
    modelScript: input.modelScript,
    language: input.language,
    version: input.version,
    sourceHash: input.sourceHash,
    ...(input.placement ? { placement: input.placement } : {})
  };
  return {
    version: "woohaa-node-generation-history-v1",
    entryId,
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    kind: "model",
    createdAt: input.createdAt,
    sourceIdentity: encodeNodeGenerationIdentity(identity),
    currentIdentity: modelContentIdentity(input.sourceHash, input.placement),
    recoverable: true,
    previewable: true,
    source: { label: "模型脚本", sourceHash: input.sourceHash },
    payload
  };
}

/**
 * 构造（不插入）一条模型编辑版本条目
 * （change: 图片聚焦编辑，design D5/D6 的固定 snapshot outbox 复用）。
 */
export function buildModelEditEntry(input: RegisterModelEditInput): NodeGenerationHistoryEntry {
  const identity = {
    kind: "model-edit" as const,
    sourceHash: input.sourceHash,
    snapshotKey: modelPlacementSnapshotKey(input.placement)
  };
  const entryId = nodeHistoryEntryId({ canvasId: input.canvasId, nodeId: input.nodeId, identity });
  return {
    version: "woohaa-node-generation-history-v1",
    entryId,
    canvasId: input.canvasId,
    nodeId: input.nodeId,
    kind: "model",
    createdAt: input.createdAt,
    sourceIdentity: encodeNodeGenerationIdentity(identity),
    // 内容寻址：脚本 + 摆放快照。
    currentIdentity: modelContentIdentity(input.sourceHash, input.placement),
    recoverable: true,
    previewable: true,
    source: { label: "模型编辑", sourceHash: input.sourceHash },
    payload: {
      kind: "model",
      modelScript: input.modelScript,
      language: input.language,
      version: input.version,
      sourceHash: input.sourceHash,
      placement: input.placement,
    } satisfies NodeHistoryModelPayload
  };
}
