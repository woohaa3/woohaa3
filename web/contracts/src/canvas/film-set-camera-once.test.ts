/**
 * 片场相机「只映射一次」回归
 * （change: 2026-10-23-isolate-film-set-camera-space，任务 2.2 / 5.1）。
 *
 * 前端 `modelEditor.shot` 已是**画布世界**姿态（gizmo/命中/截图共用），Rust adapter 不得再乘
 * 一次显示倍率；活动播放的采样相机是**场景单位**，必须映射一次。这里用纯数据断言两条通道的
 * 分工，不依赖 GPU。
 */
import { describe, expect, it } from "vitest";
import { filmSetDisplayTransform, mapFilmSetSceneCamera } from "./film-set-space.js";

describe("相机映射职责划分", () => {
  it("世界姿态再乘一次倍率会改变构图（必须避免）", () => {
    const display = filmSetDisplayTransform({ scale: 0.25, yaw: 0 });
    if (!display.ok) throw new Error(display.reason);
    const scene = { azimuth: 0.3, elevation: 0.4, distance: 10.6, focusOffset: { x: 0, y: 0.5, z: 0 } };
    const onceMapped = mapFilmSetSceneCamera(display.value, [0, 0, 0], scene);
    expect(onceMapped).not.toBeNull();
    if (!onceMapped) return;
    expect(onceMapped.distance).toBeCloseTo(2.65, 9);
    // 第二次映射（错误做法）会把距离压到 0.6625，等于重复缩放。
    const twice = mapFilmSetSceneCamera(display.value, [0, 0, 0], {
      ...scene,
      distance: onceMapped.distance,
      focusOffset: { x: onceMapped.focusOffset[0], y: onceMapped.focusOffset[1], z: onceMapped.focusOffset[2] }
    });
    expect(twice).not.toBeNull();
    if (!twice) return;
    expect(twice.distance).toBeCloseTo(0.6625, 9);
    expect(twice.distance).not.toBeCloseTo(onceMapped.distance, 6);
  });

  it("renderer 重建后从作品重新派生同一映射（无累计缩放）", () => {
    const display = filmSetDisplayTransform({ scale: 0.25, yaw: 0.4 });
    if (!display.ok) return;
    const scene = { azimuth: 0.3, elevation: 0.4, distance: 10.6, focusOffset: { x: 1, y: 0.5, z: -2 } };
    const first = mapFilmSetSceneCamera(display.value, [5, 1, -3], scene);
    const rebuilt = mapFilmSetSceneCamera(display.value, [5, 1, -3], scene);
    expect(rebuilt).toEqual(first);
  });
});
