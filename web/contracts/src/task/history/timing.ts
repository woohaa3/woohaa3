/**
 * Task 生命周期耗时计算
 * （change: 2026-10-13-add-enterprise-access-and-production-deployment，任务 7.3 / design D9）。
 *
 * 纯函数、无副作用：调用方（Task history repository 与监控 facade）传入已持久化的可靠时间与
 * 统一 observedAt。定义固定，缺失时间即缺失字段（页面显示未知，绝不用 updatedAt 猜测）：
 * - totalMs = 受理 → 终态时间（无终态则 observedAt）；
 * - queueMs = 受理 → 首次执行开始；
 * - executionMs = 首次执行开始 → 终态/observedAt（含重试等待）；
 * - stateMs = 状态最近变化 → 终态/observedAt（终态后冻结于该状态驻留）。
 * 时钟回拨产生的负值钳为 0。
 */
import { isTerminalTaskState } from "./guards.js";
import type { TaskExecutionState, TaskExecutionTiming } from "./types.js";

function positiveDelta(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined;
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return Math.max(0, end - start);
}

export function computeTaskTiming(input: {
  state: TaskExecutionState;
  admittedAt?: string;
  firstStartedAt?: string;
  stateChangedAt?: string;
  finishedAt?: string;
  observedAt: string;
}): TaskExecutionTiming {
  const terminal = isTerminalTaskState(input.state);
  // 终态以持久化的 finishedAt 为准；进行中才回落到 observedAt（同一次快照时刻）。
  const effectiveEnd = terminal ? input.finishedAt : input.observedAt;
  return {
    ...(input.admittedAt ? { admittedAt: input.admittedAt } : {}),
    ...(input.firstStartedAt ? { firstStartedAt: input.firstStartedAt } : {}),
    ...(input.stateChangedAt ? { stateChangedAt: input.stateChangedAt } : {}),
    ...(positiveDelta(input.admittedAt, effectiveEnd) !== undefined
      ? { totalMs: positiveDelta(input.admittedAt, effectiveEnd) }
      : {}),
    ...(positiveDelta(input.admittedAt, input.firstStartedAt) !== undefined
      ? { queueMs: positiveDelta(input.admittedAt, input.firstStartedAt) }
      : {}),
    ...(positiveDelta(input.firstStartedAt, effectiveEnd) !== undefined
      ? { executionMs: positiveDelta(input.firstStartedAt, effectiveEnd) }
      : {}),
    ...(positiveDelta(input.stateChangedAt, effectiveEnd) !== undefined
      ? { stateMs: positiveDelta(input.stateChangedAt, effectiveEnd) }
      : {}),
    observedAt: input.observedAt
  };
}

/** 用新的观测时刻重算耗时（监控快照 5 秒刷新时的在途时间校正；终态保持冻结）。 */
export function recomputeTaskTiming(
  timing: TaskExecutionTiming,
  state: TaskExecutionState,
  observedAt: string
): TaskExecutionTiming {
  return computeTaskTiming({
    state,
    ...(timing.admittedAt ? { admittedAt: timing.admittedAt } : {}),
    ...(timing.firstStartedAt ? { firstStartedAt: timing.firstStartedAt } : {}),
    ...(timing.stateChangedAt ? { stateChangedAt: timing.stateChangedAt } : {}),
    observedAt
  });
}
