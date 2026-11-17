// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { modelSceneExtension } from "./plugin.js";
import { modelSceneStore } from "./model-scene-store.js";
import type { CanvasScope } from "../canvas-runtime/canvas-scope.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  modelSceneStore.delete("node");
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function canvas() {
  return {
    id: "A",
    document: { nodes: [{ id: "node" }] },
    nodeData: { node: {} }
  };
}

it("同一画布的 renderer scope 重建也会丢弃旧 prepare 并重新准备", async () => {
  const oldResource = { token: "old" };
  const currentResource = { token: "current" };
  const scopeA = Object.freeze({ canvasId: "A", token: "1", sequence: 1 });
  const scopeB = Object.freeze({ canvasId: "A", token: "2", sequence: 2 });
  let scope: CanvasScope = scopeA;
  const scopeListeners = new Set<() => void>();
  const runtime = {
    currentCanvasScope: () => scope,
    subscribeCanvasScope: (listener: () => void) => {
      scopeListeners.add(listener);
      return () => scopeListeners.delete(listener);
    }
  };
  let resolveFirst: (value: { status: "ok"; resource: unknown }) => void = () => {};
  const firstPrepare = new Promise<{ status: "ok"; resource: unknown }>((resolve) => { resolveFirst = resolve; });
  let prepares = 0;
  const provider = {
    reportsStatus: false,
    executionKey: () => "same",
    prepare: vi.fn(() => {
      prepares += 1;
      return prepares === 1 ? firstPrepare : Promise.resolve({ status: "ok" as const, resource: currentResource });
    })
  };
  let current = canvas();
  const listeners = new Set<() => void>();
  let effectCleanup = () => {};
  const canvasRuntime = { runtime: () => runtime, subscribe: () => () => {} };
  const ctx = {
    effect: (effect: () => () => void) => { effectCleanup = effect(); },
    provide: () => {},
    get: (key: unknown) => key === "canvasRuntime" ? canvasRuntime : undefined,
    canvasRemote: { reportModelScript: vi.fn() },
    canvasState: {
      getCanvas: () => current,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }
    },
    nodeImplementations: {
      resolve: () => ({ generation: 1, modelPreparation: provider }),
      subscribe: () => () => {}
    }
  };
  const returned = modelSceneExtension({ schedule: (run) => run(), yieldToBrowser: async () => {} })(ctx as never, undefined);
  const dispose = () => {
    if (typeof returned === "function") returned();
    effectCleanup();
  };
  cleanups.push(dispose);

  await flush();
  expect(provider.prepare).toHaveBeenCalledTimes(1);

  scope = scopeB;
  scopeListeners.forEach((listener) => listener());
  resolveFirst({ status: "ok", resource: oldResource });
  await flush();

  expect(provider.prepare).toHaveBeenCalledTimes(2);
  expect(modelSceneStore.snapshot().get("node")).toBe(currentResource);
  expect(modelSceneStore.snapshot().get("node")).not.toBe(oldResource);
  listeners.clear();
  current = canvas();
});

it("临时 no-scope 失败不会锁住节点，scope 就绪后自动重试", async () => {
  const scopeA = Object.freeze({ canvasId: "A", token: "1", sequence: 1 });
  let scope: CanvasScope | null = null;
  const scopeListeners = new Set<() => void>();
  const runtime = {
    currentCanvasScope: () => scope,
    subscribeCanvasScope: (listener: () => void) => {
      scopeListeners.add(listener);
      return () => scopeListeners.delete(listener);
    }
  };
  const resource = { token: "ready" };
  let prepares = 0;
  const provider = {
    reportsStatus: false,
    executionKey: () => "same",
    prepare: vi.fn(() => {
      prepares += 1;
      return scope === null
        ? Promise.resolve({ status: "fail:execute:no-scope:runtime not ready" })
        : Promise.resolve({ status: "ok" as const, resource });
    })
  };
  const current = canvas();
  const ctx = {
    effect: (effect: () => () => void) => effect(),
    provide: () => {},
    get: (key: unknown) => key === "canvasRuntime" ? { runtime: () => runtime, subscribe: () => () => {} } : undefined,
    canvasRemote: { reportModelScript: vi.fn() },
    canvasState: { getCanvas: () => current, subscribe: () => () => {} },
    nodeImplementations: { resolve: () => ({ generation: 1, modelPreparation: provider }), subscribe: () => () => {} }
  };
  const returned = modelSceneExtension({ schedule: (run) => run() })(ctx as never, undefined);
  const dispose = () => { if (typeof returned === "function") returned(); };
  cleanups.push(dispose);

  await flush();
  const preparesBeforeScope = prepares;
  expect(preparesBeforeScope).toBeGreaterThan(0);
  expect(modelSceneStore.snapshot().has("node")).toBe(false);
  scope = scopeA;
  scopeListeners.forEach((listener) => listener());
  await flush();
  expect(prepares).toBeGreaterThan(preparesBeforeScope);
  expect(modelSceneStore.snapshot().get("node")).toBe(resource);
});
