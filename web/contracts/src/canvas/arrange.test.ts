/**
 * 选区整理规划测试（change: 2026-10-09-improve-canvas-workflow，任务 4.3）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";
import { planArrangeNodes } from "./arrange.js";

const NOW = "2026-10-09T00:00:00.000Z";

function base(): ServerCanvas {
  return createEmptyWoohaa3ServerCanvas("c1", NOW);
}


describe("planArrangeNodes 对齐", () => {
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

