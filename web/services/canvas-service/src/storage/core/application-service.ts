/**
 * 画布应用服务（任务 2.3 / design D1、D3、D4、D7、D8）。
 *
 * 编排边界：domain 规范化 → 命令应用 → 资产引用校验 → 仓库 CAS 提交 → 稳定错误。
 * 它**不**关心底层是 SQLite 还是 Mongo，也不产生 COS bytes。
 *
 * revision 语义：所有写操作都要求客户端给出 `expectedRevision`；不匹配时抛
 * `REVISION_CONFLICT` 并附最新画布，绝不静默 last-write-wins。
 */
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import type { MediaStorage } from "@woohaa3/contracts";
import { applyCanvasCommands, assertCanvasCommandBatch, type CanvasCommandRejection } from "./command-applier.js";
import type { CanvasCommandBatch } from "@woohaa3/contracts";
import { normalizeCanvasListQuery,
  type CanvasCommandCommitResult,
  type CanvasListQuery,
  type CanvasListResult,
  type CanvasRepository } from "./contracts.js";
import { CanvasStorageError } from "./errors.js";
import { collectMutatedAssets, validateAssetReferences } from "./asset-validation.js";

export type CanvasStorageLimits = {
  /** 单批命令数量上限。 */
  maxCommands: number;
  /** 单画布序列化 JSON 字节上限（提交后校验）。 */
  maxCanvasJsonBytes: number;
  /** 单个字符串字段长度上限。 */
  maxStringLength: number;
  /** 画布标题长度上限。 */
  maxTitleLength: number;
};

/**
 * 默认限制。数值来自 tasks 1.4 的真实画布样本基线（见 `notes/limits-baseline.md`）：
 * 典型画布 JSON < 256 KiB，命令批次 < 64 条，远低于下列上限，留足余量。
 */
export const DEFAULT_CANVAS_STORAGE_LIMITS: CanvasStorageLimits = {
  maxCommands: 512,
  maxCanvasJsonBytes: 8 * 1024 * 1024,
  maxStringLength: 256 * 1024,
  maxTitleLength: 512
};

export type CanvasApplicationServiceOptions = {
  repository: CanvasRepository;
  /** 中立媒体存储；提供时校验资产引用的远端存在性与 metadata 一致性。 */
  mediaStorage?: MediaStorage;
  limits?: Partial<CanvasStorageLimits>;
  now?: () => string;
  /** 生成 canvasId 的注入点（测试用确定性实现）。 */
  generateCanvasId?: () => string;
};

export type CreateCanvasRequest = {
  /** 省略时由服务生成。 */
  canvasId?: string;
  title?: string;
  operationId?: string;
};

export class CanvasApplicationService {
  private readonly repository: CanvasRepository;
  private readonly mediaStorage?: MediaStorage;
  private readonly limits: CanvasStorageLimits;
  private readonly now: () => string;
  private readonly generateCanvasId: () => string;

  constructor(options: CanvasApplicationServiceOptions) {
    this.repository = options.repository;
    this.mediaStorage = options.mediaStorage;
    this.limits = { ...DEFAULT_CANVAS_STORAGE_LIMITS, ...options.limits };
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateCanvasId = options.generateCanvasId ?? (() => `canvas-${crypto.randomUUID()}`);
  }

  getLimits(): CanvasStorageLimits {
    return { ...this.limits };
  }

  /** 创建空画布。ID 冲突由仓库抛 `CANVAS_ALREADY_EXISTS`。 */
  async createCanvas(request: CreateCanvasRequest = {}): Promise<ServerCanvas> {
    const now = this.now();
    const canvasId = request.canvasId ?? this.generateCanvasId();
    if (typeof canvasId !== "string" || canvasId.trim().length === 0) {
      throw new CanvasStorageError("INVALID_COMMAND_BATCH", "canvasId 非法");
    }
    if (canvasId.length > this.limits.maxStringLength) {
      throw new CanvasStorageError("LIMIT_EXCEEDED", "canvasId 超过长度上限");
    }
    const title = request.title;
    if (title !== undefined && title.length > this.limits.maxTitleLength) {
      throw new CanvasStorageError("LIMIT_EXCEEDED", "标题超过长度上限");
    }
    const empty = createEmptyWoohaa3ServerCanvas(canvasId, now);
    const canvas: ServerCanvas = title !== undefined && title.trim()
      ? { ...empty, title: title.trim() }
      : empty;
    return this.repository.createCanvas(canvas, request.operationId);
  }

  /** 读取规范画布；不存在抛 `CANVAS_NOT_FOUND`，绝不返回空画布顶替。 */
  async getCanvas(canvasId: string): Promise<ServerCanvas> {
    const canvas = await this.repository.getCanvas(canvasId);
    if (!canvas) {
      throw new CanvasStorageError("CANVAS_NOT_FOUND", `画布 ${canvasId} 不存在`);
    }
    return canvas;
  }

  async listCanvases(query?: CanvasListQuery): Promise<CanvasListResult> {
    return this.repository.listCanvases(normalizeCanvasListQuery(query));
  }

  /**
   * 提交命令批次。
   *
   * 流程：结构校验 → 载入最新画布（仅用于 CAS 前置检查与引用校验）→ 应用命令 →
   * 规范化 → 校验新增资产的 COS 引用 → 仓库原子提交。应用器产生部分状态时**不会**
   * 到达仓库；仓库 CAS 失败时不会留下任何写入。
   */
  async commitCommands(batch: unknown): Promise<CanvasCommandCommitResult> {
    const decoded = this.decodeBatch(batch);
    this.assertCommandLimits(decoded);

    const current = await this.repository.getCanvas(decoded.canvasId);
    if (!current) {
      throw new CanvasStorageError("CANVAS_NOT_FOUND", `画布 ${decoded.canvasId} 不存在`);
    }

    // 幂等优先于 CAS：响应丢失后的重试会带着**旧的** expectedRevision 到达，
    // 必须先命中 operation 记录并返回首次结果，而不是报 conflict（spec「响应丢失后重试」）。
    const existing = await this.repository.getOperation(decoded.canvasId, decoded.operationId);
    if (existing) {
      return {
        canvas: existing.resultCanvas,
        revision: existing.resultRevision,
        operationId: decoded.operationId,
        duplicate: true
      };
    }

    if (current.revision !== decoded.expectedRevision) {
      throw revisionConflict(current);
    }

    const applied = applyCanvasCommands(current, decoded.commands, { now: this.now() });
    if (!applied.ok) throw commandRejected(applied.rejection);

    // 只校验新增/变更的资产引用，避免每次提交都访问全部历史 COS 对象。
    const mutated = collectMutatedAssets(current.assets, applied.canvas.assets);
    await validateAssetReferences(mutated, {
      mediaStorage: this.mediaStorage,
      // 这批资产属于这张画布：远端画布的字节可能只在服务端托管存储里。
      scope: { canvasId: decoded.canvasId },
      now: this.now()
    });

    // 规范化后的聚合不得超出 JSON 上限。
    const jsonBytes = Buffer.byteLength(JSON.stringify(applied.canvas));
    if (jsonBytes > this.limits.maxCanvasJsonBytes) {
      throw new CanvasStorageError("LIMIT_EXCEEDED", "画布 JSON 超过上限", { jsonBytes });
    }

    // 目标 revision 由应用服务显式写入：有净变化递增 1，无净变化保持不变。
    // 仓库只按 `canvas.revision` 持久化，`expectedRevision` 仅用于 CAS，两个 adapter 语义一致。
    const targetCanvas: ServerCanvas = applied.changed
      ? { ...applied.canvas, revision: current.revision + 1 }
      : current;

    return this.repository.commitCanvas({
      canvas: targetCanvas,
      canvasId: decoded.canvasId,
      expectedRevision: decoded.expectedRevision,
      operationId: decoded.operationId,
      actorId: decoded.actorId,
      commands: decoded.commands as readonly unknown[],
      now: applied.changed ? applied.canvas.updatedAt : current.updatedAt
    });
  }

  /** 带 revision 的删除；仅清理结构化记录，不触碰 COS。 */
  async deleteCanvas(canvasId: string, expectedRevision: number, operationId?: string): Promise<void> {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new CanvasStorageError("INVALID_COMMAND_BATCH", "expectedRevision 必须是非负整数");
    }
    const current = await this.repository.getCanvas(canvasId);
    if (!current) {
      throw new CanvasStorageError("CANVAS_NOT_FOUND", `画布 ${canvasId} 不存在`);
    }
    if (current.revision !== expectedRevision) {
      throw revisionConflict(current);
    }
    await this.repository.deleteCanvas(canvasId, expectedRevision, operationId);
  }

  async health() {
    return this.repository.health();
  }

  private decodeBatch(batch: unknown): CanvasCommandBatch {
    return assertCanvasCommandBatch(batch);
  }

  private assertCommandLimits(batch: CanvasCommandBatch): void {
    if (batch.commands.length > this.limits.maxCommands) {
      throw new CanvasStorageError("LIMIT_EXCEEDED", "命令数量超过上限", {
        commandCount: batch.commands.length,
        maxCommands: this.limits.maxCommands
      });
    }
    if (batch.operationId.length > this.limits.maxStringLength) {
      throw new CanvasStorageError("LIMIT_EXCEEDED", "operationId 超过长度上限");
    }
    if (batch.actorId.length > this.limits.maxStringLength) {
      throw new CanvasStorageError("LIMIT_EXCEEDED", "actorId 超过长度上限");
    }
    const jsonBytes = Buffer.byteLength(JSON.stringify(batch.commands));
    if (jsonBytes > this.limits.maxCanvasJsonBytes) {
      throw new CanvasStorageError("LIMIT_EXCEEDED", "命令批次 JSON 超过上限", { jsonBytes });
    }
  }
}

export function revisionConflict(current: ServerCanvas): CanvasStorageError {
  return new CanvasStorageError("REVISION_CONFLICT", "画布 revision 已变化", {
    currentRevision: current.revision,
    currentCanvas: current
  });
}

export function commandRejected(rejection: CanvasCommandRejection): CanvasStorageError {
  return new CanvasStorageError("COMMAND_REJECTED", rejection.message, { rejectionCode: rejection.code });
}
