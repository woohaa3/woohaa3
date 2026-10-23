import { describe, expect, it } from "vitest";
import {
  BOOLEAN_NOTES,
  BOOLEAN_OPS,
  PATH_MATRIX,
  booleanAvailability,
  booleanCommand,
  booleanParams,
  clippingPathParams,
  pathToSelectionParams,
  selectionToShapeParams,
  transformParams,
} from "./boolean-ops.js";

const ready = { readonly: false, shapeLayers: 2, activeIsShape: true, };

describe("布尔运算前置条件（U14）", () => {
  it("五种运算一一映射到 layer.combineShapes.*", () => {
    expect(BOOLEAN_OPS.map(booleanCommand)).toEqual([
      "layer.combineShapes.unite",
      "layer.combineShapes.subtractFrontShape",
      "layer.combineShapes.intersectShapeAreas",
      "layer.combineShapes.excludeOverlappingShapes",
      "layer.combineShapes.mergeShapeComponents",
    ]);
    for (const op of BOOLEAN_OPS) expect(BOOLEAN_NOTES[op].length).toBeGreaterThan(0);
  });

  it("只读、非形状层、形状层不足时禁用并写明原因", () => {
    expect(booleanAvailability("unite", ready)).toEqual({ enabled: true });
    expect(booleanAvailability("unite", { ...ready, readonly: true })).toMatchObject({ enabled: false });
    expect(booleanAvailability("unite", { ...ready, activeIsShape: false })).toMatchObject({ enabled: false });
    expect(booleanAvailability("unite", { ...ready, shapeLayers: 1 })).toMatchObject({ enabled: false });
    // 合并组件在单个形状层上也可用。
    expect(booleanAvailability("mergeShapeComponents", { ...ready, shapeLayers: 1 })).toEqual({ enabled: true });
  });

  it("多选合并整层不带 layer；单选改组件运算；容差只对合并组件生效", () => {
    expect(booleanParams("unite")).toEqual({});
    expect(booleanParams("subtractFrontShape", { layer: 4, subpath: 1 })).toEqual({ layer: 4, subpath: 1 });
    expect(booleanParams("mergeShapeComponents", { tolerance: 0.1 })).toEqual({ tolerance: 0.1 });
    expect(booleanParams("unite", { tolerance: 0.1 })).toEqual({});
    expect(() => booleanParams("mergeShapeComponents", { tolerance: 20 })).toThrow(/容差/);
  });
});

describe("路径变换、裁切与选区转换（U13）", () => {
  it("变换矩阵必须六个有限数值，并保留路径定位", () => {
    expect(transformParams({ name: "work" }, PATH_MATRIX.translate(10, 0)).matrix).toEqual([1, 0, 0, 1, 10, 0]);
    expect(transformParams({ name: "layer", layer: 2 }, PATH_MATRIX.scale(0.5))).toEqual({ name: "layer", layer: 2, matrix: [0.5, 0, 0, 0.5, 0, 0] });
    const rotate = PATH_MATRIX.rotate(90);
    expect(rotate[0]).toBeCloseTo(0, 12);
    expect(rotate[1]).toBeCloseTo(1, 12);
    expect(() => transformParams({ name: "work" }, [1, 0, 0, 1, 0] as unknown as Parameters<typeof transformParams>[1])).toThrow(/六个有限数值/);
    expect(() => transformParams({ name: "work" }, [1, 0, 0, 1, Number.NaN, 0])).toThrow(/六个有限数值/);
  });

  it("裁切路径引用路径名并裁定平直度", () => {
    expect(clippingPathParams("work")).toEqual({ name: "work", flatness: 0 });
    expect(() => clippingPathParams("   ")).toThrow(/已存路径/);
    expect(() => clippingPathParams("work", 200)).toThrow(/平直度/);
  });

  it("选区转形状与路径转选区的参数范围", () => {
    expect(selectionToShapeParams({ tolerance: 2, fill: "#ff0000", name: "描摹" })).toEqual({ tolerance: 2, fill: "#ff0000", name: "描摹" });
    expect(() => selectionToShapeParams({ tolerance: 0.1 })).toThrow(/容差/);
    expect(() => selectionToShapeParams({ tolerance: 20 })).toThrow(/容差/);
    expect(pathToSelectionParams({ name: "work" }, { feather: 2, mode: "add" })).toEqual({ name: "work", feather: 2, mode: "add" });
    expect(() => pathToSelectionParams({ name: "work" }, { feather: -1 })).toThrow(/羽化/);
  });
});
