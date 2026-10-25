/**
 * 画布输入的 `perf.interaction` / `perf.segment` 收集器
 * （change: 2026-10-25-enhance-telemetry-performance-collection，design D2/D7、spec 场景"输入被门禁拒绝"）。
 *
 * 四条约束决定了这个模块的形状：
 *
 * 1. **被门禁拒绝的输入不发事件。** 入口只记时间（`enter`），确认消费之后才 `start`；拒绝路径
 *    既不 start 也不 finish，收集器于是什么都不发。
 * 2. **计时不改变行为。** `enter`/`start` 只是读一次单调时钟，`accumulate` 只加数字；没有任何
 *    查询、序列化或渲染调用被加进热路径。未装采集客户端时全部方法是 no-op。
 * 3. **事件数必须有界。** 一次拖动会上百次 pointermove，逐次 push 子阶段就会把一次输入放大成
 *    上百条 `perf.segment`。所以子阶段一律先累加到账本，`finish` 时每个阶段只出一条。
 * 4. **种类在消费之后才知道。** 按下时不知道是 pan、菜单还是拖动，所以 `enter` 返回的起点和
 *    之前已记账的段（命中查询）要能跨到 `start(kind)` 那一刻，不能在那时丢掉。
 */
import {
  beginPerfInteraction,
  isPerfCollectionEnabled,
  telemetryNow,
  type PerfInteractionHandle
} from "../../../services/telemetry-primitives.js";

export type PerfInputResult = "success" | "failure" | "cancelled";

/** 一个计时起点；未开启采集时是 `undefined`（调用点不必分支）。 */
export type PerfMoment = number | undefined;

export type PerfInputRecorder = {
  /** 输入入口（门禁之前）：开一份新账本并返回起点。有进行中的收集时不重置账本。 */
  enter(): PerfMoment;
  /** 确认消费后开始收集；缺省用 `enter` 记下的起点。重复调用以第一次为准。 */
  start(kind: string, at?: PerfMoment): void;
  /** 累加一段已经测好的耗时（命中查询/滚轮/高频移动）。 */
  accumulate(stage: string, durationMs: number): void;
  /** 把"从 `from` 到现在"累加到 `stage`；`from` 缺失时是 no-op。 */
  accumulateSince(stage: string, from: PerfMoment): void;
  /** 结束并发送；重复调用只发一次。`endedAt` 用于结算"最后一段活动结束"之后才判定的输入。 */
  finish(result?: PerfInputResult, endedAt?: number): void;
  /** 放弃这次收集（输入最终未被消费）：不发送任何事件。 */
  discard(): void;
};

const IDLE: PerfInputRecorder = {
  enter: () => undefined,
  start: () => undefined,
  accumulate: () => undefined,
  accumulateSince: () => undefined,
  finish: () => undefined,
  discard: () => undefined
};

/** 一次输入最多累计的子阶段种类数（等于契约里固定集合的大小，不随事件放大）。 */
const MAX_ACCUMULATED_STAGES = 8;

/**
 * 创建一个输入收集器。
 *
 * 未开启采集时返回零成本的 idle 实现：手势代码里不必到处判空，也不会在读时钟上花任何时间。
 */
export function createPerfInputRecorder(): PerfInputRecorder {
  if (!isPerfCollectionEnabled()) return IDLE;
  let enteredAt: PerfMoment;
  let handle: PerfInteractionHandle | null = null;
  /** 子阶段累计耗时（stage → ms）；`start` 之前就可以存在（命中查询先于种类判定）。 */
  let totals: Map<string, number> | null = null;
  const reset = (): void => {
    handle = null;
    totals = null;
    enteredAt = undefined;
  };
  /** 累加到当前输入的账本：阶段种类有上限，事件条数因此有界。 */
  const add = (stage: string, durationMs: number): void => {
    if (!Number.isFinite(durationMs)) return;
    const current = totals ?? (totals = new Map());
    // 超过种类上限就并入最后一个已有阶段，绝不因此增加事件条数。
    const key = current.size >= MAX_ACCUMULATED_STAGES && !current.has(stage)
      ? ([...current.keys()].pop() ?? stage)
      : stage;
    current.set(key, (current.get(key) ?? 0) + Math.max(0, durationMs));
  };
  return {
    enter() {
      // 只在没有进行中的收集时开新账本：滚轮会按每个 wheel 事件 enter，但一段手势共用一条事实。
      if (!handle) totals = null;
      enteredAt = telemetryNow();
      return enteredAt;
    },
    start(kind, at) {
      if (handle) return;
      handle = beginPerfInteraction(kind, at ?? enteredAt);
    },
    accumulate(stage, durationMs) {
      if (!handle && enteredAt === undefined) return;
      add(stage, durationMs);
    },
    accumulateSince(stage, from) {
      if (from === undefined) return;
      if (!handle && enteredAt === undefined) return;
      add(stage, telemetryNow() - from);
    },
    finish(result = "success", endedAt) {
      if (!handle) {
        reset();
        return;
      }
      const current = handle;
      const accumulated = totals;
      reset();
      // 账本在结束前一次性转为分段：条数 = 实际发生的阶段种类数（有界）。
      if (accumulated) for (const [stage, durationMs] of accumulated) current.push(stage, durationMs);
      current.finish(result, endedAt);
    },
    discard() {
      reset();
    }
  };
}
