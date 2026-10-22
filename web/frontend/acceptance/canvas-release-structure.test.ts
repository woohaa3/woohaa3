import { afterEach, expect, it, vi } from "vitest";
import { applyCanvasCommands, findGroupContainingCenter, getWoohaa3CanvasNodeAbsolutePosition,
  reparentDraggedNodes, type Woohaa3CanvasNode } from "@woohaa3/contracts";
import { planGroupStructureChange } from "../src/extension-api/command-planner.js";
import { createDragGestureFamily } from "../src/cordis/plugins/canvas-shell/drag-gesture.js";
import { woohaa3CanvasStore } from "../src/cordis/services/canvas-state/index.js";
import { canvasWith } from "../src/cordis/plugins/canvas-shell/test-support/controller-harness.js";

function family() {
  return createDragGestureFamily({ state: {}, submit: vi.fn(), buildScene: () => null,
    schedule: vi.fn(), clearHeldKeys: vi.fn() } as unknown as Parameters<typeof createDragGestureFamily>[0]);
}

afterEach(() => woohaa3CanvasStore.getState().applyWorkingCanvas(null));
it.each([
  { name: "nested local move", at: { x: 160, y: 180 }, parent: "inner", remote: false },
  { name: "leave nested groups", at: { x: 900, y: 600 }, parent: undefined, remote: false },
  { name: "enter target and refit", at: { x: 880, y: -10 }, parent: "target", remote: false },
  { name: "latest working ancestor coordinates", at: { x: 380, y: 290 }, parent: "inner", remote: true }
])("$name matches the complete parenting planner and preserves world placement", ({ at, parent, remote }) => {
  const canonical = canvasWith([]);
  canonical.document.nodes = [
    // Document order intentionally follows the existing nested-group targeting contract.
    { id: "inner", type: "group", parentId: "g", position: { x: 30, y: 40 }, width: 300, height: 260 },
    { id: "g", type: "group", position: { x: 100, y: 100 }, width: 600, height: 500 },
    { id: "leaf", type: "image", parentId: "inner", position: { x: 10, y: 20 }, width: 100, height: 80 },
    { id: "target", type: "group", position: { x: 900, y: 0 }, width: 100, height: 100 },
    { id: "unrelated", type: "image", position: { x: 1500, y: 900 }, width: 100, height: 80 }
  ];
  canonical.nodeData = { unrelated: { prompt: "keep" } };
  woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
  const family = createDragGestureFamily({ state: {}, submit: vi.fn(), buildScene: () => null,
    schedule: vi.fn(), clearHeldKeys: vi.fn() } as unknown as Parameters<typeof createDragGestureFamily>[0]);
  const origins = new Map([["leaf", { x: 140, y: 160 }]]);
  if (remote) {
    woohaa3CanvasStore.getState().applyWorkingCanvas({ ...canonical, nodeData: { unrelated: { prompt: "newer" } },
      document: { ...canonical.document, nodes: canonical.document.nodes.map(n =>
        n.id === "g" ? { ...n, position: { x: 300, y: 200 } } : n) } });
  }
  const latest = woohaa3CanvasStore.getState().working!, before = structuredClone(latest);
  const previews = new Map([["leaf", at]]);
  const commands = family.dragDropCommands(origins, previews);
  // Independent full-array oracle: canonical contracts targeting/reparenting plus structural diff.
  const nodes = latest.document.nodes.map(n => ({ ...n, data: {} })) as Woohaa3CanvasNode[];
  const byId = new Map(nodes.map(n => [n.id, n]));
  const parentPosition = getWoohaa3CanvasNodeAbsolutePosition(byId.get("inner")!, byId);
  const projected = nodes.map(n => n.id === "leaf" ? { ...n,
    position: { x: at.x - parentPosition.x, y: at.y - parentPosition.y } } : n);
  const target = findGroupContainingCenter(projected, "leaf");
  const after = reparentDraggedNodes(projected, ["leaf"], target).nodes;
  expect(commands).toEqual(planGroupStructureChange(nodes, after));
  const applied = applyCanvasCommands(latest, commands, { now: "2026-10-13T00:00:00.000Z" });
  expect(applied.ok).toBe(true); if (!applied.ok) return;
  const resulting = applied.canvas.document.nodes.map(n => ({ ...n, data: {} })) as Woohaa3CanvasNode[];
  const resultById = new Map(resulting.map(n => [n.id, n])), leaf = resultById.get("leaf")!;
  expect(leaf.parentId).toBe(parent);
  expect(getWoohaa3CanvasNodeAbsolutePosition(leaf, resultById)).toEqual(at);
  expect(applied.canvas.nodeData).toEqual(latest.nodeData);
  expect(applied.canvas.document.nodes.find(n => n.id === "unrelated")).toEqual(latest.document.nodes.find(n => n.id === "unrelated"));
  expect(latest).toEqual(before); expect(woohaa3CanvasStore.getState().canvas).toEqual(canonical);
  if (parent === "target") {
    const targetNode = resultById.get("target")!;
    expect(targetNode.position.x).toBeLessThan(900); expect(targetNode.width).toBeGreaterThan(100);
  }
});

it("mixed group/non-group drag keeps the full structural fallback and descendant world coordinates", () => {
  const canonical = canvasWith([]);
  canonical.document.nodes = [
    { id: "g", type: "group", position: { x: 100, y: 100 }, width: 300, height: 260 },
    { id: "child", type: "image", parentId: "g", position: { x: 20, y: 30 }, width: 100, height: 80 },
    { id: "free", type: "image", position: { x: 600, y: 500 }, width: 100, height: 80 },
    { id: "target", type: "group", position: { x: 900, y: 0 }, width: 160, height: 180 }
  ];
  woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
  const commands = family().dragDropCommands(new Map([["g", { x: 100, y: 100 }], ["free", { x: 600, y: 500 }]]),
    new Map([["g", { x: 130, y: 140 }], ["free", { x: 920, y: 10 }]]));
  const nodes = canonical.document.nodes.map(n => ({ ...n, data: {} })) as Woohaa3CanvasNode[];
  const projected = nodes.map(n => n.id === "g" ? { ...n, position: { x: 130, y: 140 } }
    : n.id === "free" ? { ...n, position: { x: 920, y: 10 } } : n);
  const after = reparentDraggedNodes(projected, ["free"], findGroupContainingCenter(projected, "free")).nodes;
  expect(commands).toEqual(planGroupStructureChange(nodes, after));
  const applied = applyCanvasCommands(canonical, commands, { now: "2026-10-13T00:00:00.000Z" });
  expect(applied.ok).toBe(true); if (!applied.ok) return;
  const resulting = applied.canvas.document.nodes.map(n => ({ ...n, data: {} })) as Woohaa3CanvasNode[];
  const byId = new Map(resulting.map(n => [n.id, n]));
  expect(getWoohaa3CanvasNodeAbsolutePosition(byId.get("child")!, byId)).toEqual({ x: 150, y: 170 });
  expect(byId.get("child")!.position).toEqual({ x: 20, y: 30 });
  expect(byId.get("free")!.parentId).toBe("target");
  expect(getWoohaa3CanvasNodeAbsolutePosition(byId.get("free")!, byId)).toEqual({ x: 920, y: 10 });
});

it("warm no-structure release uses the shared index without copying or iterating the full node array", () => {
  const canonical = canvasWith([{ id: "source", x: 0, y: 0 }, ...Array.from({ length: 1000 }, (_, i) =>
    ({ id: `other-${i}`, x: 600 + i * 300, y: 600 }))]);
  woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
  const planner = family(), origins = new Map([["source", { x: 0, y: 0 }]]);
  planner.dragDropCommands(origins, new Map([["source", { x: 20, y: 30 }]])); // establish shared index
  const nodes = canonical.document.nodes;
  const descriptors = new Map<PropertyKey, PropertyDescriptor | undefined>();
  const keys: PropertyKey[] = ["map", "filter", "slice", "forEach", Symbol.iterator];
  try {
    for (const key of keys) {
      descriptors.set(key, Object.getOwnPropertyDescriptor(nodes, key));
      Object.defineProperty(nodes, key, { configurable: true, value: () => { throw new Error("full-array access"); } });
    }
    expect(planner.dragDropCommands(origins, new Map([["source", { x: 40, y: 50 }]])))
      .toEqual([{ type: "node.update", nodeId: "source", position: { x: 40, y: 50 } }]);
    expect(planner.dragDropCommands(origins, new Map([["source", { x: 0, y: 0 }]]))).toEqual([]);
  } finally {
    for (const key of keys) { const descriptor = descriptors.get(key);
      if (descriptor) Object.defineProperty(nodes, key, descriptor); else Reflect.deleteProperty(nodes, key); }
  }
});
