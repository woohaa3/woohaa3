import { describe, expect, it } from "vitest";
import { groupBadgePresentationScreenRect } from "./group-badge-screen-rect.js";

describe("groupBadgePresentationScreenRect", () => {
  // 迁移后的真实数据（主用画布 revision 921）：节点自身 1566×1158，成员布局矩形 1624.25×2017.25。
  const node = { type: "group", width: 1566, height: 1158 };
  const layout = { width: 1624.25, height: 2017.25 };
  const zoom = 0.3;
  const card = { left: 100, top: 50, width: node.width * zoom, height: node.height * zoom };
  const projection = { width: 320, height: 240 };

  it("按渲染矩形（成员布局尺寸）的下缘定位徽标，不用节点自身尺寸", () => {
    const badge = groupBadgePresentationScreenRect({ card, zoom, node, layout, collapsed: false, projection })!;
    // 徽标顶 = 卡片顶 + (布局高度 + 40 - 投影高/2) × 倍率；用节点高度会少算一整个成员区间。
    expect(badge.top).toBeCloseTo(card.top + (layout.height + 40 - projection.height / 2) * zoom, 5);
    expect(badge.top).toBeGreaterThan(card.top + (node.height + 40) * zoom + 200);
    // 徽标尺寸就是模型投影，不再乘任何倍率。
    expect(badge.width).toBeCloseTo(projection.width * zoom, 5);
    expect(badge.height).toBeCloseTo(projection.height * zoom, 5);
    // 徽标中心始终与布局中心（气泡中线）重合。
    expect(badge.left + badge.width / 2).toBeCloseTo(card.left + (layout.width / 2) * zoom, 5);
  });

  it("没有布局尺寸时退回节点自身尺寸（普通 group 与折叠兜底）", () => {
    const badge = groupBadgePresentationScreenRect({ card, zoom, node, layout: null, collapsed: false, projection })!;
    expect(badge.top).toBeCloseTo(card.top + (node.height + 40 - projection.height / 2) * zoom, 5);
  });

  it("收起时徽标位置和大小保持不变", () => {
    const badge = groupBadgePresentationScreenRect({ card, zoom, node, layout, collapsed: true, projection })!;
    expect(badge).toEqual(groupBadgePresentationScreenRect({ card, zoom, node, layout, collapsed: false, projection }));
    // 背板移除后仍以完整布局为锚点，不生成紧凑气泡。
    expect(badge.top).toBeCloseTo(card.top + (layout.height + 40 - projection.height / 2) * zoom, 5);
    expect(badge.left + badge.width / 2).toBeCloseTo(card.left + (layout.width / 2) * zoom, 5);
  });

  it("模型投影缺失时没有徽标范围", () => {
    expect(groupBadgePresentationScreenRect({ card, zoom, node, layout, collapsed: false, projection: null })).toBeNull();
  });

  it("倍率无效时不做锚定", () => {
    expect(groupBadgePresentationScreenRect({ card, zoom: 0, node, layout, collapsed: false, projection })).toBeNull();
    expect(groupBadgePresentationScreenRect({ card, zoom: Number.NaN, node, layout, collapsed: false, projection })).toBeNull();
  });
});
