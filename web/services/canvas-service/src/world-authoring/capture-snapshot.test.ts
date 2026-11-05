import { describe, expect, it } from "vitest";
import {
  worldCaptureDynamicBaseKey,
  worldCaptureVersionKeysEqual,
  SHARED_WORLD_VERSION,
  createDefaultWorldCameraData,
  createEmptyWoohaa3ServerCanvas,
  createWorldAnimationScript,
  type ServerCanvas
} from "@woohaa3/contracts";
import { buildWorldCameraObservation } from "./capture-snapshot.js";

function canvasWith(options: { script?: string; durationSeconds?: number; captureMode?: "static" | "dynamic" } = {}): ServerCanvas {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas", "2026-11-05T00:00:00Z");
  canvas.document.nodes.push({ id: "camera", type: "world-camera", position: { x: 0, y: 0 } });
  canvas.nodeData.camera = {
    worldCamera: {
      ...createDefaultWorldCameraData("camera", "v1", { u: 0, v: 0 }),
      captureMode: { kind: options.captureMode ?? "static" }
    }
  } as never;
  canvas.document.nodes.push({ id: "area", type: "scene-area" });
  const area: Record<string, unknown> = {
    kind: "scene-area",
    version: SHARED_WORLD_VERSION,
    areaId: "area-1",
    scopeVersion: "scope-1",
    bounds: { min: { u: -30, v: -30 }, max: { u: 30, v: 30 } }
  };
  if (options.script !== undefined) {
    area.animationScript = createWorldAnimationScript({
      script: options.script,
      duration: options.durationSeconds ?? 4,
      loop: false
    });
  }
  canvas.nodeData.area = { sceneArea: area } as never;
  return canvas;
}

const SCRIPT = `function build(motion) {
  motion.camera.tween({ cameraId: "camera", property: "position", startTime: 0, endTime: 4, from: [0, 0, 1.8], to: [2, 0, 1.8], easing: "linear" });
}`;

describe("buildWorldCameraObservation", () => {
  it("静态镜头保持图片输出与静态回归", () => {
    const canvas = canvasWith();
    const result = buildWorldCameraObservation({
      canvasId: canvas.id,
      canvas,
      cameraId: "camera",
      outputLongEdge: 2048,
      attemptCounter: 1
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.observation.kind).toBe("static");
    if (result.observation.kind !== "static") return;
    expect(result.observation.request.output.contentType).toBe("image/png");
    expect(result.observation.request.output.width).toBe(2048);
  });

  it("动态镜头产出视频输出与动画/区间/fps 键", () => {
    const canvas = canvasWith({ script: SCRIPT, captureMode: "static" });
    const result = buildWorldCameraObservation({
      canvasId: canvas.id,
      canvas,
      cameraId: "camera",
      outputLongEdge: 2048,
      attemptCounter: 1
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.observation.kind !== "dynamic") throw new Error("expected dynamic");
    const { request, key } = result.observation;
    expect(request.key.outputVersion).toBe(key.outputVersion);
    expect(request.output.container).toBe("video/mp4");
    expect(request.output.width).toBe(1024);
    expect(key.fps).toBe(24);
    expect(key.timeRange).toEqual({ startSeconds: 0, endSeconds: 4 });
    expect(key.animation).toMatchObject({ areaId: "area-1", scriptRevision: 1 });
    // 动画上下文派生，不受旧 captureMode 影响。
    expect(result.observation.durationSeconds).toBe(4);
  });

  it("超过单次上限时显式拒绝而不是静默截断", () => {
    const canvas = canvasWith({ script: SCRIPT, durationSeconds: 90 });
    const over = buildWorldCameraObservation({
      canvasId: canvas.id,
      canvas,
      cameraId: "camera",
      outputLongEdge: 2048,
      attemptCounter: 1
    });
    expect(over).toMatchObject({ ok: false, code: "duration-exceeded" });

    const shorter = buildWorldCameraObservation({
      canvasId: canvas.id,
      canvas,
      cameraId: "camera",
      outputLongEdge: 2048,
      attemptCounter: 1,
      timeRange: { startSeconds: 0, endSeconds: 30 }
    });
    expect(shorter.ok).toBe(true);
    if (shorter.ok && shorter.observation.kind === "dynamic") {
      expect(shorter.observation.key.timeRange.endSeconds).toBe(30);
    }
  });

  it("区间与帧率非法时拒绝", () => {
    const canvas = canvasWith({ script: SCRIPT });
    expect(buildWorldCameraObservation({
      canvasId: canvas.id,
      canvas,
      cameraId: "camera",
      outputLongEdge: 2048,
      attemptCounter: 1,
      timeRange: { startSeconds: 3, endSeconds: 2 }
    })).toMatchObject({ ok: false, code: "invalid-data" });
    expect(buildWorldCameraObservation({
      canvasId: canvas.id,
      canvas,
      cameraId: "camera",
      outputLongEdge: 2048,
      attemptCounter: 1,
      fps: 120
    })).toMatchObject({ ok: false, code: "fps-out-of-range" });
  });
});


describe("动态键与调度基础键", () => {
  it("动态键本身不能当六字段键比较，基础键可以", () => {
    const canvas = canvasWith({ script: SCRIPT });
    const result = buildWorldCameraObservation({
      canvasId: canvas.id,
      canvas,
      cameraId: "camera",
      outputLongEdge: 2048,
      attemptCounter: 1
    });
    if (!result.ok || result.observation.kind !== "dynamic") throw new Error("expected dynamic");
    const base = worldCaptureDynamicBaseKey(result.observation.key);
    // 旧实现把完整动态键存进调度状态，严格六字段解码永远失败 → 每次冻结都误判 superseded。
    expect(worldCaptureVersionKeysEqual(result.observation.key, result.observation.key)).toBe(false);
    expect(worldCaptureVersionKeysEqual(base, base)).toBe(true);
  });
});
