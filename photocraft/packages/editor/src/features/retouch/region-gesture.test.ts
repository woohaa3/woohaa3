import { describe, expect, it } from "vitest";
import {
  MAX_RED_EYE_POINTS,
  addRedEyePoint,
  dragOffset,
  isRegionDrag,
  redEyePointsInRect,
  regionGestureFromDrag,
  regionGestureKind
} from "./region-gesture.js";
import { DEFAULT_REGION_OPTIONS } from "./tool-parameters.js";

/**
 * 区域手势的几何与拒绝条件（change: 2026-10-22-add-photocraft-retouch-workflows，U37）。
 *
 * 共享画布（单一写入）把拖动/单击原始坐标交给本域；这里锁定「零偏移不发起命令」「红眼不是
 * 拖动」「最多 64 处」「重复点不重复添加」这几条，避免集成时在共享文件里再写一遍规则。
 */

describe("区域拖动", () => {
  it("取整到像素并把零偏移判成「没有拖动」", () => {
    expect(dragOffset({ from: { x: 10.4, y: 4.6 }, to: { x: 22.6, y: 4.2 } })).toEqual([12, 0]);
    expect(dragOffset({ from: { x: 10, y: 4 }, to: { x: 10.4, y: 4.4 } })).toBeNull();
    expect(dragOffset(null)).toBeNull();
    expect(dragOffset({ from: { x: Number.NaN, y: 0 }, to: { x: 1, y: 1 } })).toBeNull();
    expect(isRegionDrag({ from: { x: 0, y: 0 }, to: { x: 0, y: 0 } })).toBe(false);
    expect(isRegionDrag({ from: { x: 0, y: 0 }, to: { x: 3, y: -2 } })).toBe(true);
  });

  it("拖动 → 区域参数入口，拒绝零偏移与越界选项", () => {
    const ok = regionGestureFromDrag("paint.patch", { from: { x: 2, y: 2 }, to: { x: 12, y: 2 } }, DEFAULT_REGION_OPTIONS);
    expect("gesture" in ok && ok.gesture.offset).toEqual([10, 0]);
    const zero = regionGestureFromDrag("paint.patch", { from: { x: 2, y: 2 }, to: { x: 2, y: 2 } }, DEFAULT_REGION_OPTIONS);
    expect("reason" in zero && zero.reason).toContain("1 像素");
    const bad = regionGestureFromDrag("paint.contentAwareMove", { from: { x: 2, y: 2 }, to: { x: 8, y: 2 } }, {
      ...DEFAULT_REGION_OPTIONS,
      structure: 9
    });
    expect("reason" in bad && bad.reason).toContain("结构");
    // 红眼不是拖动：误用拖动入口必须说明，而不是当成「点了一处」。
    const redEye = regionGestureFromDrag("paint.redEye", { from: { x: 2, y: 2 }, to: { x: 8, y: 2 } }, DEFAULT_REGION_OPTIONS);
    expect("reason" in redEye && redEye.reason).toContain("红眼");
    expect(regionGestureKind("paint.redEye")).toBe("click");
    expect(regionGestureKind("paint.patch")).toBe("drag");
  });
});

describe("红眼标记", () => {
  it("重复点不重复添加，越界与非法坐标给出原因", () => {
    const first = addRedEyePoint([], { x: 12.4, y: 9.6 });
    expect(first.points).toEqual([[12, 10]]);
    expect(first.reason).toBeNull();
    const again = addRedEyePoint(first.points, { x: 12.2, y: 9.9 });
    expect(again.points).toEqual([[12, 10]]);
    expect(again.reason).toContain("已经标记");
    const invalid = addRedEyePoint(first.points, { x: Number.NaN, y: 1 });
    expect(invalid.reason).toContain("无效");
    expect(invalid.points).toEqual([[12, 10]]);
  });

  it("超过 64 处时拒绝，而不是静默丢弃", () => {
    const many = Array.from({ length: MAX_RED_EYE_POINTS }, (_, index) => [index, index] as const);
    const overflow = addRedEyePoint(many, { x: 200, y: 200 });
    expect(overflow.points).toHaveLength(MAX_RED_EYE_POINTS);
    expect(overflow.reason).toContain("64");
  });

  it("框选取区域内一点（不把整块当红眼）", () => {
    expect(redEyePointsInRect({ x: 10, y: 20, width: 8, height: 6 })).toEqual([[14, 23]]);
    expect(redEyePointsInRect({ x: 10, y: 20, width: -8, height: -6 })).toEqual([[6, 17]]);
    expect(redEyePointsInRect(null)).toEqual([]);
  });
});
