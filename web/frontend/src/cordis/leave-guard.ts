/**
 * 页面离开守卫
 * （change: 2026-10-21-add-photocraft-document-workspace，任务 4.1 / design D6）。
 *
 * 页面级 feature（目前是 PhotoCraft 多文档工作区）注册自己的「是否有未结算文档」与「串行结算」
 * 两步；切换画布、离开页面与浏览器/窗口关闭都先问它：
 *
 * - 返回画布 / 关闭 tab **不**经过这里（那是工作区内部导航，不保存）；
 * - `settle()` 由 feature 串行处理全部文档，失败即返回原因，调用方必须停止离开并保留现场；
 * - `hasUnsaved()` 是同步的，供 `beforeunload` 这类不能等待的场合尽力提示。
 *
 * 本模块只做注册与聚合，不拥有浏览器事件；事件接线在 composition（`main.tsx`）与
 * Canvas Switcher 的导航入口。
 */
export type LeaveGuardParticipant = {
  id: string;
  /** 是否存在未保存/未结算的文档（同步查询）。 */
  hasUnsaved: () => boolean;
  /**
   * 串行结算全部文档。返回失败原因时调用方不得离开。
   *
   * 实现必须自己处理「保存 / 明确放弃 / 取消」的用户选择；已成功项保留推进后的基线。
   */
  settle: () => Promise<{ ok: true } | { ok: false; reason: string }>;
};

export type LeaveResult = { ok: true } | { ok: false; reason: string };

export class PageLeaveGuard {
  private readonly participants = new Map<string, LeaveGuardParticipant>();
  private inFlight: Promise<LeaveResult> | null = null;

  register(participant: LeaveGuardParticipant): () => void {
    this.participants.set(participant.id, participant);
    return () => {
      if (this.participants.get(participant.id) === participant) this.participants.delete(participant.id);
    };
  }

  /** 是否有任一参与者存在未结算文档（同步；`beforeunload` 与导航前置检查用）。 */
  hasUnsaved(): boolean {
    for (const participant of this.participants.values()) {
      try {
        if (participant.hasUnsaved()) return true;
      } catch {
        // 参与者自身异常不应把「没有未保存」误报成可安全离开。
        return true;
      }
    }
    return false;
  }

  /** 串行结算全部参与者；重复调用合并（避免切画布与关闭窗口并发时保存两次）。 */
  settle(): Promise<LeaveResult> {
    if (this.inFlight) return this.inFlight;
    const participants = [...this.participants.values()];
    this.inFlight = (async (): Promise<LeaveResult> => {
      try {
        for (const participant of participants) {
          if (!participant.hasUnsaved()) continue;
          const result = await participant.settle();
          if (!result.ok) return result;
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : "保存失败，已保留当前页面" };
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }
}
