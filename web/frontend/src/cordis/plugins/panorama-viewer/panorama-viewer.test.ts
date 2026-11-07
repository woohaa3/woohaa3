import { describe, expect, it, vi } from "vitest";
import { PanoramaStore, isEquirectangular } from "./panorama-store.js";
import { clamp } from "./panorama-view.js";

describe("isEquirectangular", () => {
  it("接受 2:1 与 5% 以内的偏差", () => {
    expect(isEquirectangular(4096, 2048)).toBe(true);
    expect(isEquirectangular(2100, 1024)).toBe(true);
  });
  it("拒绝非 2:1 与无效尺寸", () => {
    expect(isEquirectangular(1024, 1024)).toBe(false);
    expect(isEquirectangular(2100, 3648)).toBe(false);
    expect(isEquirectangular(0, 0)).toBe(false);
  });
});

describe("PanoramaStore", () => {
  it("打开 / 关闭会通知订阅者，重复关闭不重复通知", () => {
    const store = new PanoramaStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.open("n1", "/api/media/x.png", "全景");
    expect(store.getSnapshot()).toEqual({ nodeId: "n1", url: "/api/media/x.png", title: "全景" });
    store.close();
    store.close();
    expect(store.getSnapshot().nodeId).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("clamp", () => {
  it("夹在区间内", () => {
    expect(clamp(120, 30, 100)).toBe(100);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);
  });
});

describe("frameDelta", () => {
  it("没有按键时返回 null，对向按键相互抵消", async () => {
    const { frameDelta } = await import("./panorama-keys.js");
    expect(frameDelta(new Set())).toBeNull();
    expect(frameDelta(new Set(["KeyA", "KeyD"]))).toBeNull();
  });
  it("Q 推进（视场减小），D 右转，W 上抬", async () => {
    const { frameDelta, KEY_ZOOM_STEP, KEY_ROTATE_STEP } = await import("./panorama-keys.js");
    expect(frameDelta(new Set(["KeyQ"]))).toEqual({ dFov: -KEY_ZOOM_STEP, dYaw: 0, dPitch: 0 });
    expect(frameDelta(new Set(["KeyD", "KeyW"]))).toEqual({ dFov: 0, dYaw: KEY_ROTATE_STEP, dPitch: KEY_ROTATE_STEP });
  });
});
