/**
 * Canvas Script 能力可用性与并发门禁
 * （change: 2026-10-13-add-canvas-script-authoring，任务 2.4 / 3.1 / design D4、D5）。
 *
 * 「可用」是一个显式事实，而不是「try 一下」。当隔离执行器未装配、或持久化 profile 不能原子
 * 保存脚本回执元数据时，能力必须明确 `available:false` 并给出原因；不得以普通 JS 执行或
 * 进程内回执冒充（spec「执行或持久化依赖不可用」）。
 *
 * 并发门禁在**执行之前**生效：超出单 principal/全局并发或排队上限时返回繁忙错误，且被拒绝的
 * 请求不占用任何预算，普通读写不受影响。
 */
import { CANVAS_SCRIPT_LIMITS } from "@woohaa3/contracts";

export type CanvasScriptCapability =
  | { available: true }
  | { available: false; reason: string };

export type CanvasScriptQueueDecision =
  | { allowed: true; release: () => void }
  | { allowed: false; code: "busy"; message: string };

/**
 * 进程内并发门禁。
 *
 * MCP/Canvas 无状态进程内的**尽力而为**保护，不是跨实例配额：单实例部署由它兜底，
 * 多实例部署需在入口再加分布式限流（本 change 不声称已具备）。
 */
export class CanvasScriptConcurrencyGate {
  private globalActive = 0;
  private queued = 0;
  private readonly perPrincipal = new Map<string, number>();

  constructor(
    private readonly limits: { maxConcurrentPerPrincipal: number; maxConcurrentGlobal: number; maxQueueDepth: number } = {
      maxConcurrentPerPrincipal: CANVAS_SCRIPT_LIMITS.maxConcurrentPerPrincipal,
      maxConcurrentGlobal: CANVAS_SCRIPT_LIMITS.maxConcurrentGlobal,
      maxQueueDepth: CANVAS_SCRIPT_LIMITS.maxQueueDepth
    }
  ) {}

  /** 尝试占用一个执行名额；失败返回不可重试的 busy。 */
  acquire(principalId: string): CanvasScriptQueueDecision {
    const active = this.perPrincipal.get(principalId) ?? 0;
    if (active >= this.limits.maxConcurrentPerPrincipal || this.globalActive >= this.limits.maxConcurrentGlobal) {
      return { allowed: false, code: "busy", message: "同一主体或全服脚本执行已达并发上限" };
    }
    this.globalActive += 1;
    this.perPrincipal.set(principalId, active + 1);
    let released = false;
    return {
      allowed: true,
      release: () => {
        if (released) return;
        released = true;
        this.globalActive = Math.max(0, this.globalActive - 1);
        const current = (this.perPrincipal.get(principalId) ?? 1) - 1;
        if (current <= 0) this.perPrincipal.delete(principalId);
        else this.perPrincipal.set(principalId, current);
      }
    };
  }

  /**
   * 登记一个等待名额。返回 `false` 表示排队已满（调用方应返回繁忙错误而不是堆积）。
   *
   * 本进程内服务**不**真正挂起等待：拿不到名额即返回 busy；`enqueue/dequeue` 仅用于
   * 上层需要显式统计等待者时的记账（保持可能的内存有界）。
   */
  enqueue(): boolean {
    if (this.queued >= this.limits.maxQueueDepth) return false;
    this.queued += 1;
    return true;
  }

  dequeue(): void {
    this.queued = Math.max(0, this.queued - 1);
  }

  get activeCount(): number {
    return this.globalActive;
  }

  get queueDepth(): number {
    return this.queued;
  }
}
