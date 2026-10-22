/**
 * 聚焦观察镜头增量 wire 协议。
 *
 * 断言固定结构、camelCase 键、有限值规范化，以及与 Rust
 * `bevy/src/protocol/observer.rs` 的版本字符串一致。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANVAS_OBSERVER_UPDATE_VERSION,
  applyObserverToScene,
  canvasObserverUpdateRequest
} from "./observer-update.js";
import { CANVAS_RENDER_SCENE_VERSION, type CanvasRenderScene } from "./render-scene.js";
import { defaultAppTheme } from "../theme/index.js";

const preview = { azimuth: 0.4, elevation: 0.2, distanceScale: 1.1, targetOffset: [0, 0.5, 0] as [number, number, number] };

describe("observer update wire", () => {
  it("编码固定结构：不含节点/边/完整场景", () => {
    const json = canvasObserverUpdateRequest({
      baseSceneGeneration: 7, nodeId: "n1", preview, yaw: 0.2, pitch: -0.1, distance: 4, target: [1, 2, 3]
    });
    const parsed = JSON.parse(json);
    expect(Object.keys(parsed).sort()).toEqual([
      "baseSceneGeneration", "distance", "nodeId", "pitch", "preview", "target", "version", "yaw"
    ]);
    expect(parsed.version).toBe(CANVAS_OBSERVER_UPDATE_VERSION);
    expect(json).not.toContain("nodes");
    expect(json).not.toContain("edges");
  });

  it("规范化非有限值，并把距离下限钳到 0.001", () => {
    const parsed = JSON.parse(canvasObserverUpdateRequest({
      baseSceneGeneration: 3.9, nodeId: "n",
      preview: { azimuth: Number.NaN, elevation: Number.POSITIVE_INFINITY, distanceScale: 0, targetOffset: [Number.NaN, 1, 2] },
      yaw: Number.NaN, pitch: 0, distance: 4, target: [0, 0, 0]
    }));
    expect(parsed.baseSceneGeneration).toBe(3);
    expect(parsed.preview).toEqual({ azimuth: 0, elevation: 0, distanceScale: 0.001, targetOffset: [0, 1, 2] });
    expect(parsed.yaw).toBe(0);
  });

  it("只改匹配节点的 modelFocus 与 modelPreview", () => {
    const scene = {
      version: CANVAS_RENDER_SCENE_VERSION, revision: 1, nodes: [
        { id: "a", type: "model", x: 0, y: 0, width: 1, height: 1, body: "", title: "", typeLabel: "", progress: 0, busy: false, texture: false, resizable: false, modelPreview: { azimuth: 0, elevation: 0, distanceScale: 1, targetOffset: [0, 0, 0] } },
        { id: "b", type: "image", x: 0, y: 0, width: 1, height: 1, body: "", title: "", typeLabel: "", progress: 0, busy: false, texture: false, resizable: false }
      ],
      edges: [], selection: { nodes: [], edge: null }, viewport: { x: 0, y: 0, zoom: 1 }, draft: null, surface: null, theme: defaultAppTheme(),
      modelFocus: { version: "woohaa-model-focus-v1" as const, nodeId: "a", target: [0, 0, 0] as [number, number, number], yaw: 0, pitch: 0, distance: 4, fov: 1, radius: 1 }
    } as CanvasRenderScene;
    const next = applyObserverToScene(scene, {
      baseSceneGeneration: 1, nodeId: "a", preview, yaw: 1, pitch: -0.5, distance: 6, target: [9, 8, 7]
    });
    expect(next.modelFocus).toMatchObject({ nodeId: "a", yaw: 1, pitch: -0.5, distance: 6, target: [9, 8, 7] });
    expect(next.nodes[0]?.modelPreview).toEqual(preview);
    expect(next.nodes[1]).toEqual(scene.nodes[1]);
  });

  it("版本字符串与 Rust protocol/observer.rs 一致", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const rust = readFileSync(resolve(here, "../../../../bevy/src/protocol/observer.rs"), "utf8");
    const match = rust.match(/CANVAS_OBSERVER_UPDATE_VERSION: &str = "([^"]+)"/);
    expect(match, "bevy 缺少 CANVAS_OBSERVER_UPDATE_VERSION").toBeTruthy();
    expect(match![1]).toBe(CANVAS_OBSERVER_UPDATE_VERSION);
  });
});
