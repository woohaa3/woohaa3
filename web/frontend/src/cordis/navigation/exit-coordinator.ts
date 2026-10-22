/**
 * 聚焦编辑异步退出协调器
 * （change: 2026-10-08-add-image-focus-editing-and-unified-node-history，任务 3.3/3.4 / design D7）。
 *
 * 在 Navigation 的**同步** transition 之前进行异步准备：返回/Esc、切换聚焦目标、打开冲突普通
 * panel 与可等待的页面离开都是显式 exit request；存在净内容变化时先保存并确认完成回执，或
 * 由用户明确放弃，然后再 dispatch。没有净变化时直接可逆退出。
 *
 * 关键约束：
 * - Navigation snapshot 仍同步原子发布；协调器只在前置阶段异步。
 * - 重复退出请求合并为同一次结算（进行中直接返回同一 promise）。
 * - 保存失败/冲突保留原工作区与草稿，返回失败供 UI 内联提示（不先关闭再要求找回）。
 * - 强制 scope 释放/目标删除无法等待时**不**声称完成，只清理并保留可恢复引用。
 */

export type FocusExitParticipant = {
  id: string;
  /** 当前是否有未结算的净内容变化（同步查询，用于 Dialog pre-commit 门禁）。 */
  hasUnsavedChanges: () => boolean;
  /**
   * 执行异步准备（保存/归档）。返回：
   * - `{ ok: true }`：已结算，可以继续退出。
   * - `{ ok: false, reason }`：保留现场（保存失败/冲突/需要用户决策）。
   */
  prepare: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 用户明确放弃时调用（丢弃本地草稿，但不得回滚已权威提交内容）。 */
  abandon?: () => void;
  /** Visual return after all content has settled; runs even for a clean focus. */
  afterPrepare?: () => Promise<void>;
};

export type FocusExitResult =
  | { ok: true; removed: boolean }
  | { ok: false; code: "focus-exit-required" | "exit-prepare-failed"; reason: string };

/**
 * 活动操作门禁（change: 2026-10-21-add-photocraft-document-workspace，D3）。
 *
 * 返回非空原因表示当前活动文档仍有未结束操作（笔迹、未确认文字/变换/调整/属性草稿），
 * 切换文档或返回画布必须被拒绝且现场保留。由编辑 feature 注册；没有文档打开时不注册。
 */
export type FocusSwitchGate = () => string | null;

export class FocusExitCoordinator {
  private readonly participants = new Map<string, FocusExitParticipant>();
  private readonly gates = new Map<string, FocusSwitchGate>();
  private inFlight: Promise<FocusExitResult> | null = null;

  register(participant: FocusExitParticipant): () => void {
    this.participants.set(participant.id, participant);
    return () => {
      if (this.participants.get(participant.id) === participant) this.participants.delete(participant.id);
    };
  }

  /** 注册活动操作门禁；返回注销函数。 */
  registerSwitchGate(id: string, gate: FocusSwitchGate): () => void {
    this.gates.set(id, gate);
    return () => {
      if (this.gates.get(id) === gate) this.gates.delete(id);
    };
  }

  /** 首个非空门禁原因；全部通过返回 null（同步，供 Navigation transition 使用）。 */
  switchGate(): string | null {
    for (const gate of this.gates.values()) {
      const reason = gate();
      if (reason) return reason;
    }
    return null;
  }

  /** 是否有任一参与者存在未结算净变化（同步；Dialog pre-commit 门禁用）。 */
  hasUnsavedChanges(): boolean {
    for (const participant of this.participants.values()) {
      if (participant.hasUnsavedChanges()) return true;
    }
    return false;
  }

  /**
   * 结算全部脏参与者的异步准备。重复调用合并为同一次结算。
   *
   * 任一参与者失败即保留现场并返回失败（不继续退出、不清理其草稿）。
   */
  prepare(): Promise<FocusExitResult> {
    if (this.inFlight) return this.inFlight;
    const dirty = [...this.participants.values()].filter((participant) => participant.hasUnsavedChanges());

    this.inFlight = Promise.resolve().then(async (): Promise<FocusExitResult> => {
      try {
        for (const participant of dirty) {
          const result = await participant.prepare();
          if (!result.ok) return { ok: false, code: "exit-prepare-failed", reason: result.reason };
        }
        for (const participant of this.participants.values()) await participant.afterPrepare?.();
        return { ok: true, removed: dirty.length > 0 };
      } catch (error) {
        return { ok: false, code: "exit-prepare-failed", reason: error instanceof Error ? error.message : "保存失败，请重试" };
      } finally {
        this.inFlight = null;
      }
    });
    return this.inFlight;
  }

  /** 用户明确放弃：调用每个脏参与者的 abandon（不回滚已提交内容）。 */
  abandonAll(): void {
    for (const participant of this.participants.values()) {
      if (!participant.hasUnsavedChanges()) continue;
      participant.abandon?.();
    }
  }
}
