import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "../domain/index.js";
import type { WorldAnimationScript } from "../world-animation-script.js";
import { buildCanvasRenderScene, renderSceneFingerprint } from "./scene-builder.js";

function fixture() {
  const canvas = createEmptyWoohaa3ServerCanvas("scope-presentation");
  canvas.document.nodes.push(
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "group", type: "workflow-group-2d", position: { x: 200, y: 200 } },
    { id: "model", type: "model3d", position: { x: 400, y: 200 } },
    { id: "camera", type: "world-camera", position: { x: 600, y: 200 } },
    { id: "member", type: "text", position: { x: 240, y: 240 } }
  );
  canvas.nodeData.area = {
    sceneArea: {
      kind: "scene-area",
      version: "shared-world-v1",
      areaId: "area-main",
      scopeVersion: "area-v1",
      bounds: { min: { u: -2, v: -2 }, max: { u: 2, v: 2 } }
    }
  };
  canvas.nodeData.group = {
    workflowGroup2d: {
      kind: "workflow-group-2d",
      version: "shared-world-v1",
      groupId: "group-main",
      scopeVersion: "group-v1",
      memberNodeIds: ["member"]
    }
  };
  canvas.nodeData.model = {
    sharedWorldInstance: {
      kind: "world-instance",
      version: "shared-world-v1",
      instanceId: "instance-main",
      transform: {
        version: "shared-world-v1",
        position: { u: 1, v: 1, h: 0 },
        rotation: [0, 0, 0, 1],
        scale: 1
      }
    }
  };
  canvas.nodeData.camera = {
    worldCamera: {
      kind: "world-camera",
      version: "shared-world-v1",
      cameraId: "camera-main",
      settingsVersion: "camera-v1",
      position: { u: 0, v: 0, h: 1.5 },
      rotation: [0, 0, 0, 1],
      projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 100 },
      captureMode: { kind: "static" },
      aspect: { width: 16, height: 9 },
      boundInstanceId: null
    }
  };
  return canvas;
}

it("projects scene areas only as ground bounds, never as a content card", () => {
  const scene = buildCanvasRenderScene({ canvas: fixture(), selection: { nodes: ["area"] } });
  expect(scene.nodes.map(node => node.id)).not.toContain("area");
  expect(scene.sceneAreas).toEqual([{
    nodeId: "area",
    title: "导演区 1",
    bounds: { min: { u: -2, v: -2 }, max: { u: 2, v: 2 } }
  }]);
  expect(scene.selection.nodes).toEqual(["area"]);
});

it("renders 2D groups as member frames and shared-world models without a card", () => {
  const scene = buildCanvasRenderScene({ canvas: fixture() });
  const group = scene.nodes.find(node => node.id === "group")!;
  expect(group.chrome).toEqual({ kind: "frame", groupId: "group-main", memberNodeIds: ["member"] });
  const model = scene.nodes.find(node => node.id === "model")!;
  expect(model.chrome).toEqual({ kind: "none" });
  expect(model.resizable).toBe(false);
  expect(model.modelPreview).toBeUndefined();
  expect(model.id).toBe("model");
  expect(model.sharedWorldInstance?.instanceId).toBe("instance-main");
  expect(scene.nodes.find(node => node.id === "camera")?.chrome).toBeUndefined();
  expect(scene.nodes.find(node => node.id === "member")?.chrome).toBeUndefined();
});

it("keeps a shared-world model in the render scene without card layout", () => {
  const canvas = fixture();
  const model = canvas.document.nodes.find(node => node.id === "model")!;
  delete model.position;
  delete model.width;
  delete model.height;
  const scene = buildCanvasRenderScene({ canvas });
  const rendered = scene.nodes.find(node => node.id === "model");
  expect(rendered).toBeDefined();
  expect(rendered!.chrome).toEqual({ kind: "none" });
  expect(rendered!.sharedWorldInstance?.instanceId).toBe("instance-main");
});

it("overrides scene-area bounds for drag preview without touching nodeData", () => {
  const canvas = fixture();
  const preview = new Map([["area", { min: { u: -1, v: -3 }, max: { u: 5, v: 4 } }]]);
  const scene = buildCanvasRenderScene({ canvas, sceneAreaPreviews: preview });
  expect(scene.sceneAreas).toEqual([{
    nodeId: "area",
    title: "导演区 1",
    bounds: { min: { u: -1, v: -3 }, max: { u: 5, v: 4 } }
  }]);
  expect(canvas.nodeData.area?.sceneArea).toMatchObject({
    bounds: { min: { u: -2, v: -2 }, max: { u: 2, v: 2 } }
  });
});

it("projects a world camera pose for the 3D renderer and keeps its card identity", () => {
  const scene = buildCanvasRenderScene({ canvas: fixture() });
  const camera = scene.nodes.find(node => node.id === "camera")!;
  expect(camera.worldCamera?.cameraId).toBe("camera-main");
  expect(camera.worldCamera?.position).toEqual({ u: 0, v: 0, h: 1.5 });
  expect(camera.title).toBe("未命名镜头");
  expect(camera.typeLabel).toBe("镜头");
  expect(camera.chrome).toBeUndefined();
});

it("applies a transient camera pose without rewriting the source canvas", () => {
  const canvas = fixture();
  const scene = buildCanvasRenderScene({
    canvas,
    worldCameraPreviews: new Map([["camera", {
      position: { u: 4, v: 5, h: 6 },
      rotation: [0, 0, 0, 1]
    }]])
  });
  const camera = scene.nodes.find(node => node.id === "camera")!;
  expect(camera.worldCamera?.position).toEqual({ u: 4, v: 5, h: 6 });
  expect((canvas.nodeData.camera as { worldCamera?: { position?: unknown } }).worldCamera)
    .toMatchObject({ position: { u: 0, v: 0, h: 1.5 } });
});

it("lets a transient camera pose win over the sampled animation", () => {
  const canvas = fixture();
  const area = canvas.nodeData.area!.sceneArea as Record<string, unknown>;
  area.animationScript = {
    script: 'motion.camera.tween({ cameraId: "camera-main", property: "position", startTime: 0, endTime: 4, from: [1, 2, 1.5], to: [3, 4, 1.5], easing: "linear" });',
    scriptLanguage: "javascript",
    scriptVersion: "woohaa-world-animation-js-v1",
    revision: 1,
    sourceHash: "camera-hash",
    duration: 4,
    loop: false
  } satisfies WorldAnimationScript;
  const sampled = buildCanvasRenderScene({ canvas, sceneAnimationTimes: new Map([["area", 0]]) });
  expect(sampled.nodes.find(node => node.id === "camera")!.worldCamera?.position)
    .toEqual({ u: 1, v: 2, h: 1.5 });

  const dragged = buildCanvasRenderScene({
    canvas,
    sceneAnimationTimes: new Map([["area", 0]]),
    worldCameraPreviews: new Map([["camera", {
      position: { u: 9, v: 8, h: 7 },
      rotation: [0, 0, 0, 1]
    }]])
  });
  expect(dragged.nodes.find(node => node.id === "camera")!.worldCamera?.position)
    .toEqual({ u: 9, v: 8, h: 7 });
});

it("drops edges that would point at the omitted scene-area node", () => {
  const canvas = fixture();
  canvas.document.edges.push(
    { id: "to-area", source: "member", target: "area", sourceHandle: null, targetHandle: null, data: {} },
    { id: "kept", source: "member", target: "camera", sourceHandle: null, targetHandle: null, data: {} }
  );
  const scene = buildCanvasRenderScene({ canvas });
  expect(scene.edges.map(edge => edge.id)).toEqual(["kept"]);
});

it("execution start and stop invalidate the render fingerprint without canonical changes", () => {
  const canvas = fixture();
  const scene = buildCanvasRenderScene({ canvas });
  const idle = renderSceneFingerprint(scene);
  scene.executingScopes = ["area", "group"];
  expect(renderSceneFingerprint(scene)).not.toBe(idle);
  scene.executingScopes = [];
  expect(renderSceneFingerprint(scene)).toBe(idle);
  expect(canvas.nodeData.area).not.toHaveProperty("executingScopes");
});

it("samples each director at its own playhead without modifying canonical transforms", () => {
  const canvas = fixture();
  const animationScript = (instanceId: string): WorldAnimationScript => ({
    script: `motion.instance.tween(${JSON.stringify(instanceId)}, { property: "scale", startTime: 0, endTime: 4, from: [1], to: [5], easing: "linear" });`,
    scriptLanguage: "javascript",
    scriptVersion: "woohaa-world-animation-js-v1",
    revision: 1,
    sourceHash: `hash-${instanceId}`,
    duration: 4,
    loop: false
  });
  const area = canvas.nodeData.area!.sceneArea as Record<string, unknown>;
  area.animationScript = animationScript("instance-main");
  canvas.document.nodes.push(
    { id: "area-b", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "model-b", type: "model3d", position: { x: 0, y: 0 } }
  );
  canvas.nodeData["area-b"] = { sceneArea: { ...area, areaId: "area-b", animationScript: animationScript("instance-b") } };
  canvas.nodeData["model-b"] = { sharedWorldInstance: {
    ...(canvas.nodeData.model!.sharedWorldInstance as Record<string, unknown>), instanceId: "instance-b"
  } };
  const scene = buildCanvasRenderScene({ canvas, sceneAnimationTimes: new Map([["area", 1], ["area-b", 3]]) });
  expect(scene.nodes.find(node => node.id === "model")!.sharedWorldInstance!.transform.scale).toBe(2);
  expect(scene.nodes.find(node => node.id === "model-b")!.sharedWorldInstance!.transform.scale).toBe(4);
  expect(canvas.nodeData.model!.sharedWorldInstance).toMatchObject({ transform: { scale: 1 } });

  // The selected director wins when two areas address the same shared instance.
  canvas.nodeData["area-b"] = { sceneArea: { ...area, areaId: "area-b" } };
  const selected = buildCanvasRenderScene({ canvas, selection: { nodes: ["area"] },
    sceneAnimationTimes: new Map([["area", 1], ["area-b", 3]]) });
  expect(selected.nodes.find(node => node.id === "model")!.sharedWorldInstance!.transform.scale).toBe(2);
});
