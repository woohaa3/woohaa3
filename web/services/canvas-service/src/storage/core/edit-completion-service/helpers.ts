/**
 * 编辑完成服务：共享 helper（receipt、当前身份、命令、条目构造）
 * （自 `edit-completion-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R13）。
 *
 * 辅助身份读取只复刻契约层内容身份公式，不复制 history 规则。
 */
import {
  decodeImageEditDocument,
  decodeModelPlacement,
  encodeNodeGenerationIdentity,
  hashModelScript,
  imageEditDocumentContentIdentity,
  modelContentIdentity,
  modelPlacementSnapshotKey,
  nodeHistoryEntryId,
  type CanvasCommand,
  type ImageEditCompleteRequest,
  type NodeGenerationHistoryEntry,
  type ServerCanvas,
  type StoredAsset
} from "@woohaa3/contracts";
import type { EditCompletionRecord } from "../edit-completion-contracts.js";
import type { EditCompletionResult } from "./types.js";

export function kindForNodeType(type: string): "image" | "model" | null {
  if (type === "image") return "image";
  if (type === "model3d" || type === "composite-asset") return "model";
  return null;
}

export function isActiveGeneration(data: Record<string, unknown> | undefined): boolean {
  const status = data?.taskStatus;
  return status === "pending" || status === "processing";
}

/** 节点当前图片/模型内容身份（与 node-history-service 的 currentIdentityOf 同构）。 */
export function currentIdentityOfNode(canvas: ServerCanvas, nodeId: string, kind: "image" | "model"): string | null {
  const data = canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
  if (!data) return null;
  if (kind === "model") {
    const source = typeof data.modelScript === "string" ? data.modelScript : "";
    if (source === "") return null;
    const placement = data.modelPlacement === undefined || data.modelPlacement === null
      ? undefined
      : (decodeModelPlacement(data.modelPlacement) ?? undefined);
    return modelContentIdentity(hashModelScript(source), placement);
  }
  const outputId = typeof data.outputAssetId === "string" ? data.outputAssetId : "";
  if (!outputId) return null;
  const asset = canvas.assets.find((candidate) => candidate.id === outputId);
  const storageKey = asset?.metadata && typeof (asset.metadata as { storageKey?: unknown }).storageKey === "string"
    ? (asset.metadata as { storageKey: string }).storageKey
    : "";
  const imageEdit = data.imageEdit !== undefined && data.imageEdit !== null
    ? decodeImageEditDocument(data.imageEdit)
    : null;
  if (imageEdit?.ok) {
    const baseId = imageEdit.value.baseAssetId;
    const baseAsset = canvas.assets.find((candidate) => candidate.id === baseId);
    const baseStorageKey = baseAsset?.metadata && typeof (baseAsset.metadata as { storageKey?: unknown }).storageKey === "string"
      ? (baseAsset.metadata as { storageKey: string }).storageKey
      : "";
    // 工程分支与 v1 标注分支共用同一入口，但身份公式不同（编辑扩展工作区）。
    return imageEditDocumentContentIdentity({
      document: imageEdit.value,
      baseStorageKey,
      outputStorageKey: storageKey
    });
  }
  return storageKey ? `media:${storageKey}` : null;
}

export function toReceipt(record: EditCompletionRecord) {
  return {
    requestId: record.requestId,
    sessionId: record.sessionId,
    canvasId: record.canvasId,
    nodeId: record.nodeId,
    kind: record.kind,
    status: record.status,
    contentIdentity: record.contentIdentity,
    entryId: record.entryId,
    revision: record.revision,
    contentCommitted: record.contentCommitted,
    ...(record.errorCode ? { errorCode: record.errorCode } : {}),
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {})
  };
}

export function existingCreatedAt(existing: EditCompletionRecord | null, fallback: string): string {
  return existing?.createdAt ?? fallback;
}

export function failWithReceipt(record: EditCompletionRecord, code: import("@woohaa3/contracts").EditSessionErrorCode, message: string): EditCompletionResult {
  return { ok: false, code, message, receipt: toReceipt(record) };
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.slice(0, 200);
}

export function buildImageEditCommands(request: ImageEditCompleteRequest):
  | { ok: true; commands: CanvasCommand[] }
  | { ok: false; message: string } {
  const baseAsset: StoredAsset = {
    id: request.media.baseAssetId,
    title: "编辑原图",
    mediaKind: "image",
    source: "uploaded",
    status: "ready",
    createdAt: new Date(0).toISOString(),
    url: `/api/media/${request.media.baseStorageKey}`,
    metadata: {
      storageKey: request.media.baseStorageKey,
      checksum: baseChecksumFor(request),
      contentType: baseContentTypeFor(request),
      size: baseSizeFor(request)
    }
  };
  const outputAsset: StoredAsset = {
    id: request.media.outputAssetId,
    title: "编辑结果",
    mediaKind: "image",
    source: "generated",
    status: "ready",
    createdAt: new Date(0).toISOString(),
    url: `/api/media/${request.media.outputStorageKey}`,
    metadata: {
      storageKey: request.media.outputStorageKey,
      checksum: request.media.checksum,
      contentType: request.media.contentType,
      size: request.media.size
    }
  };
  return {
    ok: true,
    commands: [
      { type: "asset.upsert", asset: baseAsset },
      { type: "asset.upsert", asset: outputAsset },
      {
        type: "nodeData.patch",
        nodeId: request.nodeId,
        value: {
          outputAssetId: outputAsset.id,
          resourceKind: "image",
          taskStatus: "successed",
          progress: 100,
          error: null,
          errorMessage: null,
          imageEdit: request.media.imageEdit ?? null
        }
      }
    ]
  };
}

export function baseChecksumFor(request: ImageEditCompleteRequest): string {
  return request.media.baseChecksum ?? request.media.checksum;
}
export function baseContentTypeFor(request: ImageEditCompleteRequest): string {
  return request.media.baseContentType ?? request.media.contentType;
}
export function baseSizeFor(request: ImageEditCompleteRequest): number {
  return request.media.baseSize ?? request.media.size;
}

export function imageEditContentIdentityOf(request: ImageEditCompleteRequest): string {
  if (!request.media.imageEdit) return `media:${request.media.outputStorageKey}`;
  return imageEditDocumentContentIdentity({
    document: request.media.imageEdit,
    baseStorageKey: request.media.baseStorageKey,
    outputStorageKey: request.media.outputStorageKey
  });
}

/** 从当前权威模型内容构造编辑版本条目（complete 只归档，不额外推进 revision）。 */
export function buildModelEditEntryFromCanvas(canvas: ServerCanvas, nodeId: string, createdAt: string): NodeGenerationHistoryEntry | null {
  const data = canvas.nodeData[nodeId] as Record<string, unknown> | undefined;
  const modelScript = typeof data?.modelScript === "string" ? data.modelScript : "";
  if (modelScript.trim() === "") return null;
  const language = typeof data?.modelScriptLanguage === "string" ? data.modelScriptLanguage : "";
  const version = typeof data?.modelScriptVersion === "string" ? data.modelScriptVersion : "";
  if (language === "" || version === "") return null;
  const placement = decodeModelPlacement(data?.modelPlacement) ?? { offset: { x: 0, y: 0, z: 0 }, scale: 1, yaw: 0 };
  const sourceHash = hashModelScript(modelScript);
  // 保留规范镜头感知的摆放快照键（不改变既有身份语义）。
  const identity = { kind: "model-edit" as const, sourceHash, snapshotKey: modelPlacementSnapshotKey(placement) };
  return {
    version: "woohaa-node-generation-history-v1",
    entryId: nodeHistoryEntryId({ canvasId: canvas.id, nodeId, identity }),
    canvasId: canvas.id,
    nodeId,
    kind: "model",
    createdAt,
    sourceIdentity: encodeNodeGenerationIdentity(identity),
    currentIdentity: modelContentIdentity(sourceHash, placement),
    recoverable: true,
    previewable: true,
    source: { label: "模型编辑", sourceHash },
    payload: {
      kind: "model",
      modelScript,
      language,
      version,
      sourceHash,
      placement,
    }
  };
}
