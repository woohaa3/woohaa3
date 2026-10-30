/**
 * 前端 speculative working projection store
 * （change: add-frontend-speculative-canvas-state，任务 2.1–2.5 / design D3、D4、D5）。
 *
 * 显式区分四层状态：
 * - `canonicalCanvas`：服务端 published Y.Doc 的确定性派生（唯一规范事实源）；
 * - `pendingBatches`：本页已提交但尚未结算的有序语义命令批次（仅内存）；
 * - `workingCanvas`：canonical 加有序 pending batches 的确定性计算结果（可丢弃）；
 * - gesture drafts：高频拖拽/输入预览（由 interaction controller 持有，不在此）。
 *
 * 关键不变式（design D1 / D11）：
 * - working projection 不写本地 Y.Doc、IndexedDB、localStorage 或 sessionStorage；
 * - 不推进规范 revision；`workingCanvas.revision` 沿用 canonical 的 revision；
 * - 任务、MCP、资产授权等 canonical-only 副作用必须读 `canonicalCanvas`。
 */
import {
  applyCanvasCommands,
  isCanvasCommandBatchSatisfied,
  type CanvasCommand,
  type ServerCanvas
} from "@woohaa3/contracts";

/** 单个 pending 批次的状态（design D3）。 */
export type PendingBatchState = "pending" | "accepted" | "observed" | "blocked";

export type PendingBatch = {
  commandId: string;
  /** 提交时客户端看到的 canonical revision（诊断与前置条件）。 */
  baseRevision: number;
  commands: readonly CanvasCommand[];
  /** 固定的提交时间；重放时复用，避免每次重放产生不同时间字段。 */
  submittedAt: string;
  state: PendingBatchState;
  /** 服务端接受的 result revision；未知为 null。 */
  resultRevision: number | null;
  /** 服务端拒绝/失败原因；未知为 null。 */
  error: string | null;
};

export type WorkingProjectionSnapshot = {
  canonicalCanvas: ServerCanvas | null;
  workingCanvas: ServerCanvas | null;
  pendingBatches: readonly PendingBatch[];
};

/** 本地 reducer 拒绝时的结构化错误（不发送，不进入 pending）。 */
export type LocalRejection = { commandId: string; code: string; message: string };

const NO_CANVAS = "画布尚未 hydrate，拒绝变更";

/**
 * Working projection store。纯内存、可丢弃；不持有任何持久化能力。
 */
export class WorkingProjectionStore {
  constructor(private readonly lifecycle?: import("@woohaa3/contracts").ManagedNodeLifecycleResolver, private readonly getContent?: () => import("@woohaa3/contracts").ContentContributionResolver | undefined) {}
  private canonical: ServerCanvas | null = null;
  private pending: PendingBatch[] = [];
  private working: ServerCanvas | null = null;
  private rejections: LocalRejection[] = [];
  private readonly listeners = new Set<() => void>();

  /** 当前 canonical 派生（唯一规范事实源）。 */
  get canonicalCanvas(): ServerCanvas | null {
    return this.canonical;
  }

  /** 当前 working projection（canonical + pending）。 */
  get workingCanvas(): ServerCanvas | null {
    return this.working;
  }

  /** 当前有序 pending 批次（副本）。 */
  get pendingBatches(): readonly PendingBatch[] {
    return [...this.pending];
  }

  /** 最近一次本地拒绝（供 UI 诊断）。 */
  get lastRejections(): readonly LocalRejection[] {
    return [...this.rejections];
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** canonical-only 消费者读取入口：任务、MCP、资产授权必须用它。 */
  canonicalSelector(): ServerCanvas | null {
    return this.canonical;
  }

  /** working 消费者读取入口：Bevy render scene、hit test、选择、后续编辑规划。 */
  workingSelector(): ServerCanvas | null {
    return this.working;
  }

  /**
   * 应用新导出的 canonical 派生（Yjs observer 路径）。
   *
   * 依赖 canonical 变化时重基：先清理已满足的批次，再按顺序重放剩余批次。
   */
  applyCanonical(canonical: ServerCanvas | null): void {
    this.canonical = canonical;
    this.rejections = [];
    this.recompute();
  }

  /**
   * 追加一个 pending 批次（提交流程第 3–4 步）。
   *
   * 先在当前 workingCanvas 上用共享 reducer 本地校验：失败则不登记、不发送，返回拒绝。
   * 成功则登记并返回生成的 batch。
   */
  appendBatch(input: {
    commandId: string;
    commands: readonly CanvasCommand[];
    baseRevision: number;
    submittedAt: string;
  }): { ok: true; batch: PendingBatch } | { ok: false; code: string; message: string } {
    const base = this.working ?? this.canonical;
    if (!base) {
      const rejection: LocalRejection = { commandId: input.commandId, code: "unknown-node", message: NO_CANVAS };
      this.rejections = [...this.rejections, rejection];
      return { ok: false, code: rejection.code, message: rejection.message };
    }
    // 本地原子验证：用固定 submittedAt 应用在 working 上（与重放同一语义）。
    const applied = applyCanvasCommands(base, input.commands, { now: input.submittedAt, lifecycle: this.lifecycle, content: this.getContent?.() });
    if (!applied.ok) {
      this.rejections = [...this.rejections, {
        commandId: input.commandId,
        code: applied.rejection.code,
        message: applied.rejection.message
      }];
      return { ok: false, code: applied.rejection.code, message: applied.rejection.message };
    }
    const batch: PendingBatch = {
      commandId: input.commandId,
      baseRevision: input.baseRevision,
      commands: [...input.commands],
      submittedAt: input.submittedAt,
      state: "pending",
      resultRevision: null,
      error: null
    };
    const needsReplay = this.pending.some(entry => entry.state === "blocked")
      || (this.canonical !== null && isCanvasCommandBatchSatisfied(this.canonical, batch.commands, this.getContent?.()));
    this.pending.push(batch);
    if (needsReplay) {
      // Preserve ordered blocking and canonical-first observation semantics.
      this.recompute();
    } else {
      // Atomic validation already applied this batch to the valid pending prefix.
      this.working = applied.canvas;
      this.emit();
    }
    return { ok: true, batch };
  }

  /**
   * 收到服务端 command result。
   *
   * - accepted/duplicate：记录 result revision，若 canonical 已覆盖则结算；
   * - rejected/failed：移除批次并重放后续；
   * - no-op：result revision 等于 base，canonical 已覆盖即结算。
   */
  applyResult(input: {
    commandId: string;
    status: "accepted" | "duplicate" | "rejected" | "failed";
    revision?: number;
    code?: string;
    error?: string;
  }): void {
    const index = this.pending.findIndex((entry) => entry.commandId === input.commandId);
    if (index < 0) return;
    const batch = this.pending[index];
    if (input.status === "rejected" || input.status === "failed") {
      const message = input.error ?? "命令被拒绝";
      this.pending.splice(index, 1);
      this.rejections = [
        ...this.rejections,
        { commandId: input.commandId, code: input.code ?? input.status, message }
      ];
      this.recompute();
      return;
    }
    batch.state = "accepted";
    batch.resultRevision = input.revision ?? batch.baseRevision;
    batch.error = null;
    this.recompute();
  }

  /** 发送失败：立即移除批次并重放剩余的（提交流程第 6 步）。 */
  rejectBatch(commandId: string, message: string): void {
    const index = this.pending.findIndex((entry) => entry.commandId === commandId);
    if (index < 0) return;
    this.pending.splice(index, 1);
    this.rejections = [...this.rejections, { commandId, code: "send-failed", message }];
    this.recompute();
  }

  /** Owner availability changed: replay from canonical, including batches blocked by a missing owner. */
  refreshContent(): void {
    for (const batch of this.pending) {
      if (batch.state !== "blocked") continue;
      batch.state = batch.resultRevision === null ? "pending" : "accepted";
      batch.error = null;
    }
    this.recompute();
  }

  /** 断线：不形成离线 outbox，仅保留当前 pending 供重连后重放。 */
  markUnknown(): void {
    // pending 保持不变；UI 通过 pendingCount 显示「等待确认」。
    this.emit();
  }

  /**
   * 重新计算 workingCanvas：canonical + 有序 pending batches（design D5）。
   *
   * 结算与重放规则：
   * 1. 已 accepted 且 canonical revision 覆盖 result revision → 从 pending 移除；
   * 2. 无 result 但效果已出现在 canonical 的批次 → observed，不重复应用；
   * 3. 其它批次按提交顺序应用；
   * 4. 某批次无法应用（reducer 拒绝）→ blocked，其部分结果不进入 working；
   *    后续依赖 blocked 的批次同样 blocked。
   */
  private recompute(): void {
    let working = this.canonical;
    const survivors: PendingBatch[] = [];
    let blockedSeen = false;

    for (const batch of this.pending) {
      // 1) result 已明确关联 commandId；canonical 覆盖该 result revision 即代表命令已结算。
      // 不再额外比较原始命令值：服务端可能对坐标等字段做规范化，且后续 revision 也可能
      // 合法覆盖同一字段。继续重放旧 effect 反而会让 pending 永久残留。
      if (
        batch.state === "accepted"
        && batch.resultRevision !== null
        && this.canonical !== null
        && this.canonical.revision >= batch.resultRevision
      ) {
        continue;
      }
      // 2) 尚无 result，但效果已出现在 canonical → observed，不重复应用。
      if (
        batch.state === "pending"
        && this.canonical !== null
        && isCanvasCommandBatchSatisfied(this.canonical, batch.commands, this.getContent?.())
      ) {
        batch.state = "observed";
        batch.resultRevision = this.canonical.revision;
        continue;
      }
      // 4) 前序 blocked：不重放，但保留（UI 显示诊断）。
      if (batch.state === "blocked" || blockedSeen) {
        blockedSeen = true;
        survivors.push(batch);
        continue;
      }
      // 3) 在 working 上按提交顺序应用。
      if (working === null) {
        survivors.push(batch);
        continue;
      }
      const applied = applyCanvasCommands(working, batch.commands, { now: batch.submittedAt, lifecycle: this.lifecycle, content: this.getContent?.() });
      if (!applied.ok) {
        // 远端变化导致无法重放：blocked，不把部分结果加入 working。
        batch.state = "blocked";
        batch.error = batch.error ?? applied.rejection.message;
        blockedSeen = true;
        survivors.push(batch);
        continue;
      }
      working = applied.changed ? applied.canvas : working;
      survivors.push(batch);
    }

    this.pending = survivors;
    // working projection 不伪造未来 revision：沿用 canonical 的 revision。
    this.working = working;
    this.emit();
  }

  /** 快照（供调试/测试）。 */
  snapshot(): WorkingProjectionSnapshot {
    return {
      canonicalCanvas: this.canonical,
      workingCanvas: this.working,
      pendingBatches: this.pendingBatches
    };
  }

  /** 清空全部内存状态（shutdown / 测试）。 */
  clear(): void {
    this.canonical = null;
    this.working = null;
    this.pending = [];
    this.rejections = [];
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
