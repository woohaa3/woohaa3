/**
 * 地面范围对角锁定等比缩放测试
 * （change: 2026-10-12-align-film-set-scope-with-isometric-grid，design D6）。
 */
import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "@woohaa3/contracts";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { resizeTarget, scopeResizeTarget } from "./interaction-2d-helpers.js";

describe("scopeResizeTarget（对角锁定等比缩放）", () => {
  // 节点中心 (130,100)，尺寸 260×195；拖右下角，锚点左上角 (0, 2.5)。
  const originCenter = { x: 130, y: 100 };
  const anchor = { x: 0, y: 2.5 };
  const handle = { x: 260, y: 197.5 };
  const base = { handle, anchor, originCenter, originWidth: 260, originHeight: 195 };

  it("无位移不产生目标（不提交无净变化）", () => {
    expect(scopeResizeTarget(base, handle)).toBeNull();
  });

  it("沿对角轴拖动按比例等比缩放，锚点保持不动", () => {
    // 轴 d = handle - anchor = (260, 195)；沿 d 拖一段使 k = 2。
    const world = { x: handle.x + 260, y: handle.y + 195 };
    const target = scopeResizeTarget(base, world);
    expect(target!.width).toBe(520);
    expect(target!.height).toBe(390);
    expect(target!.width / target!.height).toBeCloseTo(260 / 195, 5);
    // 锚点（左上角）保持不动：新中心 = anchor + k×(C-anchor)。
    const expectedCenter = { x: anchor.x + 2 * (originCenter.x - anchor.x), y: anchor.y + 2 * (originCenter.y - anchor.y) };
    expect(target!.position).toEqual({ x: expectedCenter.x - 260, y: expectedCenter.y - 195 });
  });

  it("垂直于对角轴的位移不缩放", () => {
    const world = { x: handle.x - 195, y: handle.y + 260 };
    expect(scopeResizeTarget(base, world)).toBeNull();
  });

  it("缩小遵守最小节点尺寸对应比例 kMin", () => {
    const world = { x: handle.x - 100000, y: handle.y - 100000 };
    const target = scopeResizeTarget(base, world);
    const kMin = Math.max(200 / 260, 150 / 195);
    expect(target!.width).toBe(Math.round(260 * kMin));
    expect(target!.height).toBe(Math.round(195 * kMin));
  });

  it("非有限输入不产生目标", () => {
    expect(scopeResizeTarget(base, { x: Number.NaN, y: 100 })).toBeNull();
  });
});

it("普通矩形缩放也使用目标节点类别下限", () => {
  const previous = woohaa3CanvasStore.getState().canvas;
  const canvas = createEmptyWoohaa3ServerCanvas("resize");
  canvas.document.nodes.push({ id: "film", type: "composite-asset", position: { x: 0, y: 0 }, width: 260, height: 195 });
  woohaa3CanvasStore.getState().applyRemoteCanvas(canvas);
  try {
    const gesture = { nodeId: "film", start: { x: 0, y: 0 }, originWidth: 260, originHeight: 195 };
    expect(resizeTarget(gesture, { x: -1000, y: -1000 })).toEqual({ width: 200, height: 150 });
    expect(resizeTarget(gesture, { x: 0, y: 0 })).toBeNull();
  } finally { woohaa3CanvasStore.getState().applyRemoteCanvas(previous!); }
});
