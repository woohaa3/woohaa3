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
  /** 渲染器实际出帧数（累计）；只有能读到运行时计数时才存在。 */
  readonly renderFrames?: number;
  /** 3D 主 pass draw call 记录数（累计）；与 `renderFrames` 配对求每帧均值。 */
  readonly drawCalls?: number;
  /** 渲染阶段累计墙钟与帧数（仅 dev 能读到运行侧工作诊断）：Queue / Prepare / Render 拆开。 */
  readonly stageQueueMs?: number;
  readonly stageQueueFrames?: number;
  readonly stagePrepareMs?: number;
  readonly stagePrepareFrames?: number;
  readonly stageRenderMs?: number;
  readonly stageRenderFrames?: number;
  /** 累计提交的模型实例数；与 `stageRenderFrames` 配对求每帧均值（draw call 少不代表画得少）。 */
  readonly drawnInstances?: number;
  /** 窗口关闭那一刻的帧节奏标签（`idle` / `dwell` / `active:<忙碌项>`）；不是累计量。 */
  readonly pacing?: string;
  /** 每帧步骤的累计墙钟（ms），按步骤名分组；只有装了步骤计时才存在。 */
  readonly stepMs?: Readonly<Record<string, number>>;
  /** 主世界（Update 图）每帧墙钟累计，以及其中模型同步系统的累计。 */
  readonly stageMainMs?: number;
  readonly stageMainFrames?: number;
  readonly stageModelMs?: number;
  readonly stageModelFrames?: number;
  /** 预览卡片规模快照（`d`=延迟队列、`v`=可见、`l`=在途、`r`=就绪、`b`=纹理 MB）；不是累计量。 */
  readonly previews?: string;
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

const EMPTY_FRAME_COUNTERS: PerfFrameCounters = {  sceneBuilds: 0,
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
 * 窗口内最短可上报片段。画布在整窗到点前卸载时，只有跑够这个时长的可见片段才补写：
 * 再短的分母里几乎全是挂载开销，帧率与每帧耗时都会失真。
 */
const PARTIAL_WINDOW_MIN_MS = 10_000;

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

  // 步骤耗时（`stepMs`）是"每帧花多少"的相对量，首个窗口也得有基线：否则每次刷新后
  // 第一条样本永远缺这一步，而"刚刷新就复现"恰恰是最常被观察的一段。其余累计量保持
  // 原口径（首窗没有先前基线时，累计值本身就是窗口量）。
  try {
    const initialSteps = options.read().stepMs;
    if (initialSteps) baseline = { ...baseline, stepMs: { ...initialSteps } };
  } catch {
    // 读不到步骤计时就照常缺省。
  }

  const reset = (): void => {
    baseline = sample();
    windowStartedAt = telemetryNow();
  };

  const close = (closeOptions: { discard?: boolean } = {}): void => {
    if (disposed) return;
    const current = sample();
    const elapsedMs = Math.max(0, telemetryNow() - windowStartedAt);
    // 窗口刚被重置就立刻到点（恢复前台后的第一次心跳、连挂两次 attach）：分母里没有
    // 可用的观察时长，写出去就是一条 0 帧率的假事实。
    if (elapsedMs < 1_000) {
      reset();
      return;
    }
    const delta = diffCounters(current, baseline, elapsedMs);
    // 每帧 draw call 均值：只有窗口内真的出过帧、且两次都读到了运行时计数才写。
    const drawCalls =
      delta.renderFrames > 0
        ? Math.round(delta.drawCalls / delta.renderFrames)
        : undefined;
    const renderFps =
      delta.renderFps === undefined ? undefined : Math.round(delta.renderFps * 10) / 10;
    const pacing =
      typeof current.pacing === "string" && current.pacing.length > 0 ? current.pacing : undefined;
    const previews =
      typeof current.previews === "string" && current.previews.length > 0 ? current.previews : undefined;
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
          frameExecutions: delta.frameExecutions,
          ...(renderFps === undefined ? {} : { renderFps }),
          ...(drawCalls === undefined ? {} : { drawCalls }),
          ...(delta.queueMs === undefined ? {} : { queueMs: delta.queueMs }),
          ...(delta.prepareMs === undefined ? {} : { prepareMs: delta.prepareMs }),
          ...(delta.renderMs === undefined ? {} : { renderMs: delta.renderMs }),
          ...(delta.drawnInstances === undefined ? {} : { drawnInstances: delta.drawnInstances }),
          ...(delta.mainMs === undefined ? {} : { mainMs: delta.mainMs }),
          ...(delta.modelMs === undefined ? {} : { modelMs: delta.modelMs }),
          ...(delta.steps === undefined ? {} : { steps: delta.steps }),
          ...(pacing === undefined ? {} : { pacing }),
          ...(previews === undefined ? {} : { previews })
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
      // 在可见性**边界**上结算：可见段本身是干净的（隐藏期间没有帧，混进来才会污染分母）。
      // 用户看了一会儿画布再切走，正是最常见的一次观察，丢掉它就等于没有样本。
      if (hidden) {
        const elapsed = telemetryNow() - windowStartedAt;
        if (elapsed >= PARTIAL_WINDOW_MIN_MS) close();
        else close({ discard: true });
      } else reset();
    },
    dispose() {
      if (disposed) return;
      // 画布在整窗到点前卸载（离开画布页、切到别的画布）时，60 秒整窗永远等不到，
      // 这类会话在遥测里彻底消失——短会话正是"看过片场再回来"最需要的事实。
      // 只要这一段是可见的、且已经跑够最短时长，就在卸载前补写。
      try {
        const visible = options.isHidden?.() !== true;
        if (visible && telemetryNow() - windowStartedAt >= PARTIAL_WINDOW_MIN_MS) close();
      } catch {
        // 补写失败不影响卸载。
      }
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

type FrameDelta = PerfFrameCounters & {
  readonly renderFrames: number;
  readonly drawCalls: number;
  /** 画布出帧率；两侧都读不到渲染器计数时为 `undefined`（不是 0）。 */
  readonly renderFps: number | undefined;
  /** 渲染三阶段与实例数的每帧均值；读不到运行侧工作诊断时为 `undefined`。 */
  readonly queueMs: number | undefined;
  readonly prepareMs: number | undefined;
  readonly renderMs: number | undefined;
  readonly drawnInstances: number | undefined;
  /** 主世界每帧墙钟均值：`frameExecMs` 与渲染三阶段之间的缺口。 */
  readonly mainMs: number | undefined;
  /** 主世界里模型同步系统的每帧墙钟均值。 */
  readonly modelMs: number | undefined;
  /** 窗口内最贵的几步（`<步骤>:<每帧 ms>`），按每帧耗时降序取前三。 */
  readonly steps: string | undefined;
  readonly averageFrameMs: number;
  readonly fps: number;
};

function diffCounters(current: PerfFrameCounters, baseline: PerfFrameCounters, elapsedMs: number): FrameDelta {
  type NumericCounterKey = Exclude<keyof PerfFrameCounters, "pacing" | "stepMs" | "previews">;
  const delta = (key: NumericCounterKey): number =>
    Math.max(0, (current[key] ?? 0) - (baseline[key] ?? 0));
  /** 累计量 / 累计帧数；窗口任一端的计数缺失就不写（不用 0 冒充"没花时间"）。 */
  const perFrame = (
    total: NumericCounterKey,
    frames: NumericCounterKey,
    round: (value: number) => number
  ): number | undefined => {
    if (current[total] === undefined || current[frames] === undefined) return undefined;
    const denominator = delta(frames);
    return denominator > 0 ? round(delta(total) / denominator) : undefined;
  };
  const frameExecutions = delta("frameExecutions");
  const frameExecutionMs = delta("frameExecutionMs");
  const seconds = Math.max(0, elapsedMs) / 1000;
  // 窗口内渲染器计数可读时才写帧率。窗口基线缺计数按 0 处理（与 `drawCalls` 同一口径：
  // 首个窗口没有先前基线时，累计值本身就是窗口量）。
  const renderFrames = current.renderFrames === undefined ? undefined : delta("renderFrames");
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
    renderFrames: delta("renderFrames"),
    drawCalls: delta("drawCalls"),
    renderFps: renderFrames === undefined || seconds <= 0 ? undefined : renderFrames / seconds,
    queueMs: perFrame("stageQueueMs", "stageQueueFrames", round2),
    prepareMs: perFrame("stagePrepareMs", "stagePrepareFrames", round2),
    renderMs: perFrame("stageRenderMs", "stageRenderFrames", round2),
    drawnInstances: perFrame("drawnInstances", "stageRenderFrames", Math.round),
    mainMs: perFrame("stageMainMs", "stageMainFrames", round2),
    modelMs: perFrame("stageModelMs", "stageModelFrames", round2),
    steps: formatSteps(current.stepMs, baseline.stepMs, frameExecutions),
    averageFrameMs: frameExecutions === 0 ? 0 : frameExecutionMs / frameExecutions,
    // 帧率的分母是窗口的真实墙钟时长：没有样本就是 0，不补估算值。
    fps: frameExecutions === 0 || seconds <= 0 ? 0 : frameExecutions / seconds
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 窗口内最贵的三步（每帧毫秒）。第一个窗口没有基线就不报：那时"差分"其实是
 * 页面加载至今的累计值，会假报成一步很慢。低于 0.05ms 的步骤不参与排序。
 */
function formatSteps(
  current: Readonly<Record<string, number>> | undefined,
  baseline: Readonly<Record<string, number>> | undefined,
  frames: number
): string | undefined {
  if (!current || !baseline || frames <= 0) return undefined;
  const parts: Array<[string, number]> = [];
  for (const [name, value] of Object.entries(current)) {
    if (!Number.isFinite(value)) continue;
    const perFrame = Math.max(0, value - (baseline[name] ?? 0)) / frames;
    if (perFrame >= 0.05) parts.push([name, perFrame]);
  }
  if (parts.length === 0) return undefined;
  parts.sort((a, b) => b[1] - a[1]);
  return parts.slice(0, 3).map(([name, ms]) => `${name}:${round1(ms)}`).join(",");
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
