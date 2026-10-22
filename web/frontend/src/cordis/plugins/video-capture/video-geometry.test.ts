/**
 * 视频 dialog 几何/时间工具测试
 * （change: port-video-editing-dialogs，任务 2.2 / 3.1 / 3.3；design D5）。
 */
import { describe, expect, it } from "vitest";
import {
  MIN_RANGE_SECONDS,
  clampRange,
  clampTimelineRange,
  clampUnit,
  formatVideoTime,
  getVideoContentRect,
  resolveFirstVideoFrameTime,
  resolveLastVideoFrameTime,
  shapeToPixels,
  toContentPixel,
  toNormalizedPoint
} from "./video-geometry.js";

describe("内容区域映射（letterbox 排除）", () => {
  it("宽视频在窄容器上下有 letterbox", () => {
    const rect = getVideoContentRect(1920, 1080, 1000, 1000);
    expect(rect.width).toBeCloseTo(1000);
    expect(rect.height).toBeCloseTo(562.5);
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo((1000 - 562.5) / 2);
  });

  it("letterbox 区域外的点返回钳制坐标（不越界）", () => {
    const content = getVideoContentRect(1920, 1080, 1000, 1000);
    const rect = { left: 0, top: 0, width: 1000, height: 1000 };
    // 顶部 letterbox（y 超出内容上方）→ 钳制到 0。
    expect(toNormalizedPoint(500, 10, rect, content)).toEqual({ x: 0.5, y: 0 });
  });

  it("内容区域内点按内容矩形归一化", () => {
    const content = getVideoContentRect(100, 100, 200, 100);
    const rect = { left: 0, top: 0, width: 200, height: 100 };
    // 内容居中：x 从 50 到 150。
    expect(toNormalizedPoint(100, 50, rect, content)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("归一化坐标映射回像素可逆", () => {
    const content = getVideoContentRect(1920, 1080, 800, 600);
    const pixel = toContentPixel({ x: 0.25, y: 0.75 }, content);
    expect(pixel.x).toBeCloseTo(content.x + 0.25 * content.width);
    expect(pixel.y).toBeCloseTo(content.y + 0.75 * content.height);
  });

  it("shapeToPixels 使用同一内容矩形映射", () => {
    const content = { x: 0, y: 0, width: 100, height: 50 };
    const points = shapeToPixels({ id: "s", tool: "rect", color: "#ffffff", strokeWidth: 1, points: [{ x: 0.2, y: 0.4 }, { x: 0.8, y: 0.6 }] }, content);
    expect(points).toEqual([{ x: 20, y: 20 }, { x: 80, y: 30 }]);
  });
});

describe("时间钳制与首尾帧", () => {
  it("clampRange 处理非有限值", () => {
    expect(clampRange(Number.NaN, 2, 8)).toBe(2);
    expect(clampRange(10, 0, 5)).toBe(5);
    expect(clampUnit(1.5)).toBe(1);
    expect(clampUnit(-1)).toBe(0);
  });

  it("首帧为 0，尾帧不超过 duration 且留 epsilon", () => {
    expect(resolveFirstVideoFrameTime()).toBe(0);
    expect(resolveLastVideoFrameTime(10)).toBeLessThan(10);
    expect(resolveLastVideoFrameTime(10)).toBeGreaterThan(0);
    expect(resolveLastVideoFrameTime(0)).toBe(0);
  });

  it("末帧时间不因 ended 状态越界", () => {
    const last = resolveLastVideoFrameTime(2.5);
    expect(last).toBeLessThanOrEqual(2.5);
    expect(last).toBeGreaterThanOrEqual(0);
  });
});

describe("时间轴区间钳制", () => {
  it("区间跨度不小于 0.05 秒", () => {
    const clamped = clampTimelineRange({ startSeconds: 1, endSeconds: 1.01, duration: 10 });
    expect(clamped.endSeconds! - clamped.startSeconds).toBeGreaterThanOrEqual(MIN_RANGE_SECONDS - 1e-9);
  });

  it("起点拖过最大位置被钳制，且区间保持最小跨度", () => {
    const clamped = clampTimelineRange({ startSeconds: 100, endSeconds: 100.5, duration: 4 });
    expect(clamped.startSeconds).toBeLessThanOrEqual(4);
    expect(clamped.endSeconds! - clamped.startSeconds).toBeGreaterThanOrEqual(MIN_RANGE_SECONDS - 1e-9);
  });

  it("终点拖出 duration 被钳制", () => {
    const clamped = clampTimelineRange({ startSeconds: 2, endSeconds: 99, duration: 5 });
    expect(clamped.endSeconds).toBe(5);
  });

  it("点编辑不含 end", () => {
    expect(clampTimelineRange({ startSeconds: 3, duration: 5 })).toEqual({ startSeconds: 3 });
  });
});

describe("时间显示", () => {
  it("格式化 mm:ss.xx 且不出现负值", () => {
    expect(formatVideoTime(0)).toBe("00:00.00");
    expect(formatVideoTime(65.5)).toBe("01:05.50");
    expect(formatVideoTime(-3)).toBe("00:00.00");
    expect(formatVideoTime(Number.NaN)).toBe("00:00.00");
  });
});
