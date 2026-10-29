import { describe, expect, it } from "vitest";
import { shotPreviewLinkOrigin } from "./shot-preview-scene-input.js";

// 「主用」画布上的真实片场徽标（group 高 2017.25、倍率 12.63 → 1110×808，画布坐标）。
const badge = { center: { x: 747.875, y: 4237.37 } };

describe("shotPreviewLinkOrigin", () => {
  it("片场 group 的归属线起点取徽标中心，不跟随相机姿态", () => {
    // 相机悬在场景上方，投影落在徽标上方的组气泡里（y 3707，徽标上缘 3833）。
    expect(shotPreviewLinkOrigin(badge, { x: 858, y: 3707 })).toEqual({ x: 747.875, y: 4237.37 });
  });

  it("相机投影缺失时仍能给出起点（徽标就是场景入口）", () => {
    expect(shotPreviewLinkOrigin(badge, null)).toEqual({ x: 747.875, y: 4237.37 });
  });

  it("没有外部徽标的复合资产片场退回相机姿态投影", () => {
    expect(shotPreviewLinkOrigin(null, { x: 120, y: -40 })).toEqual({ x: 120, y: -40 });
  });

  it("既无徽标也无相机投影时不画线", () => {
    expect(shotPreviewLinkOrigin(null, null)).toBeNull();
  });
});
