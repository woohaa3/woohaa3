import { describe, expect, it } from "vitest";
import {
  activeCloneSlot,
  boundsOf,
  cloneOverlayCorners,
  cloneOverlayOpacity,
  cloneOverlayScreenCorners,
  cloneOverlayVisible,
  cloneSourcePoint,
  cloneStrokeSource,
  cloneTransformMatrix
} from "./clone-overlay.js";
import { type CloneOverlay, type CloneSourceSlot } from "./tool-parameters.js";

/**
 * 仿制源叠加与取样映射（change: 2026-10-22-add-photocraft-retouch-workflows，U39 / D2）。
 *
 * 叠加层必须与落笔取同一份取景，因此这里锁定的映射与上游
 * `presets/clone_source.rs::transform_matrix` 同义：缩放、旋转、翻转、锚点与取样点。
 * 用 `anchor === source` 的槽位隔离「变换」本身，锚点偏移另有用例覆盖。
 */

const slot = (patch: Partial<CloneSourceSlot> = {}): CloneSourceSlot => ({
  index: 0,
  source: [12, 14],
  anchor: [12, 14],
  offset: [0, 0],
  layer: 1,
  width: 100,
  height: 100,
  linked: false,
  rotation: 0,
  flipH: false,
  flipV: false,
  ...patch
});

const overlay = (patch: Partial<CloneOverlay> = {}): CloneOverlay => ({
  show: true,
  opacity: 100,
  clipped: true,
  autoHide: true,
  invert: false,
  blend: "normal",
  ...patch
});

describe("仿制源取样映射", () => {
  it("恒等变换下目标点按「取样点 − 锚点」偏移取样", () => {
    expect(cloneSourcePoint(slot(), { x: 10, y: 6 })).toEqual({ x: 10, y: 6 });
    // 真实的槽位锚点通常不同于取样点：目标侧同样偏移再取样。
    expect(cloneSourcePoint(slot({ anchor: [4, 4] }), { x: 10, y: 6 })).toEqual({ x: 18, y: 16 });
    // 没有取样点时不伪造映射。
    expect(cloneSourcePoint(slot({ source: null }), { x: 1, y: 1 })).toBeNull();
  });

  it("缩放 200% 让目标偏移只映射一半的源距离", () => {
    const point = cloneSourcePoint(slot({ width: 200, height: 200 }), { x: 22, y: 14 });
    // 目标向右 10 → 源向右 5（源被放大一倍，画面上看到的是两倍细节）。
    expect(point).toEqual({ x: 17, y: 14 });
  });

  it("旋转 90° 与水平翻转改变映射方向（与上游同一矩阵）", () => {
    // 屏幕逆时针 90°：目标 +x 落到源的 +y。
    expect(cloneSourcePoint(slot({ rotation: 90 }), { x: 22, y: 14 })).toMatchObject({ x: 12, y: 24 });
    expect(cloneTransformMatrix([100, 100], 0, true, false)[0]).toBeCloseTo(-1, 9);
    expect(cloneSourcePoint(slot({ flipH: true }), { x: 22, y: 14 })).toEqual({ x: 2, y: 14 });
  });

  it("缩放为 0 时钳到极小值而不是产生 NaN；非有限旋转回退单位阵", () => {
    const tiny = cloneTransformMatrix([0, 0], 0, false, false);
    expect(tiny.every((value) => Number.isFinite(value))).toBe(true);
    expect(tiny[0]).toBeGreaterThan(0);
    expect(cloneTransformMatrix([100, 100], Number.NaN, false, false)).toEqual([1, 0, 0, 1]);
  });
});

describe("叠加取样框", () => {
  it("没有取样点时返回 null（不画假框）", () => {
    expect(cloneOverlayCorners(slot({ source: null }), 20, true)).toBeNull();
  });

  it("框围绕锚点，且随旋转与缩放一起变换", () => {
    const straight = cloneOverlayCorners(slot(), 20, true)!;
    expect(straight).toHaveLength(4);
    // size 20 → 半宽 10，锚点即取样窗中心。
    expect(straight[0].x).toBeCloseTo(2, 9);
    expect(straight[0].y).toBeCloseTo(4, 9);
    expect(straight[2].x).toBeCloseTo(22, 9);
    // 90° 旋转把正方形四角映射到彼此（集合不变），所以用非等比缩放 + 45° 才看得出旋转：
    // 未旋转时是轴对齐矩形，45° 后外接矩形变大。
    const rotated = cloneOverlayCorners(slot({ width: 200, rotation: 45 }), 20, true)!;
    const plain = cloneOverlayCorners(slot({ width: 200 }), 20, true)!;
    expect(boundsOf(rotated)!.width).toBeGreaterThan(boundsOf(plain)!.width + 1);
    // 只改缩放：框在文档里变大（源窗口按百分比放大）。
    const scaled = cloneOverlayCorners(slot({ width: 200, height: 200 }), 20, true)!;
    expect(scaled[0].x).not.toBeCloseTo(straight[0].x, 3);
    expect(boundsOf(scaled)!.width).toBeCloseTo(40, 6);
    // 取样点没有锚点时，框围绕取样点本身。
    expect(cloneOverlayCorners(slot({ anchor: null }), 20, true)![0]).toEqual(straight[0]);
  });

  it("显示条件：选项关闭／无取样点／落笔自动隐藏都不画", () => {
    expect(cloneOverlayVisible(overlay(), slot(), false)).toBe(true);
    expect(cloneOverlayVisible(overlay({ show: false }), slot(), false)).toBe(false);
    expect(cloneOverlayVisible(overlay(), slot({ source: null }), false)).toBe(false);
    expect(cloneOverlayVisible(overlay(), slot(), true)).toBe(false);
    expect(cloneOverlayVisible(overlay({ autoHide: false }), slot(), true)).toBe(true);
    expect(cloneOverlayOpacity(overlay({ opacity: 40 }))).toBeCloseTo(0.4, 9);
    expect(cloneOverlayOpacity(overlay({ opacity: 400 }))).toBe(1);
    expect(cloneOverlayOpacity(overlay({ opacity: -20 }))).toBe(0);
  });

  it("客户坐标换算与外包矩形", () => {
    const screen = cloneOverlayScreenCorners(slot(), 10, true, (point) => ({ x: point.x * 2, y: point.y * 3 }));
    expect(screen).not.toBeNull();
    // 文档 (7..17, 9..19) → 客户 (14..34, 27..57)。
    expect(boundsOf(screen!)).toEqual({ x: 14, y: 27, width: 20, height: 30 });
    // 换算失败（元素未布局）时整框不画，而不是画到 (0,0)。
    expect(cloneOverlayScreenCorners(slot(), 10, true, () => null)).toBeNull();
    expect(boundsOf([])).toBeNull();
  });

  it("落笔取样源以活动槽位为准，槽位有源时不覆盖 source", () => {
    // 真实缺陷：共享画布把 app 本地的旧取样点塞进 `source`，内核就不再读活动槽位，
    // 于是「切到 2 号槽位」对之后的每一笔都无效。槽位有源时必须交回内核。
    expect(cloneStrokeSource(slot({ source: [300, 280] }), [110, 150], { x: 40, y: 40 }, true)).toEqual({});
    // 换槽位只换槽位本身，函数不掺入任何本地旧值。
    expect(cloneStrokeSource(slot({ index: 1, source: [310, 280] }), [110, 150], { x: 40, y: 40 }, true)).toEqual({});
  });

  it("宿主没有仿制源端口时回退到本地取样点；都没有则明确拒绝", () => {
    // 槽位为 null = 没有端口 → 用 app 本地 Alt+取样点。
    expect(cloneStrokeSource(null, [110, 150], { x: 40, y: 40 }, true)).toEqual({
      source: [110, 150],
      anchor: [40, 40]
    });
    // 对齐关闭：锚点固定为本笔起点，避免被相邻落点拽着走。
    expect(cloneStrokeSource(slot({ source: null, anchor: [9, 9] }), [110, 150], { x: 40, y: 40 }, false)).toEqual({
      source: [110, 150],
      anchor: [40, 40]
    });
    // 对齐开启且槽位已有锚点：沿用该锚点（与内核 aligned 语义一致）。
    expect(cloneStrokeSource(slot({ source: null, anchor: [9, 9] }), [110, 150], { x: 40, y: 40 }, true)).toEqual({
      source: [110, 150],
      anchor: [9, 9]
    });
    // 槽位没有源、也没有本地点：提示取样，而不是落一笔「成功但无变化」。
    const missing = cloneStrokeSource(slot({ source: null }), null, { x: 40, y: 40 }, true);
    expect("reason" in missing && missing.reason).toContain("采样点");
  });

  it("活动槽位按索引取，缺该索引时用列表最后一项而不是伪造空槽位", () => {
    const slots = [slot({ index: 0 }), slot({ index: 1, source: [1, 2] })];
    expect(activeCloneSlot(slots, 1)?.index).toBe(1);
    // 索引 9 钳到最大槽位号 4，列表里没有 4：退回最后一项（仍是真实槽位）。
    expect(activeCloneSlot(slots, 9)?.index).toBe(1);
    expect(activeCloneSlot(slots, Number.NaN)?.index).toBe(0);
    expect(activeCloneSlot([], 0)).toBeNull();
  });
});
