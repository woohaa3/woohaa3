import { afterEach, expect, it, vi } from "vitest";
import { createWheelEntryHandler } from "./wheel-entry.js";
import type { InteractionCore } from "../interaction-core.js";
import type { TelemetryEventInput } from "@woohaa3/contracts";
import { setTelemetryClientForTesting } from "../../../services/telemetry-primitives.js";

afterEach(() => {
  vi.resetAllMocks();
  setTelemetryClientForTesting(undefined);
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

it("consumes repeated wheel input without emitting performance events or installing timers", () => {
  const sink = telemetrySink();
  setTelemetryClientForTesting(sink);
  const setTimeout = vi.fn();
  const onWheel = vi.fn(() => ({ kind: "zoom", source: "mouse" }));
  const handler = createWheelEntryHandler(coreOf({ target: { setTimeout } }), { onWheel } as never);
  for (let i = 0; i < 100; i++) handler({ preventDefault: vi.fn() } as unknown as WheelEvent);
  expect(onWheel).toHaveBeenCalledTimes(100);
  expect(sink.events).toEqual([]);
  expect(setTimeout).not.toHaveBeenCalled();
});
