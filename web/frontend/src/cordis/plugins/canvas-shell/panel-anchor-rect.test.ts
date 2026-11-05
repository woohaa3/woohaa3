import { describe, expect, it } from "vitest";
import { sceneAreaPanelRect, sceneAreaTitleRect, worldAabbPanelRect, worldCameraPanelRect, worldInstancePanelRect } from "./panel-anchor-rect.js";

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

  it("共享世界模型用 AABB 的屏幕包围盒作为锚点，下沿低于原点投影", () => {
    const aabb = { min: [0, 0, 0] as [number, number, number], max: [10, 20, 30] as [number, number, number] };
    const renderer = (x: number, y: number, z: number) => ({ x: 100 + x, y: 300 - y + z * 0.5 });
    const rect = worldAabbPanelRect(aabb, renderer);
    // 八角落投影后的包围盒：x ∈ [100,110]，y ∈ [280,315]。
    expect(rect).toEqual({ left: 100, top: 280, width: 10, height: 35 });
    // 原点 (0,0,0) 投影在下沿 300，AABB 下沿（最低角）在 315，高于原点的面板会压住模型。
    expect(rect.top + rect.height).toBeGreaterThan(renderer(0, 0, 0).y);
  });

  it("镜头机位在视口内时锚到地面投影点，而不是卡片或空中机位", () => {
    const card = { left: 400, top: 100, width: 248, height: 156 };
    const area = { left: 0, top: 0, width: 1440, height: 1000 };
    const rect = worldCameraPanelRect({ u: 2, v: 3, h: 9 }, project, area, card);
    const ground = project(2, 3, 0);
    expect(rect).toEqual({ left: ground.x - 12, top: ground.y - 12, width: 24, height: 24 });
    // 机位本体（h=9）悬在地面之上，面板不能锚到它。
    expect(rect.top).toBeGreaterThan(project(2, 3, 9).y);
  });

  it("机位在视口外（只能看到卡片）时退回卡片矩形", () => {
    const card = { left: 400, top: 100, width: 248, height: 156 };
    const area = { left: 0, top: 0, width: 1440, height: 1000 };
    // 机位被平移到视口右侧之外，卡片仍在视口内。
    const far = (u: number, v: number, h = 0) => ({ x: 3000 + u, y: project(u, v, h).y });
    expect(worldCameraPanelRect({ u: 2, v: 3, h: 1 }, far, area, card)).toBe(card);
  });

  it("镜头本体可见但地面投影点离开视口时不退回卡片（否则会压在镜头上）", () => {
    const card = { left: 400, top: 100, width: 248, height: 156 };
    // 地面投影 y≈275 已越过视口底边，机位本体 y≈95 仍在视口内。
    const area = { left: 0, top: 0, width: 1440, height: 250 };
    const rect = worldCameraPanelRect({ u: 2, v: 3, h: 9 }, project, area, card);
    const ground = project(2, 3, 0);
    expect(rect).not.toBe(card);
    expect(rect).toEqual({ left: ground.x - 12, top: ground.y - 12, width: 24, height: 24 });
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

it("keeps the timeline aligned with a compensated large title at low zoom", () => {
  const bounds = { min: { u: 0, v: 0 }, max: { u: 400, v: 400 } };
  const rects = [0.1, 0.3, 0.8].map(zoom => sceneAreaTitleRect(bounds, (u, v) => {
    const point = project(u, v); return { x: point.x * zoom, y: point.y * zoom };
  }, zoom));
  expect(rects[0].width).toBeCloseTo(rects[1].width);
  expect(rects[0].height).toBeCloseTo(rects[1].height);
  expect(rects[0].width).toBeCloseTo(rects[2].width);
});
