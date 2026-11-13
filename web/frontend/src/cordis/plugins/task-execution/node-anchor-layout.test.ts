import { describe, expect, it } from "vitest";
import { layoutNodePanel, usableCanvasArea } from "./node-anchor-layout.js";

const area = { left: 100, top: 50, width: 900, height: 700 };

describe("layoutNodePanel", () => {
  it("subtracts a right detail sidebar from the canvas area exactly once", () => {
    const area = usableCanvasArea({ left: 0, top: 0, width: 1440, height: 900 }, [{ left: 1040, top: 0, width: 400, height: 900 }]);
    expect(area).toEqual({ left: 0, top: 0, width: 1040, height: 900 });
    const panel = layoutNodePanel({ left: 900, top: 200, width: 90, height: 70 }, area, { width: 760, height: 300 });
    expect(panel!.left + panel!.width).toBeLessThanOrEqual(1024);
  });
  it("keeps the full canvas height beside a vertically centered right sidebar", () => {
    expect(usableCanvasArea(
      { left: 0, top: 0, width: 1440, height: 900 },
      [{ left: 1040, top: 180, width: 400, height: 540 }]
    )).toEqual({ left: 0, top: 0, width: 1040, height: 900 });
  });
  it("anchors below with a 12px gap and clamps to the available width", () => {
    expect(layoutNodePanel({ left: 440, top: 200, width: 100, height: 80 }, area, { width: 800, height: 300 }))
      .toEqual({ left: 116, top: 292, width: 760, maxHeight: 458, placement: "below" });
  });

  it("keeps group panels below the badge even when there is more room above", () => {
    const badge = { left: 440, top: 540, width: 88, height: 64 };
    expect(layoutNodePanel(badge, area, { width: 600, height: 300 }, "above", "below"))
      .toMatchObject({ top: 616, maxHeight: 134, placement: "below" });
  });

  it("节点完全离开视口时不再留下贴边面板（含 below 策略）", () => {
    const offscreen = { left: 1200, top: 200, width: 100, height: 80 };
    expect(layoutNodePanel(offscreen, area, { width: 600, height: 300 })).toBeNull();
    expect(layoutNodePanel(offscreen, area, { width: 600, height: 300 }, undefined, "below")).toBeNull();
  });

  it("flips above when the lower area is too short", () => {
    expect(layoutNodePanel({ left: 440, top: 540, width: 100, height: 80 }, area, { width: 600, height: 300 })?.placement).toBe("above");
  });

  it("limits height when neither side fits and hides fully offscreen nodes", () => {
    const edge = layoutNodePanel({ left: 440, top: 340, width: 100, height: 80 }, area, { width: 600, height: 900 });
    expect(edge?.placement).toBe("edge");
    expect(edge?.maxHeight).toBeLessThan(900);
    expect(layoutNodePanel({ left: 1200, top: 200, width: 100, height: 80 }, area, { width: 600, height: 300 })).toBeNull();
  });

  it("clamps both horizontal edges and keeps the selected side through a small resize", () => {
    const left = layoutNodePanel({ left: 110, top: 180, width: 90, height: 60 }, area, { width: 500, height: 220 });
    const right = layoutNodePanel({ left: 870, top: 180, width: 90, height: 60 }, area, { width: 500, height: 220 });
    expect(left?.left).toBe(116);
    expect(right?.left).toBe(484);
    const held = layoutNodePanel({ left: 440, top: 530, width: 100, height: 80 }, area, { width: 500, height: 320 }, "above");
    expect(held?.placement).toBe("above");
  });

  it("pins an oversized node fallback to the larger available side", () => {
    const node = { left: 220, top: 180, width: 600, height: 470 };
    const panel = layoutNodePanel(node, area, { width: 800, height: 520 });
    expect(panel?.placement).toBe("edge");
    expect(panel?.left).toBeGreaterThanOrEqual(area.left + 16);
    expect(panel!.left + panel!.width).toBeLessThanOrEqual(area.left + area.width - 16);
    expect(panel?.maxHeight).toBeLessThan(520);
  });
});

describe("严格下方（below 策略）", () => {
  const viewport = { left: 0, top: 0, width: 1440, height: 2000 };

  it("面板整块落在锚点下缘之外，不盖住对象", () => {
    const badge = { left: 100, top: 1000, width: 880, height: 640 };
    const panel = layoutNodePanel(badge, viewport, { width: 760, height: 320 }, undefined, "below")!;
    expect(panel.placement).toBe("below");
    expect(panel.top).toBeCloseTo(badge.top + badge.height + 12, 5);
    expect(panel.top).toBeGreaterThanOrEqual(badge.top + badge.height);
  });

  it("下方空间不足时只压缩高度并保持在下方，不飘到对象左右两侧", () => {
    const node = { left: 440, top: 540, width: 100, height: 80 };
    const area = { left: 0, top: 0, width: 1440, height: 700 };
    const panel = layoutNodePanel(node, area, { width: 600, height: 320 }, undefined, "below")!;
    expect(panel.placement).toBe("below");
    expect(panel.top).toBe(node.top + node.height + 12);
    // 高度收回视口内的可用空间，面板内部滚动；不再改贴 left/right。
    expect(panel.maxHeight).toBe(area.top + area.height - (node.top + node.height) - 12);
    expect(panel.maxHeight).toBeLessThan(320);
    // 仍以节点中心水平居中，不是贴到节点侧面。
    const center = panel.left + panel.width / 2;
    expect(center).toBeCloseTo(node.left + node.width / 2, 5);
  });

  it("锚点下缘已越过视口底边时隐藏，而不是改贴侧面或视口边缘", () => {
    const badge = { left: 400, top: 600, width: 880, height: 640 };
    const area = { left: 0, top: 0, width: 1440, height: 900 };
    expect(layoutNodePanel(badge, area, { width: 760, height: 320 }, undefined, "below")).toBeNull();
  });

  it("贴底停靠保留面板自然高度，锚点下缘越过底边也不隐藏", () => {
    const badge = { left: 400, top: 600, width: 880, height: 640 };
    const area = { left: 0, top: 0, width: 1440, height: 900 };
    const panel = layoutNodePanel(badge, area, { width: 760, height: 320 }, undefined, "dock")!;
    expect(panel.placement).toBe("edge");
    expect(panel.maxHeight).toBe(320);
    expect(panel.top + panel.maxHeight).toBeCloseTo(area.top + area.height - 12, 5);
    // 锚点整体越过底边仍算部分可见，面板贴底而不是消失。
    expect(layoutNodePanel({ left: 400, top: 850, width: 200, height: 400 }, area, { width: 760, height: 320 }, undefined, "dock")).not.toBeNull();
  });
});
