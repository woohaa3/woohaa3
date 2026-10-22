import { afterEach, describe, expect, it, vi } from "vitest";
import { sceneDiagnostics, resetSceneDiagnostics } from "../canvas-runtime/scene-diagnostics.js";
import { createInteractionRecorder, type InteractionSample } from "./interaction-performance.js";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => { nodeSelectionStore.reset(); vi.unstubAllEnvs(); });

function recordingTarget(base: Record<string, unknown> = {}) {
  let now = 0;
  let nextId = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { cb: () => void; at: number }>();
  const listeners = new Map<string, () => void>();
  const batches: Array<{ samples: Array<{ kind: string; source: string; phase: string; release?: string; handlerMs: number; nextRafMs: number | null }>; dropped: number }> = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    batches.push(JSON.parse(init.body as string));
    return { ok: true, status: 204 };
  });
  let tick: () => void = () => {};
  const target = {
    ...base,
    performance: { timeOrigin: 1234, now: () => now },
    crypto: { randomUUID: () => "test-recorder" },
    navigator: { userAgent: "test", platform: "Linux" },
    innerWidth: 1000, innerHeight: 800, devicePixelRatio: 1,
    console: { warn: vi.fn() },
    document: { hidden: false, addEventListener: (name: string, cb: () => void) => listeners.set(name, cb),
      removeEventListener: (name: string) => listeners.delete(name) },
    fetch,
    requestAnimationFrame: (cb: FrameRequestCallback) => { const id = nextId++; frames.set(id, cb); return id; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
    setTimeout: base.setTimeout ?? ((cb: () => void, ms: number) => { const id = nextId++; timers.set(id, { cb, at: now + ms }); return id; }),
    clearTimeout: base.clearTimeout ?? ((id: number) => timers.delete(id)),
    setInterval: (cb: () => void) => { tick = cb; return 1; },
    clearInterval: vi.fn(),
    addEventListener: base.addEventListener ?? ((name: string, cb: () => void) => listeners.set(name, cb)),
    removeEventListener: base.removeEventListener ?? ((name: string) => listeners.delete(name))
  } as unknown as Window & typeof globalThis;
  return { target, batches, fetch, frames, listeners, tick: () => tick(), setNow: (value: number) => { now = value; for (const [id, timer] of timers) { if (timer.at <= now) { timers.delete(id); timer.cb(); } } },
    frame: () => { const callbacks = [...frames.values()]; frames.clear(); for (const cb of callbacks) cb(now); } };
}

describe("interaction performance recording", () => {
  it("coalesces rAF observation, measures durations and flushes only in batches", async () => {
    const f = recordingTarget();
    const recorder = createInteractionRecorder(f.target)!;
    f.setNow(3);
    recorder.record("pan", "pointer", "move", 1);
    recorder.record("zoom", "pinch", "wheel", 2);
    expect(f.frames.size).toBe(1);
    expect(f.fetch).not.toHaveBeenCalled();
    f.setNow(17);
    f.frame();
    f.tick();
    await vi.waitFor(() => expect(f.batches).toHaveLength(1));
    expect(f.batches[0].samples).toMatchObject([
      { handlerMs: 2, nextRafMs: 16 }, { handlerMs: 1, nextRafMs: 15 }
    ]);
    recorder.dispose();
    expect(f.target.clearInterval).toHaveBeenCalled();
  });

  it("bounds memory and reports overflow plus failed uploads", async () => {
    const f = recordingTarget();
    const recorder = createInteractionRecorder(f.target)!;
    for (let i = 0; i < 2050; i++) recorder.record("drag", "pointer", "move", 0);
    f.frame();
    f.fetch.mockRejectedValueOnce(new Error("offline"));
    f.tick();
    await vi.waitFor(() => expect(f.target.console.warn).toHaveBeenCalled());
    f.tick();
    await vi.waitFor(() => expect(f.batches.reduce((sum, b) => sum + b.samples.length, 0)).toBe(1792));
    expect(f.batches[0].dropped).toBe(258);
    expect(f.batches.every((b) => b.samples.length <= 256)).toBe(true);
    recorder.dispose();
  });

  it("settles missing frames and flushes on dispose; can be disabled", () => {
    const f = recordingTarget();
    const recorder = createInteractionRecorder(f.target)!;
    recorder.record("pan", "pointer", "move", 0);
    recorder.dispose();
    expect(f.frames.size).toBe(0);
    expect(f.batches[0].samples[0].nextRafMs).toBeNull();
    expect(f.fetch.mock.calls[0][1].keepalive).toBe(true);
    vi.stubEnv("VITE_WOOHAA_PERFORMANCE", "0");
    expect(createInteractionRecorder(f.target)).toBeUndefined();
  });

  it("flushes pending samples when hiding during an in-flight upload", async () => {
    const f = recordingTarget();
    const recorder = createInteractionRecorder(f.target)!;
    let resolveUpload: (value: { ok: boolean; status: number }) => void = () => {};
    f.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveUpload = resolve; }));
    recorder.record("pan", "pointer", "move", 0);
    f.frame();
    f.tick();
    recorder.record("zoom", "pinch", "wheel", 0);
    Object.defineProperty(f.target.document, "hidden", { value: true });
    f.listeners.get("visibilitychange")!();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    resolveUpload({ ok: true, status: 204 });
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(2));
    expect(f.batches[0].samples[0].nextRafMs).toBeNull();
    expect(f.fetch.mock.calls[1][1].keepalive).toBe(true);
    recorder.dispose();
  });

  it("records actual pan, drag, wheel/pinch and controls while ignoring hover and blocked input", () => {
    woohaa3CanvasStore.getState().applyRemoteCanvas(canvasWith([{ id: "n1", x: 0, y: 0 }]));
    const dom = harness();
    const f = recordingTarget(dom.target);
    const { runtime } = runtimeCapturing();
    let blocked = false;
    const controller = installInteractionController({ canvas: dom.canvas, target: f.target,
      getRuntime: () => runtime, getSession: () => getSession() as never, isModalActive: () => blocked });
    controller.restoreViewport({ x: 0, y: 0, zoom: 1 });
    controller.flush();
    dom.fire("pointermove", { clientX: 100, clientY: 100 });
    dom.fire("pointerdown", { clientX: 100, clientY: 100 });
    dom.fire("pointermove", { clientX: 130, clientY: 100 });
    dom.fire("pointerup", { clientX: 130, clientY: 100 });
    dom.fire("pointerdown", { button: 1, clientX: 800, clientY: 700 });
    dom.fire("pointermove", { clientX: 810, clientY: 700 });
    dom.fire("pointerup", { clientX: 810, clientY: 700 });
    dom.fire("wheel", { deltaX: 2, deltaY: 3, deltaMode: 0, timeStamp: 10 });
    dom.fire("wheel", { deltaX: 0, deltaY: 100, deltaMode: 1, timeStamp: 300 });
    dom.fire("wheel", { deltaX: 0, deltaY: -2, deltaMode: 0, ctrlKey: true, timeStamp: 310 });
    controller.zoomTo(1);
    blocked = true;
    dom.fire("wheel", { deltaX: 0, deltaY: 100, deltaMode: 1 });
    controller.dispose();
    expect(f.batches.flatMap((b) => b.samples).map((s) => `${s.kind}/${s.source}/${s.phase}`)).toEqual([
      "drag/pointer/down", "drag/pointer/move", "drag/pointer/up",
      "pan/pointer/down", "pan/pointer/move", "pan/pointer/up",
      "pan/trackpad/wheel", "zoom/mouse/wheel", "zoom/pinch/wheel", "zoom/zoom-to/control"
    ]);
    expect(f.batches.flatMap(b => b.samples).find(s => s.kind === "drag" && s.phase === "up")?.release).toBe("move-submit");
  });
});

describe("timing schema v3", () => {
  it("reports diagnostic read cost once outside the input handler", async () => {
    resetSceneDiagnostics();
    const f = recordingTarget();
    const recorder = createInteractionRecorder(f.target, { refreshDiagnostics: () => f.setNow(f.target.performance.now() + 4) })!;
    f.setNow(2);
    recorder.record("drag", "pointer", "move", 1);
    recorder.record("drag", "pointer", "move", 5);
    f.setNow(20); f.frame(); f.setNow(124); f.tick();
    await vi.waitFor(() => expect(f.batches).toHaveLength(1));
    const samples = f.batches[0].samples as unknown as InteractionSample[];
    expect(samples[0].handlerMs).toBe(1);
    expect(samples[1].handlerMs).toBe(1);
    expect(samples[0].frame).toMatchObject({ diagnosticsReadMs: 8, diagnosticsReads: 2 });
    expect(samples[1].frame).toBeUndefined();
    recorder.dispose();
  });
  it("refreshes Rust only at interval boundaries and isolates diagnostic failures", async () => {
    resetSceneDiagnostics();
    let reads = 0;
    const f = recordingTarget();
    const recorder = createInteractionRecorder(f.target, { refreshDiagnostics: () => {
      reads++;
      if (reads === 1) throw new Error("unavailable renderer");
      sceneDiagnostics.rustRenderMs = 5;
      sceneDiagnostics.rustRenderFrames = 1;
    } })!;
    for (let index = 0; index < 100; index++) recorder.record("drag", "pointer", "move", 0);
    expect(reads).toBe(1);
    f.setNow(102); f.frame(); f.tick();
    await vi.waitFor(() => expect(f.batches).toHaveLength(1));
    expect(reads).toBe(2);
    const frames = (f.batches[0].samples as unknown as InteractionSample[]).filter(sample => sample.frame);
    expect(frames).toHaveLength(1);
    expect(frames[0].frame?.rustRenderMs).toBeUndefined(); // unknown start, never inferred zero
    recorder.dispose();
  });
  it("owns counters once per interval and separates wait from measured execution", async () => {
    resetSceneDiagnostics();
    const f = recordingTarget();
    const recorder = createInteractionRecorder(f.target)!;
    sceneDiagnostics.rustRenderMs = 10;
    sceneDiagnostics.rustRenderFrames = 2;
    f.setNow(2);
    recorder.record("drag", "pointer", "move", 1);
    recorder.record("drag", "pointer", "move", 1);
    sceneDiagnostics.frameExecutions += 1;
    sceneDiagnostics.frameExecutionMs += 3;
    sceneDiagnostics.rustRenderMs += 4.5;
    sceneDiagnostics.rustRenderFrames += 1;
    sceneDiagnostics.sceneStringify += 1;
    sceneDiagnostics.cardBlockBuilds += 2;
    sceneDiagnostics.cardDecorationBuilds += 1;
    sceneDiagnostics.edgeBlockBuilds += 3;
    sceneDiagnostics.containerBlockBuilds += 2;
    f.setNow(102); f.frame(); f.tick();
    await vi.waitFor(() => expect(f.batches).toHaveLength(1));
    const samples = f.batches[0].samples as unknown as Array<{ intervalId: number; frame?: { frameExecutionMs: number; sceneStringify: number }; segments: { rafWaitMs: number; frameWorkMs?: number } }>;
    expect(samples[0].intervalId).toBe(samples[1].intervalId);
    expect(samples.filter(sample => sample.frame)).toHaveLength(1);
    expect(samples[0].frame).toMatchObject({ rustRenderMs: 4.5, rustRenderFrames: 1, frameExecutionMs: 3, sceneStringify: 1, cardBlockBuilds: 2, cardDecorationBuilds: 1, edgeBlockBuilds: 3, containerBlockBuilds: 2 });
    expect(samples[0].segments).toMatchObject({ rafWaitMs: 100 });
    expect(samples[0].segments.frameWorkMs).toBeUndefined();
    recorder.dispose();
  });
  it("retains event identity and picks up queued long tasks delivered after rAF", async () => {
    let identity = { js: "first", wasm: "wasm-first", mode: "development" };
    let entries: PerformanceEntry[] = [];
    class Observer {
      static supportedEntryTypes = ["longtask"];
      observe() {}
      disconnect() {}
      takeRecords() { const out = entries; entries = []; return out; }
    }
    const f = recordingTarget({ PerformanceObserver: Observer });
    const recorder = createInteractionRecorder(f.target, { identity: () => ({ ...identity }) })!;
    f.setNow(2); recorder.record("pan", "pointer", "move", 1);
    f.setNow(60); f.frame();
    entries = [{ startTime: 0, duration: 55 } as PerformanceEntry];
    identity = { js: "second", wasm: "wasm-second", mode: "development" };
    f.tick();
    f.setNow(160); // Complete the bounded late-observer settlement interval.
    await vi.waitFor(() => expect(f.batches).toHaveLength(1));
    expect(f.batches[0].samples[0]).toMatchObject({ context: { identity: { js: "first" } }, segments: { longTaskMs: 55 } });
    recorder.dispose();
  });
});

describe("bounded long-task settlement", () => {
  it("waits once for late observer delivery and closes remaining work immediately", async () => {
    let entries: PerformanceEntry[] = [];
    class Observer {
      static supportedEntryTypes = ["longtask"];
      observe() {}
      disconnect() {}
      takeRecords() { const out = entries; entries = []; return out; }
    }
    let settle: () => void = () => {};
    const setTimeout = vi.fn((cb: () => void, delay: number) => { settle = cb; expect(delay).toBe(100); return 42; });
    const clearTimeout = vi.fn();
    const f = recordingTarget({ PerformanceObserver: Observer, setTimeout, clearTimeout });
    const recorder = createInteractionRecorder(f.target)!;
    f.setNow(2); recorder.record("drag", "pointer", "move", 1);
    f.setNow(60); f.frame(); f.tick(); f.tick();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(setTimeout).toHaveBeenCalledTimes(1);
    entries = [{ startTime: 0, duration: 55 } as PerformanceEntry, { startTime: 0, duration: 55 } as PerformanceEntry];
    f.setNow(160); settle();
    await vi.waitFor(() => expect(f.batches).toHaveLength(1));
    expect(f.batches[0].samples[0]).toMatchObject({ nextRafMs: 59, segments: { longTaskMs: 55 } });
    f.setNow(162); recorder.record("drag", "pointer", "up", 161);
    f.setNow(170); f.frame(); f.tick();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    recorder.dispose();
    await vi.waitFor(() => expect(f.batches).toHaveLength(2));
    expect(clearTimeout).toHaveBeenCalledWith(42);
    expect(f.fetch.mock.calls[1][1].keepalive).toBe(true);
  });
});
