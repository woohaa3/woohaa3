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

  it("能读到渲染计数时按窗口内渲染帧数折算每帧 draw call", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const timers = fakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    // 首个窗口没有先前基线：累计值本身就是窗口量。
    let state = counters();
    const window = createPerfFrameWindow({
      read: () => state,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    });
    state = counters({ renderFrames: 400, drawCalls: 4800, frameExecutions: 300 });
    clock = 60_000;
    timers.tick();
    // 窗口内 400 个渲染帧、4800 次记录 → 每帧 12 次；累计值不直接外泄。
    expect(sink.events[0]?.attributes?.drawCalls).toBe(12);
    // 同一窗口的渲染器计数也给出画布出帧率：400 帧 / 60 s。
    expect(sink.events[0]?.attributes?.renderFps).toBe(6.7);
    window.dispose();
  });

  it("能读到渲染阶段计数时按窗口内帧数折算每帧渲染耗时与实例数", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const timers = fakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    // 首个窗口没有先前基线：累计值本身就是窗口量（与 drawCalls 同一口径）。
    let state = counters();
    const window = createPerfFrameWindow({
      read: () => state,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    });
    state = counters({
      renderFrames: 600,
      drawCalls: 1200,
      stageQueueMs: 30,
      stageQueueFrames: 60,
      stagePrepareMs: 300,
      stagePrepareFrames: 60,
      stageRenderMs: 900,
      stageRenderFrames: 60,
      drawnInstances: 240000,
      stageMainMs: 1200,
      stageMainFrames: 60,
      stageModelMs: 180,
      stageModelFrames: 60,
      pacing: "active:previews",
      previews: "d2,v3,l1,r4,b48"
    });
    clock = 60_000;
    timers.tick();
    // 60 个渲染帧：queue 0.5ms、prepare 5ms、render 15ms，每帧 4000 个实例。
    expect(sink.events[0]?.attributes?.queueMs).toBe(0.5);
    expect(sink.events[0]?.attributes?.prepareMs).toBe(5);
    expect(sink.events[0]?.attributes?.renderMs).toBe(15);
    expect(sink.events[0]?.attributes?.drawnInstances).toBe(4000);
    // 主世界每帧 20ms、其中模型同步 3ms：JS 帧循环与渲染三阶段都没覆盖这一层。
    expect(sink.events[0]?.attributes?.mainMs).toBe(20);
    expect(sink.events[0]?.attributes?.modelMs).toBe(3);
    expect(sink.events[0]?.attributes?.pacing).toBe("active:previews");
    // 预览规模是快照而不是累计量：直接透传，不做差分。
    expect(sink.events[0]?.attributes?.previews).toBe("d2,v3,l1,r4,b48");
    window.dispose();
  });

  it("只报窗口内最贵的三步，首个窗口也按开窗基线求", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const timers = fakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    // 开窗时已累计的步骤耗时属于页面加载至今，不能当成这个窗口的均值——所以开窗就
    // 采一次 stepMs 基线；首窗只报开窗之后的增量（这里 400ms / 60 帧）。
    let state = counters({ stepMs: { "video-sync": 500 } });
    const window = createPerfFrameWindow({
      read: () => state,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    });
    state = counters({ frameExecutions: 60, stepMs: { "video-sync": 900 } });
    clock = 60_000;
    timers.tick();
    expect(sink.events[0]?.attributes?.steps).toBe("video-sync:6.7");

    // 第二个窗口：60 帧内 video-sync 又多花 300ms、image-sync 30ms、frame 12ms。
    state = counters({
      frameExecutions: 120,
      stepMs: { "video-sync": 1200, "image-sync": 30, frame: 12, tiny: 3 }
    });
    clock = 120_000;
    timers.tick();
    // 每帧：5ms / 0.5ms / 0.2ms；低于 0.05ms 的步骤不参与，最多取前三。
    expect(sink.events[1]?.attributes?.steps).toBe("video-sync:5,image-sync:0.5,frame:0.2");
    window.dispose();
  });

  it("读不到渲染计数时不写 drawCalls", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const timers = fakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);
    let state = counters();
    const window = createPerfFrameWindow({
      read: () => state,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    });
    state = counters({ frameExecutions: 300 });
    clock = 60_000;
    timers.tick();
    expect(sink.events[0]?.attributes).not.toHaveProperty("drawCalls");
    expect(sink.events[0]?.attributes).not.toHaveProperty("renderFps");
    expect(sink.events[0]?.attributes).not.toHaveProperty("renderMs");
    expect(sink.events[0]?.attributes).not.toHaveProperty("drawnInstances");
    expect(sink.events[0]?.attributes).not.toHaveProperty("pacing");
    window.dispose();
  });

  it("页面隐藏时在可见边界结算，恢复后从新窗口重新累计", () => {
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

    // 30 s 时切后台：这一段的 30 s 是干净的可见段，按边界结算写出去。
    clock = 30_000;
    hidden = true;
    window.visibilityChanged(true);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.attributes?.frameExecutions).toBe(900);
    expect(sink.events[0]?.attributes?.fps).toBe(30);

    // 后台的 60 秒里计数仍在涨（900 → 2700），但不进入任何窗口。
    clock = 90_000;
    state = counters({ frameExecutions: 2700, frameExecutionMs: 2700 });
    hidden = false;
    window.visibilityChanged(false);
    timers.tick();
    expect(sink.events).toHaveLength(1);

    // 回到前台再跑 60 秒：只计恢复之后的 600 帧。
    clock = 150_000;
    state = counters({ frameExecutions: 3300, frameExecutionMs: 3300 });
    timers.tick();
    expect(sink.events).toHaveLength(2);
    expect(sink.events[1]?.attributes?.frameExecutions).toBe(600);
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

  it("画布中途卸载时补写跑够最短时长的可见片段", () => {
    setTelemetryBuildModeForTesting("dev");
    const sink = client();
    setTelemetryClientForTesting(sink);
    const timers = fakeTimers();
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => clock);

    // 只有 3 秒：挂载开销占比太大，不补写。
    const short = createPerfFrameWindow({
      read: () => counters({ frameExecutions: 300, frameExecutionMs: 300 }),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    });
    clock = 3_000;
    short.dispose();
    expect(sink.events).toHaveLength(0);

    // 12 秒：补写整段，帧率仍按真实墙钟求。
    const window = createPerfFrameWindow({
      read: () => counters({ frameExecutions: 600, frameExecutionMs: 600 }),
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval
    });
    clock = 15_000;
    window.dispose();
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.attributes?.fps).toBe(50);
    expect(sink.events[0]?.attributes?.frameExecutions).toBe(600);
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
