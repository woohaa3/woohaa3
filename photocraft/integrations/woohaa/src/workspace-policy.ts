/**
 * 资源与工作区运行政策（纯逻辑）
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 4.3 / design D8）。
 *
 * 上限与并发是**工作区运行政策**，不写入工程格式，也不改变单文档可接收范围：
 * - 打开文档数上限（核心 `MAX_OPEN_DOCUMENTS`）；
 * - 全局解码/打开并发 1（一次只准备一个内核实例，避免峰值叠加）；
 * - 活动预览生产者 1（只有活动文档发布主预览与区域细节）。
 *
 * 这里只提供可测试的策略与并发闸门；实际资源测量在真实设备上采集，不在此估算。
 */
import { MAX_OPEN_DOCUMENTS } from "@woohaa3/photocraft-editor";

export type WorkspacePolicy = {
  /** 同时打开的文档数上限。 */
  maxDocuments: number;
  /** 同时进行的内核打开/解码数。 */
  maxOpenConcurrency: number;
  /** 同时发布主预览的文档数（恒为 1）。 */
  maxPreviewProducers: number;
};

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  maxDocuments: MAX_OPEN_DOCUMENTS,
  maxOpenConcurrency: 1,
  maxPreviewProducers: 1
};

/** 简单串行闸门：保证同一时刻只有一个打开/解码在跑，其余排队。 */
export class SerialGate {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  constructor(private readonly limit = 1) {}

  /** 当前排队中的任务数（诊断用）。 */
  backlog(): number {
    return this.pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const start = this.tail.then(() => {
      this.pending -= 1;
      return task();
    });
    // 上一个任务失败不应阻塞后续任务。
    this.tail = start.catch(() => undefined);
    void this.limit;
    return start;
  }
}

/**
 * 新打开是否被允许。
 *
 * 达到上限时返回具体原因与「关闭一个文档后重试」的指引；已有文档不受影响（不静默淘汰）。
 */
export function canOpenDocument(count: number, policy: WorkspacePolicy = DEFAULT_WORKSPACE_POLICY): { ok: true } | { ok: false; reason: string } {
  if (count < policy.maxDocuments) return { ok: true };
  return { ok: false, reason: `最多同时打开 ${policy.maxDocuments} 个文档，请先关闭一个后再打开新的文档` };
}

/** 只有活动文档发布主预览与区域细节。 */
export function shouldProducePreview(documentId: string | null, activeDocumentId: string | null): boolean {
  return documentId !== null && documentId === activeDocumentId;
}

/** 并行解码单位（供日志/诊断；不改变行为）。 */
export function describePolicy(policy: WorkspacePolicy = DEFAULT_WORKSPACE_POLICY): string {
  return `文档上限 ${policy.maxDocuments} · 打开并发 ${policy.maxOpenConcurrency} · 活动预览 ${policy.maxPreviewProducers}`;
}
