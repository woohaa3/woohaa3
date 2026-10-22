/**
 * 选区整理规划测试（change: 2026-10-09-improve-canvas-workflow，任务 4.3）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";
import { planArrangeNodes } from "./arrange.js";
import { applyCanvasCommands } from "./command-reducer.js";
import { nodeWorldRect } from "./geometry.js";

const NOW = "2026-10-09T00:00:00.000Z";

function base(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas("c1", NOW);
}

function threeFree(): ServerCanvas {
  const canvas = base();
  canvas.document.nodes = [
    { id: "a", type: "text", position: { x: 0, y: 0 }, width: 300, height: 100 },
    { id: "b", type: "image", position: { x: 200, y: 400 }, width: 300, height: 100 },
    { id: "c", type: "video", position: { x: 400, y: 160 }, width: 300, height: 100 }
  ];
  return canvas;
}

describe("planArrangeNodes 对齐", () => {
  it("左对齐生成 node.update 且用选区最左边界", () => {
    const canvas = threeFree();
    const result = planArrangeNodes(canvas, ["a", "b", "c"], { kind: "left" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyCanvasCommands(canvas, result.commands, { now: NOW });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    for (const id of ["a", "b", "c"]) {
      expect(applied.canvas.document.nodes.find((n) => n.id === id)?.position.x).toBe(0);
    }
  });

  it("垂直等距分布固定两端且保持世界位置", () => {
    const canvas = threeFree();
    const result = planArrangeNodes(canvas, ["a", "b", "c"], { kind: "vertical" });
    // a/b/c 的 y 起点 0/400/160 → 排序 a(0),c(160),b(400)
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyCanvasCommands(canvas, result.commands, { now: NOW });
    if (!applied.ok) return;
    const yOf = (id: string) => applied.canvas.document.nodes.find((n) => n.id === id)!.position.y;
    // 固定两端：a=0，b 底边 400+100=500；总高 3×100=300，跨度 500，g=(500-300)/2=100
    expect(yOf("a")).toBe(0);
    expect(yOf("b")).toBe(400);
    expect(yOf("c")).toBe(200);
  });
});

describe("planArrangeNodes 非法输入", () => {
  it("跨直接父级混选被禁用", () => {
    const canvas = base();
    canvas.document.nodes = [
      { id: "g1", type: "group", position: { x: 0, y: 0 }, width: 300, height: 300 },
      { id: "g2", type: "group", position: { x: 500, y: 0 }, width: 300, height: 300 },
      { id: "a", type: "text", position: { x: 20, y: 20 }, parentId: "g1", width: 100, height: 50 },
      { id: "b", type: "text", position: { x: 20, y: 20 }, parentId: "g2", width: 100, height: 50 }
    ];
    const result = planArrangeNodes(canvas, ["a", "b"], { kind: "left" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("同一层级");
  });

  it("父组与后代混选被禁用", () => {
    const canvas = base();
    canvas.document.nodes = [
      { id: "g", type: "group", position: { x: 0, y: 0 }, width: 400, height: 400 },
      { id: "child", type: "text", position: { x: 20, y: 20 }, parentId: "g", width: 100, height: 50 }
    ];
    const result = planArrangeNodes(canvas, ["g", "child"], { kind: "left" });
    expect(result.ok).toBe(false);
  });

  it("空间不足的分布被禁用并给出原因", () => {
    const canvas = base();
    canvas.document.nodes = [
      { id: "a", type: "text", position: { x: 0, y: 0 }, width: 200, height: 50 },
      { id: "b", type: "text", position: { x: 10, y: 0 }, width: 200, height: 50 },
      { id: "c", type: "text", position: { x: 20, y: 0 }, width: 200, height: 50 }
    ];
    const result = planArrangeNodes(canvas, ["a", "b", "c"], { kind: "horizontal" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("空间不足");
  });

  it("无净变化返回空命令", () => {
    const canvas = base();
    canvas.document.nodes = [
      { id: "a", type: "text", position: { x: 0, y: 0 }, width: 100, height: 50 },
      { id: "b", type: "text", position: { x: 0, y: 100 }, width: 100, height: 50 }
    ];
    const result = planArrangeNodes(canvas, ["a", "b"], { kind: "left" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.commands).toHaveLength(0);
  });
});

describe("planArrangeNodes 组内整理保持未选成员世界位置", () => {
  it("组内两个成员左对齐后，未选成员世界位置不变", () => {
    const canvas = base();
    canvas.document.nodes = [
      { id: "g", type: "group", position: { x: 0, y: 0 }, width: 600, height: 400 },
      { id: "m1", type: "text", position: { x: 40, y: 40 }, parentId: "g", width: 100, height: 50 },
      { id: "m2", type: "text", position: { x: 300, y: 40 }, parentId: "g", width: 100, height: 50 },
      { id: "m3", type: "text", position: { x: 500, y: 300 }, parentId: "g", width: 100, height: 50 }
    ];
    const byIdBefore = new Map(canvas.document.nodes.map((n) => [n.id, n]));
    const m3Before = nodeWorldRect(byIdBefore.get("m3")!, byIdBefore);

    const result = planArrangeNodes(canvas, ["m1", "m2"], { kind: "left" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyCanvasCommands(canvas, result.commands, { now: NOW });
    if (!applied.ok) return;
    const byIdAfter = new Map(applied.canvas.document.nodes.map((n) => [n.id, n]));
    const m3After = nodeWorldRect(byIdAfter.get("m3")!, byIdAfter);
    expect(m3After.x).toBeCloseTo(m3Before.x, 3);
    expect(m3After.y).toBeCloseTo(m3Before.y, 3);
  });
});
