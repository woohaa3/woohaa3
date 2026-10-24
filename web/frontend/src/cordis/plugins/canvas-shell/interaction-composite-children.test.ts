import { afterEach, expect, it } from "vitest";
import type { CanvasCommand, CanvasRenderScene } from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach(fn => fn()); nodeSelectionStore.reset(); });
function setup(selected: string[] = []) {
  const canvas = canvasWith([{ id: "owner", x: 0, y: 0 }, { id: "container", x: 400, y: 0 }, { id: "entity", x: 800, y: 0 }]);
  canvas.document.nodes[0].type = canvas.document.nodes[1].type = "composite-asset";
  canvas.nodeData.owner = { extensionId: "third-extension" };
  canvas.nodeData.container = { extensionId: "third-extension" };
  const registry = new CompositeAssetRegistry();
  registry.register({ extensionId: "third-extension", owner: "third-extension", executionKey: () => "", prepare: () => null,
    children: (_canvas, ownerNodeId) => ownerNodeId === "owner" ? [
      { nodeId: "container", ownerNodeId, kind: "container" }, { nodeId: "entity", ownerNodeId, kind: "entity" }
    ] : [] });
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  nodeSelectionStore.setFromRuntime({ nodeIds: selected, primaryNodeId: selected[0] ?? null, editingFocus: false }, new Set(canvas.document.nodes.map(n => n.id)));
  const dom = harness(), capture = runtimeCapturing({ pointHit: () => ({ kind: "node", nodeId: "owner" }) });
  const edits: CanvasCommand[][] = [];
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
    getRuntime: () => capture.runtime, getSession: () => getSession() as never, compositeAssets: registry,
    onEditCommands: commands => { edits.push([...commands]); } });
  cleanups.push(() => controller.dispose()); controller.flush();
  return { dom, capture, edits, controller };
}
for (const selected of [[], ["owner", "container", "entity"]]) it(`moves shared children exactly once with selection ${selected.length}`, () => {
  const h = setup(selected);
  h.dom.fire("pointerdown", { clientX: 100, clientY: 100 });
  h.dom.fire("pointermove", { clientX: 150, clientY: 160 }); h.controller.flush();
  h.dom.fire("pointerup", { clientX: 150, clientY: 160 }); h.controller.flush();
  expect(h.edits.flat()).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: "node.update", nodeId: "owner", position: { x: 50, y: 60 } }),
    expect.objectContaining({ type: "node.update", nodeId: "container", position: { x: 450, y: 60 } }),
    expect.objectContaining({ type: "node.update", nodeId: "entity", position: { x: 850, y: 60 } })
  ]));
  expect(h.edits.flat()).toHaveLength(3);
});
it("cancel clears the whole child preview and leaves no edit or stuck gesture", () => {
  const h = setup();
  h.dom.fire("pointerdown", { clientX: 100, clientY: 100 });
  h.dom.fire("pointermove", { clientX: 150, clientY: 160 }); h.controller.flush();
  h.dom.fire("pointercancel", {}); h.controller.flush();
  expect(h.edits).toEqual([]);
  expect((h.capture.scenes.at(-1) as CanvasRenderScene | undefined)?.nodes.find(n => n.id === "container")?.x).toBe(400);
  h.dom.fire("pointerdown", { clientX: 100, clientY: 100 });
  h.dom.fire("pointermove", { clientX: 110, clientY: 110 });
  h.dom.fire("pointerup", { clientX: 110, clientY: 110 });
  expect(h.edits.flat()).toHaveLength(3);
});
