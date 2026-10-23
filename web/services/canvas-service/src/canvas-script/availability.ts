/**
 * Canvas Script 能力可用性与资源调度
 * （change: 2026-10-13-add-canvas-script-authoring，任务 2.4 / 3.1 / design D4、D5；
 *  change: 2026-10-22-remove-agent-execution-limits，任务 5.1 / 6.1 / design D6）。
 *
 * 「可用」是一个显式事实，而不是「try 一下」。当隔离执行器未装配、或持久化 profile 不能原子
 * 保存脚本回执元数据时，能力必须明确 `available:false` 并给出原因；不得以普通 JS 执行或
 * 进程内回执冒充（spec「执行或持久化依赖不可用」）。
 *
 * 这里原本有单 principal/全局并发与排队上限（原 2 / 8 / 32），超出即返回不可重试的 busy。
 * 并发数量不是权限：合法脚本不再因为「同时有多少个在执行/排队」被拒绝。调度改为**实际资源**
 * 表达——进程内只保留一个观察性的活跃计数供诊断，执行本身仍由可终止的隔离故障域承载；
 * 用户可随时停止，真实资源故障按事实报告。
 */

export type CanvasScriptCapability =
  | { available: true }
  | { available: false; reason: string };

export type CanvasScriptQueueDecision = { allowed: true; release: () => void };

/**
 * 进程内执行观察器（不再拒绝）。
 *
 * 只统计活跃执行数与历史最大并发，供诊断/配额解释使用；`acquire` 永不放行失败，
 * 因此没有任何「超出队列长度即拒绝」路径。
 */
export class CanvasScriptConcurrencyGate {
  private globalActive = 0;

  /** 占用一个执行名额（永不拒绝）。 */
  acquire(_principalId: string): CanvasScriptQueueDecision {
    this.globalActive += 1;
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.globalActive = Math.max(0, this.globalActive - 1);
      }
    };
  }

  get activeCount(): number {
    return this.globalActive;
  }
}
