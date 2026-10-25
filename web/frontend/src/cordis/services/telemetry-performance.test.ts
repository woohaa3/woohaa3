/**
 * 帧窗口聚合测试（change: 2026-10-25-enhance-telemetry-performance-collection，任务 3.5）。
 *
 * 守的是 spec 里三条可验证的口径：
 * - 一小时的静止画布最多约 60 条 `perf.frame`，没有逐帧事件；
 * - 窗口内切到后台时半窗被丢弃，恢复后从新窗口累计；
 * - 构建模式缺失时不发（不以 `unknown` 占位）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TelemetryEventInput } from "@woohaa3/contracts";
import {
  createPerfFrameWindow,
  setTelemetryBuildModeForTesting,
  setTelemetryClientForTesting,
  type PerfFrameCounters
} from "./telemetry-performance.js";

function counters(overrides: Partial<PerfFrameCounters> = {}): PerfFrameCounters {
  return {
    sceneBuilds: 0,
    sceneSubmits: 0,
    sceneDedupes: 0,
    viewportSubmits: 0,
    positionSubmits: 0,
    sceneStringify: 0,
    stringifyMs: 0,
    wasmAcceptMs: 0,
    frameExecutions: 0,
    frameExecutionMs: 0,
    ...overrides
  };
}

/** 可控定时器：测试自己决定"到点了"。 */
function fakeTimers() {
  let handler: (() => void) | null = null;
  const cleared: unknown[] = [];
  return {
    setInterval: (next: () => void) => {
      handler = next;
      return "timer";
    },
    clearInterval: (handle: unknown) => {
      cleared.push(handle);
      handler = null;
    },
    tick: () => handler?.(),
    cleared
  };
}

function client() {
  const events: TelemetryEventInput[] = [];
  return {
    events,
    record: (input: TelemetryEventInput) => events.push(input),
    flush: () => undefined,
    status: () => ({ queued: events.length, droppedOverflow: 0, droppedInvalid: 0, droppedFailed: 0 }),
    dispose: () => undefined
  };
}

afterEach(() => {
  setTelemetryClientForTesting(undefined);
  setTelemetryBuildModeForTesting(undefined);
  vi.restoreAllMocks();
});

describe("帧窗口聚合", () => {
  it("一个窗口只产出一条 perf.frame，携带窗口内的增量而不是累计值", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const timers = fakeTimers();
    // 墙钟：窗口 60 s 内执行了 3600 帧。注入时钟避免依赖真实等待。
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    let state = counters();
    const window = createPerfFrameWindow({
      read: () => state,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    });

    state = counters({
      sceneBuilds: 1,
      sceneSubmits: 1,
      sceneDedupes: 2,
      viewportSubmits: 10,
      positionSubmits: 3,
      sceneStringify: 1,
      stringifyMs: 4,
      wasmAcceptMs: 6,
      frameExecutions: 3600,
      frameExecutionMs: 3600
    });
    clock = 60_000;
    timers.tick();

    expect(sink.events).toHaveLength(1);
    const [frame] = sink.events;
    expect(frame?.name).toBe("perf.frame");
    expect(frame?.attributes).toMatchObject({
      mode: "dev",
      sceneBuilds: 1,
      sceneSubmits: 1,
      sceneDedupes: 2,
      viewportSubmits: 10,
      positionSubmits: 3,
      stringify: 1,
      wasmAcceptMs: 6,
      frameExecutions: 3600
    });
    // 帧率的分母是真实窗口时长（60 s），不是猜的 60 fps。
    expect(frame?.attributes?.fps).toBe(60);
    // durationMs 是窗口内平均帧执行耗时。
    expect(frame?.durationMs).toBe(1);

    // 第二个窗口只写增量：累计值不重复计入。
    clock = 120_000;
    state = counters({ ...state, sceneBuilds: 2, frameExecutions: 3660, frameExecutionMs: 3660 });
    timers.tick();
    expect(sink.events).toHaveLength(2);
    expect(sink.events[1]?.attributes?.sceneBuilds).toBe(1);
    expect(sink.events[1]?.attributes?.frameExecutions).toBe(60);
    window.dispose();
  });

  it("页面隐藏时丢弃半窗，恢复后从新窗口重新累计", () => {
    setTelemetryBuildModeForTesting("production");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const timers = fakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    let state = counters({ frameExecutions: 900, frameExecutionMs: 900 });
    const window = createPerfFrameWindow({
      read: () => state,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      isHidden: () => hidden
    });
    let hidden = false;

    // 30 s 时切后台：这半窗不得写入。
    clock = 30_000;
    hidden = true;
    window.visibilityChanged(true);
    timers.tick();
    expect(sink.events).toHaveLength(0);

    // 恢复前台：从新的基线重新累计，隐藏期的计数不进入样本。
    hidden = false;
    window.visibilityChanged(false);
    state = counters({ frameExecutions: 900 + 1800, frameExecutionMs: 900 + 1800 });
    clock = 90_000;
    timers.tick();
    expect(sink.events).toHaveLength(1);
    // 只有恢复之后的 1800 帧计入；隐藏期间已有的 900 帧不会被补发。
    expect(sink.events[0]?.attributes?.frameExecutions).toBe(1800);
    window.dispose();
  });

  it("构建模式缺失时不发任何 perf.frame", () => {
    const sink = client();
    setTelemetryClientForTesting(sink);
    const timers = fakeTimers();
    const window = createPerfFrameWindow({
      read: () => counters({ frameExecutions: 10, frameExecutionMs: 10 }),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    });
    timers.tick();
    expect(sink.events).toHaveLength(0);
    window.dispose();
  });

  it("计数器回退（渲染器重建）按 0 处理，绝不输出负值", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const timers = fakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    let state = counters({ sceneBuilds: 5, frameExecutions: 100, frameExecutionMs: 200 });
    const window = createPerfFrameWindow({
      read: () => state,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    });
    // 第一窗建立高水位基线。
    clock = 60_000;
    timers.tick();
    expect(sink.events[0]?.attributes?.sceneBuilds).toBe(5);
    // 渲染器重建让累计值回退：这一段按"没跑"处理。
    state = counters({ sceneBuilds: 1, frameExecutions: 3, frameExecutionMs: 3 });
    clock = 120_000;
    timers.tick();
    expect(sink.events).toHaveLength(2);
    expect(sink.events[1]?.attributes?.sceneBuilds).toBe(0);
    expect(sink.events[1]?.attributes?.frameExecutions).toBe(0);
    window.dispose();
  });

  it("dispose 后不再写事件，也不再保留定时器", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const timers = fakeTimers();
    const window = createPerfFrameWindow({
      read: () => counters({ frameExecutions: 10, frameExecutionMs: 10 }),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    });
    window.dispose();
    expect(timers.cleared).toEqual(["timer"]);
    timers.tick();
    window.close();
    expect(sink.events).toHaveLength(0);
  });
});
