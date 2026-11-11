import { expect, it } from "vitest";
import {
  createDefaultWorldCameraData,
  createEmptyWoohaa3ServerCanvas,
  decodeWorldCamera,
  defaultWorldCameraProjection,
  type CanvasNodeData,
  type ServerCanvas,
  type WorldCameraData
} from "@woohaa3/contracts";
import {
  beginWorldCameraDrag,
  cardFollowPosition,
  cameraCanvasPosition,
  isWorldCameraTarget,
  planWorldCameraMove,
  poseFor,
  worldCameraMoved,
  worldCameraSettingsOfPose
} from "./world-camera-drag.js";
import { worldModelSelectionFromPick } from "../canvas-runtime/model-world-presentation.js";

function canvasWithCamera(): { canvas: ServerCanvas; cameraId: string } {
  const canvas = createEmptyWoohaa3ServerCanvas("camera-drag");
  const camera = createDefaultWorldCameraData("camera-1", "camera-v1", { u: 0, v: 0 });
  canvas.document.nodes.push({ id: "camera-node", type: "world-camera", position: { x: 0, y: 0 } });
  canvas.nodeData["camera-node"] = { worldCamera: camera } as unknown as CanvasNodeData;
  return { canvas, cameraId: camera.cameraId };
}

it("recognizes a valid world-camera node as a 3D drag target", () => {
  const { canvas } = canvasWithCamera();
  expect(isWorldCameraTarget(canvas, "camera-node")).toBe(true);
  expect(isWorldCameraTarget(canvas, "missing")).toBe(false);
  expect(beginWorldCameraDrag(canvas, "camera-node", null, "move")).toBeNull();
  expect(beginWorldCameraDrag(canvas, "camera-node", { u: 0, v: 0 }, "move")).not.toBeNull();
});

it("moves a camera on the ground without changing its height, rotation or settings identity", () => {
  const { canvas } = canvasWithCamera();
  const camera = (canvas.nodeData["camera-node"] as unknown as { worldCamera: WorldCameraData }).worldCamera;
  const start = beginWorldCameraDrag(canvas, "camera-node", { u: 0, v: 0 }, "move")!;
  expect(planWorldCameraMove(start, { u: 2, v: -3 })).toEqual({
    position: {
      u: camera.position.u + 2,
      v: camera.position.v - 3,
      h: camera.position.h
    },
    rotation: camera.rotation
  });
  expect(worldCameraMoved(start, { u: 0.0005, v: 0 })).toBe(false);
});

it("snaps an isometric camera to a valid 90-degree yaw when rotating", () => {
  const { canvas } = canvasWithCamera();
  const base = (canvas.nodeData["camera-node"] as unknown as { worldCamera: WorldCameraData }).worldCamera;
  // 默认镜头是透视投影；本用例针对等距镜头的 90° 吸附，必须显式声明等距投影。
  const camera: WorldCameraData = { ...base, projection: defaultWorldCameraProjection("isometric") };
  canvas.nodeData["camera-node"] = { worldCamera: camera } as unknown as CanvasNodeData;
  const start = beginWorldCameraDrag(canvas, "camera-node", { u: 0, v: 0 }, "rotate")!;
  const pose = planWorldCameraMove(start, { u: 1, v: 0 })!;
  expect(pose.rotation).not.toEqual(camera.rotation);
  expect(decodeWorldCamera({ ...camera, ...pose }).ok).toBe(true);
  // 小幅拖动不产生朝向变化，避免误触把镜头跳到下一象限。
  expect(planWorldCameraMove(start, { u: 0.1, v: 0 })).toBeNull();
});

it("keeps perspective rotation smooth and rejects the pristine no-op", () => {
  const canvas = createEmptyWoohaa3ServerCanvas("camera-perspective");
  const base = createDefaultWorldCameraData("camera-1", "camera-v1", { u: 0, v: 0 });
  const camera = {
    ...base,
    projection: {
      kind: "perspective" as const,
      verticalFovRadians: Math.PI / 3,
      nearMeters: 0.1,
      farMeters: 500
    }
  };
  canvas.document.nodes.push({ id: "camera-node", type: "world-camera", position: { x: 0, y: 0 } });
  canvas.nodeData["camera-node"] = { worldCamera: camera } as unknown as CanvasNodeData;
  const pose = poseFor(camera, "rotate", { u: 1, v: 0 })!;
  expect(decodeWorldCamera({ ...camera, ...pose }).ok).toBe(true);
  expect(() => worldCameraSettingsOfPose(camera, pose)).not.toThrow();
  const start = beginWorldCameraDrag(canvas, "camera-node", { u: 0, v: 0 }, "rotate")!;
  expect(planWorldCameraMove(start, { u: 0, v: 0 })).toBeNull();
});

it("moves the card by the camera's canvas displacement and preserves their offset", () => {
  const { canvas } = canvasWithCamera();
  const start = beginWorldCameraDrag(canvas, "camera-node", { u: 0, v: 0 }, "move")!;
  const basePose = { position: start.camera.position, rotation: start.camera.rotation };
  expect(cardFollowPosition(start, basePose)).toEqual(start.card);
  const movedPose = {
    position: { ...start.camera.position, u: start.camera.position.u + 2 },
    rotation: start.camera.rotation
  };
  const before = cameraCanvasPosition(basePose);
  const after = cameraCanvasPosition(movedPose);
  const moved = cardFollowPosition(start, movedPose);
  expect(moved.x - start.card.x).toBeCloseTo(after.x - before.x, 6);
  expect(moved.y - start.card.y).toBeCloseTo(after.y - before.y, 6);
});

it("selects a camera from the renderer pick", () => {
  const { canvas } = canvasWithCamera();
  expect(worldModelSelectionFromPick({
    canvas,
    pick: { ok: true, value: { nodeId: "camera-node" } },
    selected: []
  })).toEqual(["camera-node"]);
});
