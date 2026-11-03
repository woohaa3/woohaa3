import { describe, expect, it } from "vitest";
// Imported from the contract source so this focused unit test does not depend on a
// rebuilt shared `dist` while parallel sessions are editing the contracts barrel.
import {
  WORLD_CAMERA_ASPECT_PRESETS,
  WORLD_CAMERA_CARD_SIZE,
  createDefaultWorldCameraData,
  defaultIsometricCameraRotation,
  isWorldCameraIsometricRotation,
  withWorldCameraAspect,
  withWorldCameraBinding,
  withWorldCameraFraming,
  withWorldCameraProjectionKind,
  worldCameraAspectPresetId,
  worldCameraBindingOptions,
  worldCameraBoundTarget,
  worldCameraFailureText,
  worldCameraFramingControl,
  worldCameraSettingsEqual,
  worldCameraUiSettingsOf
} from "../../../../../contracts/src/canvas/world-camera-ui.js";
import { decodeWorldCamera } from "../../../../../contracts/src/canvas/world-camera-codec.js";
import { applyCanvasCommands } from "../../../../../contracts/src/canvas/command-reducer.js";
import { createEmptyWoohaa3ServerCanvas } from "../../../../../contracts/src/canvas/domain/index.js";

const instance = (instanceId: string) => ({
  kind: "world-instance",
  version: "shared-world-v1",
  instanceId,
  transform: {
    version: "shared-world-v1",
    position: { u: 0, v: 0, h: 0 },
    rotation: [0, 0, 0, 1],
    scale: 1
  }
});

const canvas = {
  document: { nodes: [{ id: "model-a", type: "model3d" }, { id: "model-b", type: "model3d" }, { id: "camera", type: "world-camera" }] },
  nodeData: {
    "model-a": { title: "主角", sharedWorldInstance: instance("instance-a") },
    "model-b": { sharedWorldInstance: instance("instance-b") },
    camera: { worldCamera: {} }
  }
};

describe("world camera UI contract", () => {
  it("creates a codec-valid default isometric camera independent of card size", () => {
    const camera = createDefaultWorldCameraData("camera-1", "settings-1", { u: 2, v: -3 });
    const decoded = decodeWorldCamera(camera);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.projection.kind).toBe("isometric");
    expect(decoded.value.boundInstanceId).toBeNull();
    expect(decoded.value.aspect).toEqual({ width: 16, height: 9 });
    expect(isWorldCameraIsometricRotation(decoded.value.rotation)).toBe(true);
    expect(WORLD_CAMERA_CARD_SIZE).toEqual({ width: 248, height: 156 });
    expect(worldCameraAspectPresetId(worldCameraUiSettingsOf(decoded.value))).toBe("16:9");
  });

  it("switches projections without inventing an isometric pose from a perspective rotation", () => {
    const base = worldCameraUiSettingsOf(createDefaultWorldCameraData("camera-1", "settings-1", { u: 0, v: 0 }));
    const perspective = withWorldCameraProjectionKind({
      ...base,
      rotation: [0, 0, 0, 1]
    }, "perspective");
    expect(perspective.projection.kind).toBe("perspective");
    expect(perspective.rotation).toEqual([0, 0, 0, 1]);

    const isometric = withWorldCameraProjectionKind(perspective, "isometric");
    expect(isometric.projection.kind).toBe("isometric");
    expect(isWorldCameraIsometricRotation(isometric.rotation)).toBe(true);
    expect(defaultIsometricCameraRotation()).toEqual(isometric.rotation);
  });

  it("maps framing controls between isometric size and perspective FOV", () => {
    const base = worldCameraUiSettingsOf(createDefaultWorldCameraData("camera-1", "settings-1", { u: 0, v: 0 }));
    expect(worldCameraFramingControl(base).unit).toBe("m");
    expect(withWorldCameraFraming(base, 99).projection).toMatchObject({ kind: "isometric", verticalSizeMeters: 80 });
    const perspective = withWorldCameraProjectionKind(base, "perspective");
    expect(worldCameraFramingControl(perspective).value).toBeCloseTo(60, 1);
    const tightened = withWorldCameraFraming(perspective, 45);
    expect(tightened.projection.kind).toBe("perspective");
    if (tightened.projection.kind === "perspective") {
      expect(tightened.projection.verticalFovRadians).toBeCloseTo(Math.PI / 4, 6);
    }
  });

  it("lists every shared-world instance and reports a missing binding without unbinding it", () => {
    const options = worldCameraBindingOptions(canvas);
    expect(options.map((option) => option.value)).toEqual(["", "instance-a", "instance-b"]);
    expect(options[1].label).toBe("主角");
    expect(worldCameraBoundTarget(canvas, null)).toEqual({ status: "unbound" });
    expect(worldCameraBoundTarget(canvas, "instance-a")).toMatchObject({ status: "bound", nodeId: "model-a" });
    expect(worldCameraBoundTarget(canvas, "gone")).toMatchObject({ status: "missing", instanceId: "gone" });
    expect(worldCameraBindingOptions(canvas, "gone").at(-1)).toEqual({ value: "gone", label: "模型不可用（gone）" });
  });

  it("keeps aspect and explicit unbinding as camera-only settings", () => {
    const base = worldCameraUiSettingsOf(createDefaultWorldCameraData("camera-1", "settings-1", { u: 0, v: 0 }));
    const square = withWorldCameraAspect(base, "1:1");
    expect(worldCameraAspectPresetId(square)).toBe("1:1");
    const bound = withWorldCameraBinding(square, "instance-a");
    expect(worldCameraSettingsEqual(bound, withWorldCameraBinding(square, "instance-a"))).toBe(true);
    expect(bound.boundInstanceId).toBe("instance-a");
    expect(withWorldCameraBinding(bound, null).boundInstanceId).toBeNull();
    expect(WORLD_CAMERA_ASPECT_PRESETS).toHaveLength(4);
  });

  it("accepts the created card and camera payload through the shared reducer", () => {
    const camera = createDefaultWorldCameraData("camera-1", "settings-1", { u: 0, v: 0 });
    const result = applyCanvasCommands(createEmptyWoohaa3ServerCanvas("canvas-1", "2026-11-03T00:00:00.000Z"), [{
      type: "node.add",
      node: { id: "camera-node", type: "world-camera", position: { x: 40, y: 60 }, width: 248, height: 156 },
      nodeData: { worldCamera: camera } as never
    }], { now: "2026-11-03T00:00:00.000Z" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.canvas.document.nodes[0]).toMatchObject({ id: "camera-node", type: "world-camera", width: 248, height: 156 });
    const decoded = decodeWorldCamera((result.canvas.nodeData["camera-node"] as { worldCamera?: unknown }).worldCamera);
    expect(decoded.ok).toBe(true);
  });

  it("explains authority conflicts in product language", () => {
    expect(worldCameraFailureText("version-conflict")).toContain("载入最新");
    expect(worldCameraFailureText("target-unavailable")).toContain("解除绑定");
    expect(worldCameraFailureText("unknown", "服务未就绪")).toBe("服务未就绪");
  });
});
