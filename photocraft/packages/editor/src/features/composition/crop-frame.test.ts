import { expect, it } from "vitest";
import {
  CROP_HANDLES,
  cropFrameCenter,
  cropGridLines,
  cropHandlePoint,
  dragCropFrame,
  isValidCropFrame,
  straightenAngle,
  MIN_CROP_SIZE
} from "./crop-frame.js";

const frame = { x: 10, y: 20, width: 100, height: 80 };

it("框中心与九个手柄落在框的对应边上", () => {
  expect(cropFrameCenter(frame)).toEqual({ x: 60, y: 60 });
  expect(cropHandlePoint(frame, "nw")).toEqual({ x: 10, y: 20 });
  expect(cropHandlePoint(frame, "se")).toEqual({ x: 110, y: 100 });
  expect(cropHandlePoint(frame, "n")).toEqual({ x: 60, y: 20 });
  expect(cropHandlePoint(frame, "e")).toEqual({ x: 110, y: 60 });
  expect(cropHandlePoint(frame, "rotate")).toEqual(cropHandlePoint(frame, "n"));
  expect(CROP_HANDLES).toEqual(["nw", "n", "ne", "e", "se", "s", "sw", "w", "rotate"]);
});

it("移动手柄只平移，不改变宽高", () => {
  expect(dragCropFrame(frame, "move", { x: 5.4, y: -3.6 })).toEqual({ x: 15, y: 16, width: 100, height: 80 });
});

it("八个方向手柄各自只改对应边", () => {
  expect(dragCropFrame(frame, "e", { x: 20, y: 999 })).toEqual({ x: 10, y: 20, width: 120, height: 80 });
  expect(dragCropFrame(frame, "w", { x: -20, y: 999 })).toEqual({ x: -10, y: 20, width: 120, height: 80 });
  expect(dragCropFrame(frame, "s", { x: 999, y: 10 })).toEqual({ x: 10, y: 20, width: 100, height: 90 });
  expect(dragCropFrame(frame, "n", { x: 999, y: 10 })).toEqual({ x: 10, y: 30, width: 100, height: 70 });
  // 角手柄同时改两边。
  expect(dragCropFrame(frame, "se", { x: 10, y: 10 })).toEqual({ x: 10, y: 20, width: 110, height: 90 });
  expect(dragCropFrame(frame, "nw", { x: -10, y: -10 })).toEqual({ x: 0, y: 10, width: 110, height: 90 });
});

it("拖过头不会翻转，宽高停在最小尺寸；非法 delta 原样返回", () => {
  const collapsed = dragCropFrame(frame, "e", { x: -1000, y: 0 });
  expect(collapsed.width).toBe(MIN_CROP_SIZE);
  expect(collapsed.x).toBe(10);
  expect(dragCropFrame(frame, "w", { x: 1000, y: 0 }).width).toBe(MIN_CROP_SIZE);
  expect(dragCropFrame(frame, "move", { x: Number.NaN, y: 0 })).toEqual(frame);
  expect(dragCropFrame(frame, "rotate", { x: 30, y: 30 })).toEqual(frame);
});

it("比例约束围绕对角锚点，边手柄围绕对边中点", () => {
  // 4:3；拖右下角，左上角固定。
  const corner = dragCropFrame(frame, "se", { x: 40, y: 0 }, { ratio: 4 / 3 });
  expect(corner.x).toBe(10);
  expect(corner.y).toBe(20);
  expect(corner.width / corner.height).toBeCloseTo(4 / 3, 1);
  expect(corner.width).toBe(140);
  // 拖右边，垂直中心不变。
  const edge = dragCropFrame(frame, "e", { x: 20, y: 0 }, { ratio: 1 });
  expect(edge.width).toBe(120);
  expect(edge.height).toBe(120);
  expect(edge.y).toBe(0);
  // 比例夹到最小尺寸后不再出现 0 宽高。
  const tiny = dragCropFrame({ x: 0, y: 0, width: 1, height: 1 }, "se", { x: -50, y: -50 }, { ratio: 2 });
  expect(tiny.width).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
  expect(tiny.height).toBeGreaterThanOrEqual(MIN_CROP_SIZE);
});

it("禁止越界时移动与缩放都夹在画布内", () => {
  const document = { width: 120, height: 100 };
  const moved = dragCropFrame(frame, "move", { x: 50, y: 50 }, { allowOutside: false, document });
  expect(moved).toEqual({ x: 20, y: 20, width: 100, height: 80 });
  const resized = dragCropFrame(frame, "se", { x: 200, y: 200 }, { allowOutside: false, document });
  expect(resized.x + resized.width).toBeLessThanOrEqual(document.width);
  expect(resized.y + resized.height).toBeLessThanOrEqual(document.height);
});

it("拉直角度以正上方为 0、顺时针为正，并夹到 ±45°", () => {
  const center = { x: 50, y: 50 };
  expect(straightenAngle(center, { x: 50, y: 0 })).toBe(0);
  expect(straightenAngle(center, { x: 60, y: 40 })).toBe(45);
  expect(straightenAngle(center, { x: 40, y: 40 })).toBe(-45);
  expect(straightenAngle(center, { x: 150, y: 50 })).toBe(45);
  expect(straightenAngle(center, center)).toBe(0);
  expect(straightenAngle(center, { x: Number.NaN, y: 1 })).toBe(0);
});

it("网格线：三分线各两条，网格按步长生成且总数受限", () => {
  expect(cropGridLines(frame, "none")).toEqual({ x: [], y: [] });
  const thirds = cropGridLines(frame, "thirds");
  expect(thirds.x).toHaveLength(2);
  expect(thirds.x[0]).toBeCloseTo(10 + 100 / 3);
  expect(thirds.y[1]).toBeCloseTo(20 + (80 * 2) / 3);
  const grid = cropGridLines(frame, "grid", 20);
  expect(grid.x).toHaveLength(4);
  expect(grid.y).toHaveLength(3);
  // 超大框仍然只生成有限条线。
  const huge = cropGridLines({ x: 0, y: 0, width: 100_000, height: 100_000 }, "grid", 1);
  expect(huge.x.length).toBeLessThanOrEqual(400);
  expect(huge.y.length).toBeLessThanOrEqual(400);
});

it("合法框判定拒绝非有限值与亚像素尺寸", () => {
  expect(isValidCropFrame(frame)).toBe(true);
  expect(isValidCropFrame({ x: 0, y: 0, width: 0, height: 10 })).toBe(false);
  expect(isValidCropFrame({ x: 0, y: 0, width: 10, height: Number.POSITIVE_INFINITY })).toBe(false);
});
