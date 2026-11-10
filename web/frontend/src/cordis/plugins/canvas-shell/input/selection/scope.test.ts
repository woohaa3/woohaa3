import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type ServerCanvas } from "@woohaa3/contracts";
import { enclosingAuthoringScope, hasSelectedSiblingInScope, scopeSelectionPrecedence, selectsCardDirectly } from "./scope.js";

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
        { id: "model", type: "model3d", position: { x: 0, y: 0 } },
        { id: "model2", type: "model3d", position: { x: 0, y: 0 } },
        { id: "camera", type: "world-camera", position: { x: 0, y: 0 } },
        { id: "loose", type: "image", position: { x: 500, y: 500 } }
      ]
    },
    nodeData: {
      group: {
        workflowGroup2d: {
          kind: "workflow-group-2d",
          version: "shared-world-v1",
          groupId: "group",
          scopeVersion: "g1",
          memberNodeIds: ["member"]
        }
      },
      area: {
        sceneArea: {
          kind: "scene-area",
          version: "shared-world-v1",
          areaId: "a1",
          scopeVersion: "s1",
          bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
        }
      },
      model: {
        sharedWorldInstance: {
          kind: "world-instance",
          version: "shared-world-v1",
          instanceId: "i1",
          transform: { version: "shared-world-v1", position: { u: 2, v: 3, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
        }
      },
      model2: {
        sharedWorldInstance: {
          kind: "world-instance",
          version: "shared-world-v1",
          instanceId: "i2",
          transform: { version: "shared-world-v1", position: { u: 6, v: 6, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
        }
      },
      camera: {
        worldCamera: {
          kind: "world-camera",
          version: "shared-world-v1",
          cameraId: "cam-1",
          settingsVersion: "cam-v1",
          position: { u: 4, v: 5, h: 1.5 },
          rotation: [0, 0, 0, 1],
          projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
          captureMode: { kind: "static" },
          aspect: { width: 16, height: 9 },
          boundInstanceId: null
        }
      }
    }
  } as unknown as ServerCanvas;
}

describe("enclosingAuthoringScope", () => {
  it("uses the explicit 2D-group member table", () => {
    expect(enclosingAuthoringScope(canvas(), "member")).toBe("group");
  });

  it("uses director-area ground bounds for world models and cameras", () => {
    expect(enclosingAuthoringScope(canvas(), "model")).toBe("area");
    expect(enclosingAuthoringScope(canvas(), "camera")).toBe("area");
  });

  it("returns null for nodes outside any container", () => {
    expect(enclosingAuthoringScope(canvas(), "loose")).toBeNull();
  });
});

describe("selectsCardDirectly", () => {
  it("lets the camera's 2D card bypass the container, but not its 3D pick", () => {
    expect(selectsCardDirectly(canvas(), "camera", "card")).toBe(true);
    expect(selectsCardDirectly(canvas(), "camera", "pick")).toBe(false);
    expect(selectsCardDirectly(canvas(), "model", "card")).toBe(false);
  });
});

describe("scopeSelectionPrecedence", () => {
  it("selects the container while it is not selected", () => {
    expect(scopeSelectionPrecedence({ canvas: canvas(), nodeId: "member", selected: [] })).toBe("group");
    expect(scopeSelectionPrecedence({ canvas: canvas(), nodeId: "model", selected: [] })).toBe("area");
  });

  it("lets the child through once the container is selected", () => {
    expect(scopeSelectionPrecedence({ canvas: canvas(), nodeId: "member", selected: ["group"] })).toBeNull();
    expect(scopeSelectionPrecedence({ canvas: canvas(), nodeId: "model", selected: ["area"] })).toBeNull();
  });

  it("keeps additive and already-selected children unchanged", () => {
    expect(scopeSelectionPrecedence({ canvas: canvas(), nodeId: "member", selected: [], additive: true })).toBeNull();
    expect(scopeSelectionPrecedence({ canvas: canvas(), nodeId: "member", selected: ["member"] })).toBeNull();
  });

  it("keeps the child direct when a sibling in the same container is already selected", () => {
    expect(scopeSelectionPrecedence({ canvas: canvas(), nodeId: "model2", selected: ["model"] })).toBeNull();
    expect(hasSelectedSiblingInScope(canvas(), ["model"], "area")).toBe(true);
    expect(hasSelectedSiblingInScope(canvas(), ["loose"], "area")).toBe(false);
  });
});
