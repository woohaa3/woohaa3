/**
 * 图片聚焦取景会话测试
 * （change: 2026-10-16-integrate-photocraft-image-editing：删掉旧标注编辑器后，会话只剩取景）。
 *
 * 覆盖适应窗口缩放、直接写取景与原图解码后的源尺寸校正；不涉及渲染与 GPU。
 */
import { describe, expect, it } from "vitest";
import { ImageFocusSession } from "../src/focus-session.js";

function session(overrides: Partial<{ sourceWidth: number; sourceHeight: number }> = {}) {
  return new ImageFocusSession({
    nodeId: "image",
    baseAssetId: "asset-base",
    baseStorageKey: "sha256-base",
    sourceWidth: overrides.sourceWidth ?? 1024,
    sourceHeight: overrides.sourceHeight ?? 768
  });
}

describe("ImageFocusSession 取景", () => {
  it("适应窗口缩放同时写入取景，0 或非法值退回 1", () => {
    const focus = session();
    focus.setFitZoom(0.25);
    expect(focus.currentFitZoom()).toBe(0.25);
    expect(focus.viewportState().zoom).toBe(0.25);
    focus.setFitZoom(0);
    expect(focus.currentFitZoom()).toBe(1);
    focus.setFitZoom(Number.NaN);
    expect(focus.currentFitZoom()).toBe(1);
  });

  it("直接写取景只影响呈现，返回副本", () => {
    const focus = session();
    focus.setViewport({ x: 30, y: -20, zoom: 1.4 });
    const view = focus.viewportState();
    expect(view).toEqual({ x: 30, y: -20, zoom: 1.4 });
    view.x = 999;
    expect(focus.viewportState().x).toBe(30);
  });

  it("解码后校正源尺寸，非法尺寸忽略", () => {
    const focus = session({ sourceWidth: 0, sourceHeight: 0 });
    focus.adoptSourceSize(1600, 900);
    expect([focus.sourceWidth, focus.sourceHeight]).toEqual([1600, 900]);
    focus.adoptSourceSize(-1, 0);
    expect([focus.sourceWidth, focus.sourceHeight]).toEqual([1600, 900]);
  });
});
