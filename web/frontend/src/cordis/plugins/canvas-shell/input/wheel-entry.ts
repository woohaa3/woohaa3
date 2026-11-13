/**
 * 共享 wheel 入口处理器
 * （change: 2026-10-10-optimize-canvas-interaction-hot-path，从 `interaction-2d-input` 拆出以保持
 * 业务单文件 ≤500 行的体积守卫）。
 *
 * 只负责门禁与分派：视口消费本身在 `interaction-viewport.onWheel` 完成。
 *
 * 遥测口径（change: 2026-10-25-enhance-telemetry-performance-collection，design D2/D7）：
 * **一次滚轮"连续动作"是一条 `perf.interaction`，不是一个 wheel 事件一条**。触控板双指平移
 * 每秒抛几十个 wheel 事件，逐条写库与逐条记录 pointermove 是同一个错误——既撞保留上限，也让
 * "这类输入有多慢"被单事件噪声淹没。所以按空闲间隔合并：第一下开门，同一段内继续累加，
 * 空闲 `WHEEL_BURST_IDLE_MS` 后结算。被门禁拒绝的 wheel 连门都不开（spec: 拒绝输入不发）。
 */
import { createPerfInputRecorder, type PerfMoment } from "./perf-interaction.js";
import type { InteractionCore } from "../interaction-core.js";
import type { createWheelViewport } from "../interaction-viewport.js";

/** 与视口提交的 120 ms 空闲判定同量级：同一段手势内的 wheel 合并成一条事实。 */
const WHEEL_BURST_IDLE_MS = 120;

/** 视口消费返回的滚轮种类（`pan` = 触控板双指平移，`zoom` = 滚轮/捏合缩放）。 */
type WheelKind = "pan" | "zoom";

export type WheelEntryHandler = ((event: WheelEvent) => void) & {
  /** 立即结算当前滚轮段（页面隐藏/失焦/卸载时用；不把跨可见性切换的两段拼成一条）。 */
  flushPerfBurst: () => void;
};

/** 构造共享 wheel 入口；`viewport` 只做消费。 */
export function createWheelEntryHandler(
  core: InteractionCore,
  viewport: ReturnType<typeof createWheelViewport>
): WheelEntryHandler {
  const { canvas, model } = core;
  /**
   * 定时器宿主：正式宿主是 `window`，测试/无动画环境可能只提供部分能力。
   * 缺 `setTimeout` 时不留悬挂段，当场结算（见 `extendBurst`）。
   */
  const timerHost = (core.target ?? {}) as {
    setTimeout?: (handler: () => void, ms: number) => unknown;
    clearTimeout?: (handle: number) => void;
  };
  const perf = createPerfInputRecorder();
  let burstKind: WheelKind | null = null;
  let burstTimer: number | null = null;
  /** 本段最后一次 wheel 被处理的时刻：总耗时的终点，不是空闲定时器触发的时刻。 */
  let lastActivityAt: PerfMoment = undefined;

  const clearBurstTimer = (): void => {
    if (burstTimer === null) return;
    timerHost.clearTimeout?.(burstTimer);
    burstTimer = null;
  };

  /** 关闭当前滚轮段并发送；没有开启的段时是空操作。 */
  const closeBurst = (result: "success" | "cancelled" = "success"): void => {
    clearBurstTimer();
    if (burstKind === null) return;
    burstKind = null;
    perf.finish(result, lastActivityAt);
    lastActivityAt = undefined;
  };

  /** 同一段内继续累加；种类变了（缩放↔平移）先把上一段结算掉，不混一个 kind。 */
  const extendBurst = (kind: WheelKind, startedAt: PerfMoment, handledAt: number): void => {
    if (burstKind !== null && burstKind !== kind) closeBurst();
    if (burstKind === null) {
      burstKind = kind;
      perf.start(kind === "zoom" ? "zoom" : "wheel-pan", startedAt);
    }
    perf.accumulate("viewport-apply", Math.max(0, handledAt - (startedAt ?? handledAt)));
    lastActivityAt = handledAt;
    clearBurstTimer();
    const timer = timerHost.setTimeout?.(() => {
      burstTimer = null;
      closeBurst();
    }, WHEEL_BURST_IDLE_MS);
    // 没有定时器的环境（测试/无动画宿主）：不留悬挂段，当场结算。
    burstTimer = typeof timer === "number" ? timer : null;
    if (burstTimer === null) closeBurst();
  };

  /** 消费一次 wheel；只有视口真的接受了这次事件才计入。 */
  const consume = (event: WheelEvent, rect?: { left: number; top: number }): void => {
    const started = perf.enter();
    const consumed = rect ? viewport.onWheel(event, rect) : viewport.onWheel(event);
    if (!consumed) return;
    extendBurst(consumed.kind, started, now());
  };

  const handler = (event: WheelEvent): void => {
    // modal 打开时滚轮不得缩放画布（design D6）。
    const imageFocused = core.options.isImageFocused?.() ?? !!core.options.getImageFocus?.();
    if (imageFocused && !(core.options.isImageFocusPending?.() ?? false)) {
      event.preventDefault();
      if (!core.focusInputBlocked() && core.options.getImageViewportTarget?.()?.read()) consume(event);
      return;
    }
    if (core.modalActive()) {
      event.preventDefault();
      return;
    }
    // 聚焦查看：滚轮缩放由 document capture 阶段的 onDocumentWheel 处理。
    if (model.active) {
      event.preventDefault();
      return;
    }
    // 视频聚焦：滚轮由聚焦 overlay 消费，普通画布不缩放。
    if (core.options.isVideoFocused?.() ?? !!core.options.getVideoFocus?.()) {
      event.preventDefault();
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    consume(event, { left: bounds.left, top: bounds.top });
  };

  return Object.assign(handler, { flushPerfBurst: () => closeBurst() });
}

function now(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === "function" ? perf.now() : Date.now();
}
