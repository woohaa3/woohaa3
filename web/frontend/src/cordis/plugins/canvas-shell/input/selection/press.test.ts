import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { resolveContextSelection, resolvePressSelection } from "./press.js";

function canvas(): ServerCanvas {
  const base = createEmptyWoohaa3ServerCanvas("c1");
  return {
    ...base,
    document: {
      ...base.document,
      nodes: [
        { id: "group", type: "workflow-group-2d", position: { x: 0, y: 0 }, width: 300, height: 200 },
        { id: "member", type: "image", position: { x: 20, y: 20 }, width: 180, height: 100 },
        { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
        { id: "model1", type: "model3d", position: { x: 0, y: 0 } },
        { id: "model2", type: "model3d", position: { x: 0, y: 0 } },
        { id: "camera", type: "world-camera", position: { x: 0, y: 0 } },
        { id: "grouped-camera", type: "world-camera", position: { x: 0, y: 0 } }
      ]
    },
    nodeData: {
      group: {
        workflowGroup2d: {
          kind: "workflow-group-2d", version: "shared-world-v1", groupId: "group",
          scopeVersion: "g1", memberNodeIds: ["member", "grouped-camera"]
        }
      },
      area: {
        sceneArea: {
          kind: "scene-area", version: "shared-world-v1", areaId: "a1", scopeVersion: "s1",
          bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
        }
      },
      model1: {
        sharedWorldInstance: {
          kind: "world-instance", version: "shared-world-v1", instanceId: "i1",
          transform: { version: "shared-world-v1", position: { u: 2, v: 3, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
        }
      },
      model2: {
        sharedWorldInstance: {
          kind: "world-instance", version: "shared-world-v1", instanceId: "i2",
          transform: { version: "shared-world-v1", position: { u: 6, v: 6, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
        }
      },
      camera: {
        worldCamera: cameraData("cam-1", 4, 5)
      },
      "grouped-camera": {
        worldCamera: cameraData("cam-2", 5, 4)
      }
    }
  } as unknown as ServerCanvas;
}

function cameraData(cameraId: string, u: number, v: number) {
  return {
    kind: "world-camera",
    version: "shared-world-v1",
    cameraId,
    settingsVersion: `${cameraId}-v1`,
    position: { u, v, h: 1.5 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    boundInstanceId: null
  };
}

describe("resolvePressSelection", () => {
  it("enters the container before selecting a child", () => {
    expect(resolvePressSelection({ canvas: canvas(), nodeId: "model1", selected: [] })).toMatchObject({
      selection: ["area"], reason: "scope-entry", gesture: "scope"
    });
  });

  it("switches directly between siblings in the same container", () => {
    expect(resolvePressSelection({ canvas: canvas(), nodeId: "model2", selected: ["model1"] })).toMatchObject({
      selection: ["model2"], reason: "sibling-switch", gesture: "child"
    });
  });

  it("keeps an already-selected child for the domain gesture", () => {
    expect(resolvePressSelection({ canvas: canvas(), nodeId: "model1", selected: ["model1"] })).toMatchObject({
      selection: null, reason: "already-selected", gesture: "keep"
    });
  });

  it("toggles additively without entering the container", () => {
    expect(resolvePressSelection({ canvas: canvas(), nodeId: "model1", selected: [], additive: true })).toMatchObject({
      selection: ["model1"], reason: "toggle", gesture: "toggle"
    });
  });

  it("selects a camera directly from its 2D card without entering the container", () => {
    expect(resolvePressSelection({ canvas: canvas(), nodeId: "camera", selected: [], via: "card" })).toMatchObject({
      selection: ["camera"], reason: "child", gesture: "child"
    });
    expect(resolvePressSelection({ canvas: canvas(), nodeId: "grouped-camera", selected: [], via: "card" })).toMatchObject({
      selection: ["grouped-camera"], reason: "child", gesture: "child"
    });
  });

  it("keeps container precedence when the 3D camera is picked", () => {
    expect(resolvePressSelection({ canvas: canvas(), nodeId: "camera", selected: [], via: "pick" })).toMatchObject({
      selection: ["area"], reason: "scope-entry", gesture: "scope"
    });
    expect(resolvePressSelection({ canvas: canvas(), nodeId: "grouped-camera", selected: [], via: "pick" })).toMatchObject({
      selection: ["group"], reason: "scope-entry", gesture: "scope"
    });
  });

  it("keeps right-click selection from drilling into a container", () => {
    expect(resolveContextSelection({ canvas: canvas(), nodeId: "model1", selected: [] })).toMatchObject({
      selection: ["model1"], gesture: "child"
    });
  });
});
