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
