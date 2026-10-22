/**
 * 共享 edit planner / effect capture 往返测试
 * （change: 2026-10-09-improve-canvas-workflow，任务 1.4）。
 *
 * 覆盖创建/粘贴结构插入、移动/缩放、删除（级联后代/空父组）、连线、重命名与成组/解组，
 * 验证 forward 与 inverse 都能在共享 reducer 上原子执行并恢复到原状态。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { planCanvasEdit } from "./edit-plan.js";

const NOW = "2026-10-09T00:00:00.000Z";

function base(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas("c1", NOW);
}

function withNodes(): ServerCanvas {
  const canvas = base();
  canvas.document.nodes = [
    { id: "a", type: "text", position: { x: 0, y: 0 }, width: 260, height: 195 },
    { id: "b", type: "image", position: { x: 100, y: 0 }, width: 260, height: 195 }
  ];
  canvas.nodeData = { a: { title: "作品 A" }, b: {} };
  return canvas;
}

function applyEdit(canvas: ServerCanvas, plan: { preconditions: unknown[]; operations: unknown[] }): ServerCanvas {
  const result = applyCanvasCommands(canvas, [
    { type: "edit.apply", preconditions: plan.preconditions, operations: plan.operations } as never
  ], { now: NOW });
  if (!result.ok) throw new Error(`edit 失败：${result.rejection.code} ${result.rejection.message}`);
  return result.canvas;
}

describe("planner 移动往返", () => {
  it("forward 应用后 inverse 恢复原位置", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [
      { type: "node.update", nodeId: "a", position: { x: 200, y: 100 } }
    ]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const moved = applyEdit(canvas, plan.forward);
    expect(moved.document.nodes.find((n) => n.id === "a")?.position).toEqual({ x: 200, y: 100 });
    const restored = applyEdit(moved, plan.inverse);
    expect(restored.document.nodes.find((n) => n.id === "a")?.position).toEqual({ x: 0, y: 0 });
  });

  it("移动后他人修改该节点，撤销因条件不成立被拒绝", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [
      { type: "node.update", nodeId: "a", position: { x: 200, y: 100 } }
    ]);
    if (!plan.ok) return;
    const moved = applyEdit(canvas, plan.forward);
    // 另一操作继续移动同一字段
    moved.document.nodes.find((n) => n.id === "a")!.position = { x: 400, y: 0 };
    const result = applyCanvasCommands(moved, [
      { type: "edit.apply", preconditions: plan.inverse.preconditions, operations: plan.inverse.operations } as never
    ], { now: NOW });
    expect(result.ok).toBe(false);
  });

  it("移动后无关节点变化不阻止撤销", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [
      { type: "node.update", nodeId: "a", position: { x: 200, y: 100 } }
    ]);
    if (!plan.ok) return;
    const moved = applyEdit(canvas, plan.forward);
    moved.document.nodes.find((n) => n.id === "b")!.position = { x: 999, y: 999 };
    const restored = applyEdit(moved, plan.inverse);
    expect(restored.document.nodes.find((n) => n.id === "a")?.position).toEqual({ x: 0, y: 0 });
    expect(restored.document.nodes.find((n) => n.id === "b")?.position).toEqual({ x: 999, y: 999 });
  });
});

describe("planner 创建与删除往返", () => {
  it("创建节点后撤销删除该节点", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [
      { type: "node.add", node: { id: "new", type: "video", position: { x: 400, y: 0 } } }
    ]);
    if (!plan.ok) return;
    const created = applyEdit(canvas, plan.forward);
    expect(created.document.nodes.some((n) => n.id === "new")).toBe(true);
    const undone = applyEdit(created, plan.inverse);
    expect(undone.document.nodes.some((n) => n.id === "new")).toBe(false);
  });

  it("级联删除 group 后完整恢复后代与空父组", () => {
    const canvas = base();
    canvas.document.nodes = [
      { id: "g", type: "group", position: { x: 0, y: 0 }, width: 400, height: 400 },
      { id: "child1", type: "text", position: { x: 20, y: 20 }, parentId: "g", width: 260, height: 195 },
      { id: "child2", type: "image", position: { x: 20, y: 240 }, parentId: "g", width: 260, height: 195 },
      { id: "other", type: "text", position: { x: 800, y: 0 }, width: 260, height: 195 }
    ];
    canvas.nodeData = { child1: { title: "作品一" }, child2: {} };
    canvas.document.edges = [{ id: "e1", source: "child1", target: "child2", sourceHandle: null, targetHandle: null, data: {} }];
    const plan = planCanvasEdit(canvas, [{ type: "node.remove", nodeIds: ["g"] }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const deleted = applyEdit(canvas, plan.forward);
    expect(deleted.document.nodes.map((n) => n.id)).toEqual(["other"]);
    const restored = applyEdit(deleted, plan.inverse);
    expect(restored.document.nodes.map((n) => n.id).sort()).toEqual(["child1", "child2", "g", "other"]);
    expect(restored.document.edges.some((e) => e.id === "e1")).toBe(true);
    expect(restored.nodeData.child1.title).toBe("作品一");
  });

  it("删除后父 ID 被复用，恢复被拒绝", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [{ type: "node.remove", nodeIds: ["a"] }]);
    if (!plan.ok) return;
    const deleted = applyEdit(canvas, plan.forward);
    const reused = applyCanvasCommands(deleted, [
      { type: "node.add", node: { id: "a", type: "text", position: { x: 0, y: 0 } } }
    ], { now: NOW });
    if (!reused.ok) return;
    const result = applyCanvasCommands(reused.canvas, [
      { type: "edit.apply", preconditions: plan.inverse.preconditions, operations: plan.inverse.operations } as never
    ], { now: NOW });
    expect(result.ok).toBe(false);
  });
});

describe("planner 连线往返", () => {
  it("连线创建与删除映射一致的往返", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [
      { type: "edge.add", edge: { id: "e1", source: "a", target: "b" } }
    ]);
    if (!plan.ok) return;
    const connected = applyEdit(canvas, plan.forward);
    expect(connected.document.edges.some((e) => e.id === "e1")).toBe(true);
    const undone = applyEdit(connected, plan.inverse);
    expect(undone.document.edges.some((e) => e.id === "e1")).toBe(false);
  });

  it("删除边后撤销恢复同一稳定 edgeId", () => {
    const canvas = withNodes();
    canvas.document.edges = [{ id: "e1", source: "a", target: "b", sourceHandle: null, targetHandle: null, data: {} }];
    const plan = planCanvasEdit(canvas, [{ type: "edge.remove", edgeId: "e1" }]);
    if (!plan.ok) return;
    const removed = applyEdit(canvas, plan.forward);
    expect(removed.document.edges).toHaveLength(0);
    const restored = applyEdit(removed, plan.inverse);
    expect(restored.document.edges.some((e) => e.id === "e1")).toBe(true);
  });
});

describe("planner 重命名往返", () => {
  it("稳定项目关联可撤销/重做，保留无关远端标题并拒绝关联冲突", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [{ type: "nodeData.patch", nodeId: "a", value: { projectStorageKey: "key-a", inputHash: "hash-a" } }]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const associated = applyEdit(canvas, plan.forward);
    associated.nodeData.a.title = "远端名称";
    const undone = applyEdit(associated, plan.inverse);
    expect(undone.nodeData.a.projectStorageKey).toBeUndefined();
    expect(undone.nodeData.a.inputHash).toBeUndefined();
    expect(undone.nodeData.a.title).toBe("远端名称");
    const redone = applyEdit(undone, plan.forward);
    expect(redone.nodeData.a.projectStorageKey).toBe("key-a");
    redone.nodeData.a.projectStorageKey = "remote-key";
    const conflict = applyCanvasCommands(redone, [{ type: "edit.apply", ...plan.inverse }]);
    expect(conflict.ok).toBe(false);
  });

  it("重命名 title 后撤销恢复原值", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [
      { type: "nodeData.patch", nodeId: "a", value: { title: "夏季新品主图" } }
    ]);
    if (!plan.ok) return;
    const renamed = applyEdit(canvas, plan.forward);
    expect(renamed.nodeData.a.title).toBe("夏季新品主图");
    const restored = applyEdit(renamed, plan.inverse);
    expect(restored.nodeData.a.title).toBe("作品 A");
  });

  it("为原本无名称的节点命名后撤销移除该字段", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [
      { type: "nodeData.patch", nodeId: "b", value: { title: "新命名" } }
    ]);
    if (!plan.ok) return;
    const renamed = applyEdit(canvas, plan.forward);
    expect(renamed.nodeData.b.title).toBe("新命名");
    const restored = applyEdit(renamed, plan.inverse);
    expect(Object.prototype.hasOwnProperty.call(restored.nodeData.b, "title")).toBe(false);
  });
});

describe("planner 成组/解组往返", () => {
  it("成组（新增 group + reparent）与解组往返", () => {
    const canvas = base();
    canvas.document.nodes = [
      { id: "a", type: "text", position: { x: 0, y: 0 }, width: 260, height: 195 },
      { id: "b", type: "image", position: { x: 100, y: 0 }, width: 260, height: 195 }
    ];
    const groupPlan = planCanvasEdit(canvas, [
      { type: "node.add", node: { id: "g", type: "group", position: { x: -40, y: -40 }, width: 400, height: 300 } },
      { type: "node.update", nodeId: "a", parentId: "g" },
      { type: "node.update", nodeId: "b", parentId: "g" }
    ]);
    expect(groupPlan.ok).toBe(true);
    if (!groupPlan.ok) return;
    const grouped = applyEdit(canvas, groupPlan.forward);
    expect(grouped.document.nodes.find((n) => n.id === "a")?.parentId).toBe("g");
    const ungrouped = applyEdit(grouped, groupPlan.inverse);
    // 撤销后恢复为顶层（group 被删除，a/b 返回原父级）
    expect(ungrouped.document.nodes.some((n) => n.id === "g")).toBe(false);
    expect(ungrouped.document.nodes.find((n) => n.id === "a")?.parentId).toBeUndefined();
  });
});

describe("planner 无净变化与非法动作", () => {
  it("无净变化不产生可撤销记录", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [
      { type: "node.update", nodeId: "a", position: { x: 0, y: 0 } }
    ]);
    expect(plan.ok).toBe(false);
  });

  it("asset.upsert 不进入可撤销规划", () => {
    const canvas = withNodes();
    const plan = planCanvasEdit(canvas, [
      { type: "asset.upsert", asset: { id: "x", title: "t", mediaKind: "image", source: "generated", status: "ready", createdAt: NOW } }
    ]);
    expect(plan.ok).toBe(false);
  });
});
