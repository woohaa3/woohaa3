/**
 * 内存编辑完成回执 repository（测试/无后端部署）
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 2.1）。
 *
 * 与 SQLite adapter 共享同一套语义（幂等 upsert、按状态扫描、节点/画布删除生命周期）。
 */
import type { EditCompletionStatus } from "@woohaa3/contracts";
import type { EditCompletionRecord, EditCompletionRepository } from "./edit-completion-contracts.js";

export class InMemoryEditCompletionRepository implements EditCompletionRepository {
  /** completionKey → record。 */
  private readonly records = new Map<string, EditCompletionRecord>();

  async get(canvasId: string, nodeId: string, requestId: string): Promise<EditCompletionRecord | null> {
    const record = this.records.get(key(canvasId, nodeId, requestId));
    return record ? clone(record) : null;
  }

  async put(record: EditCompletionRecord): Promise<void> {
    this.records.set(key(record.canvasId, record.nodeId, record.requestId), clone(record));
  }

  async listByStatus(status: EditCompletionStatus, limit: number): Promise<EditCompletionRecord[]> {
    const all = [...this.records.values()]
      .filter((record) => record.status === status)
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0));
    return all.slice(0, Math.max(0, limit)).map(clone);
  }

  async listPreparedImages(limit: number): Promise<EditCompletionRecord[]> {
    return [...this.records.values()].filter((record) => record.status === "prepared" && record.kind === "image" && record.pendingEntries.length > 0)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, Math.max(0, limit)).map(clone);
  }

  async listByNode(canvasId: string, nodeId: string): Promise<EditCompletionRecord[]> {
    return [...this.records.values()]
      .filter((record) => record.canvasId === canvasId && record.nodeId === nodeId)
      .map(clone);
  }

  async delete(canvasId: string, nodeId: string, requestId: string): Promise<void> {
    this.records.delete(key(canvasId, nodeId, requestId));
  }

  async deleteNode(canvasId: string, nodeId: string): Promise<void> {
    for (const [recordKey, record] of [...this.records]) {
      if (record.canvasId === canvasId && record.nodeId === nodeId) this.records.delete(recordKey);
    }
  }

  async deleteCanvas(canvasId: string): Promise<void> {
    for (const [recordKey, record] of [...this.records]) {
      if (record.canvasId === canvasId) this.records.delete(recordKey);
    }
  }

  async health(): Promise<{ ok: boolean; backend: string }> {
    return { ok: true, backend: "memory" };
  }
}

function key(canvasId: string, nodeId: string, requestId: string): string {
  return `${canvasId}\u0000${nodeId}\u0000${requestId}`;
}

function clone(record: EditCompletionRecord): EditCompletionRecord {
  return JSON.parse(JSON.stringify(record)) as EditCompletionRecord;
}
