/**
 * 共享输入分段采集
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，从 `interaction-2d-input` 拆出以保持
 * 业务单文件 ≤500 行的体积守卫）。
 *
 * 提供单次 pointer/wheel 事件的可选分段容器：`measure` 计时一个已知分段，`reset` 在每次
 * 事件入口清空。未覆盖余量 = handlerMs - 已知分段（由共享入口结算）。
 */
import type { InteractionRecorder, InteractionSegments } from "./interaction-performance.js";

export type InputSegments = {
  /** 清空当前事件分段（每次事件入口调用）。 */
  reset: () => void;
  /** 计时一个已知分段并累加到当前事件。 */
  measure: <T>(key: keyof InteractionSegments, run: () => T) => T;
  /** 当前事件分段（无则 undefined）。 */
  current: () => InteractionSegments | undefined;
};

/** 构造分段容器；`recorder` 为空时 `measure` 直接透传，不产生计时开销。 */
export function createInputSegments(recorder: InteractionRecorder): InputSegments {
  const stack: Array<{ children: number }> = [];
  let eventSegments: InteractionSegments | undefined;
  const add = (key: keyof InteractionSegments, value: number) => {
    eventSegments ??= {};
    eventSegments[key] = Math.round(((eventSegments[key] ?? 0) + value) * 100) / 100;
  };
  return {
    reset: () => { eventSegments = undefined; },
    measure: <T,>(key: keyof InteractionSegments, run: () => T): T => {
      if (!recorder) return run();
      const start = recorder.now();
      const scope = { children: 0 };
      stack.push(scope);
      try { return run(); } finally {
        const elapsed = Math.max(0, recorder.now() - start);
        stack.pop();
        const parent = stack.at(-1);
        if (parent) parent.children += elapsed;
        add(key, Math.max(0, elapsed - scope.children));
      }
    },
    current: () => eventSegments
  };
}
