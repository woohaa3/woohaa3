import { describe, expect, it } from "vitest";
import { decodeVectorShapeParams } from "@woohaa3/photocraft-protocol";
import { SHAPE_KINDS, hitTolerance, shapeCreateParams, shapeGeometry, shapePreview } from "./shape-tools.js";

const canvas = [800, 600] as const;

describe("形状拖绘几何（U08/U09）", () => {
  it("反向拖绘也会翻正成非负矩形", () => {
    const geometry = shapeGeometry({ kind: "rect", start: [120, 90], end: [20, 30] }, canvas);
    expect(geometry.rect).toEqual([20, 30, 100, 60]);
  });

  it("Shift 约束比例：以较大边为准的正方形", () => {
    expect(shapeGeometry({ kind: "ellipse", start: [10, 10], end: [60, 30], modifiers: { constrain: true } }, canvas).rect)
      .toEqual([10, 10, 50, 50]);
  });

  it("Shift 把直线吸附到 15° 的整数倍并保持长度", () => {
    const drag = { kind: "line" as const, start: [0, 0] as const, end: [100, 10] as const, modifiers: { constrain: true } };
    const geometry = shapeGeometry(drag, canvas);
    expect(geometry.to[0]).toBeCloseTo(Math.hypot(100, 10), 6);
    expect(geometry.to[1]).toBeCloseTo(0, 6);
  });

  it("Alt 以起点为中心向两侧对称展开", () => {
    expect(shapeGeometry({ kind: "rect", start: [100, 100], end: [140, 130], modifiers: { fromCenter: true } }, canvas).rect)
      .toEqual([60, 70, 80, 60]);
  });

  it("零面积与越界几何直接拒绝，不产生半成品", () => {
    expect(() => shapeGeometry({ kind: "rect", start: [5, 5], end: [5, 5] }, canvas)).toThrow(/面积为零/);
    expect(() => shapeGeometry({ kind: "line", start: [5, 5], end: [5, 5] }, canvas)).toThrow(/长度为零/);
    expect(() => shapeGeometry({ kind: "rect", start: [5, 5], end: [1e9, 5] }, canvas)).toThrow(/超出文档可保存范围/);
    expect(() => shapeGeometry({ kind: "rect", start: [5, 5], end: [Number.NaN, 9] }, canvas)).toThrow(/超出文档可保存范围/);
  });
});

describe("形状参数编译（与内核同文）", () => {
  it("七种形状都产出可提交参数，矩形带四角圆角", () => {
    for (const kind of SHAPE_KINDS) {
      const params = shapeCreateParams({ kind, start: [0, 0], end: [80, 60], radius: 4, sides: 6, starRatio: 0.4, weight: 2 }, canvas);
      // 「三角形」是界面别名，提交时必须归一成内核认识的 polygon + sides: 3。
      expect(params.kind, kind).toBe(kind === "triangle" ? "polygon" : kind);
    }
    expect(shapeCreateParams({ kind: "rect", start: [0, 0], end: [80, 60], radius: 4 }, canvas))
      .toMatchObject({ kind: "rect", radii: [4, 4, 4, 4] });
    expect(shapeCreateParams({ kind: "line", start: [0, 0], end: [80, 60], weight: 3 }, canvas))
      .toMatchObject({ kind: "line", from: [0, 0], to: [80, 60], weight: 3 });
  });

  it("圆角矩形未填半径时取 10 与短边一半的较小值", () => {
    const params = shapeCreateParams({ kind: "roundedRect", start: [0, 0], end: [12, 8] }, canvas);
    expect(params.radii).toEqual([4, 4, 4, 4]);
  });

  it("三角形固定三边；多边形/星形按参数并拒绝越界", () => {
    // 三角形提交成内核认识的 polygon + sides: 3，而不是悬空的 `triangle` kind。
    const triangle = shapeCreateParams({ kind: "triangle", start: [0, 0], end: [10, 10] }, canvas);
    expect(triangle.kind).toBe("polygon");
    expect(triangle.sides).toBe(3);
    // 非星形不发 `starRatio`：多边形显式发 1.0 会被白名单判非法。
    expect(triangle.starRatio).toBeUndefined();
    expect(shapeCreateParams({ kind: "polygon", start: [0, 0], end: [10, 10], sides: 7 }, canvas).starRatio).toBeUndefined();
    expect(shapeCreateParams({ kind: "polygon", start: [0, 0], end: [10, 10], sides: 7 }, canvas).sides).toBe(7);
    expect(() => shapeCreateParams({ kind: "polygon", start: [0, 0], end: [10, 10], sides: 2 }, canvas)).toThrow(/边数/);
    expect(() => shapeCreateParams({ kind: "star", start: [0, 0], end: [10, 10], starRatio: 1.2 }, canvas)).toThrow(/内外比例/);
    expect(() => shapeCreateParams({ kind: "rect", start: [0, 0], end: [10, 10], radius: 50 }, canvas)).toThrow(/圆角半径/);
  });

  it("预览失败时给出可展示原因而不是抛错", () => {
    const preview = shapePreview({ kind: "rect", start: [3, 3], end: [3, 3] }, canvas);
    expect(preview.ok).toBe(false);
    if (!preview.ok) expect(preview.message).toMatch(/面积为零/);
    expect(shapePreview({ kind: "rect", start: [0, 0], end: [5, 5] }, canvas).ok).toBe(true);
  });

  it("命中阈值按取景换算，非法缩放退回屏幕阈值", () => {
    expect(hitTolerance(6, 2)).toBe(3);
    expect(hitTolerance(6, 0.5)).toBe(12);
    expect(hitTolerance(6, 0)).toBe(6);
    expect(hitTolerance(6, Number.NaN)).toBe(6);
  });

  it("每种形状的提交参数都通过协议解码器（UI 与内核只有一份 wire 契约）", () => {
    for (const kind of SHAPE_KINDS) {
      const params = shapeCreateParams({ kind, start: [0, 0], end: [80, 60], radius: 4, sides: 6, starRatio: 0.4, weight: 2 }, canvas);
      const decoded = decodeVectorShapeParams(params);
      expect(decoded, `${kind} 必须被协议接受`).not.toBeNull();
      // 界面种类与 wire 种类只在「三角形 → 三边多边形」这一处不同。
      expect(decoded!.kind).toBe(kind === "triangle" ? "polygon" : kind);
    }
    // 圆角矩形默认半径也必须是协议允许值（不能靠调用方补齐）。
    const rounded = shapeCreateParams({ kind: "roundedRect", start: [0, 0], end: [12, 8] }, canvas);
    expect(decodeVectorShapeParams(rounded)?.radii).toEqual([4, 4, 4, 4]);
    // 面板会在参数上追加 fillRule；解码器必须接受这一形态。
    expect(decodeVectorShapeParams({ ...shapeCreateParams({ kind: "rect", start: [0, 0], end: [8, 8] }, canvas), fillRule: "evenodd" })?.fillRule)
      .toBe("evenodd");
  });

  it("协议拒绝的参数不会被当成可提交候选送出", () => {
    const params = shapeCreateParams({ kind: "rect", start: [0, 0], end: [10, 10] }, canvas);
    expect(decodeVectorShapeParams({ ...params, rect: [0, 0, 0, 10] })).toBeNull();
    expect(decodeVectorShapeParams({ ...params, radii: [99, 99, 99, 99] })).toBeNull();
    // `sides` 只对多边形/星形有效：同样的越界值在 polygon 上必须被拒（在 rect 上则是无关字段）。
    const polygon = shapeCreateParams({ kind: "polygon", start: [0, 0], end: [10, 10], sides: 5 }, canvas);
    expect(decodeVectorShapeParams({ ...polygon, sides: 2 })).toBeNull();
    expect(decodeVectorShapeParams({ ...polygon, sides: 5 })).not.toBeNull();
  });
});
