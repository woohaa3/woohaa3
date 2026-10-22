// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { setAppBasePathForTesting } from "../services/app-base-path";
import { createLifecycleRecorder } from "./lifecycle-performance.js";

describe("lifecycle recorder", () => {
  afterEach(() => { setAppBasePathForTesting("/"); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it("records overlapping spans once, flags background intervals and cancels outstanding work", async () => {
    let clock = 10, hidden = false;
    vi.spyOn(window.performance, "now").mockImplementation(() => clock);
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const recorder = createLifecycleRecorder(window, true)!;
    const first = recorder.begin("image-prepare");
    clock = 20;
    recorder.begin("video-first-frame");
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    hidden = false;
    clock = 40;
    first(); first("error");
    await recorder.flush();
    recorder.dispose();
    await Promise.resolve(); await Promise.resolve();
    const spans = fetch.mock.calls.flatMap(call => JSON.parse(call[1].body).samples);
    expect(spans.filter(span => span.stage === "image-prepare")).toEqual([
      expect.objectContaining({ startedAt: 10, durationMs: 30, outcome: "ok", hidden: true })
    ]);
    expect(spans.find(span => span.stage === "video-first-frame").outcome).toBe("cancelled");
  });
  it("does nothing when disabled and reports failed batch loss on the next upload", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(createLifecycleRecorder(window, false)).toBeUndefined();
    const recorder = createLifecycleRecorder(window, true)!;
    recorder.begin("app-start")();
    await recorder.flush();
    recorder.begin("wasm-init")("error");
    await recorder.flush();
    expect(JSON.parse(fetch.mock.calls[1][1].body).dropped).toBe(1);
    recorder.dispose();
  });
  it("uploads inside the configured application mount", async () => {
    setAppBasePathForTesting("/dev/test/");
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const recorder = createLifecycleRecorder(window, true)!;
    recorder.begin("app-start")();
    await recorder.flush();
    expect(fetch.mock.calls[0][0]).toBe("/dev/test/__dev/performance/interactions");
    recorder.dispose();
  });
  it("bounds queued samples and preserves overflow counts", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetch);
    const recorder = createLifecycleRecorder(window, true)!;
    for (let i = 0; i < 2050; i++) recorder.begin("image-prepare")();
    await recorder.flush();
    const batch = JSON.parse(fetch.mock.calls[0][1].body);
    expect(batch.samples).toHaveLength(256);
    expect(batch.dropped).toBe(2);
    recorder.dispose();
    await Promise.resolve();
  });
});
