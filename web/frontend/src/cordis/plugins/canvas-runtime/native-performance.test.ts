// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createNativePerformance } from "./native-performance.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function setup() {
  vi.useFakeTimers();
  const sent: Array<Record<string, any>> = [];
  const abort = vi.fn();
  const open = vi.fn();
  class Xhr {
    open = open; setRequestHeader = vi.fn(); abort = abort;
    timeout = 0; onloadend: (() => void) | null = null;
    send(body: string) { sent.push(JSON.parse(body)); }
  }
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("XMLHttpRequest", Xhr);
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => { frames.push(callback); return frames.length; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const metrics = createNativePerformance(globalThis, "test-token");
  return { metrics, sent, abort, open, frames };
}
it("collects bounded XHR quantiles off the input path and sends asynchronously", () => {
  const { metrics, sent, open } = setup();
  for (let i = 1; i <= 4096; i++) metrics.record("set_viewport", i);
  expect(sent).toHaveLength(0);
  vi.advanceTimersByTime(2000);
  expect(open).toHaveBeenCalledWith("POST", "woohaa-native://localhost/rpc", true);
  expect(sent[0]?.args[0].set_viewport).toEqual({ count:4096, windowCount:2048, meanMs:2048.5,
    p50Ms:3072, p95Ms:3994, maxMs:4096 });
  expect(JSON.stringify(sent[0])).not.toContain("test-token");
  metrics.dispose();
});
it("allows only one report in flight, aborts it on disposal and cancels timers", () => {
  const { metrics, sent, abort } = setup();
  metrics.record("query_unrecognized", 3);
  vi.advanceTimersByTime(6000);
  expect(sent).toHaveLength(1);
  expect(sent[0]?.args[0].query_other.count).toBe(1);
  metrics.dispose();
  expect(abort).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  metrics.record("query_unrecognized", 3);
  vi.advanceTimersByTime(2000);
  expect(sent).toHaveLength(1);
});
it("does not count a hidden-page suspension as a visible rAF interval", () => {
  const { metrics, frames, sent } = setup();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  frames[0]!(100); frames[1]!(116);
  document.dispatchEvent(new Event("visibilitychange"));
  frames[2]!(10000); frames[3]!(10017);
  vi.advanceTimersByTime(2000);
  expect(sent[0]?.args[0].raf_interval.count).toBe(2);
  expect(sent[0]?.args[0].raf_interval.maxMs).toBe(17);
  metrics.dispose();
});

it("persists background work with freshness while excluding model IDs and content", () => {
  const { metrics, sent } = setup();
  metrics.recordWork({ snapshotBuilds: 2, renderStages: { work: { renderMs: 7, renderFrames: 3 } }, secret: "content" }, 100, 108);
  vi.advanceTimersByTime(2000);
  expect(sent[0]?.args[1]).toEqual({ readStartedAtMonotonicMs: 100, observedAtMonotonicMs: 108, readWallMs: 8,
    renderMs: 7, renderFrames: 3, snapshotBuilds: 2 });
  expect(JSON.stringify(sent)).not.toContain("content");
  metrics.dispose();
});
