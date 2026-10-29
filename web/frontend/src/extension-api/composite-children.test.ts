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
      { nodeId: "container", ownerNodeId, kind: "container", role: "object-entry", sourceItemId: "object-a", panel: { title: "References", imageIds: ["thumbnail"] } },
      { nodeId: "output", ownerNodeId, kind: "entity", role: "preview" },
      { nodeId: "pinned", ownerNodeId, kind: "entity", role: "preview", followOwner: false },
      { nodeId: "missing", ownerNodeId, kind: "entity", role: "preview" }
    ] : [] });
  const before = JSON.stringify(canvas);
  expect(registry.scopeShapes(canvas).get("container")).toBe("rect");
  expect(registry.dragAlongNodeIds(canvas, "owner")).toEqual(["container", "output"]);
  const scene = buildCanvasRenderScene({ canvas, compositeAssetScopeShapes: registry.scopeShapes(canvas) });
  registry.projectChildren(scene, canvas);
  expect(scene.nodes.find(n => n.id === "owner")?.compositeAsset?.ownershipLinks?.targetNodeIds).toEqual(["container", "output", "pinned"]);
  expect(scene.nodes.find(n => n.id === "owner")?.compositeAsset?.ownershipLinks?.targetItemIds).toEqual({ container: "object-a" });
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
    children: () => [{ nodeId: "output", ownerNodeId: "foreign", kind: "entity", role: "preview" }] });
  expect(registry.children(canvas).size).toBe(0);
});

it("keeps shot-preview ownership links for group film sets but drops them inside composite assets", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("shot-links"), registry = new CompositeAssetRegistry();
  for (const [id, type] of [["owner", "composite-asset"], ["group", "group"], ["composite-card", "video"], ["group-card", "video"]]) {
    canvas.document.nodes.push({ id, type, position: { x: 0, y: 0 } });
    canvas.nodeData[id] = { extensionId: "shot-links" };
  }
  const dispose = registry.register({ extensionId: "shot-links", owner: "shot-links", executionKey: () => "", prepare: () => null,
    children: (_canvas, ownerNodeId) => [
      { nodeId: "composite-card", ownerNodeId: "owner", kind: "entity" as const, role: "preview" as const },
      { nodeId: "group-card", ownerNodeId: "group", kind: "entity" as const, role: "preview" as const }
    ].filter(child => child.ownerNodeId === ownerNodeId) });
  const scene: ReturnType<typeof buildCanvasRenderScene> = {
    version: 1,
    revision: 1,
    nodes: [
      { id: "owner", x: 0, y: 0, width: 400, height: 300, type: "composite-asset", kind: "node", title: "", typeLabel: "", compositeAsset: { panel: { title: "owner" } } },
      { id: "group", x: 0, y: 0, width: 400, height: 300, type: "group", kind: "node", title: "", typeLabel: "" },
      { id: "composite-card", x: 0, y: 0, width: 240, height: 185, type: "video", kind: "node", title: "", typeLabel: "" },
      { id: "group-card", x: 0, y: 0, width: 240, height: 185, type: "video", kind: "node", title: "", typeLabel: "" }
    ],
    edges: [],
    selection: { nodes: [], edge: null },
    viewport: { x: 0, y: 0, zoom: 1 },
    draft: null,
    shotPreviewLinks: [
      { id: "a", ownerNodeId: "owner", previewNodeId: "composite-card", clipId: "clip", start: { x: 0, y: 0 } },
      { id: "b", ownerNodeId: "group", previewNodeId: "group-card", clipId: "clip", start: { x: 0, y: 0 } }
    ]
  } as unknown as ReturnType<typeof buildCanvasRenderScene>;
  registry.projectChildren(scene, canvas);
  // 片场复合资产内部的预览卡片与其它子对象共用 ownershipLinks，不需要独立归属线。
  // 片场 group 的预览卡片由 group 托管，但它浮在画布上与徽标相隔很远——归属线是唯一关联呈现。
  expect((scene.shotPreviewLinks ?? []).map(link => link.previewNodeId)).toEqual(["group-card"]);
  dispose();
});
