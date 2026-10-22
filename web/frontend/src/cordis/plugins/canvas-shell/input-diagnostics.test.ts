// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { installInputDiagnostics } from "./input-diagnostics.js";
import type { InteractionCore } from "./interaction-core.js";
import { resetSceneDiagnostics, sceneDiagnostics } from "../canvas-runtime/scene-diagnostics.js";

afterEach(() => { resetSceneDiagnostics(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const counters = () => ({ queries: sceneDiagnostics.interactionQueries, unavailableQueries: sceneDiagnostics.interactionUnavailable });

function setup() {
  const canvas = document.createElement("canvas");
  const target: Record<string, unknown> = {};
  let blocked = true;
  const query = vi.fn(() => 12);
  const core = {
    canvas, target, modalActive: () => blocked, focusInputBlocked: () => false,
    model: { active: false }, state: { gesture: { kind: "none" } }, writable: () => true,
    activeViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    options: { getRuntime: () => ({ interactionGeneration: query }) }
  } as unknown as InteractionCore;
  const snapshot = () => (target.__canvasInputDiagnostics as {
    snapshot(): { current: { canvasBlocked: boolean }; events: Array<{
      type: string; before: { canvasBlocked: boolean; focusBlocked: boolean; queries: number };
      after?: { queries: number; unavailableQueries: number };
    }> }
  }).snapshot();
  return { canvas, target, core, snapshot, unblock: () => { blocked = false; } };
}

it("retains blocked clicks after recovery and distinguishes rejected queries without issuing a query", async () => {
  const h = setup();
  // Production installs the controller before diagnostic capture listeners.
  h.canvas.addEventListener("pointerdown", () => {
    if (h.core.modalActive()) return;
    sceneDiagnostics.interactionQueries++;
    sceneDiagnostics.interactionUnavailable++;
  });
  const dispose = installInputDiagnostics(h.core, () => null, counters);
  h.canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 20, clientY: 30 }));
  await Promise.resolve();
  h.unblock();
  h.canvas.dispatchEvent(new MouseEvent("pointerdown"));
  await Promise.resolve();
  const report = h.snapshot();
  expect(report.current.canvasBlocked).toBe(false);
  expect(report.events[0]).toMatchObject({ before: { canvasBlocked: true, focusBlocked: false, queries: 0 }, after: { queries: 0 } });
  expect(report.events[1]).toMatchObject({ before: { canvasBlocked: false, queries: 0 }, after: { queries: 1, unavailableQueries: 1 } });
  expect(sceneDiagnostics.interactionQueries).toBe(1);
  dispose();
});

it("bounds history, excludes pointermove, and releases listeners and mirror on dispose", async () => {
  const h = setup();
  const remove = vi.spyOn(h.canvas, "removeEventListener");
  const dispose = installInputDiagnostics(h.core, () => null, counters);
  for (let i = 0; i < 80; i++) h.canvas.dispatchEvent(new MouseEvent("pointerdown"));
  h.canvas.dispatchEvent(new MouseEvent("pointermove"));
  expect(h.snapshot().events).toHaveLength(64);
  expect(h.snapshot().events.every(entry => entry.type === "pointerdown")).toBe(true);
  const mirror = h.target.__canvasInputDiagnostics;
  dispose();
  await Promise.resolve();
  expect(h.target.__canvasInputDiagnostics).toBeUndefined();
  expect(remove).toHaveBeenCalledTimes(12);
  expect((mirror as { snapshot(): { events: unknown[] } }).snapshot().events).toHaveLength(64);
});

it("disposing an older controller preserves the newer controller's mirror", () => {
  const h = setup();
  const old = installInputDiagnostics(h.core, () => null, counters);
  const current = installInputDiagnostics(h.core, () => null, counters);
  const mirror = h.target.__canvasInputDiagnostics;
  old();
  expect(h.target.__canvasInputDiagnostics).toBe(mirror);
  current();
});

it("automatically uploads captured rejected clicks and flushes an unsettled click on disposal", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  const h = setup();
  h.core.target = window as Window & typeof globalThis;
  const dispose = installInputDiagnostics(h.core, () => null, counters);
  h.canvas.dispatchEvent(new MouseEvent("pointerdown", { clientX: 20, clientY: 30 }));
  await vi.advanceTimersByTimeAsync(500);
  const saved = JSON.parse(fetch.mock.calls[0][1].body).samples[0];
  expect(saved).toMatchObject({ type: "pointerdown", x: 20, y: 30,
    before: { canvasBlocked: true }, after: { canvasBlocked: true } });
  h.canvas.addEventListener("pointerup", event => event.stopImmediatePropagation(), true);
  h.canvas.dispatchEvent(new MouseEvent("pointerup"));
  dispose();
  await vi.advanceTimersByTimeAsync(0);
  const last = JSON.parse(fetch.mock.calls[1][1].body).samples[0];
  expect(last).toMatchObject({ type: "pointerup", before: { canvasBlocked: true } });
});

it("settles after the controller synchronously, including handlers that stop propagation", () => {
  const h = setup();
  h.canvas.addEventListener("pointerdown", event => {
    sceneDiagnostics.interactionQueries++;
    h.unblock();
    event.stopPropagation();
  });
  const dispose = installInputDiagnostics(h.core, () => null, counters);
  h.canvas.dispatchEvent(new MouseEvent("pointerdown"));
  expect(h.snapshot().events[0]).toMatchObject({ before: { canvasBlocked: true, queries: 0 },
    after: { canvasBlocked: false, queries: 1 } });
  dispose();
});
