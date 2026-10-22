// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installPerformanceRecorder, intervalSummary, numericDelta } from "./record-performance.js";

afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ""; history.replaceState({}, "", "/"); });
describe("performance recorder", () => {
  it("only mounts with explicit query opt-in", () => {
    const dispose = installPerformanceRecorder();
    expect(document.querySelector("button")).toBeNull(); dispose();
  });
  it("captures after ten seconds and cleans up", () => {
    vi.useFakeTimers(); history.replaceState({}, "", "/?recordPerformance=1");
    const getWorkDiagnostics = vi.fn().mockReturnValueOnce({ render: { frames: 10, ms: 20 } }).mockReturnValueOnce({ render: { frames: 40, ms: 35 } });
    Object.assign(window, { __bevyRuntime: { getWorkDiagnostics } });
    const dispose = installPerformanceRecorder();
    const button = document.querySelector("button")!;
    button.click(); expect(button.disabled).toBe(true);
    vi.advanceTimersByTime(10000);
    const result = JSON.parse(document.querySelector("pre")!.textContent!);
    expect(result.rendererWorkDelta).toEqual({ render: { frames: 30, ms: 15 } });
    expect(result.interactionProfile).toEqual({ phases: {}, slowFrames: [], videoEvents: [], videoEventsDropped: 0, slowOperations: [], slowOperationsDropped: 0 });
    expect(button.disabled).toBe(false);
    expect(getWorkDiagnostics).toHaveBeenCalledTimes(2);
    dispose(); expect(document.querySelector("button")).toBeNull();
  });
  it("cancels timers on disposal", () => {
    vi.useFakeTimers(); history.replaceState({}, "", "/?recordPerformance=1");
    const getWorkDiagnostics = vi.fn(() => ({})); Object.assign(window, { __bevyRuntime: { getWorkDiagnostics } });
    const dispose = installPerformanceRecorder(); document.querySelector("button")!.click(); dispose();
    vi.advanceTimersByTime(11000); expect(getWorkDiagnostics).toHaveBeenCalledTimes(1);
  });
  it("summarizes callback intervals and nested counter deltas", () => {
    expect(intervalSummary([10, 20, 30])).toMatchObject({ meanMs: 20, p95Ms: 30, maxMs: 30 });
    expect(intervalSummary([]).p95Ms).toBeNull();
    expect(numericDelta({ count: 5, name: "x" }, { count: 2 })).toEqual({ count: 3 });
  });
});
