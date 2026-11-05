import { describe, expect, it } from "vitest";
import { sceneAreaPanelRect, sceneAreaTitleRect, worldInstancePanelRect } from "./panel-anchor-rect.js";

/** 等距式投影：u 向右下、v 向左下，便于验证四边形包围盒。 */
const project = (u: number, v: number, h = 0) => ({
  x: 100 + u * 30 - v * 30,
  y: 200 + u * 15 + v * 15 - h * 20,
});

describe("执行面板锚点矩形", () => {
  it("导演区使用地面四角的投影包围盒，而不是卡片坐标", () => {
    const rect = sceneAreaPanelRect({ min: { u: 0, v: 0 }, max: { u: 4, v: 4 } }, project);
    expect(rect).toEqual({ left: -20, top: 200, width: 240, height: 120 });
  });

  it("共享世界模型用世界原点作为面板锚点", () => {
    const rect = worldInstancePanelRect({ u: 2, v: 3, h: 1 }, project);
    const anchor = project(2, 3, 1);
    expect(rect).toEqual({ left: anchor.x - 12, top: anchor.y - 12, width: 24, height: 24 });
  });

  it("时间轴锚定左下斜边标题，并跟随平移和缩放", () => {
    const bounds = { min: { u: 0, v: 0 }, max: { u: 4, v: 4 } };
    const rect = sceneAreaTitleRect(bounds, project, 1);
    expect(rect.left + rect.width / 2).toBeCloseTo(40);
    expect(rect.top + rect.height / 2).toBeCloseTo(290);
    const zoomed = sceneAreaTitleRect(bounds, (u, v) => {
      const point = project(u, v); return { x: point.x * 2 + 50, y: point.y * 2 - 30 };
    }, 2);
    expect(zoomed.width).toBeCloseTo(rect.width * 2);
    expect(zoomed.height).toBeCloseTo(rect.height * 2);
    expect(zoomed.left).toBeCloseTo(rect.left * 2 + 50);
    expect(zoomed.top).toBeCloseTo(rect.top * 2 - 30);
  });
});
