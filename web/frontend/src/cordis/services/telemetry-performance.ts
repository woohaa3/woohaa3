/**
 * 帧窗口聚合（change: 2026-10-25-enhance-telemetry-performance-collection，design D4/D7）。
 *
 * 为什么单独一个模块：窗口要读 `scene-diagnostics` 的热路径计数，那份计数器属于
 * canvas-runtime；启动闭包只该有零依赖的计时原语（`telemetry-primitives.ts`）。所以本模块由
 * canvas-runtime 在**画布页**里静态引入，不参与入口闭包。
 *
 * 逐帧 60 fps × 3600 s = 216,000 行/小时会撞 `telemetry.local.maxRows`（默认 200,000），
 * 所以每 60 s 只产出一条 `perf.frame`。窗口长度是契约常量而不是设置项：采样窗口一变，
 * 历史样本的 p95 立刻不可比，而本机没有任何机制标注"这条样本用的是哪档采样"。
 */
import { TELEMETRY_PERF_FRAME_WINDOW_MS } from "@woohaa3/contracts";
import { activeTelemetryClient, telemetryBuildMode, telemetryNow } from "./telemetry-primitives.js";

export {
  activeTelemetryClient,
  beginPerfInteraction,
  beginStartupSpan,
  isPerfCollectionEnabled,
  recordStartupSpan,
  setTelemetryBuildModeForTesting,
  setTelemetryClientForTesting,
  telemetryBuildMode,
  telemetryNow
} from "./telemetry-primitives.js";
export type { PerfInteractionHandle, TelemetryBuildMode } from "./telemetry-primitives.js";

/** 帧窗口的计数快照（字段名与 `scene-diagnostics` 一致，便于直接对账）。 */
export type PerfFrameCounters = {
  readonly sceneBuilds: number;
  readonly sceneSubmits: number;
  readonly sceneDedupes: number;
  readonly viewportSubmits: number;
  readonly positionSubmits: number;
  readonly sceneStringify: number;
  readonly stringifyMs: number;
  readonly wasmAcceptMs: number;
  readonly frameExecutions: number;
  readonly frameExecutionMs: number;
};

export type PerfFrameWindowOptions = {
  /** 读取累计计数（同一来源；窗口之间做差分）。 */
  read: () => PerfFrameCounters;
  /** 窗口长度；缺省取契约常量。测试可缩短。 */
  windowMs?: number;
  /** 页面是否隐藏（隐藏时丢弃半窗）。 */
  isHidden?: () => boolean;
  /** 定时器（测试注入）。 */
  setInterval?: (handler: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
};

export type PerfFrameWindow = {
  /** 关闭窗口并写入整窗；`discard: true` 只重置基线（半窗丢弃）。 */
  close(options?: { discard?: boolean }): void;
  /** 页面可见性变化：隐藏时丢半窗，恢复后从新窗口重新累计。 */
  visibilityChanged(hidden: boolean): void;
  dispose(): void;
};

const EMPTY_FRAME_COUNTERS: PerfFrameCounters = {
  sceneBuilds: 0,
  sceneSubmits: 0,
  sceneDedupes: 0,
  viewportSubmits: 0,
  positionSubmits: 0,
  sceneStringify: 0,
  stringifyMs: 0,
  wasmAcceptMs: 0,
  frameExecutions: 0,
  frameExecutionMs: 0
};

/**
 * 创建帧窗口聚合器。
 *
 * 计数器是单调累计的；渲染器重建可能让累计值回退，回退按"这一段没跑"处理，绝不输出负值。
 */
export function createPerfFrameWindow(options: PerfFrameWindowOptions): PerfFrameWindow {
  const interval = Math.max(1, Math.trunc(options.windowMs ?? TELEMETRY_PERF_FRAME_WINDOW_MS));
  /** 窗口基线：每条事件只写窗口内的增量，不写进程累计值。 */
  let baseline: PerfFrameCounters = { ...EMPTY_FRAME_COUNTERS };
  /** 窗口起点（单调时钟）：帧率的分母是真实窗口时长，不是猜的常量。 */
  let windowStartedAt = telemetryNow();
  let timer: unknown = null;
  let disposed = false;

  const sample = (): PerfFrameCounters => {
    try {
      return { ...EMPTY_FRAME_COUNTERS, ...options.read() };
    } catch {
      // 读取失败按"没有新工作"处理：不补零估算，也不让窗口异常冒泡。
      return { ...baseline };
    }
  };

  const reset = (): void => {
    baseline = sample();
    windowStartedAt = telemetryNow();
  };

  const close = (closeOptions: { discard?: boolean } = {}): void => {
    if (disposed) return;
    const current = sample();
    const elapsedMs = Math.max(0, telemetryNow() - windowStartedAt);
    const delta = diffCounters(current, baseline, elapsedMs);
    reset();
    // 半窗（页面切后台）、缺构建模式、无客户端：一律不写。窗口里的 0 会污染分位数。
    const mode = telemetryBuildMode();
    if (closeOptions.discard === true || mode === undefined) return;
    const client = activeTelemetryClient();
    if (!client) return;
    try {
      client.record({
        name: "perf.frame",
        result: "success",
        origin: "browser",
        surface: "canvas",
        durationMs: Math.round(delta.averageFrameMs),
        attributes: {
          mode,
          fps: round1(delta.fps),
          sceneBuilds: delta.sceneBuilds,
          sceneSubmits: delta.sceneSubmits,
          sceneDedupes: delta.sceneDedupes,
          viewportSubmits: delta.viewportSubmits,
          positionSubmits: delta.positionSubmits,
          stringify: delta.sceneStringify,
          wasmAcceptMs: Math.round(delta.wasmAcceptMs),
          frameExecMs: round1(delta.averageFrameMs),
          frameExecutions: delta.frameExecutions
        }
      });
    } catch {
      // 见 `telemetry-primitives.ts`：单条事实失败不影响调用方。
    }
  };

  const start = (): void => {
    if (timer !== null || disposed) return;
    const setIntervalFn =
      options.setInterval ?? ((handler: () => void, ms: number) => globalThis.setInterval(handler, ms));
    try {
      timer = setIntervalFn(() => {
        // 页面隐藏时跳过整轮：隐藏期的计数不代表用户看到的画面。
        if (options.isHidden?.() === true) {
          close({ discard: true });
          return;
        }
        close();
      }, interval);
    } catch {
      timer = null;
    }
  };

  start();

  return {
    close,
    visibilityChanged(hidden) {
      // 隐藏即丢掉当前半窗（不把可见段与隐藏段拼成一条），恢复后从新的基线重新累计。
      if (hidden) close({ discard: true });
      else reset();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== null) {
        try {
          const clear =
            options.clearInterval ??
            ((handle: unknown) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>));
          clear(timer);
        } catch {
          // 清理失败没有业务含义。
        }
        timer = null;
      }
      baseline = { ...EMPTY_FRAME_COUNTERS };
    }
  };
}

type FrameDelta = PerfFrameCounters & { readonly averageFrameMs: number; readonly fps: number };

function diffCounters(current: PerfFrameCounters, baseline: PerfFrameCounters, elapsedMs: number): FrameDelta {
  const delta = (key: keyof PerfFrameCounters): number => Math.max(0, current[key] - baseline[key]);
  const frameExecutions = delta("frameExecutions");
  const frameExecutionMs = delta("frameExecutionMs");
  const seconds = Math.max(0, elapsedMs) / 1000;
  return {
    sceneBuilds: delta("sceneBuilds"),
    sceneSubmits: delta("sceneSubmits"),
    sceneDedupes: delta("sceneDedupes"),
    viewportSubmits: delta("viewportSubmits"),
    positionSubmits: delta("positionSubmits"),
    sceneStringify: delta("sceneStringify"),
    stringifyMs: delta("stringifyMs"),
    wasmAcceptMs: delta("wasmAcceptMs"),
    frameExecutions,
    frameExecutionMs,
    averageFrameMs: frameExecutions === 0 ? 0 : frameExecutionMs / frameExecutions,
    // 帧率的分母是窗口的真实墙钟时长：没有样本就是 0，不补估算值。
    fps: frameExecutions === 0 || seconds <= 0 ? 0 : frameExecutions / seconds
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
