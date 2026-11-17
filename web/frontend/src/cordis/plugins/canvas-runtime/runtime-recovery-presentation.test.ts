// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadBevyRuntime, type BevyModule, type BevyRuntime } from "./bevy-runtime.js";
import { mockModule, sceneWith } from "./test-support/runtime-harness.js";

type Handoff = { ready(module: BevyModule): void };
const registry = () => (globalThis as typeof globalThis & { __rendererRealms: Map<string, Handoff> }).__rendererRealms;
let runtime: BevyRuntime | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.body.innerHTML = '<div class="bevy-canvas-surface"><canvas id="bevy-canvas"></canvas></div>';
});
afterEach(() => { runtime?.dispose(); runtime = undefined; document.body.innerHTML = ""; registry()?.clear(); vi.useRealTimers(); });

function healthyModule() {
  const module = mockModule([]);
  let generation = 0;
  let rendered = true;
  module.seed_runtime_generation = value => { generation = value; };
  module.set_scene = () => ++generation;
  module.runtime_health = () => JSON.stringify({ version: "woohaa-runtime-health-v1", updates: 10,
    renders: 10, appliedRevision: 1, appliedGeneration: generation, renderedGeneration: rendered ? generation : 0 });
  return { module, allowRender: (value: boolean) => { rendered = value; } };
}
async function boot() {
  const pending = loadBevyRuntime();
  [...registry().values()][0].ready(healthyModule().module);
  runtime = await pending;
  return runtime;
}
async function beginRecovery() {
  runtime!.recoverRuntime!();
  await vi.advanceTimersByTimeAsync(0);
  const iframe = document.querySelector("iframe")!;
  expect(iframe.style.opacity).toBe("0");
  expect(document.querySelector<HTMLElement>(".bevy-canvas-surface")!.dataset.canvasPresented).toBeUndefined();
  return iframe;
}

it("a healthy replacement reveals the replayed canvas after recovery without another scene submission", async () => {
  const active = await boot(); active.setScene({ ...sceneWith("k", "s"), nodes: [] });
  await vi.advanceTimersByTimeAsync(20);
  const outgoing = document.querySelector("iframe")!;
  expect(outgoing.style.opacity).toBe("1");
  const incoming = await beginRecovery(); expect(outgoing.isConnected).toBe(false);
  [...registry().values()][0].ready(healthyModule().module);
  await vi.advanceTimersByTimeAsync(0);
  expect(active.isReady()).toBe(true);
  expect(incoming.style.opacity).toBe("1");
  expect(document.querySelector<HTMLElement>(".bevy-canvas-surface")!.dataset.canvasPresented).toBe("true");
});

it("a replacement stays covered until the replayed scene generation has rendered", async () => {
  const active = await boot(); active.setScene({ ...sceneWith("k", "s"), nodes: [] });
  await vi.advanceTimersByTimeAsync(20);
  const incoming = await beginRecovery();
  const next = healthyModule(); next.allowRender(false); [...registry().values()][0].ready(next.module);
  await vi.advanceTimersByTimeAsync(50);
  expect(incoming.style.opacity).toBe("0"); expect(active.isReady()).toBe(false);
  next.allowRender(true); await vi.advanceTimersByTimeAsync(50);
  expect(incoming.style.opacity).toBe("1"); expect(active.isReady()).toBe(true);
});

it("recovering before any themed scene keeps the curtain until the first scene arrives", async () => {
  const active = await boot(); const incoming = await beginRecovery();
  [...registry().values()][0].ready(healthyModule().module); await vi.advanceTimersByTimeAsync(0);
  expect(active.isReady()).toBe(true); expect(incoming.style.opacity).toBe("0");
  active.setScene({ ...sceneWith("k", "s"), nodes: [] }); await vi.advanceTimersByTimeAsync(20);
  expect(incoming.style.opacity).toBe("1");
});

it("scoped recovery replaces the visit even when tokens repeat", async () => {
  const makeScoped = () => {
    const fixture = healthyModule();
    const legacy = fixture.module.set_scene;
    const begin = vi.fn(() => "1");
    const end = vi.fn();
    const scopedScene = vi.fn((json: string, _token: string) => legacy(json));
    Object.assign(fixture.module, {
      begin_canvas_scope: begin, end_canvas_scope: end, set_scene_scoped: scopedScene,
      set_texture_scoped: vi.fn(), set_model_media_texture_scoped: vi.fn(),
      set_image_focus_details_scoped: vi.fn(), poll_texture_receipts_scoped: vi.fn(() => "[]")
    });
    return { ...fixture, begin, end, scopedScene };
  };
  const initial = makeScoped();
  const pending = loadBevyRuntime();
  [...registry().values()][0].ready(initial.module);
  runtime = await pending;
  const scene = { ...sceneWith("k", "s"), nodes: [], canvasId: "a" };
  const old = runtime.openCanvasScope!("a")!;
  runtime.setScene(scene);
  await vi.advanceTimersByTimeAsync(20);
  await beginRecovery();
  expect(runtime.closeCanvasScope!(old)).toBe(false);
  expect(() => runtime!.openCanvasScope!("a")).toThrow();
  const replacement = makeScoped();
  [...registry().values()][0].ready(replacement.module);
  await vi.advanceTimersByTimeAsync(0);
  expect(runtime.isReady()).toBe(true);
  expect(replacement.begin).toHaveBeenCalledWith("a");
  expect(replacement.scopedScene).toHaveBeenCalledWith(expect.any(String), "1");
  const current = runtime.openCanvasScope!("a")!;
  expect(current).not.toBe(old);
  expect(current.token).toBe(old.token);
  expect(runtime.closeCanvasScope!(old)).toBe(false);
});

it("scoped recovery refuses a legacy replacement", async () => {
  const initial = healthyModule();
  const originalScene = initial.module.set_scene;
  Object.assign(initial.module, {
    begin_canvas_scope: vi.fn(() => "1"), end_canvas_scope: vi.fn(),
    set_scene_scoped: vi.fn((json: string, _token: string) => originalScene(json)),
    set_texture_scoped: vi.fn(), set_model_media_texture_scoped: vi.fn(),
    set_image_focus_details_scoped: vi.fn(), poll_texture_receipts_scoped: vi.fn(() => "[]")
  });
  const pending = loadBevyRuntime();
  [...registry().values()][0].ready(initial.module);
  runtime = await pending;
  const old = runtime.openCanvasScope!("a")!;
  runtime.setScene({ ...sceneWith("k", "s"), nodes: [], canvasId: "a" });
  await vi.advanceTimersByTimeAsync(20);
  await beginRecovery();
  const replacement = healthyModule();
  const legacyScene = vi.spyOn(replacement.module, "set_scene");
  [...registry().values()][0].ready(replacement.module);
  await vi.advanceTimersByTimeAsync(0);
  expect(legacyScene).not.toHaveBeenCalled();
  expect(runtime.isReady()).toBe(false);
  expect(runtime.closeCanvasScope!(old)).toBe(false);
  expect(() => runtime!.openCanvasScope!("a")).toThrow();
});

it("failed scoped replay never revives the old visit", async () => {
  const initial = healthyModule();
  const originalScene = initial.module.set_scene;
  const methods = {
    begin_canvas_scope: vi.fn(() => "1"), end_canvas_scope: vi.fn(),
    set_texture_scoped: vi.fn(), set_model_media_texture_scoped: vi.fn(),
    set_image_focus_details_scoped: vi.fn(), poll_texture_receipts_scoped: vi.fn(() => "[]")
  };
  Object.assign(initial.module, methods, { set_scene_scoped: vi.fn((json: string, _token: string) => originalScene(json)) });
  const pending = loadBevyRuntime();
  [...registry().values()][0].ready(initial.module);
  runtime = await pending;
  const old = runtime.openCanvasScope!("a")!;
  runtime.setScene({ ...sceneWith("k", "s"), nodes: [], canvasId: "a" });
  await vi.advanceTimersByTimeAsync(20);
  await beginRecovery();
  const replacement = healthyModule();
  const replay = vi.fn(() => { throw new Error("replay failed"); });
  Object.assign(replacement.module, methods, { set_scene_scoped: replay });
  [...registry().values()][0].ready(replacement.module);
  await vi.advanceTimersByTimeAsync(0);
  expect(replay).toHaveBeenCalled();
  expect(runtime.isReady()).toBe(false);
  expect(runtime.closeCanvasScope!(old)).toBe(false);
  expect(() => runtime!.openCanvasScope!("a")).toThrow();
});
