import { describe, expect, it, beforeEach } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "./domain/index.js";
import { SHARED_WORLD_VERSION } from "./shared-world.js";
import { createWorldAnimationScript } from "./world-animation-script.js";
import { buildCanvasRenderScene } from "./render-scene/scene-builder.js";
import { clearShotAnimationCache } from "./world-camera-shot.js";

beforeEach(() => clearShotAnimationCache());

function canvas(animated: boolean) {
  const base = createEmptyWoohaa3ServerCanvas("canvas-1", new Date("2026-11-05T00:00:00.000Z").toISOString());
  base.document.nodes = [
    { id: "cam", type: "world-camera", position: { x: 0, y: 0 } },
    { id: "area", type: "scene-area" }
  ] as never;
  base.nodeData = {
    cam: {
      worldCamera: {
        kind: "world-camera",
        version: SHARED_WORLD_VERSION,
        cameraId: "camera-1",
        settingsVersion: "v1",
        position: { u: 0, v: 0, h: 1.8 },
        rotation: [0, 0, 0, 1],
        projection: { kind: "perspective", verticalFovRadians: Math.PI / 3, nearMeters: 0.1, farMeters: 80 },
        captureMode: { kind: "static" },
        aspect: { width: 16, height: 9 },
        boundInstanceId: null
      }
    },
    area: {
      sceneArea: {
        kind: "scene-area",
        version: SHARED_WORLD_VERSION,
        areaId: "area-1",
        scopeVersion: "scope-1",
        bounds: { min: { u: -10, v: -10 }, max: { u: 10, v: 10 } },
        ...(animated
          ? { animationScript: createWorldAnimationScript({ script: "function build(motion) {}", duration: 4, loop: false }) }
          : {})
      }
    }
  } as never;
  return base;
}

describe("镜头卡片呈现", () => {
  it("动态镜头卡片显示视频时长与状态，预览不可下载", () => {
    const scene = buildCanvasRenderScene({ canvas: canvas(true) });
    const node = scene.nodes.find((entry) => entry.id === "cam");
    // 卡片图标与右键「插入镜头」一致：使用相机（shot）图标，而不是通用节点图标。
    expect(node?.type).toBe("shot");
    expect(node?.cameraShot).toMatchObject({
      kind: "dynamic",
      phase: "preview",
      durationSeconds: 4,
      downloadable: false,
      playable: false,
      label: "预览 · 4s"
    });
    expect(node?.typeLabel).toBe("预览 · 4s");

    const ready = buildCanvasRenderScene({
      canvas: canvas(true),
      worldCameraShotPhases: new Map([["cam", "ready"]])
    }).nodes.find((entry) => entry.id === "cam");
    expect(ready?.cameraShot).toMatchObject({ phase: "ready", downloadable: true, label: "视频 · 4s" });

    const stale = buildCanvasRenderScene({
      canvas: canvas(true),
      worldCameraShotPhases: new Map([["cam", "stale"]])
    }).nodes.find((entry) => entry.id === "cam");
    expect(stale?.cameraShot).toMatchObject({ phase: "stale", downloadable: false, label: "已过期 · 4s" });

    const failed = buildCanvasRenderScene({
      canvas: canvas(true),
      worldCameraShotPhases: new Map([["cam", "failed"]])
    }).nodes.find((entry) => entry.id === "cam");
    expect(failed?.cameraShot).toMatchObject({ phase: "failed", downloadable: false, label: "准备失败" });
  });

  it("动画移除后卡片恢复静态语义", () => {
    const node = buildCanvasRenderScene({ canvas: canvas(false) }).nodes.find((entry) => entry.id === "cam");
    expect(node?.cameraShot).toMatchObject({ kind: "static", phase: "ready" });
    expect(node?.typeLabel).not.toContain("视频");
    expect(node?.typeLabel).not.toContain("预览");
  });
});
