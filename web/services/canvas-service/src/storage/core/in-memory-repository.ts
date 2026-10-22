/**
 * 测试专用 in-memory `CanvasRepository`（任务 2.4）。
 *
 * 它实现与 SQLite/Mongo **相同的 contract 语义**（CAS、operation 幂等、原子提交、
 * 重启后幂等记录保持），因此可以被 adapter contract suite 直接复用，用来先固定行为、
 * 再验证真实数据库实现没有漂移。刻意只用于测试：生产路径由 composition root 显式选择
 * SQLite 或 Mongo，不存在内存回退。
 *
 * 「原子性」在这里由「先全部校验、再一次性写入」保证：任一校验失败都不改变任何状态。
 */
import type { ServerCanvas } from "@woohaa3/contracts";
import { normalizeCanvasListQuery,
  type CanvasCommandCommitResult,
  type CanvasListQuery,
  type CanvasListResult,
  type CanvasOperationRecord,
  type CanvasRepository,
  type CanvasRepositoryHealth,
  type CanvasSummary,
  type CommitCanvasInput } from "./contracts.js";
import { CanvasStorageError } from "./errors.js";

type MemoryCanvasRecord = {
  canvas: ServerCanvas;
  operations: Map<string, CanvasOperationRecord>;
  createdAt: string;
};

export type InMemoryCanvasRepositoryOptions = {
  /** 注入下一次操作的失败，用于验证失败无部分写入。 */
  faults?: InMemoryCanvasRepositoryFaults;
};

/** 供 contract suite 注入故障，验证事务回滚语义。 */
export type InMemoryCanvasRepositoryFaults = {
  failNextCommit?: Error;
  failNextCreate?: Error;
  failNextDelete?: Error;
};

export class InMemoryCanvasRepository implements CanvasRepository {
  private readonly lifecycle = new Map<string, { canvasId: string; result?: ServerCanvas; revision?: number }>();
  private readonly records = new Map<string, MemoryCanvasRecord>();
  private readonly faults: InMemoryCanvasRepositoryFaults;

  constructor(options: InMemoryCanvasRepositoryOptions = {}) {
    this.faults = options.faults ?? {};
  }

  /** 测试用：注入下一次提交失败。 */
  failNextCommit(error: Error): void {
    this.faults.failNextCommit = error;
  }

  /** 测试用：注入下一次创建失败（用于验证导入/替换的恢复路径）。 */
  failNextCreate(error: Error): void {
    this.faults.failNextCreate = error;
  }

  /**
   * 幂等补行：模拟 SQLite 仓储的同名能力（从远端拉下来的画布需要一条目录行）。
   * 已存在时只刷新标题与时间，**不**覆盖 revision/内容。
   */
  async ensureCanvasRow(canvas: ServerCanvas): Promise<void> {
    const existing = this.records.get(canvas.id);
    if (existing) {
      this.records.set(canvas.id, {
        ...existing,
        canvas: { ...existing.canvas, title: canvas.title ?? "", updatedAt: canvas.updatedAt }
      });
      return;
    }
    this.records.set(canvas.id, {
      canvas,
      operations: new Map(),
      createdAt: canvas.updatedAt
    });
  }

  async createCanvas(canvas: ServerCanvas, operationId?: string): Promise<ServerCanvas> {
    const receipt = operationId ? this.lifecycle.get(`create:${operationId}`) : undefined;
    if (receipt) {
      if (receipt.canvasId !== canvas.id) throw new CanvasStorageError("CANVAS_ALREADY_EXISTS", "operationId 已绑定其他画布");
      return structuredClone(receipt.result!);
    }
    const fault = this.faults.failNextCreate;
    if (fault) {
      this.faults.failNextCreate = undefined;
      throw fault;
    }
    if (this.records.has(canvas.id)) {
      throw new CanvasStorageError("CANVAS_ALREADY_EXISTS", `画布 ${canvas.id} 已存在`);
    }
    const now = canvas.updatedAt;
    const created: ServerCanvas = { ...canvas, revision: 1, updatedAt: now };
    this.records.set(canvas.id, {
      canvas: created,
      operations: new Map(),
      createdAt: now
    });
    if (operationId) this.lifecycle.set(`create:${operationId}`, { canvasId: canvas.id, result: structuredClone(created) });
    return created;
  }

  async getCanvas(canvasId: string): Promise<ServerCanvas | null> {
    const record = this.records.get(canvasId);
    return record ? cloneCanvas(record.canvas) : null;
  }

  async getOperation(canvasId: string, operationId: string): Promise<CanvasOperationRecord | null> {
    const record = this.records.get(canvasId);
    const operation = record?.operations.get(operationId);
    return operation ? structuredClone(operation) : null;
  }

  async listOperations(canvasId: string): Promise<CanvasOperationRecord[]> {
    const record = this.records.get(canvasId);
    if (!record) return [];
    return [...record.operations.values()].map((operation) => structuredClone(operation));
  }

  async listCanvases(query?: CanvasListQuery): Promise<CanvasListResult> {
    const { offset, limit, ids } = normalizeCanvasListQuery(query);
    // 白名单先过滤再分页（任务 5.5 修正）：`total` 是被授权集合的总数。
    const allowed = ids ? new Set(ids) : null;
    const summaries = [...this.records.values()]
      .filter((record) => allowed === null || allowed.has(record.canvas.id))
      .map((record) => summarize(record))
      .sort(compareSummaries);
    return {
      items: summaries.slice(offset, offset + limit),
      total: summaries.length,
      offset,
      limit
    };
  }

  async commitCanvas(input: CommitCanvasInput): Promise<CanvasCommandCommitResult> {
    // 先做全部校验，再一次性写入 —— 保证失败无部分写入。
    const record = this.records.get(input.canvasId);
    if (!record) {
      throw new CanvasStorageError("CANVAS_NOT_FOUND", `画布 ${input.canvasId} 不存在`);
    }

    const existing = record.operations.get(input.operationId);
    if (existing) {
      return {
        canvas: cloneCanvas(existing.resultCanvas),
        revision: existing.resultRevision,
        operationId: input.operationId,
        duplicate: true
      };
    }

    if (record.canvas.revision !== input.expectedRevision) {
      throw conflict(record.canvas);
    }

    const commitFault = this.faults.failNextCommit;
    if (commitFault) {
      this.faults.failNextCommit = undefined;
      throw commitFault;
    }

    const next = cloneCanvas(input.canvas);
    // 无净变化时应用服务传入的是原画布（revision 不变）；否则已递增。
    const resultRevision = next.revision;
    const operation: CanvasOperationRecord = {
      canvasId: input.canvasId,
      operationId: input.operationId,
      baseRevision: input.expectedRevision,
      resultRevision,
      actorId: input.actorId,
      createdAt: input.now,
      resultCanvas: cloneCanvas(next)
    };
    record.operations.set(input.operationId, operation);
    record.canvas = next;

    return { canvas: cloneCanvas(next), revision: resultRevision, operationId: input.operationId, duplicate: false };
  }

  async deleteCanvas(canvasId: string, expectedRevision: number, operationId?: string): Promise<void> {
    const receipt = operationId ? this.lifecycle.get(`delete:${operationId}`) : undefined;
    if (receipt) {
      if (receipt.canvasId !== canvasId || receipt.revision !== expectedRevision) throw new CanvasStorageError("REVISION_CONFLICT", "删除回执与请求不符");
      return;
    }
    const record = this.records.get(canvasId);
    if (!record) {
      throw new CanvasStorageError("CANVAS_NOT_FOUND", `画布 ${canvasId} 不存在`);
    }
    if (record.canvas.revision !== expectedRevision) {
      throw conflict(record.canvas);
    }
    const deleteFault = this.faults.failNextDelete;
    if (deleteFault) {
      this.faults.failNextDelete = undefined;
      throw deleteFault;
    }
    // 只删结构化记录；不触碰任何 COS 对象。
    this.records.delete(canvasId);
    if (operationId) this.lifecycle.set(`delete:${operationId}`, { canvasId, revision: expectedRevision });
  }

  async health(): Promise<CanvasRepositoryHealth> {
    return { ok: true, backend: "memory" };
  }

  /** 运维恢复：按原样写回（保留 revision/updatedAt），不重置为 1。 */
  async restoreCanvas(canvas: ServerCanvas): Promise<void> {
    const existing = this.records.get(canvas.id);
    this.records.set(canvas.id, {
      canvas: structuredClone(canvas),
      operations: existing?.operations ?? new Map(),
      createdAt: existing?.createdAt ?? canvas.updatedAt
    });
  }

  /** 测试用：读取某画布的 operation 记录数。 */
  operationCount(canvasId: string): number {
    return this.records.get(canvasId)?.operations.size ?? 0;
  }
}

function summarize(record: MemoryCanvasRecord): CanvasSummary {
  const canvas = record.canvas;
  return {
    id: canvas.id,
    title: canvas.title ?? "",
    revision: canvas.revision,
    updatedAt: canvas.updatedAt,
    createdAt: record.createdAt,
    nodeCount: canvas.document.nodes.length,
    assetCount: canvas.assets.length
  };
}

/** 稳定排序：updatedAt 降序，id 升序作为确定性次级键。 */
function compareSummaries(a: CanvasSummary, b: CanvasSummary): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function conflict(canvas: ServerCanvas): CanvasStorageError {
  return new CanvasStorageError("REVISION_CONFLICT", "画布 revision 已变化", {
    currentRevision: canvas.revision,
    currentCanvas: canvas
  });
}

/** 深拷贝，避免测试外部持有引用后污染仓库内部状态。 */
function cloneCanvas(canvas: ServerCanvas): ServerCanvas {
  return structuredClone(canvas);
}
