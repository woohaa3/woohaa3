import { afterEach, expect, it, vi } from "vitest";
import { createWheelEntryHandler } from "./wheel-entry.js";
import type { InteractionCore } from "../interaction-core.js";
import type { TelemetryEventInput } from "@woohaa3/contracts";
import { setTelemetryBuildModeForTesting, setTelemetryClientForTesting } from "../../../services/telemetry-primitives.js";

afterEach(() => {
  vi.resetAllMocks();
  setTelemetryClientForTesting(undefined);
  setTelemetryBuildModeForTesting(undefined);
});

/** 采集客户端假件：把事件收进数组，便于断言"发了什么/什么都没发"。 */
function telemetrySink() {
  const events: TelemetryEventInput[] = [];
  return {
    events,
    record: (input: TelemetryEventInput) => events.push(input),
    flush: () => undefined,
    status: () => ({ queued: events.length, droppedOverflow: 0, droppedInvalid: 0, droppedFailed: 0 }),
    dispose: () => undefined
  };
}

function coreOf(overrides: Record<string, unknown> = {}) {
  return {
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    model: { active: false },
    modalActive: () => false,
    focusInputBlocked: () => false,
    // 正式宿主是 window；测试给一个同步宿主，滚轮段因此当场结算（不必等空闲定时器）。
    target: { setTimeout: (handler: () => void) => { handler(); return 1; }, clearTimeout: () => undefined },
    options: {},
    ...overrides
  } as unknown as InteractionCore;
}

it("passes the measured canvas rect into viewport consumption", () => {
  const onWheel = vi.fn(() => ({ kind: "pan", source: "trackpad" }));
  const core = coreOf({ canvas: { getBoundingClientRect: () => ({ left: 12, top: 34 }) } });
  createWheelEntryHandler(core, { onWheel } as never)({ preventDefault: vi.fn() } as unknown as WheelEvent);
  expect(onWheel).toHaveBeenCalledWith(expect.anything(), { left: 12, top: 34 });
});

it("blocks viewport zoom on modal, focused model and video focus", () => {
  const onWheel = vi.fn();
  const base = { canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, options: {} };
  for (const core of [
    coreOf({ ...base, modalActive: () => true }),
    coreOf({ ...base, model: { active: true } }),
    coreOf({ ...base, options: { isVideoFocused: () => true } })
  ]) {
    createWheelEntryHandler(core, { onWheel } as never)({ preventDefault: vi.fn() } as unknown as WheelEvent);
  }
  expect(onWheel).not.toHaveBeenCalled();
});

it("被门禁拒绝的滚轮不产生 perf.interaction", () => {
  setTelemetryBuildModeForTesting("dev");
  const sink = telemetrySink();
  setTelemetryClientForTesting(sink);
  const onWheel = vi.fn();
  const core = coreOf({ modalActive: () => true });
  createWheelEntryHandler(core, { onWheel } as never)({ preventDefault: vi.fn() } as unknown as WheelEvent);
  expect(onWheel).not.toHaveBeenCalled();
  expect(sink.events).toHaveLength(0);
});

it("被视口消费的滚轮产生一条 perf.interaction 与 viewport-apply 分段", () => {
  setTelemetryBuildModeForTesting("dev");
  const sink = telemetrySink();
  setTelemetryClientForTesting(sink);
  const onWheel = vi.fn(() => ({ kind: "pan", source: "trackpad" }));
  createWheelEntryHandler(coreOf(), { onWheel } as never)({ preventDefault: vi.fn() } as unknown as WheelEvent);

  const interactions = sink.events.filter((event) => event.name === "perf.interaction");
  const segments = sink.events.filter((event) => event.name === "perf.segment");
  expect(interactions).toHaveLength(1);
  // 触控板平移在契约里是 `wheel-pan`，与按住空格的 `pan` 区分开。
  expect(interactions[0]?.attributes).toMatchObject({ mode: "dev", kind: "wheel-pan" });
  expect(segments).toHaveLength(1);
  expect(segments[0]?.attributes?.stage).toBe("viewport-apply");
});

it("分类判定不是视口手势时不产生事件", () => {
  setTelemetryBuildModeForTesting("dev");
  const sink = telemetrySink();
  setTelemetryClientForTesting(sink);
  const onWheel = vi.fn(() => null);
  createWheelEntryHandler(coreOf(), { onWheel } as never)({ preventDefault: vi.fn() } as unknown as WheelEvent);
  expect(onWheel).toHaveBeenCalled();
  expect(sink.events).toHaveLength(0);
});
