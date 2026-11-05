import { describe, expect, it, beforeEach } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "./domain/index.js";
import { SHARED_WORLD_VERSION } from "./shared-world.js";
import { createWorldAnimationScript } from "./world-animation-script.js";
import {
  clearShotAnimationCache,
  effectiveShotKind,
  planWorldCameraStillFrame,
  worldCameraAnimationDuration,
  worldCameraShotContext,
  worldCameraShotState
} from "./world-camera-shot.js";

function camera(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "world-camera",
    version: SHARED_WORLD_VERSION,
    cameraId: id,
    settingsVersion: `settings-${id}`,
    position: { u: 0, v: 0, h: 1.8 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: Math.PI / 3, nearMeters: 0.1, farMeters: 80 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    boundInstanceId: null,
    ...overrides
  };
}

function canvasWith(
  entries: Array<{
    id: string;
    type: string;
    worldCamera?: Record<string, unknown>;
    sceneArea?: Record<string, unknown>;
  }>
): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-1", new Date("2026-11-05T00:00:00.000Z").toISOString());
  canvas.document.nodes = entries.map((entry) => ({
    id: entry.id,
    type: entry.type,
    data: {}
  })) as ServerCanvas["document"]["nodes"];
  for (const entry of entries) {
    if (entry.worldCamera) {
      (canvas.nodeData as Record<string, unknown>)[entry.id] = { worldCamera: entry.worldCamera };
    }
    if (entry.sceneArea) {
      (canvas.nodeData as Record<string, unknown>)[entry.id] = { sceneArea: entry.sceneArea };
    }
  }
  return canvas;
}

function area(
  id: string,
  script: string | null,
  bounds = { min: { u: -5, v: -5 }, max: { u: 5, v: 5 } }
): Record<string, unknown> {
  return {
    kind: "scene-area",
    version: SHARED_WORLD_VERSION,
    areaId: id,
    scopeVersion: `scope-${id}`,
    bounds,
    ...(script === null
      ? {}
      : { animationScript: createWorldAnimationScript({ script, duration: 4, loop: false }) })
  };
}

beforeEach(() => clearShotAnimationCache());

describe("effectiveShotKind", () => {
  it("把动画导演区内的静态机位派生为 dynamic", () => {
    const canvas = canvasWith([
      { id: "area-1", type: "scene-area", sceneArea: area("area-1", "function build(motion) {}") },
      { id: "cam-node", type: "world-camera", worldCamera: camera("camera-1") }
    ]);
    const context = worldCameraShotContext(canvas, "camera-1");
    expect(context?.kind).toBe("dynamic");
    expect(context?.reason).toBe("anchor-in-animated-area");
    expect(context?.animation?.duration).toBe(4);
    expect(effectiveShotKind(canvas, "camera-1")).toBe("dynamic");
  });

  it("区外但被 camera 轨道驱动仍是 dynamic", () => {
    const script = `motion.camera.tween({ cameraId: "camera-1", property: "position", startTime: 0, endTime: 4, from: [0, 0, 1.8], to: [1, 0, 1.8], easing: "linear" });`;
    const canvas = canvasWith([
      { id: "area-1", type: "scene-area", sceneArea: area("area-1", script) },
      {
        id: "cam-node",
        type: "world-camera",
        worldCamera: camera("camera-1", { position: { u: 40, v: 40, h: 1.8 } })
      }
    ]);
    const context = worldCameraShotContext(canvas, "camera-1");
    expect(context?.kind).toBe("dynamic");
    expect(context?.reason).toBe("camera-track");
  });

  it("区外但绑定实例被 instance 轨道驱动仍是 dynamic", () => {
    const script = `motion.instance.tween("instance-9", { property: "position", startTime: 0, endTime: 4, from: [0, 0, 0], to: [1, 0, 0], easing: "linear" });`;
    const canvas = canvasWith([
      { id: "area-1", type: "scene-area", sceneArea: area("area-1", script) },
      {
        id: "cam-node",
        type: "world-camera",
        worldCamera: camera("camera-1", { position: { u: 40, v: 40, h: 1.8 }, boundInstanceId: "instance-9" })
      }
    ]);
    const context = worldCameraShotContext(canvas, "camera-1");
    expect(context?.kind).toBe("dynamic");
    expect(context?.reason).toBe("bound-instance-track");
  });

  it("无动画覆盖时派生为 static", () => {
    const canvas = canvasWith([
      { id: "area-1", type: "scene-area", sceneArea: area("area-1", null) },
      { id: "cam-node", type: "world-camera", worldCamera: camera("camera-1") }
    ]);
    expect(effectiveShotKind(canvas, "camera-1")).toBe("static");
    expect(worldCameraAnimationDuration(canvas, "camera-1")).toBeNull();
  });

  it("增删 animationScript 会改变派生结果与时长，且不改写 canonical", () => {
    const withScript = canvasWith([
      { id: "area-1", type: "scene-area", sceneArea: area("area-1", "function build(motion) {}") },
      { id: "cam-node", type: "world-camera", worldCamera: camera("camera-1") }
    ]);
    const snapshot = JSON.stringify(withScript.nodeData);
    expect(effectiveShotKind(withScript, "camera-1")).toBe("dynamic");
    expect(worldCameraAnimationDuration(withScript, "camera-1")).toBe(4);
    // 读取派生结果不写回规范数据。
    expect(JSON.stringify(withScript.nodeData)).toBe(snapshot);

    const withoutScript = canvasWith([
      { id: "area-1", type: "scene-area", sceneArea: area("area-1", null) },
      { id: "cam-node", type: "world-camera", worldCamera: camera("camera-1") }
    ]);
    expect(effectiveShotKind(withoutScript, "camera-1")).toBe("static");
    expect(worldCameraAnimationDuration(withoutScript, "camera-1")).toBeNull();
  });

  it("移除动画后回到 static，历史视频字段不被改写", () => {
    const canvas = canvasWith([
      { id: "area-1", type: "scene-area", sceneArea: area("area-1", null) },
      { id: "cam-node", type: "world-camera", worldCamera: camera("camera-1") },
      { id: "video-node", type: "video" }
    ]);
    (canvas.nodeData as Record<string, unknown>)["video-node"] = {
      outputAssetId: "asset-historic-video",
      status: "success"
    };
    expect(effectiveShotKind(canvas, "camera-1")).toBe("static");
    expect((canvas.nodeData as Record<string, { outputAssetId?: string }>)["video-node"]?.outputAssetId)
      .toBe("asset-historic-video");
  });
});

describe("worldCameraShotState", () => {
  it("四种状态与可下载性", () => {
    expect(worldCameraShotState({ kind: "dynamic", durationSeconds: 4, capturedKeyMatchesCurrent: null, failed: false }))
      .toMatchObject({ phase: "preview", downloadable: false, playable: false, label: "预览 · 4s" });
    expect(worldCameraShotState({ kind: "dynamic", durationSeconds: 4, capturedKeyMatchesCurrent: true, failed: false }))
      .toMatchObject({ phase: "ready", downloadable: true, playable: true, label: "视频 · 4s" });
    expect(worldCameraShotState({ kind: "dynamic", durationSeconds: 4, capturedKeyMatchesCurrent: false, failed: false }))
      .toMatchObject({ phase: "stale", downloadable: false, label: "已过期 · 4s" });
    expect(worldCameraShotState({ kind: "dynamic", durationSeconds: 4, capturedKeyMatchesCurrent: true, failed: true }))
      .toMatchObject({ phase: "failed", downloadable: false, label: "准备失败" });
  });

  it("静态镜头不提供视频状态", () => {
    expect(worldCameraShotState({ kind: "static", durationSeconds: null, capturedKeyMatchesCurrent: null, failed: false }))
      .toMatchObject({ phase: "ready", downloadable: false, playable: false });
  });
});

describe("导出当前帧", () => {
  it("动态镜头的静帧导出不改变卡片语义，时间点变化产生新身份", () => {
    const canvas = canvasWith([
      { id: "area-1", type: "scene-area", sceneArea: area("area-1", "function build(motion) {}") },
      { id: "cam-node", type: "world-camera", worldCamera: camera("camera-1") }
    ]);
    const first = planWorldCameraStillFrame({ canvas, camera: "camera-1", timeSeconds: 1, worldContentVersion: "w1" });
    const again = planWorldCameraStillFrame({ canvas, camera: "camera-1", timeSeconds: 1, worldContentVersion: "w1" });
    const later = planWorldCameraStillFrame({ canvas, camera: "camera-1", timeSeconds: 2.5, worldContentVersion: "w1" });
    expect(first?.kind).toBe("dynamic");
    expect(first?.identity).toBe(again?.identity);
    expect(first?.identity).not.toBe(later?.identity);
    expect(effectiveShotKind(canvas, "camera-1")).toBe("dynamic");
  });

  it("静态镜头导出静帧沿用静态语义", () => {
    const canvas = canvasWith([
      { id: "cam-node", type: "world-camera", worldCamera: camera("camera-1") }
    ]);
    const plan = planWorldCameraStillFrame({ canvas, camera: "camera-1", timeSeconds: 0 });
    expect(plan?.kind).toBe("static");
    expect(plan?.durationSeconds).toBeNull();
  });
});
