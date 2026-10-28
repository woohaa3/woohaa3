/**
 * 内存节点历史仓库（测试/无后端部署）
 * （change: add-canvas-node-generation-history，任务 1.2）。
 *
 * 与 SQLite adapter 共享同一套语义（稳定去重键、`(createdAt, entryId)` 倒序、
 * cursor 排他、画布/节点删除生命周期、容量统计），便于 contract 一致性断言。
 */
import type { NodeGenerationHistoryEntry, NodeHistoryKindCounts } from "@woohaa3/contracts";
import { emptyNodeHistoryKindCounts } from "@woohaa3/contracts";
import {
  nodeHistoryEntryBytes,
  type NodeHistoryCanvasStats,
  type NodeHistoryIndexRow,
  type NodeHistoryInsertManyResult,
  type NodeHistoryInsertResult,
  type NodeHistoryCanvasListInput,
  type NodeHistoryListInput,
  type NodeHistoryListResult,
  type NodeHistoryRepository
} from "./node-history-contracts.js";

export class InMemoryNodeHistoryRepository implements NodeHistoryRepository {
  /** canvasId → (entryId → entry)。 */
  private readonly entries = new Map<string, Map<string, NodeGenerationHistoryEntry>>();

  async insert(entry: NodeGenerationHistoryEntry): Promise<NodeHistoryInsertResult> {
    const byCanvas = this.entries.get(entry.canvasId) ?? new Map<string, NodeGenerationHistoryEntry>();
    const existing = byCanvas.get(entry.entryId);
    if (existing) return { status: "duplicate", entry: clone(existing) };
    byCanvas.set(entry.entryId, clone(entry));
    this.entries.set(entry.canvasId, byCanvas);
    return { status: "inserted", entry: clone(entry) };
  }

  /**
   * 单事务批量幂等登记（内存实现与 SQLite 同一语义）。
   *
   * 先完成全部判定与克隆，再一次性提交；中途异常不会留下部分插入。
   */
  async insertMany(entries: readonly NodeGenerationHistoryEntry[]): Promise<NodeHistoryInsertManyResult> {
    const insertedIds: string[] = [];
    const duplicateIds: string[] = [];
    const pending = new Map<string, Map<string, NodeGenerationHistoryEntry>>();
    for (const entry of entries) {
      const byCanvas = pending.get(entry.canvasId) ?? new Map(this.entries.get(entry.canvasId) ?? []);
      if (byCanvas.has(entry.entryId)) {
        duplicateIds.push(entry.entryId);
        continue;
      }
      // 克隆在此抛错（不可序列化 payload）时整个批次不提交。
      byCanvas.set(entry.entryId, clone(entry));
      pending.set(entry.canvasId, byCanvas);
      insertedIds.push(entry.entryId);
    }
    for (const [canvasId, byCanvas] of pending) {
      this.entries.set(canvasId, byCanvas);
    }
    return { insertedIds, duplicateIds };
  }

  async get(canvasId: string, nodeId: string, entryId: string): Promise<NodeGenerationHistoryEntry | null> {
    const entry = this.entries.get(canvasId)?.get(entryId);
    if (!entry || entry.nodeId !== nodeId) return null;
    return clone(entry);
  }

  async markUnrecoverable(canvasId: string, nodeId: string, entryId: string): Promise<void> {
    const byCanvas = this.entries.get(canvasId);
    const entry = byCanvas?.get(entryId);
    if (!byCanvas || !entry || entry.nodeId !== nodeId) return;
    byCanvas.set(entryId, { ...entry, recoverable: false, previewable: false });
  }

  async list(input: NodeHistoryListInput): Promise<NodeHistoryListResult> {
    const all = [...(this.entries.get(input.canvasId)?.values() ?? [])]
      .filter((entry) => entry.nodeId === input.nodeId)
      .sort(compareNewestFirst);
    const filtered = input.cursor ? all.filter((entry) => afterCursor(entry, input.cursor!)) : all;
    const page = filtered.slice(0, input.limit);
    const next = page.length < filtered.length ? page[page.length - 1] : null;
    return {
      items: page.map(clone),
      nextCursor: next ? { createdAt: next.createdAt, entryId: next.entryId } : null,
      total: all.length
    };
  }

  async listCanvas(input: NodeHistoryCanvasListInput): Promise<NodeHistoryListResult> {
    const all = [...(this.entries.get(input.canvasId)?.values() ?? [])]
      .filter((entry) => (input.kind === undefined || entry.kind === input.kind) && (!input.summary || !input.summaryNodeId || entry.nodeId === input.summaryNodeId))
      .sort(compareNewestFirst);
    if (input.summary) {
      const counts = new Map<string, number>();
      const failures = new Set<string>(), currents = new Set<string>();
      const items = all.filter(entry => {
        const count = counts.get(entry.nodeId) ?? 0; counts.set(entry.nodeId, count + 1);
        const failure = entry.payload.kind === "failure" && entry.payload.outcome === "failed" && !failures.has(entry.nodeId);
        const current = entry.payload.kind !== "failure" && entry.currentIdentity === input.currentIdentities?.[entry.nodeId] && !currents.has(entry.nodeId);
        if (failure) failures.add(entry.nodeId);
        if (current) currents.add(entry.nodeId);
        return count < 24 || failure || current;
      }).map(clone);
      return { items, nextCursor: null, total: items.length };
    }
    const filtered = input.cursor ? all.filter((entry) => afterCursor(entry, input.cursor!)) : all;
    const page = filtered.slice(0, input.limit);
    const next = page.length < filtered.length ? page[page.length - 1] : null;
    return {
      items: page.map(clone),
      nextCursor: next ? { createdAt: next.createdAt, entryId: next.entryId } : null,
      total: all.length
    };
  }

  async canvasKindCounts(canvasId: string): Promise<NodeHistoryKindCounts> {
    const counts = emptyNodeHistoryKindCounts();
    for (const entry of this.entries.get(canvasId)?.values() ?? []) {
      counts[entry.kind] += 1;
    }
    return counts;
  }

  async listForNode(canvasId: string, nodeId: string): Promise<NodeGenerationHistoryEntry[]> {
    return [...(this.entries.get(canvasId)?.values() ?? [])]
      .filter((entry) => entry.nodeId === nodeId)
      .sort(compareNewestFirst)
      .map(clone);
  }

  async listCanvasIndex(canvasId: string): Promise<NodeHistoryIndexRow[]> {
    return [...(this.entries.get(canvasId)?.values() ?? [])]
      .sort(compareOldestFirst)
      .map((entry) => ({
        entryId: entry.entryId,
        canvasId: entry.canvasId,
        nodeId: entry.nodeId,
        createdAt: entry.createdAt,
        currentIdentity: entry.currentIdentity,
        bytes: nodeHistoryEntryBytes(entry)
      }));
  }

  async canvasStats(canvasId: string): Promise<NodeHistoryCanvasStats> {
    let count = 0;
    let bytes = 0;
    for (const entry of this.entries.get(canvasId)?.values() ?? []) {
      count += 1;
      bytes += nodeHistoryEntryBytes(entry);
    }
    return { count, bytes };
  }

  async delete(canvasId: string, entryIds: readonly string[]): Promise<void> {
    const byCanvas = this.entries.get(canvasId);
    if (!byCanvas) return;
    for (const entryId of entryIds) byCanvas.delete(entryId);
    if (byCanvas.size === 0) this.entries.delete(canvasId);
  }

  async deleteNode(canvasId: string, nodeId: string): Promise<void> {
    const byCanvas = this.entries.get(canvasId);
    if (!byCanvas) return;
    for (const [entryId, entry] of [...byCanvas]) {
      if (entry.nodeId === nodeId) byCanvas.delete(entryId);
    }
    if (byCanvas.size === 0) this.entries.delete(canvasId);
  }

  async deleteCanvas(canvasId: string): Promise<void> {
    this.entries.delete(canvasId);
  }

  async health(): Promise<{ ok: boolean; backend: string }> {
    return { ok: true, backend: "memory" };
  }
}

/** 倒序：createdAt 降序，再 entryId 降序（稳定次级键）。 */
function compareNewestFirst(a: NodeGenerationHistoryEntry, b: NodeGenerationHistoryEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.entryId < b.entryId ? 1 : a.entryId > b.entryId ? -1 : 0;
}

/** 升序：createdAt 升序，再 entryId 升序（容量清理最旧优先）。 */
function compareOldestFirst(a: NodeGenerationHistoryEntry, b: NodeGenerationHistoryEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

/** cursor 排他：只保留严格排在 cursor 之后的条目（倒序语义）。 */
function afterCursor(
  entry: { createdAt: string; entryId: string },
  cursor: { createdAt: string; entryId: string }
): boolean {
  if (entry.createdAt !== cursor.createdAt) return entry.createdAt < cursor.createdAt;
  return entry.entryId < cursor.entryId;
}

function clone(entry: NodeGenerationHistoryEntry): NodeGenerationHistoryEntry {
  return JSON.parse(JSON.stringify(entry)) as NodeGenerationHistoryEntry;
}
