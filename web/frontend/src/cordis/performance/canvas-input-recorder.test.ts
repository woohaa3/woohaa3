// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createCanvasInputRecorder } from "./canvas-input-recorder.js";
import { setAppBasePathForTesting } from "../services/app-base-path.js";

afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  setAppBasePathForTesting("/");
});

it("automatically uploads on the timer inside the application mount", async () => {
  vi.useFakeTimers();
  setAppBasePathForTesting("/dev/test/");
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const recorder = createCanvasInputRecorder(window)!;
  recorder.record({ type: "pointerdown", before: { canvasBlocked: true } });
  expect(fetch).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/dev/test/__dev/performance/interactions");
  const payload = JSON.parse(fetch.mock.calls[0][1].body);
  expect(payload).toMatchObject({ category: "canvas-input", runtime: "wasm", sequence: 0,
    samples: [{ type: "pointerdown", before: { canvasBlocked: true } }] });
  expect(fetch.mock.calls[0][1].keepalive).toBe(true);
  recorder.dispose();
});

it("retries the same batch after failure and preserves newer inputs and overflow counts", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const recorder = createCanvasInputRecorder(window)!;
  recorder.record({ id: "blocked-click" });
  await vi.advanceTimersByTimeAsync(500);
  for (let i = 0; i < 260; i++) recorder.record({ id: i });
  await vi.advanceTimersByTimeAsync(500);
  const batches = fetch.mock.calls.map(call => JSON.parse(call[1].body));
  expect(batches[1]).toEqual(batches[0]);
  expect(batches[2]).toMatchObject({ sequence: 1, dropped: 4 });
  expect(batches.slice(2).flatMap(batch => batch.samples)).toHaveLength(256);
  expect(batches[2].samples[0]).toEqual({ id: 4 });
  recorder.dispose();
});

it("pagehide and dispose drain inputs queued behind an in-flight write", async () => {
  vi.useFakeTimers();
  let accept!: (response: { ok: boolean }) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise(resolve => { accept = resolve; }))
    .mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const recorder = createCanvasInputRecorder(window)!;
  recorder.record({ id: "first" });
  await vi.advanceTimersByTimeAsync(500);
  recorder.record({ id: "last" });
  window.dispatchEvent(new Event("pagehide"));
  recorder.dispose();
  accept({ ok: true });
  await recorder.flush();
  expect(fetch.mock.calls.flatMap(call => JSON.parse(call[1].body).samples))
    .toEqual([{ id: "first" }, { id: "last" }]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch).toHaveBeenCalledTimes(2);
});
