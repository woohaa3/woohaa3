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
