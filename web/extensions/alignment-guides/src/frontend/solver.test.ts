import { describe, expect, it } from "vitest";
import type { AlignmentRect } from "@woohaa3/frontend/extension-api";
import { resolveAlignmentSnap } from "./solver.js";

const rect = (x: number, y: number, width: number, height: number): AlignmentRect => ({ x, y, width, height });

describe("resolveAlignmentSnap", () => {
  it("超出阈值时不吸附也不出参考线", () => {
    const result = resolveAlignmentSnap({
      moving: [rect(0, 0, 100, 100)],
      candidates: [rect(200, 130, 100, 40)],
      threshold: 6
    });
    expect(result).toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("左边贴左边：向右吸附并给出一条竖直参考线", () => {
    const result = resolveAlignmentSnap({
      moving: [rect(3, 40, 100, 50)],
      candidates: [rect(0, 0, 80, 200)],
      threshold: 6
    });
    expect(result.dx).toBeCloseTo(-3);
    expect(result.dy).toBe(0);
    const vertical = result.guides.filter(guide => guide.axis === "x");
    expect(vertical).toHaveLength(1);
    expect(vertical[0]!.position).toBeCloseTo(0);
    expect(vertical[0]!.start).toBeCloseTo(-6);
    expect(vertical[0]!.end).toBeCloseTo(206);
    expect(vertical[0]!.kind).toBe("start");
  });

  it("两个轴各自独立：x 命中、y 无候选时不偏移", () => {
    const result = resolveAlignmentSnap({
      moving: [rect(10, 10, 100, 100)],
      candidates: [rect(0, 200, 50, 500)],
      threshold: 12
    });
    expect(result.dx).toBeCloseTo(-10);
    expect(result.dy).toBe(0);
    expect(result.guides.some(guide => guide.axis === "x")).toBe(true);
    expect(result.guides.some(guide => guide.axis === "y")).toBe(false);
  });

  it("中心线对齐命中 center 类型", () => {
    const result = resolveAlignmentSnap({
      moving: [rect(50, 300, 100, 40)],
      candidates: [rect(0, 0, 200, 80)],
      threshold: 6
    });
    expect(result.dx).toBeCloseTo(0);
    const vertical = result.guides.find(guide => guide.axis === "x");
    expect(vertical?.kind).toBe("center");
    expect(vertical?.position).toBeCloseTo(100);
  });

  it("同时与多个对象对齐时，同一位置的线只出一次且跨度取并集", () => {
    const result = resolveAlignmentSnap({
      moving: [rect(0, 100, 100, 100)],
      candidates: [rect(0, 0, 50, 50), rect(0, 400, 50, 50)],
      threshold: 6
    });
    const vertical = result.guides.filter(guide => guide.axis === "x" && guide.position === 0);
    expect(vertical).toHaveLength(1);
    expect(vertical[0]!.start).toBeCloseTo(-6);
    expect(vertical[0]!.end).toBeCloseTo(456);
  });

  it("多选拖动按并集矩形求对齐", () => {
    const result = resolveAlignmentSnap({
      moving: [rect(3, 0, 50, 50), rect(3, 200, 50, 50)],
      candidates: [rect(0, 0, 20, 600)],
      threshold: 6
    });
    expect(result.dx).toBeCloseTo(-3);
    expect(result.guides.filter(guide => guide.axis === "x")).toHaveLength(1);
  });

  it("没有候选时保持原位移且不产生参考线", () => {
    expect(resolveAlignmentSnap({ moving: [rect(0, 0, 10, 10)], candidates: [], threshold: 6 }))
      .toEqual({ dx: 0, dy: 0, guides: [] });
  });

  it("阈值按世界单位生效", () => {
    const input = { moving: [rect(20, 0, 10, 10)], candidates: [rect(0, 0, 10, 10)] };
    expect(resolveAlignmentSnap({ ...input, threshold: 6 }).dx).toBe(0);
    expect(resolveAlignmentSnap({ ...input, threshold: 12 }).dx).toBeCloseTo(-10);
  });

  it("每个轴最多输出 3 条参考线", () => {
    const result = resolveAlignmentSnap({
      moving: [rect(0, 0, 100, 100)],
      candidates: [rect(0, 200, 10, 10), rect(50, 300, 10, 10), rect(100, 400, 10, 10), rect(25, 500, 10, 10)],
      threshold: 6
    });
    expect(result.guides.filter(guide => guide.axis === "x").length).toBeLessThanOrEqual(3);
  });
});
