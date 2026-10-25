import { afterEach, expect, it, vi } from "vitest";
import { createWheelEntryHandler } from "./wheel-entry.js";
import type { InteractionCore } from "../interaction-core.js";

const { preview } = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("./model-preview.js", () => ({ modelPreviewWheel: preview }));
afterEach(() => vi.resetAllMocks());

function coreOf(overrides: Record<string, unknown> = {}) {
  return {
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    model: { active: false },
    modalActive: () => false,
    focusInputBlocked: () => false,
    options: {},
    ...overrides
  } as unknown as InteractionCore;
}

it("preview consumption short-circuits viewport handling", () => {
  preview.mockReturnValue(true);
  const onWheel = vi.fn();
  const handler = createWheelEntryHandler(coreOf(), { onWheel } as never);
  const event = { preventDefault: vi.fn() } as unknown as WheelEvent;
  handler(event);
  expect(onWheel).not.toHaveBeenCalled();
});

it("passes the measured canvas rect into viewport consumption", () => {
  preview.mockReturnValue(false);
  const onWheel = vi.fn(() => ({ kind: "pan", source: "trackpad" }));
  const core = coreOf({ canvas: { getBoundingClientRect: () => ({ left: 12, top: 34 }) } });
  createWheelEntryHandler(core, { onWheel } as never)({ preventDefault: vi.fn() } as unknown as WheelEvent);
  expect(onWheel).toHaveBeenCalledWith(expect.anything(), { left: 12, top: 34 });
});

it("blocks viewport zoom on modal, focused model and video focus", () => {
  preview.mockReturnValue(false);
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

it("a throwing preview query propagates without consuming viewport", () => {
  preview.mockImplementationOnce(() => { throw new Error("query failed"); });
  const onWheel = vi.fn();
  const handler = createWheelEntryHandler(coreOf(), { onWheel } as never);
  expect(() => handler({ preventDefault: vi.fn() } as unknown as WheelEvent)).toThrow("query failed");
  expect(onWheel).not.toHaveBeenCalled();
});
