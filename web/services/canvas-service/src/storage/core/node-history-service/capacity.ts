/**
 * 节点生成历史服务：确定性容量清理与删除回收
 * （自 `node-history-service.ts` 拆出，change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，R02）。
 *
 * 只依赖受控 `NodeHistoryServiceContext`；db/transaction 仍由 repository owner 管理。
 */
import { NODE_HISTORY_LIMITS, type NodeGenerationHistoryEntry } from "@woohaa3/contracts";
import type { NodeHistoryServiceContext } from "./types.js";

function compareOldest(a: NodeGenerationHistoryEntry, b: NodeGenerationHistoryEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

/** 节点删除：清理该节点全部历史。 */
export async function deleteNodeHistory(context: NodeHistoryServiceContext, canvasId: string, nodeId: string): Promise<void> {
  await context.repository.deleteNode(canvasId, nodeId);
}

/** 画布删除：清理该画布全部历史。 */
export async function deleteCanvasHistory(context: NodeHistoryServiceContext, canvasId: string): Promise<void> {
  await context.repository.deleteCanvas(canvasId);
}

/**
 * 确定性容量清理。
 *
 * 单节点：超过版本上限时按最旧优先删除，**保护**当前生效版本。
 * 画布：超过记录/字节预算时按最旧优先删除，保护当前生效版本（按节点 currentIdentity 判定）。
 */
export async function enforceCapacity(
  context: NodeHistoryServiceContext,
  readCurrentIdentity: (canvasId: string, nodeId: string) => Promise<string | null>,
  canvasId: string,
  nodeId?: string
): Promise<void> {
  if (nodeId) {
    const entries = await context.repository.listForNode(canvasId, nodeId);
    if (entries.length > NODE_HISTORY_LIMITS.maxVersionsPerNode) {
      const currentIdentity = await readCurrentIdentity(canvasId, nodeId);
      const removable = entries
        .filter((entry) => currentIdentity === null || entry.currentIdentity !== currentIdentity)
        .slice()
        .sort(compareOldest)
        .slice(0, entries.length - NODE_HISTORY_LIMITS.maxVersionsPerNode);
      if (removable.length > 0) await context.repository.delete(canvasId, removable.map((entry) => entry.entryId));
    }
  }
  const stats = await context.repository.canvasStats(canvasId);
  if (stats.count <= NODE_HISTORY_LIMITS.maxEntriesPerCanvas && stats.bytes <= NODE_HISTORY_LIMITS.maxBytesPerCanvas) {
    return;
  }
  const index = await context.repository.listCanvasIndex(canvasId);
  const protectedIdentities = new Map<string, string | null>();
  const removable: string[] = [];
  let count = stats.count;
  let bytes = stats.bytes;
  for (const row of index) {
    if (count <= NODE_HISTORY_LIMITS.maxEntriesPerCanvas && bytes <= NODE_HISTORY_LIMITS.maxBytesPerCanvas) break;
    if (!protectedIdentities.has(row.nodeId)) {
      protectedIdentities.set(row.nodeId, await readCurrentIdentity(canvasId, row.nodeId));
    }
    const currentIdentity = protectedIdentities.get(row.nodeId) ?? null;
    if (currentIdentity !== null && row.currentIdentity === currentIdentity) continue;
    removable.push(row.entryId);
    count -= 1;
    bytes -= row.bytes;
  }
  if (removable.length > 0) {
    context.log({ event: "node-history-evicted", canvasId, count: removable.length });
    await context.repository.delete(canvasId, removable);
  }
}
