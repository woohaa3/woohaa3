// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { createEmptyWoohaa3ServerCanvas, SHARED_WORLD_VERSION, type ServerCanvas } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { SceneAreaDragHandle } from "./gesture-controls.js";

const AREA_BOUNDS = { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } };

function applyAreaCanvas(): void {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  woohaa3CanvasStore.getState().applyRemoteCanvas({
    ...base,
    revision: 1,
    document: {
      ...base.document,
      nodes: [{ id: "area", type: "scene-area", position: { x: 500, y: 500 } }]
    },
    nodeData: {
      area: {
        sceneArea: {
          kind: "scene-area",
          version: SHARED_WORLD_VERSION,
          areaId: "area",
          scopeVersion: "area-v1",
          bounds: AREA_BOUNDS
        }
      }
    }
  } as ServerCanvas);
}

const mounts: Array<{ root: ReturnType<typeof createRoot>; host: HTMLDivElement }> = [];

afterEach(() => {
  for (const mount of mounts.splice(0)) {
    act(() => mount.root.unmount());
    mount.host.remove();
  }
  nodeSelectionStore.reset();
  vi.restoreAllMocks();
});

it("only subscribes the projected handle to viewport notifications while an area is selected", async () => {
  applyAreaCanvas();
  nodeSelectionStore.reset();
  const unsubscribe = vi.fn();
  const subscribeViewport = vi.fn(() => unsubscribe);
  const ctx = {
    canvasRuntime: {
      controller: () => ({
        subscribeViewport,
        worldToClient: ({ x, y }: { x: number; y: number }) => ({ x, y })
      })
    }
  };
  const interval = vi.spyOn(globalThis, "setInterval");
  const host = document.createElement("div");
  const root = createRoot(host);
  mounts.push({ root, host });

  await act(async () => { root.render(<SceneAreaDragHandle ctx={ctx as never} />); });
  expect(subscribeViewport).not.toHaveBeenCalled();
  expect(interval).not.toHaveBeenCalled();

  await act(async () => {
    nodeSelectionStore.setFromRuntime(
      { nodeIds: ["area"], primaryNodeId: "area", editingFocus: false },
      new Set(["area"])
    );
  });
  expect(subscribeViewport).toHaveBeenCalledTimes(1);
  // The handle follows the existing viewport notification instead of polling.
  expect(interval).not.toHaveBeenCalled();

  await act(async () => { root.unmount(); });
  mounts.length = 0;
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
