/**
 * 有界事件队列（change: 2026-10-20-add-local-client-telemetry，design D7）。
 *
 * 只做"装、丢最旧、按批取出"三件事，**不碰 I/O、不碰定时器**：定时、暂停与计数策略放在
 * `service.ts`，因为那部分要读设置、要写日志；放进队列会让这个数据结构同时承担策略，也更难测。
 *
 * 为什么必须是有界队列：`emit` 在业务路径上被同步调用，队列无界时一次卡死（例如磁盘满导致
 * 写入持续失败）会把内存吃光。"丢最旧"是可接受的：复盘需要的是最近的事实，而且丢弃量会通过
 * `status().droppedOverflow` 暴露出来——知道有缺口比假装完整好（design D11）。
 */
import type { TelemetryEvent } from "@woohaa3/contracts";

/** design D7：队列容量 2048。 */
export const TELEMETRY_QUEUE_CAPACITY = 2048;
/** 一个事务写一批；同时也是"队列到这个长度就尽快排空"的阈值。 */
export const TELEMETRY_FLUSH_BATCH = 64;
/** 常态排空间隔：250ms 对本机遥测足够及时，又不至于让每批只有一两条。 */
export const TELEMETRY_FLUSH_INTERVAL_MS = 250;

export class TelemetryEventQueue {
  private items: TelemetryEvent[] = [];
  private overflow = 0;
  private readonly capacity: number;

  constructor(capacity: number = TELEMETRY_QUEUE_CAPACITY) {
    // 容量至少 1：0 会让入队逻辑退化成"每条都丢"的隐式开关，而开关该由设置项表达。
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** 入队；队列满时丢最旧。返回被丢弃的条数（0 或 1），便于调用方累计 `droppedOverflow`。 */
  enqueue(event: TelemetryEvent): number {
    let dropped = 0;
    if (this.items.length >= this.capacity) {
      // 数组上限只有 2048，`shift()` 的搬移成本可忽略；换成环形缓冲会让代码复杂度翻倍。
      this.items.shift();
      this.overflow += 1;
      dropped = 1;
    }
    this.items.push(event);
    return dropped;
  }

  /** 按 FIFO 取出最多 `max` 条。 */
  take(max: number): TelemetryEvent[] {
    if (max <= 0) return [];
    return this.items.splice(0, Math.min(max, this.items.length));
  }

  /** 关闭或清空时丢弃剩余事件。 */
  clear(): void {
    this.items = [];
  }

  get size(): number {
    return this.items.length;
  }

  /** 累计因队列满而丢弃的事件数（只增不减：它是"这段运行期丢了多少"的事实）。 */
  get droppedOverflow(): number {
    return this.overflow;
  }
}
