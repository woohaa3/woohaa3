import { applyCanvasCommands, planCanvasEdit } from "../../../test-support/managed-shot-commands.js";
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";


import { buildCanvasRenderScene } from "./render-scene.js";
import { hiddenByCollapsedGroups } from "./group-presentation.js";

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("groups");
  // 嵌套 group 已不再合法（change: 2026-10-27-order-canvas-layers-by-ground-anchor，design D7）；
  // 这里改用两个同级组，验证折叠呈现互不影响。
  canvas.document.nodes = [
    { id: "g", type: "group", position: { x: 100, y: 100 }, width: 600, height: 500 },
    { id: "member", type: "text", parentId: "g", position: { x: 40, y: 40 } },
    { id: "other", type: "group", position: { x: 800, y: 100 }, width: 400, height: 300 },
    { id: "inner", type: "text", parentId: "other", position: { x: 40, y: 40 } },
    { id: "external", type: "text", position: { x: 900, y: 700 } },
  ];
  canvas.document.edges = [{ id: "out", source: "member", target: "external", sourceHandle: null, targetHandle: null, data: {} }];
  canvas.nodeData = { g: { title: "作品组" }, other: { title: "另一组" }, member: { prompt: "保留成员任务", taskStatus: "processing" } };
  return canvas;
}

describe("group collapsed presentation", () => {
  it("折叠保留徽标底边中点、隐藏递归成员与相关边；展开恢复原有尺寸和成员位置", () => {
    const canvas = fixture();
    const before = JSON.stringify(canvas);
    const expanded = buildCanvasRenderScene({ canvas });
    const applied = applyCanvasCommands(canvas, [{ type: "nodeData.patch", nodeId: "g", value: { groupCollapsed: true } }]);
    if (!applied.ok) throw Error(applied.rejection.message);
    const collapsed = buildCanvasRenderScene({ canvas: applied.canvas, selection: { nodes: ["g", "member"] } });
    // 未归属节点固定在最低绘制层；组按结构底边锚点排序（other 底边 400 低于 g 的 600）。
    expect(collapsed.nodes.map(node => node.id)).toEqual(["external", "other", "inner", "g"]);
    expect(collapsed.edges).toEqual([]);
    expect(collapsed.selection.nodes).toEqual(["g"]);
    const ofGroup = (nodes: typeof expanded.nodes) => nodes.find(node => node.id === "g")!;
    const original = ofGroup(expanded.nodes), compact = ofGroup(collapsed.nodes);
    expect(compact.x + compact.width / 2).toBe(original.x + original.width / 2);
    expect(compact.y + compact.height).toBe(original.y + original.height);
    expect(compact).toMatchObject({ width: 196, height: 112, resizable: false, group: { memberCount: 1, collapsed: true } });
    expect(applied.canvas.document.nodes).toEqual(canvas.document.nodes);
    expect(applied.canvas.document.edges).toEqual(canvas.document.edges);
    expect(applied.canvas.nodeData.member).toEqual(canvas.nodeData.member);
    applied.canvas.nodeData.g.groupCollapsed = false;
    expect(buildCanvasRenderScene({ canvas: applied.canvas }).nodes).toEqual(expanded.nodes);
    expect(JSON.stringify(canvas)).toBe(before);
  });

  it("同级组的折叠状态互相独立", () => {
    const canvas = fixture();
    canvas.nodeData.g.groupCollapsed = true;
    canvas.nodeData.other.groupCollapsed = true;
    expect([...hiddenByCollapsedGroups(canvas)].sort()).toEqual(["inner", "member"]);
    canvas.nodeData.g.groupCollapsed = false;
    expect([...hiddenByCollapsedGroups(canvas)]).toEqual(["inner"]);
    expect(buildCanvasRenderScene({ canvas }).nodes.map(node => node.id)).toEqual(["external", "other", "g", "member"]);
  });

  it("折叠可撤销、重做；非法类型或非组写入整批拒绝", () => {
    let canvas = fixture();
    const plan = planCanvasEdit(canvas, [{ type: "nodeData.patch", nodeId: "g", value: { groupCollapsed: true } }]);
    if (!plan.ok) throw Error(plan.reason);
    for (const edit of [plan.forward, plan.inverse, plan.forward]) {
      const result = applyCanvasCommands(canvas, [{ type: "edit.apply", ...edit }]);
      if (!result.ok) throw Error(result.rejection.message);
      canvas = result.canvas;
      expect(canvas.document.nodes).toHaveLength(5);
    }
    expect(canvas.nodeData.g.groupCollapsed).toBe(true);
    for (const nodeId of ["g", "external"]) {
      expect(applyCanvasCommands(canvas, [{ type: "nodeData.patch", nodeId, value: { groupCollapsed: "true" } as never }]).ok).toBe(false);
    }
    expect(applyCanvasCommands(canvas, [{ type: "nodeData.patch", nodeId: "external", value: { groupCollapsed: true } }]).ok).toBe(false);
    expect(applyCanvasCommands(canvas, [{ type: "node.add", node: { id: "invalid", type: "text", position: { x: 0, y: 0 } }, nodeData: { groupCollapsed: true } }]).ok).toBe(false);
  });
});
