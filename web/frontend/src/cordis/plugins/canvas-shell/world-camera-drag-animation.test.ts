import { expect, it } from "vitest";
import {
  createDefaultWorldCameraData,
  createEmptyWoohaa3ServerCanvas,
  createWorldAnimationScript,
  decodeSceneAreaData,
  executeWorldAnimationScript,
  sampleWorldAnimation,
  type CanvasNodeData,
  type ServerCanvas,
  type WorldAnimationScript
} from "@woohaa3/contracts";
import {
  animatedCameraAt,
  beginWorldCameraDrag,
  planWorldCameraMoveWithAnimationParts
} from "./world-camera-drag.js";

function canvasWithAnimatedCamera(input: {
  bounds?: { min: { u: number; v: number }; max: { u: number; v: number } };
  from?: [number, number, number];
  to?: [number, number, number];
} = {}): { canvas: ServerCanvas; script: WorldAnimationScript; cameraId: string } {
  const canvas = createEmptyWoohaa3ServerCanvas("camera-animation-drag");
  const camera = createDefaultWorldCameraData("camera-1", "camera-v1", { u: 20, v: 20 });
  const script = createWorldAnimationScript({
    script: `motion.camera.tween({ cameraId: "camera-1", property: "position", startTime: 0, endTime: 4, from: ${JSON.stringify(input.from ?? [1, 2, 1])}, to: ${JSON.stringify(input.to ?? [3, 4, 1])}, easing: "linear" });`,
    duration: 4,
    loop: false
  });
  canvas.document.nodes.push(
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "camera-node", type: "world-camera", position: { x: 0, y: 0 } }
  );
  canvas.nodeData.area = {
    sceneArea: {
      kind: "scene-area",
      version: "shared-world-v1",
      areaId: "area-main",
      scopeVersion: "scope-1",
      bounds: input.bounds ?? { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } },
      animationScript: script
    }
  } as unknown as CanvasNodeData;
  canvas.nodeData["camera-node"] = { worldCamera: camera } as unknown as CanvasNodeData;
  return { canvas, script, cameraId: camera.cameraId };
}

function areaScript(canvas: ServerCanvas): WorldAnimationScript | null {
  const area = decodeSceneAreaData(canvas.nodeData.area?.sceneArea);
  return area.ok ? area.value.animationScript ?? null : null;
}

function positionAt(script: WorldAnimationScript, cameraId: string, time: number) {
  const executed = executeWorldAnimationScript(script.script, { duration: script.duration, loop: script.loop });
  if (!executed.ok) throw new Error(executed.message);
  return sampleWorldAnimation(executed.ir, time).cameras.get(cameraId)?.position ?? null;
}

it("samples an animated camera's visible pose instead of its distant canonical base", () => {
  const { canvas } = canvasWithAnimatedCamera();
  const sample = animatedCameraAt(canvas, "camera-1", new Map([["area", 0]]));
  expect(sample).not.toBeNull();
  expect(sample!.camera.position).toEqual({ u: 1, v: 2, h: 1 });
  expect(sample!.areas).toHaveLength(1);
});

it("shifts camera position tracks with the drag and restores them on undo", () => {
  const { canvas } = canvasWithAnimatedCamera();
  const times = new Map([["area", 0]]);
  const sample = animatedCameraAt(canvas, "camera-1", times)!;
  const start = beginWorldCameraDrag(canvas, "camera-node", { u: 0, v: 0 }, "move", sample.camera)!;
  const plan = planWorldCameraMoveWithAnimationParts(canvas, start, { u: 2, v: 3 }, times)!;
  expect(plan.animated).toBe(true);
  expect(plan.pose.position).toEqual({ u: 3, v: 5, h: 1 });

  const forward = plan.forwardAreas[0]!;
  const forwardScript = (forward.type === "nodeData.patch"
    ? (forward.value as unknown as { sceneArea: { animationScript: WorldAnimationScript } }).sceneArea.animationScript
    : null);
  expect(positionAt(forwardScript!, "camera-1", 0)).toEqual({ u: 3, v: 5, h: 1 });

  const inverse = plan.inverseAreas[0]!;
  const inverseScript = (inverse.type === "nodeData.patch"
    ? (inverse.value as unknown as { sceneArea: { animationScript: WorldAnimationScript } }).sceneArea.animationScript
    : null);
  expect(positionAt(inverseScript!, "camera-1", 0)).toEqual({ u: 1, v: 2, h: 1 });
});

it("asks to unbind when the camera leaves the animating area", () => {
  const { canvas } = canvasWithAnimatedCamera({
    bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } },
    from: [5, 5, 1],
    to: [6, 6, 1]
  });
  const times = new Map([["area", 0]]);
  const sample = animatedCameraAt(canvas, "camera-1", times)!;
  const start = beginWorldCameraDrag(canvas, "camera-node", { u: 0, v: 0 }, "move", sample.camera)!;

  const outside = planWorldCameraMoveWithAnimationParts(canvas, start, { u: 10, v: 10 }, times)!;
  expect(outside.unbindCandidates.map(candidate => candidate.areaNodeId)).toEqual(["area"]);

  const unbound = planWorldCameraMoveWithAnimationParts(
    canvas,
    start,
    { u: 10, v: 10 },
    times,
    new Set(["area"])
  )!;
  const forward = unbound.forwardAreas[0]!;
  const sceneArea = (forward.type === "nodeData.patch"
    ? (forward.value as unknown as { sceneArea: { animationScript?: WorldAnimationScript } }).sceneArea
    : null);
  expect(sceneArea?.animationScript).toBeUndefined();
  expect(areaScript(canvas)).not.toBeNull();
});
