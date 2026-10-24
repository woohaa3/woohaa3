import { expect, it } from "vitest";
import { buildCanvasRenderScene, createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { CompositeAssetRegistry } from "./composite-assets.js";

it("an independent extension shares containers, entity links, dragging and cleanup", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("third-extension"), registry = new CompositeAssetRegistry();
  for (const [id, type] of [["owner", "composite-asset"], ["container", "composite-asset"], ["output", "video"], ["pinned", "text"]]) {
    canvas.document.nodes.push({ id, type, position: { x: 0, y: 0 } });
    canvas.nodeData[id] = { extensionId: "third-extension" };
  }
  const dispose = registry.register({ extensionId: "third-extension", owner: "third-extension", executionKey: () => "", prepare: () => null,
    children: (_canvas, ownerNodeId) => ownerNodeId === "owner" ? [
      { nodeId: "container", ownerNodeId, kind: "container", panel: { title: "References", imageIds: ["thumbnail"] } },
      { nodeId: "output", ownerNodeId, kind: "entity" },
      { nodeId: "pinned", ownerNodeId, kind: "entity", followOwner: false },
      { nodeId: "missing", ownerNodeId, kind: "entity" }
    ] : [] });
  const before = JSON.stringify(canvas);
  expect(registry.scopeShapes(canvas).get("container")).toBe("rect");
  expect(registry.dragAlongNodeIds(canvas, "owner")).toEqual(["container", "output"]);
  const scene = buildCanvasRenderScene({ canvas, compositeAssetScopeShapes: registry.scopeShapes(canvas) });
  registry.projectChildren(scene, canvas);
  expect(scene.nodes.find(n => n.id === "owner")?.compositeAsset?.ownershipLinks?.targetNodeIds).toEqual(["container", "output", "pinned"]);
  expect(scene.nodes.find(n => n.id === "container")?.compositeAsset).toMatchObject({ scopeShape: "rect", panel: { title: "References", imageIds: ["thumbnail"] } });
  expect(scene.nodes.find(n => n.id === "output")?.compositeAsset).toBeUndefined();
  expect(JSON.stringify(canvas)).toBe(before);
  canvas.document.nodes = canvas.document.nodes.filter(n => n.id !== "output");
  expect(registry.dragAlongNodeIds(canvas, "owner")).toEqual(["container"]);
  dispose(); expect(registry.children(canvas).size).toBe(0);
});

it("does not accept ownership from a different owner or unknown extension", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("c"), registry = new CompositeAssetRegistry();
  for (const id of ["owner", "foreign", "output"]) {
    canvas.document.nodes.push({ id, type: "composite-asset", position: { x: 0, y: 0 } });
    canvas.nodeData[id] = { extensionId: id === "foreign" ? "unknown" : "test" };
  }
  registry.register({ extensionId: "test", owner: "test", executionKey: () => "", prepare: () => null,
    children: () => [{ nodeId: "output", ownerNodeId: "foreign", kind: "entity" }] });
  expect(registry.children(canvas).size).toBe(0);
});
