import { afterEach, expect, it, vi } from "vitest";
import { createWheelEntryHandler } from "./wheel-entry.js";
import { createInputSegments } from "../interaction-input-segments.js";
import type { InteractionCore } from "../interaction-core.js";
import type { InteractionRecorder } from "../interaction-performance.js";
import { recordNativeInputCall } from "../../canvas-runtime/native-input-timing.js";

const { preview } = vi.hoisted(() => ({ preview: vi.fn() }));
vi.mock("./model-preview.js", () => ({ modelPreviewWheel: preview }));
afterEach(() => vi.resetAllMocks());
it("attributes a slow preview query and its overlapping IPC before ordinary viewport consumption", () => {
  let now = 0;
  const record = vi.fn();
  const recorder = { now: () => now, record } as unknown as NonNullable<InteractionRecorder>;
  const segments = createInputSegments(recorder);
  const core = { canvas: { getBoundingClientRect: () => ({ left: 0, top: 0 }) }, model: { active: false },
    modalActive: () => false, options: {} } as unknown as InteractionCore;
  preview.mockImplementation(() => { now += 44; recordNativeInputCall("query_point_hit", 39); return false; });
  const viewport = { onWheel: () => { now += 2; return { kind: "pan", source: "trackpad" }; } };
  const handler = createWheelEntryHandler(core, recorder, viewport as never, segments);
  handler({} as WheelEvent);
  expect(record).toHaveBeenCalledWith("pan", "trackpad", "wheel", 0,
    { hitQueryMs: 44, domRectMs: 0, viewportWheelMs: 2 }, undefined, undefined,
    { calls: 1, wallMs: 39, maxMs: 39, slowestMethod: "query_point_hit" });
  // A later input cannot inherit the previous input's bridge span.
  preview.mockReturnValue(false); handler({} as WheelEvent);
  expect(record.mock.calls[1][7]).toBeUndefined();
});
it("records actual preview consumption and cleans up the bridge span if a handler throws", () => {
  const record = vi.fn();
  const recorder = { now: () => 0, record } as unknown as NonNullable<InteractionRecorder>;
  const core = { canvas: {}, model: { active: false }, modalActive: () => false, options: {} } as unknown as InteractionCore;
  const handler = createWheelEntryHandler(core, recorder, {} as never, createInputSegments(recorder));
  preview.mockReturnValue(true); handler({} as WheelEvent);
  expect(record.mock.calls[0].slice(0, 3)).toEqual(["model-preview", "model-preview", "wheel"]);
  preview.mockImplementationOnce(() => { throw new Error("query failed"); });
  expect(() => handler({} as WheelEvent)).toThrow("query failed");
  recordNativeInputCall("query_point_hit", 100);
  preview.mockReturnValue(true); handler({} as WheelEvent);
  expect(record.mock.calls.at(-1)?.[7]).toBeUndefined();
});
