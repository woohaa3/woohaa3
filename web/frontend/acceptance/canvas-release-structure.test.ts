import { afterEach, expect, it, vi } from "vitest";
import { applyCanvasCommands, getWoohaa3CanvasNodeAbsolutePosition,
  type Woohaa3CanvasNode } from "@woohaa3/contracts";
import { createDragGestureFamily } from "../src/cordis/plugins/canvas-shell/drag-gesture.js";
import { woohaa3CanvasStore } from "../src/cordis/services/canvas-state/index.js";
import { canvasWith } from "../src/cordis/plugins/canvas-shell/test-support/controller-harness.js";

function family() {
  return createDragGestureFamily({ state: {}, submit: vi.fn(), buildScene: () => null,
    schedule: vi.fn(), clearHeldKeys: vi.fn() } as unknown as Parameters<typeof createDragGestureFamily>[0]);
}

afterEach(() => woohaa3CanvasStore.getState().applyWorkingCanvas(null));
it.each([
  // 释放结算（change: 2026-10-26-settle-group-boundaries-on-drop，design D2）把普通节点夹进
  // 目标组冻结的内框（左右/顶部 40、底部 80），不扩大组、不按中心自由重父化。
  // inner 绝对位置 (130,140)、300×260 → 内框允许 x∈[170,290]、y∈[180,240]。
  { name: "nested local move clamps into the frozen inner frame", at: { x: 160, y: 180 }, parent: "inner", remote: false, world: { x: 170, y: 180 } },
  { name: "leave nested groups preserves world placement", at: { x: 900, y: 600 }, parent: undefined, remote: false, world: { x: 900, y: 600 } },
  // remote：working 里 g 已挪到 (300,200)，inner 绝对位置随之变为 (330,240)。
  { name: "latest working ancestor coordinates preserve world placement", at: { x: 380, y: 290 }, parent: "inner", remote: true, world: { x: 380, y: 290 } }
])("$name", ({ at, parent, remote, world }) => {
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
  const commands = family.dragDropCommands(origins, new Map([["leaf", at]]));
  const applied = applyCanvasCommands(latest, commands, { now: "2026-10-13T00:00:00.000Z" });
  expect(applied.ok).toBe(true); if (!applied.ok) return;
  const resulting = applied.canvas.document.nodes.map(n => ({ ...n, data: {} })) as Woohaa3CanvasNode[];
  const resultById = new Map(resulting.map(n => [n.id, n])), leaf = resultById.get("leaf")!;
  expect(leaf.parentId).toBe(parent);
  expect(getWoohaa3CanvasNodeAbsolutePosition(leaf, resultById)).toEqual(world);
  expect(applied.canvas.nodeData).toEqual(latest.nodeData);
  expect(applied.canvas.document.nodes.find(n => n.id === "unrelated")).toEqual(latest.document.nodes.find(n => n.id === "unrelated"));
  expect(latest).toEqual(before); expect(woohaa3CanvasStore.getState().canvas).toEqual(canonical);
});

it("refuses a target group that cannot hold the node instead of growing it", () => {
  const canonical = canvasWith([]);
  canonical.document.nodes = [
    { id: "inner", type: "group", parentId: "g", position: { x: 30, y: 40 }, width: 300, height: 260 },
    { id: "g", type: "group", position: { x: 100, y: 100 }, width: 600, height: 500 },
    { id: "leaf", type: "image", parentId: "inner", position: { x: 10, y: 20 }, width: 100, height: 80 },
    { id: "target", type: "group", position: { x: 900, y: 0 }, width: 100, height: 100 }
  ];
  woohaa3CanvasStore.getState().applyRemoteCanvas(canonical);
  // 释放点让 leaf 中心落进 target（900..1000, 0..100），但 100×80 放不进 100×100 组的内框。
  const commands = family().dragDropCommands(new Map([["leaf", { x: 140, y: 160 }]]),
    new Map([["leaf", { x: 880, y: -10 }]]));
  const applied = applyCanvasCommands(canonical, commands, { now: "2026-10-13T00:00:00.000Z" });
  expect(applied.ok).toBe(true); if (!applied.ok) return;
  const byId = new Map(applied.canvas.document.nodes.map(n => [n.id, n]));
  expect(byId.get("leaf")!.parentId).not.toBe("target");
  // 组尺寸冻结：拒绝接收时不改写目标组几何。
  expect(byId.get("target")).toEqual(canonical.document.nodes.find(n => n.id === "target"));
  // 节点沿合法外侧弹出，与目标组不产生正面积重叠。
  const leafAt = getWoohaa3CanvasNodeAbsolutePosition(byId.get("leaf")!, byId);
  const target = byId.get("target")!;
  const overlapX = Math.min(leafAt.x + 100, target.position.x + target.width!) - Math.max(leafAt.x, target.position.x);
  const overlapY = Math.min(leafAt.y + 80, target.position.y + target.height!) - Math.max(leafAt.y, target.position.y);
  expect(overlapX <= 0 || overlapY <= 0).toBe(true);
});

it("mixed group/non-group drag keeps descendant world coordinates and never refits the target", () => {
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
  const applied = applyCanvasCommands(canonical, commands, { now: "2026-10-13T00:00:00.000Z" });
  expect(applied.ok).toBe(true); if (!applied.ok) return;
  const resulting = applied.canvas.document.nodes.map(n => ({ ...n, data: {} })) as Woohaa3CanvasNode[];
  const byId = new Map(resulting.map(n => [n.id, n]));
  // 组的成员保持相对坐标，世界坐标跟随主动组的位移。
  expect(getWoohaa3CanvasNodeAbsolutePosition(byId.get("child")!, byId)).toEqual({ x: 150, y: 170 });
  expect(byId.get("child")!.position).toEqual({ x: 20, y: 30 });
  // 160×180 的组内框放不下 100×80 的节点：拒绝接收，目标组几何不变。
  expect(byId.get("free")!.parentId).not.toBe("target");
  expect({ position: byId.get("target")!.position, width: byId.get("target")!.width, height: byId.get("target")!.height })
    .toEqual({ position: { x: 900, y: 0 }, width: 160, height: 180 });
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
