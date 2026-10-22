/**
 * 编辑完成服务：图片结算
 * （自 `edit-completion-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R13）。
 */
import {
  editCompletePayloadFingerprint,
  encodeNodeGenerationIdentity,
  imageEditDefinitionHash,
  imageEditShapesHash,
  imageEditShapesOf,
  imageEditSnapshotKey,
  imageProjectSnapshotKey,
  isImageProjectDocument,
  nodeHistoryContentIdentity,
  nodeHistoryEntryId,
  type ImageEditCompleteRequest,
  type NodeGenerationHistoryEntry,
  type NodeHistoryImageEditBaseMetadata,
  type NodeHistoryMediaPayload
} from "@woohaa3/contracts";
import { YJS_SYNC_PROTOCOL_VERSION } from "@woohaa3/contracts";
import type { EditCompletionRecord } from "../edit-completion-contracts.js";
import type { EditCompletionContext, EditCompletionResult } from "./types.js";
import {
  baseChecksumFor,
  baseContentTypeFor,
  baseSizeFor,
  buildImageEditCommands,
  currentIdentityOfNode,
  existingCreatedAt,
  imageEditContentIdentityOf,
  isActiveGeneration,
  toReceipt
} from "./helpers.js";
import { publishPending, recordFailure } from "./outbox.js";

/** 图片 complete：提交最终编辑版本。 */
export async function completeImage(ctx: EditCompletionContext, request: ImageEditCompleteRequest): Promise<EditCompletionResult> {
  const fingerprint = editCompletePayloadFingerprint(request);
  const room = await ctx.resolveRoom(request.canvasId);
  if (!room) return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_TARGET_INVALID", `画布 ${request.canvasId} 不存在`);
  const exported = room.exportCanvas();
  if (!exported.ok) return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_TARGET_INVALID", exported.message);
  const canvas = exported.canvas;
  const node = canvas.document.nodes.find((candidate) => candidate.id === request.nodeId);
  if (!node) return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_TARGET_INVALID", `节点 ${request.nodeId} 不存在`);
  if (node.type !== "image") return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_TARGET_INVALID", "目标不是图片节点");
  const data = canvas.nodeData[request.nodeId] as Record<string, unknown> | undefined;
  if (isActiveGeneration(data)) {
    return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_GENERATION_ACTIVE", "节点存在进行中的生成，无法提交编辑");
  }

  const currentIdentity = currentIdentityOfNode(canvas, request.nodeId, "image");
  const baselineEntry = await ctx.completions.get(request.canvasId, request.nodeId, `begin:${request.sessionId}`);
  const expectedBaseline = baselineEntry?.baselineContentIdentity ?? request.baselineContentIdentity;
  if (currentIdentity !== null && currentIdentity !== expectedBaseline) {
    return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_BASELINE_STALE", "节点内容已被其它写入改变，无法提交编辑", true);
  }

  if (ctx.mediaVerifier) {
    // 远端画布的编辑产物只在托管存储里：不带画布作用域会误判为「不可解析」。
    const baseOk = await existsSafe(ctx, request.media.baseStorageKey, request.canvasId);
    const outputOk = await existsSafe(ctx, request.media.outputStorageKey, request.canvasId);
    if (!baseOk || !outputOk) {
      return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_MEDIA_UNRESOLVABLE", "编辑媒体对象不可解析");
    }
    // 工程分支：工程对象也是恢复所必需的对象；配对不可解析时整次提交失败
    // （change: 2026-10-16-integrate-photocraft-image-editing，design D6）。
    if (request.media.project) {
      const projectOk = await existsSafe(ctx, request.media.project.storageKey, request.canvasId);
      if (!projectOk) {
        return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_MEDIA_UNRESOLVABLE", "工程对象不可解析，无法提交编辑");
      }
    }
  }

  const built = buildImageEditCommands(request);
  if (!built.ok) return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_INVALID", built.message);

  const contentIdentity = imageEditContentIdentityOf(request);
  const timestamp = ctx.now();
  const previous = await ctx.completions.get(request.canvasId, request.nodeId, request.requestId);
  // 在提交画布之前持久化固定历史，进程即使在两次写入之间中断也能按 commandId 对账。
  const pendingEntries = previous?.pendingEntries.length ? previous.pendingEntries : await buildImagePendingEntries(ctx, request);
  const finalEntry = pendingEntries[pendingEntries.length - 1];
  await ctx.completions.put({
    canvasId: request.canvasId,
    nodeId: request.nodeId,
    sessionId: request.sessionId,
    requestId: request.requestId,
    kind: "image",
    payloadFingerprint: fingerprint,
    baselineContentIdentity: expectedBaseline,
    status: "prepared",
    contentIdentity,
    entryId: finalEntry?.entryId ?? null,
    revision: canvas.revision,
    contentCommitted: false,
    pendingEntries,
    createdAt: existingCreatedAt(await ctx.completions.get(request.canvasId, request.nodeId, request.requestId), timestamp),
    updatedAt: timestamp
  });

  const submitted = await room.submit({
    protocolVersion: YJS_SYNC_PROTOCOL_VERSION,
    canvasId: request.canvasId,
    commandId: `edit-complete:${request.requestId}`,
    baseRevision: canvas.revision,
    actorId: "canvas-edit-completion",
    commands: built.commands
  });
  if (!submitted.ok) {
    return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_CONFLICT", submitted.message, true);
  }

  const pendingRecord: EditCompletionRecord = {
    canvasId: request.canvasId,
    nodeId: request.nodeId,
    sessionId: request.sessionId,
    requestId: request.requestId,
    kind: "image",
    payloadFingerprint: fingerprint,
    baselineContentIdentity: expectedBaseline,
    status: "history-pending",
    contentIdentity,
    entryId: finalEntry?.entryId ?? null,
    revision: submitted.revision,
    contentCommitted: true,
    pendingEntries,
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await ctx.completions.put(pendingRecord);
  await publishPending(ctx, pendingRecord);
  const finalRecord = (await ctx.completions.get(request.canvasId, request.nodeId, request.requestId)) ?? pendingRecord;
  return { ok: true, receipt: toReceipt(finalRecord) };
}

async function buildImagePendingEntries(ctx: EditCompletionContext, request: ImageEditCompleteRequest): Promise<NodeGenerationHistoryEntry[]> {
  const timestamp = ctx.now();
  const base = request.media.imageEdit
    ? {
        baseAssetId: request.media.baseAssetId,
        storageKey: request.media.baseStorageKey,
        checksum: baseChecksumFor(request),
        contentType: baseContentTypeFor(request),
        size: baseSizeFor(request),
        sourceWidth: request.media.sourceWidth,
        sourceHeight: request.media.sourceHeight
      } satisfies NodeHistoryImageEditBaseMetadata
    : null;

  const existing = await ctx.publisher.listEntriesForNode(request.canvasId, request.nodeId);
  const entries: NodeGenerationHistoryEntry[] = [];

  const hasBaseline = existing.some(
    (entry) =>
      (entry.kind === "image" && entry.sourceIdentity.startsWith("image-baseline:")) ||
      (entry.kind === "image" && !(entry.payload as NodeHistoryMediaPayload).imageEdit)
  );
  if (!hasBaseline) {
    const baselineIdentity = { kind: "image-baseline" as const, baseStorageKey: request.media.baseStorageKey };
    const payload: NodeHistoryMediaPayload = {
      kind: "image",
      storageKey: request.media.baseStorageKey,
      checksum: baseChecksumFor(request),
      contentType: baseContentTypeFor(request),
      size: baseSizeFor(request)
    };
    entries.push({
      version: "woohaa-node-generation-history-v1",
      entryId: nodeHistoryEntryId({ canvasId: request.canvasId, nodeId: request.nodeId, identity: baselineIdentity }),
      canvasId: request.canvasId,
      nodeId: request.nodeId,
      kind: "image",
      createdAt: timestamp,
      sourceIdentity: encodeNodeGenerationIdentity(baselineIdentity),
      currentIdentity: nodeHistoryContentIdentity(payload),
      recoverable: true,
      previewable: true,
      source: { label: "上传原图" },
      payload
    });
  }

  const isProject = request.media.imageEdit !== undefined && isImageProjectDocument(request.media.imageEdit);
  const editIdentity = isProject
    ? {
        kind: "image-project" as const,
        baseStorageKey: request.media.baseStorageKey,
        // 工程去重键由 base、定义身份（引擎/格式/内容 hash）与输出派生：同内容重试命中同一 identity。
        projectKey: imageProjectSnapshotKey({
          baseStorageKey: request.media.baseStorageKey,
          definitionHash: imageEditDefinitionHash(request.media.imageEdit!),
          outputStorageKey: request.media.outputStorageKey
        })
      }
    : {
        kind: "image-edit" as const,
        baseStorageKey: request.media.baseStorageKey,
        editKey: imageEditSnapshotKey({
          baseStorageKey: request.media.baseStorageKey,
          sourceWidth: request.media.sourceWidth,
          sourceHeight: request.media.sourceHeight,
          shapesHash: imageEditShapesHash({ shapes: request.media.imageEdit ? imageEditShapesOf(request.media.imageEdit) : [] }),
          outputStorageKey: request.media.outputStorageKey
        })
      };
  const editPayload: NodeHistoryMediaPayload = {
    kind: "image",
    storageKey: request.media.outputStorageKey,
    checksum: request.media.checksum,
    contentType: request.media.contentType,
    size: request.media.size,
    ...(base ? { base } : {}),
    ...(request.media.imageEdit ? { imageEdit: request.media.imageEdit } : {}),
    ...(request.media.project ? { project: request.media.project } : {})
  };
  entries.push({
    version: "woohaa-node-generation-history-v1",
    entryId: nodeHistoryEntryId({ canvasId: request.canvasId, nodeId: request.nodeId, identity: editIdentity }),
    canvasId: request.canvasId,
    nodeId: request.nodeId,
    kind: "image",
    createdAt: timestamp,
    sourceIdentity: encodeNodeGenerationIdentity(editIdentity),
    currentIdentity: nodeHistoryContentIdentity(editPayload),
    recoverable: true,
    previewable: true,
    source: { label: isProject ? "图像工程" : "图片编辑" },
    payload: editPayload
  });
  return entries;
}

async function existsSafe(ctx: EditCompletionContext, storageKey: string, canvasId: string): Promise<boolean> {
  try {
    return ctx.mediaVerifier ? await ctx.mediaVerifier.exists(storageKey, { canvasId }) : true;
  } catch {
    return false;
  }
}
