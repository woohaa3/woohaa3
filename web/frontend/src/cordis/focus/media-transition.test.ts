/**
 * 公共二维取景/插值纯函数测试
 * （change: 2026-10-12-unify-node-editors-and-focus-transitions，design D2/D7，任务 2.5）。
 *
 * 从旧 shell `focus-transition` 迁移的纯几何断言：卡片内容矩形、概览取景像素对齐与
 * 对数 zoom 插值。这里 MUST NOT 涉及时间源（时间线归 Canvas Runtime coordinator）。
 */
import { describe, expect, it } from "vitest";
import { interpolateViewport, nodeImageRect, overviewImageView, smoothstep } from "./media-transition.js";

describe("focus 平台层纯几何（任务 2.5）", () => {
  it("卡片内容矩形按比例内嵌源尺寸", () => {
    const rect = nodeImageRect({ x: 520, y: -260, width: 300, height: 240 }, 1600, 900);
    // 框内留出 header/footer 边距，等比缩放后居中。
    expect(rect.width).toBeCloseTo(Math.min(300 - 32, (240 - 68) * (1600 / 900)), 6);
    expect(rect.x).toBeGreaterThan(520);
    expect(rect.y).toBeGreaterThan(-260);
  });

  it("概览取景首帧与卡片像素对齐", () => {
    const world = nodeImageRect({ x: 520, y: -260, width: 300, height: 240 }, 1600, 900);
    const content = { x: 128, y: 56, width: 888, height: 800 };
    const overview = { x: -317, y: 428, zoom: 0.65 };
    const view = overviewImageView(world, 1600, content, overview);
    // 内容中心映射回概览下的卡片内容中心。
    const mappedX = (world.x + world.width / 2) * overview.zoom + overview.x - content.x - content.width / 2;
    const mappedY = (world.y + world.height / 2) * overview.zoom + overview.y - content.y - content.height / 2;
    expect(view.x).toBeCloseTo(mappedX, 8);
    expect(view.y).toBeCloseTo(mappedY, 8);
    expect(view.zoom).toBeCloseTo((world.width / 1600) * overview.zoom, 8);
  });

  it("插值端点与缓动：progress 0/1 落位，zoom 对数", () => {
    const from = { x: 100, y: -50, zoom: 0.08 };
    const to = { x: 0, y: 0, zoom: 0.7 };
    expect(interpolateViewport(from, to, 0).x).toBeCloseTo(from.x, 8);
    expect(interpolateViewport(from, to, 0).zoom).toBeCloseTo(from.zoom, 8);
    const end = interpolateViewport(from, to, 1);
    expect(end.x).toBeCloseTo(to.x, 8);
    expect(end.zoom).toBeCloseTo(to.zoom, 8);
    // 中点 zoom 为几何平均（对数插值）。
    const mid = interpolateViewport(from, to, 0.5);
    expect(mid.zoom).toBeCloseTo(Math.sqrt(from.zoom * to.zoom), 8);
  });

  it("smoothstep 端点与中点", () => {
    expect(smoothstep(0)).toBe(0);
    expect(smoothstep(1)).toBe(1);
    expect(smoothstep(0.5)).toBeCloseTo(0.5, 8);
    expect(smoothstep(-3)).toBe(0);
    expect(smoothstep(3)).toBe(1);
  });
});
