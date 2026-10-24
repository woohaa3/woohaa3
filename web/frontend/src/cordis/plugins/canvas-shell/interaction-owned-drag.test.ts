import { afterEach, expect, it } from "vitest";
import { CompositeAssetRegistry } from "../../../extension-api/composite-assets.js";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { canvasWith, getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); nodeSelectionStore.reset(); });

function setup() {
  const canvas = canvasWith([{ id: "base", x: 0, y: 0 }, { id: "owned", x: 350, y: -200 }, { id: "source", x: 700, y: 0 }]);
  canvas.document.nodes[0]!.type = "composite-asset";
  canvas.nodeData.base = { extensionId: "test-workflow" };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  const registry = new CompositeAssetRegistry();
  registry.register({ extensionId: "test-workflow", owner: "test-workflow", executionKey: () => "", prepare: () => ({}),
    dragAlongNodeIds: () => ["owned", "missing", "owned"] });
  const dom = harness();
  const { runtime } = runtimeCapturing({ pointHit: () => ({ kind: "film-scope", nodeId: "base" }) });
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never, compositeAssets: registry,
    getRuntime: () => runtime, getSession: () => getSession() as never });
  cleanups.push(() => controller.dispose());
  dom.fire("pointerdown", { clientX: 20, clientY: 20 });
  dom.fire("pointermove", { clientX: 80, clientY: 60 });
  controller.flush();
  return { dom, controller };
}

it("moving a scope commits the same delta for owned nodes and leaves source images independent", () => {
  const { dom, controller } = setup();
  dom.fire("pointerup", { clientX: 80, clientY: 60 }); controller.flush();
  const canvas = (woohaa3CanvasStore.getState().working ?? woohaa3CanvasStore.getState().canvas)!;
  expect(canvas.document.nodes.find(node => node.id === "base")!.position).toEqual({ x: 60, y: 40 });
  expect(canvas.document.nodes.find(node => node.id === "owned")!.position).toEqual({ x: 410, y: -160 });
  expect(canvas.document.nodes.find(node => node.id === "source")!.position).toEqual({ x: 700, y: 0 });
});

it("cancelling a scope drag restores every node", () => {
  const { dom, controller } = setup();
  dom.fire("pointercancel", {}); controller.flush();
  const canvas = (woohaa3CanvasStore.getState().working ?? woohaa3CanvasStore.getState().canvas)!;
  expect(canvas.document.nodes.find(node => node.id === "base")!.position).toEqual({ x: 0, y: 0 });
  expect(canvas.document.nodes.find(node => node.id === "owned")!.position).toEqual({ x: 350, y: -200 });
});
