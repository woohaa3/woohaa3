/**
 * 编辑完成服务：模型结算
 * （自 `edit-completion-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R13）。
 *
 * 会话内 placement/camera 已及时权威提交；complete 只归档最终快照，**不**额外推进 revision。
 */
import { editCompletePayloadFingerprint, type ModelEditCompleteRequest } from "@woohaa3/contracts";
import type { EditCompletionRecord } from "../edit-completion-contracts.js";
import type { EditCompletionContext, EditCompletionResult } from "./types.js";
import { buildModelEditEntryFromCanvas, currentIdentityOfNode, kindForNodeType, toReceipt } from "./helpers.js";
import { publishPending, recordFailure } from "./outbox.js";

export async function completeModel(ctx: EditCompletionContext, request: ModelEditCompleteRequest): Promise<EditCompletionResult> {
  const fingerprint = editCompletePayloadFingerprint(request);
  const room = await ctx.resolveRoom(request.canvasId);
  if (!room) return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_TARGET_INVALID", `画布 ${request.canvasId} 不存在`);
  const exported = room.exportCanvas();
  if (!exported.ok) return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_TARGET_INVALID", exported.message);
  const canvas = exported.canvas;
  const node = canvas.document.nodes.find((candidate) => candidate.id === request.nodeId);
  if (!node || kindForNodeType(node.type) !== "model") {
    return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_TARGET_INVALID", "目标不是模型节点");
  }
  const currentIdentity = currentIdentityOfNode(canvas, request.nodeId, "model");
  if (currentIdentity === null) return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_UNRECOVERABLE", "模型无可归档内容");

  const baseline = (await ctx.completions.get(request.canvasId, request.nodeId, `begin:${request.sessionId}`))?.baselineContentIdentity
    ?? request.baselineContentIdentity;
  // 无净变化：内容已提交但回到基线 → 不新增版本。
  if (currentIdentity === baseline) {
    const timestamp = ctx.now();
    const record: EditCompletionRecord = {
      canvasId: request.canvasId,
      nodeId: request.nodeId,
      sessionId: request.sessionId,
      requestId: request.requestId,
      kind: "model",
      payloadFingerprint: fingerprint,
      baselineContentIdentity: baseline,
      status: "completed",
      contentIdentity: currentIdentity,
      entryId: null,
      revision: canvas.revision,
      contentCommitted: true,
      pendingEntries: [],
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await ctx.completions.put(record);
    return { ok: true, receipt: toReceipt(record) };
  }

  const entry = buildModelEditEntryFromCanvas(canvas, request.nodeId, ctx.now());
  if (!entry) return recordFailure(ctx, request, fingerprint, "EDIT_SESSION_UNRECOVERABLE", "模型无可归档内容");
  const timestamp = ctx.now();
  const pending: EditCompletionRecord = {
    canvasId: request.canvasId,
    nodeId: request.nodeId,
    sessionId: request.sessionId,
    requestId: request.requestId,
    kind: "model",
    payloadFingerprint: fingerprint,
    baselineContentIdentity: baseline,
    status: "history-pending",
    contentIdentity: entry.currentIdentity,
    entryId: entry.entryId,
    revision: canvas.revision,
    contentCommitted: true,
    pendingEntries: [entry],
    createdAt: timestamp,
    updatedAt: timestamp
  };
  await ctx.completions.put(pending);
  await publishPending(ctx, pending);
  const finalRecord = (await ctx.completions.get(request.canvasId, request.nodeId, request.requestId)) ?? pending;
  return { ok: true, receipt: toReceipt(finalRecord) };
}
