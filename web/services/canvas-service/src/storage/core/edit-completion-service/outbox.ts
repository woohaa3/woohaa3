/**
 * 编辑完成服务：outbox 发布与失败回执
 * （自 `edit-completion-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R13）。
 *
 * 持久化 receipt/pending publication 共用同一协调器。
 */
import type {
  EditSessionCompleteRequest,
  EditSessionErrorCode
} from "@woohaa3/contracts";
import type { EditCompletionRecord } from "../edit-completion-contracts.js";
import type { EditCompletionContext, EditCompletionResult } from "./types.js";
import { errorMessage, toReceipt } from "./helpers.js";

/** 登记一条 history-pending 记录的固定快照；全部成功后改为 completed。 */
export async function publishPending(ctx: EditCompletionContext, record: EditCompletionRecord): Promise<boolean> {
  try {
    for (const entry of record.pendingEntries) {
      await ctx.publisher.registerEntry(entry);
    }
    await ctx.completions.put({
      ...record,
      status: "completed",
      pendingEntries: [],
      updatedAt: ctx.now()
    });
    return true;
  } catch (error) {
    ctx.log({ event: "edit-completion-publish-failed", canvasId: record.canvasId, nodeId: record.nodeId, message: errorMessage(error) });
    return false;
  }
}

export async function recordFailure(
  ctx: EditCompletionContext,
  request: EditSessionCompleteRequest,
  fingerprint: string,
  code: EditSessionErrorCode,
  message: string,
  contentCommitted = false
): Promise<EditCompletionResult> {
  const timestamp = ctx.now();
  const existing = await ctx.completions.get(request.canvasId, request.nodeId, request.requestId);
  const record: EditCompletionRecord = {
    canvasId: request.canvasId,
    nodeId: request.nodeId,
    sessionId: request.sessionId,
    requestId: request.requestId,
    kind: request.kind,
    payloadFingerprint: fingerprint,
    baselineContentIdentity: request.baselineContentIdentity,
    status: "conflict",
    contentIdentity: existing?.contentIdentity ?? "",
    entryId: existing?.entryId ?? null,
    revision: existing?.revision ?? 0,
    contentCommitted: contentCommitted || (existing?.contentCommitted ?? false),
    pendingEntries: existing?.pendingEntries ?? [],
    errorCode: code,
    errorMessage: message,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp
  };
  await ctx.completions.put(record);
  return { ok: false, code, message, receipt: toReceipt(record) };
}
