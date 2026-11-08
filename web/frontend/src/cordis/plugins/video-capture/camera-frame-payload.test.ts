/** @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, createWorldAnimationScript, worldCameraShotContext, type WorldCaptureFramingStatus } from "@woohaa3/contracts";
import { worldCameraShotStore } from "../../services/world-camera-shot-store.js";
import { cameraFramePayload } from "./seedance-plugin.js";
import { validateVideoDialogPayload } from "./definitions.js";

afterEach(() => worldCameraShotStore.clear());

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas");
  canvas.document.nodes = [
    { id: "camera", type: "world-camera", position: { x: 0, y: 0 } },
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } }
  ];
  canvas.nodeData.camera = { worldCamera: {
    kind: "world-camera", version: "shared-world-v1", cameraId: "camera", settingsVersion: "settings-1",
    position: { u: 0, v: 0, h: 1.8 }, rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" }, aspect: { width: 16, height: 9 }, boundInstanceId: null
  } };
  canvas.nodeData.area = { sceneArea: {
    kind: "scene-area", version: "shared-world-v1", areaId: "area", scopeVersion: "area-1",
    bounds: { min: { u: -4, v: -4 }, max: { u: 4, v: 4 } },
    animationScript: createWorldAnimationScript({ script: "function build(motion) {}", duration: 3, loop: false })
  } };
  const animation = worldCameraShotContext(canvas, "camera")!.animation!;
  const key = { canvasId: canvas.id, cameraId: "camera", cameraSettingsVersion: "settings-1",
    worldContentVersion: "world-1", bindingVersion: "binding-1", outputVersion: "output-1" };
  const status: WorldCaptureFramingStatus = { canvasId: canvas.id, cameraId: "camera", key, phase: "ready", stale: false,
    dynamicKey: { ...key, animation: { areaId: animation.areaId, scriptRevision: animation.scriptRevision,
      sourceHash: animation.sourceHash, durationSeconds: animation.duration }, timeRange: { startSeconds: 0, endSeconds: 3 }, fps: 24 },
    video: { version: "world-capture-video-media-v1", mediaId: "video-1", storageKey: `sha256-${"a".repeat(64)}`,
      checksum: "a".repeat(64), size: 10, contentType: "video/mp4", width: 320, height: 180,
      container: "video/mp4", durationSeconds: 3, fps: 24 }
  };
  return { canvas, status };
}

it("freezes full video provenance and rejects changed animation, stale or other-canvas results", () => {
  const { canvas, status } = fixture();
  worldCameraShotStore.set([status]);
  const payload = cameraFramePayload(canvas, "camera")!;
  expect(payload.cameraSource?.versionKey).toEqual(status.dynamicKey);
  expect(payload.cameraSource?.versionKey).not.toBe(status.dynamicKey);
  const validated = validateVideoDialogPayload(payload);
  expect(validated).toMatchObject({ ok: true, payload: { cameraSource: payload.cameraSource } });
  expect(validateVideoDialogPayload({ ...payload, cameraSource: { ...payload.cameraSource, cameraId: "other" } }).ok).toBe(false);
  const original = JSON.stringify(canvas);
  for (const patch of [{ stale: true }, { canvasId: "other" }, { dynamicKey: undefined },
    { dynamicKey: { ...status.dynamicKey!, animation: { ...status.dynamicKey!.animation, scriptRevision: 99 } } }]) {
    worldCameraShotStore.set([{ ...status, ...patch }]);
    expect(cameraFramePayload(canvas, "camera")).toBeNull();
  }
  expect(JSON.stringify(canvas)).toBe(original);
  expect(payload.videoAssetId).toBe("video-1");
});
