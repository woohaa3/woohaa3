import { applyCanvasCommands } from "../../../../../test-support/managed-shot-commands.js";
import { afterEach, expect, it } from "vitest";
import { canonicalFilmSetFields, createEmptyWoohaa3ServerCanvas, createFilmSetSnapshot, filmSetObjectContainerId, filmSetObjectModelNodeId, type CanvasRenderScene } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { getSession, harness, installSharedSession, runtimeCapturing, submitted } from "./test-support/controller-harness.js";

installSharedSession();
const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); nodeSelectionStore.reset(); });
const containerId = filmSetObjectContainerId("film", "actor");
const modelId = filmSetObjectModelNodeId("film", "actor");

function setup(selected: string[] = [], kind: "node" | "model-preview" = "node") {
  const canvas = createEmptyWoohaa3ServerCanvas("objects");
  canvas.document.nodes = [{ id: "film", type: "composite-asset", position: { x: 0, y: 0 } }];
  canvas.nodeData.film = canonicalFilmSetFields(createFilmSetSnapshot({ title: "片场", modelItemId: "actor",
    model: { modelScript: "scene.box({id:'body',size:[1,1,1]});", modelScriptVersion: "woohaa-model-js-v2" }, timeline: { duration: 0, loop: false } })) as never;
  const result = applyCanvasCommands(canvas, []);
  if (!result.ok) throw new Error(result.rejection.message);
  woohaa3CanvasStore.getState().applyRemoteCanvas(result.canvas);
  const original = result.canvas.document.nodes.find(node => node.id === containerId)!;
  nodeSelectionStore.setFromRuntime({ nodeIds: selected, primaryNodeId: selected[0] ?? null, editingFocus: false }, new Set(result.canvas.document.nodes.map(node => node.id)));
  const dom = harness();
  const { runtime, scenes } = runtimeCapturing({ pointHit: () => ({ kind, nodeId: modelId }) });
  const controller = installInteractionController({ canvas: dom.canvas, target: dom.target as never,
    getRuntime: () => runtime, getSession: () => getSession() as never });
  cleanups.push(() => controller.dispose());
  dom.fire("pointerdown", { clientX: original.position.x + 24, clientY: original.position.y + 24 });
  dom.fire("pointermove", { clientX: original.position.x + 84, clientY: original.position.y + 64 });
  controller.flush();
  const preview = scenes.at(-1) as unknown as CanvasRenderScene;
  expect(preview.nodes.find(node => node.id === containerId)).toMatchObject({ x: original.position.x + 60, y: original.position.y + 40 });
  expect(preview.nodes.find(node => node.id === modelId)).toMatchObject({ x: original.position.x + 72, y: original.position.y + 52, width: 224, height: 208 });
  return { dom, controller, original };
}

it.each([
  { selected: [], kind: "node" as const },
  { selected: [modelId], kind: "node" as const },
  { selected: [containerId, modelId], kind: "node" as const },
  { selected: [], kind: "model-preview" as const },
  { selected: [modelId], kind: "model-preview" as const }
])("dragging the model card moves its container once while preserving selection and padding ($kind, $selected)", ({ selected, kind }) => {
  const { dom, controller, original } = setup(selected, kind);
  dom.fire("pointerup", { clientX: original.position.x + 84, clientY: original.position.y + 64 });
  controller.flush();
  const canvas = (woohaa3CanvasStore.getState().working ?? woohaa3CanvasStore.getState().canvas)!;
  expect(canvas.document.nodes.find(node => node.id === containerId)?.position).toEqual({ x: original.position.x + 60, y: original.position.y + 40 });
  expect(canvas.document.nodes.find(node => node.id === modelId)).toMatchObject({ parentId: containerId, position: { x: 12, y: 12 } });
  expect(submitted.filter(command => command.type === "node.update").map(command => command.nodeId)).toEqual([containerId]);
  expect(nodeSelectionStore.getSnapshot().nodeIds).toContain(modelId);
});

it("cancelling a card drag leaves the container and card in their original positions", () => {
  const { dom, controller, original } = setup();
  dom.fire("pointercancel", {}); controller.flush();
  const canvas = (woohaa3CanvasStore.getState().working ?? woohaa3CanvasStore.getState().canvas)!;
  expect(canvas.document.nodes.find(node => node.id === containerId)?.position).toEqual(original.position);
  expect(canvas.document.nodes.find(node => node.id === modelId)?.position).toEqual({ x: 12, y: 12 });
  expect(submitted).toEqual([]);
});
