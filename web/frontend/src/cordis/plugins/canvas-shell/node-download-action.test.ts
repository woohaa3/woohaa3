import { afterEach, expect, it, vi } from "vitest";
import { builtinNodeCapabilityResolver, createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { canvasShellExtension } from "./plugin.js";
import { activateNodeAction, readNodeActionToolbars } from "./node-action-bridge.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import type { NodeActionContribution } from "../../contract/platform.js";

afterEach(() => nodeSelectionStore.reset());

it.each([true, false])("exposes and dispatches the actual area download contribution (writable=%s)", writable => {
  const canvas = createEmptyWoohaa3ServerCanvas("area-download-action");
  canvas.document.nodes.push({ id: "area", type: "scene-area", position: { x: 0, y: 0 } });
  canvas.nodeData.area = { sceneArea: { kind: "scene-area", version: "shared-world-v1", areaId: "a", scopeVersion: "s",
    bounds: { min: { u: 0, v: 0 }, max: { u: 4, v: 4 } } } };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  nodeSelectionStore.setFromRuntime({ nodeIds: ["area"], primaryNodeId: "area", editingFocus: false }, new Set(["area"]));
  const cleanups: Array<() => void> = [];
  const actions: NodeActionContribution[] = [];
  const emit = vi.fn();
  const ctx = {
    slots: { register: (slot: string, entry: NodeActionContribution) => {
      if (slot === "canvas.node-action") actions.push(entry);
      return () => {};
    }, list: () => actions },
    on: () => () => {}, emit, get: () => undefined,
    effect: (setup: () => () => void) => { cleanups.push(setup()); },
    nodeImplementations: builtinNodeCapabilityResolver,
    canvasNavigation: { getSnapshot: () => ({ mode: { type: "overview" } }) },
    canvasSession: { isWritable: () => writable }
  };
  const plugin = canvasShellExtension() as unknown as (ctx: unknown) => void;
  plugin(ctx);
  try {
    expect(readNodeActionToolbars().get("area")?.actions).toContainEqual(expect.objectContaining({
      id: "node-download", label: "下载", enabled: true, icon: "download"
    }));
    activateNodeAction({ nodeId: "area", actionId: "node-download", menu: false });
    expect(emit).toHaveBeenCalledWith("ui.node-download.save-requested", { nodeId: "area" });
  } finally { cleanups.reverse().forEach(cleanup => cleanup()); }
});
