/** prepared 与画布 durable command 的提交结果对账，不从当前节点重建历史。 */
import type { EditCompletionRecord } from "../edit-completion-contracts.js";
import type { EditCompletionContext } from "./types.js";
import { publishPending } from "./outbox.js";

export async function recoverPrepared(ctx: EditCompletionContext, record: EditCompletionRecord): Promise<EditCompletionRecord> {
  if (record.status !== "prepared" || record.kind !== "image" || record.pendingEntries.length === 0) return record;
  const room = await ctx.resolveRoom(record.canvasId);
  const committed = await room?.lookupCommand?.(`edit-complete:${record.requestId}`);
  if (!committed) return record;
  const pending: EditCompletionRecord = { ...record, status: "history-pending", contentCommitted: true, revision: committed.revision, updatedAt: ctx.now() };
  await ctx.completions.put(pending);
  await publishPending(ctx, pending);
  return await ctx.completions.get(record.canvasId, record.nodeId, record.requestId) ?? pending;
}
