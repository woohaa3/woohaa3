import { describe, expect, it } from "vitest";
import { IMAGE_PROJECT_LIMITS } from "../../image-edit.js";
import {
  VECTOR_LIMITS,
  VECTOR_SHAPE_KINDS,
  decodeVectorShapeParams,
  decodeVectorShapePresetLibrary,
  vectorPathWithinBudget,
  vectorPresetSnapshotWithinBudget
} from "./params.js";

describe("形状参数解码（U08/U09/U10）", () => {
  it("矩形与圆角矩形：翻正后的矩形、四角圆角与填充规则", () => {
    expect(decodeVectorShapeParams({ kind: "rect", rect: [10, 20, 30, 40] }))
      .toEqual({ kind: "rect", rect: [10, 20, 30, 40], from: null, to: null, radii: null, sides: null, starRatio: null, weight: null, fillRule: "nonzero", op: null });
    expect(decodeVectorShapeParams({ kind: "roundedRect", rect: [0, 0, 40, 20], radii: 6, fillRule: "evenodd", op: "subtract" }))
      .toMatchObject({ radii: [6, 6, 6, 6], fillRule: "evenodd", op: "subtract" });
    expect(decodeVectorShapeParams({ kind: "roundedRect", rect: [0, 0, 40, 20], radii: [1, 2, 3, 4] })?.radii).toEqual([1, 2, 3, 4]);
  });

  it("椭圆、多边形与星形的形状专属参数范围", () => {
    expect(decodeVectorShapeParams({ kind: "ellipse", rect: [0, 0, 10, 10] })?.sides).toBeNull();
    expect(decodeVectorShapeParams({ kind: "polygon", rect: [0, 0, 10, 10] })?.sides).toBe(5);
    expect(decodeVectorShapeParams({ kind: "polygon", rect: [0, 0, 10, 10], sides: 8 })?.sides).toBe(8);
    expect(decodeVectorShapeParams({ kind: "polygon", rect: [0, 0, 10, 10], sides: 3 })?.sides).toBe(3);
    expect(decodeVectorShapeParams({ kind: "star", rect: [0, 0, 10, 10], starRatio: 0.3 })).toMatchObject({ sides: 5, starRatio: 0.3 });
    expect(VECTOR_SHAPE_KINDS).toContain("path");
    // 界面上的「三角形」不是 wire 种类：内核只认 polygon，编辑器负责编译成 sides: 3。
    expect(VECTOR_SHAPE_KINDS).not.toContain("triangle");
    expect(decodeVectorShapeParams({ kind: "triangle", rect: [0, 0, 10, 10] })).toBeNull();
  });

  it("直线只认端点与线宽，并拒绝零长度", () => {
    expect(decodeVectorShapeParams({ kind: "line", from: [0, 0], to: [10, 10], weight: 3 }))
      .toMatchObject({ kind: "line", rect: null, from: [0, 0], to: [10, 10], weight: 3 });
    expect(decodeVectorShapeParams({ kind: "line", from: [0, 0], to: [10, 10] })?.weight).toBe(1);
    expect(decodeVectorShapeParams({ kind: "line", from: [5, 5], to: [5, 5] })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "line", from: [0, 0] })).toBeNull();
  });

  it("非法参数一律返回 null，不做静默夹取", () => {
    expect(decodeVectorShapeParams(null)).toBeNull();
    expect(decodeVectorShapeParams({})).toBeNull();
    expect(decodeVectorShapeParams({ kind: "hexagon", rect: [0, 0, 1, 1] })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "rect", rect: [0, 0, 0, 10] })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "rect", rect: [0, 0, 10, 10], fillRule: "winding" })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "rect", rect: [0, 0, 10, 10], op: "union" })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "rect", rect: [0, 0, 10, 10], radii: 6 })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "polygon", rect: [0, 0, 10, 10], sides: 2 })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "polygon", rect: [0, 0, 10, 10], sides: 101 })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "star", rect: [0, 0, 10, 10], starRatio: 1 })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "star", rect: [0, 0, 10, 10], starRatio: 0 })).toBeNull();
    // 非星形带凹比例会被内核渲染成星形，与请求的 kind 不符，必须拒绝。
    expect(decodeVectorShapeParams({ kind: "polygon", rect: [0, 0, 10, 10], starRatio: 0.5 })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "rect", rect: [0, 0, VECTOR_LIMITS.coordLimit + 1, 10] })).toBeNull();
    expect(decodeVectorShapeParams({ kind: "line", from: [0, 0], to: [10, 10], weight: -1 })).toBeNull();
  });

  it("路径形状由 path 字段承载几何，不要求 rect", () => {
    expect(decodeVectorShapeParams({ kind: "path", path: { subpaths: [] } })).toMatchObject({ kind: "path", rect: null });
    expect(decodeVectorShapeParams({ kind: "path" })).not.toBeNull();
  });
});

describe("预设库快照解码（U16）", () => {
  const library = {
    groups: [{ name: "基本形状", shapes: [{ name: "矩形", digest: "0123456789abcdef", subpaths: 1 }] }],
    custom: [{ name: "箭头", digest: "fedcba9876543210", subpaths: 2 }],
  };

  it("内置组与自定形状都保留有界摘要", () => {
    const decoded = decodeVectorShapePresetLibrary(library)!;
    expect(decoded.groups[0]!.shapes[0]).toEqual({ name: "矩形", digest: "0123456789abcdef", subpaths: 1 });
    expect(decoded.custom[0]).toEqual({ name: "箭头", digest: "fedcba9876543210", subpaths: 2 });
  });

  it("结构不符、名称或摘要非法、超预算都返回 null", () => {
    expect(decodeVectorShapePresetLibrary(null)).toBeNull();
    expect(decodeVectorShapePresetLibrary({ groups: [] })).toBeNull();
    expect(decodeVectorShapePresetLibrary({ groups: [], custom: [{ name: "x" }] })).toBeNull();
    expect(decodeVectorShapePresetLibrary({ groups: [], custom: [{ name: " ", subpaths: 0 }] })).toBeNull();
    expect(decodeVectorShapePresetLibrary({ groups: [], custom: [{ name: "x", subpaths: 0, digest: "nope" }] })).toBeNull();
    expect(decodeVectorShapePresetLibrary({ groups: [], custom: [{ name: "x".repeat(VECTOR_LIMITS.maxPresetName + 1), subpaths: 0 }] })).toBeNull();
    expect(decodeVectorShapePresetLibrary({ groups: [], custom: new Array(VECTOR_LIMITS.maxCustomShapes + 1).fill({ name: "x", subpaths: 0 }) })).toBeNull();
    expect(decodeVectorShapePresetLibrary({ groups: [{ name: "g", shapes: [{ name: "x", subpaths: 0 }] }], custom: [] })?.groups[0]!.name).toBe("g");
  });

  it("快照预算与本域常量一致", () => {
    expect(vectorPresetSnapshotWithinBudget("x".repeat(VECTOR_LIMITS.maxSnapshotBytes))).toBe(true);
    expect(vectorPresetSnapshotWithinBudget("x".repeat(VECTOR_LIMITS.maxSnapshotBytes + 1))).toBe(false);
  });
});

describe("路径几何预算（U11–U15）", () => {
  it("接受数组锚点与对象锚点两种写法", () => {
    expect(vectorPathWithinBudget({ subpaths: [{ knots: [[0, 0], [10, 10]] }] })).toBe(true);
    expect(vectorPathWithinBudget({ subpaths: [{ knots: [{ anchor: [0, 0], in: [0, 0], out: [5, 5] }] }] })).toBe(true);
  });

  it("拒绝空路径、非法结构与越界坐标", () => {
    expect(vectorPathWithinBudget(null)).toBe(false);
    expect(vectorPathWithinBudget({ subpaths: [] })).toBe(false);
    expect(vectorPathWithinBudget({ subpaths: [{ knots: [] }] })).toBe(false);
    expect(vectorPathWithinBudget({ subpaths: [{ knots: [[VECTOR_LIMITS.coordLimit + 1, 0]] }] })).toBe(false);
    expect(vectorPathWithinBudget({ subpaths: [{ knots: [{ anchor: [0, 0], out: [Number.NaN, 0] }] }] })).toBe(false);
    expect(vectorPathWithinBudget({ subpaths: new Array(VECTOR_LIMITS.maxSubpaths + 1).fill({ knots: [[0, 0]] }) })).toBe(false);
  });

  it("单子路径与全路径锚点预算都生效（解码前拒绝，不靠渲染期夹取）", () => {
    // 子路径数在预算内，但单条子路径锚点超过上限。
    const longSubpath = { knots: new Array(VECTOR_LIMITS.maxKnotsPerSubpath + 1).fill([0, 0]) };
    expect(vectorPathWithinBudget({ subpaths: [longSubpath] })).toBe(false);
    // 每条子路径都在单项预算内，但累计锚点超过全文档预算。
    const subpaths: unknown[] = [];
    const knots = new Array(64).fill([0, 0]);
    while (subpaths.length * knots.length <= VECTOR_LIMITS.maxPathPoints) subpaths.push({ knots });
    expect(subpaths.length).toBeLessThanOrEqual(VECTOR_LIMITS.maxSubpaths);
    expect(vectorPathWithinBudget({ subpaths })).toBe(false);
    // 预算引用 `IMAGE_PROJECT_LIMITS`，不是本域另留的一份数字。
    expect(VECTOR_LIMITS.maxSavedPaths).toBe(IMAGE_PROJECT_LIMITS.maxVectorSavedPaths);
    expect(VECTOR_LIMITS.maxSubpaths).toBe(IMAGE_PROJECT_LIMITS.maxVectorSubpaths);
    expect(VECTOR_LIMITS.maxKnotsPerSubpath).toBe(IMAGE_PROJECT_LIMITS.maxVectorKnotsPerSubpath);
    expect(VECTOR_LIMITS.maxPathPoints).toBe(IMAGE_PROJECT_LIMITS.maxVectorPathPoints);
  });
});
