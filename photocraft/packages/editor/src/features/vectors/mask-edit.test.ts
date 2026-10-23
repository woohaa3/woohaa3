import { describe, expect, it } from "vitest";
import {
  MASK_ACTIONS,
  maskEditParams,
  maskFromPathParams,
  maskPathTarget,
  maskState,
  maskSummaryText,
  maskVisibilityParams,
  rasterizeMaskParams,
  type VectorMaskSummary,
} from "./mask-edit.js";

const mask: VectorMaskSummary = { layer: 3, enabled: true, linked: true, density: 1, feather: 0 };

describe("矢量蒙版参数（U15）", () => {
  it("动作 id 与上游命令一一对应", () => {
    expect(MASK_ACTIONS).toEqual({
      revealAll: "layer.vectorMask.revealAll",
      hideAll: "layer.vectorMask.hideAll",
      edit: "layer.vectorMask.edit",
      enabled: "layer.vectorMask.enabled",
      linked: "layer.vectorMask.linked",
      delete: "layer.vectorMask.delete",
      fromPath: "layer.vectorMask.fromPath",
      currentPath: "layer.vectorMask.currentPath",
      rasterize: "layer.rasterize.vectorMask",
    });
  });

  it("全显/全隐只带目标图层与 hide 标记", () => {
    expect(maskVisibilityParams(4, true)).toEqual({ layer: 4, hide: false });
    expect(maskVisibilityParams(4, false)).toEqual({ layer: 4, hide: true });
    expect(maskVisibilityParams(null, true)).toEqual({ hide: false });
  });

  it("编辑参数按内核范围裁定，非法值直接抛错，不静默夹取", () => {
    expect(maskEditParams(2, { density: 55, feather: 12 })).toEqual({ layer: 2, density: 55, feather: 12 });
    expect(maskEditParams(2, { enabled: false, linked: false })).toEqual({ layer: 2, enabled: false, linked: false });
    // invert 只是「翻转一次」，false 不进参数。
    expect(maskEditParams(2, { invert: true })).toEqual({ layer: 2, invert: true });
    expect(maskEditParams(2, { invert: false })).toEqual({ layer: 2 });
    expect(() => maskEditParams(2, { density: 101 })).toThrow(/密度/);
    expect(() => maskEditParams(2, { density: -1 })).toThrow(/密度/);
    expect(() => maskEditParams(2, { feather: 1001 })).toThrow(/羽化/);
    expect(() => maskEditParams(2, { feather: Number.NaN })).toThrow(/羽化/);
    expect(() => maskEditParams(2, { enabled: 1 as unknown as boolean })).toThrow(/布尔/);
  });

  it("从路径创建、栅格化与直接编辑目标的参数形态", () => {
    expect(maskFromPathParams(5, "work")).toEqual({ layer: 5, name: "work" });
    expect(maskFromPathParams(null, "work")).toEqual({ name: "work" });
    expect(rasterizeMaskParams(5)).toEqual({ layer: 5 });
    expect(rasterizeMaskParams(null)).toEqual({});
    expect(maskPathTarget(5)).toEqual({ name: "layer", layer: 5 });
  });

  it("状态与摘要只读蒙版自身，不重建第二套模型", () => {
    expect(maskState(undefined)).toBe("none");
    expect(maskState(mask)).toBe("editable");
    expect(maskState({ ...mask, enabled: false })).toBe("disabled");
    expect(maskSummaryText(mask)).toBe("已启用 · 已链接");
    expect(maskSummaryText({ ...mask, enabled: false, linked: false, density: 0.5, feather: 4, inverted: true }))
      .toBe("已停用 · 未链接 · 密度 50% · 羽化 4 px · 已反转");
  });
});
