/**
 * 原生 drawable 覆盖范围
 * （fix: 桌面顶栏 origin 不得把 Metal 视图再收成画布洞，否则左右把手绘制与命中错开）。
 */
import { describe, expect, it } from "vitest";
import { nativeDrawableLayout } from "./native-surface-layout.js";

describe("nativeDrawableLayout", () => {
  it("顶栏把画布下推时，drawable 从窗口原点铺到画布右下角", () => {
    // 与 bevy place_native_surface(0, 26, 1280, 694) 同一组数字：交换链是 1280×720，
    // 相机视口才是 26px 下的 1280×694。Metal 视图必须覆盖前者，不能只 layout 画布洞。
    expect(nativeDrawableLayout({ left: 0, top: 26, width: 1280, height: 694 })).toEqual([
      0, 0, 1280, 720
    ]);
  });

  it("无顶栏偏移时仍覆盖画布本身", () => {
    expect(nativeDrawableLayout({ left: 0, top: 0, width: 800, height: 600 })).toEqual([
      0, 0, 800, 600
    ]);
  });
});
