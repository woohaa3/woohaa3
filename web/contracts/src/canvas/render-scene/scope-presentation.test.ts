import { expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas } from "../domain/index.js";
import { buildCanvasRenderScene } from "./scene-builder.js";

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

it("drops edges that would point at the omitted scene-area node", () => {
  const canvas = fixture();
  canvas.document.edges.push(
    { id: "to-area", source: "member", target: "area", sourceHandle: null, targetHandle: null, data: {} },
    { id: "kept", source: "member", target: "camera", sourceHandle: null, targetHandle: null, data: {} }
  );
  const scene = buildCanvasRenderScene({ canvas });
  expect(scene.edges.map(edge => edge.id)).toEqual(["kept"]);
});
