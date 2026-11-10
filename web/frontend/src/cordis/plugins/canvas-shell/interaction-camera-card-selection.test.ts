import { afterEach, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type CanvasNodeData } from "@woohaa3/contracts";
import { installInteractionController } from "./interaction-controller.js";
import { woohaa3CanvasStore } from "../../services/canvas-state/index.js";
import { nodeSelectionStore } from "../../services/selection-store.js";
import { getSession, harness, installSharedSession, runtimeCapturing } from "./test-support/controller-harness.js";

installSharedSession();
afterEach(() => nodeSelectionStore.reset());

it("selects a camera directly when its 2D card is clicked inside a director area", () => {
  const source = createEmptyWoohaa3ServerCanvas("c1");
  source.document.nodes.push(
    { id: "area", type: "scene-area", position: { x: 0, y: 0 } },
    { id: "camera", type: "world-camera", position: { x: 100, y: 100 }, width: 180, height: 120 }
  );
  source.nodeData.area = {
    sceneArea: {
      kind: "scene-area",
      version: "shared-world-v1",
      areaId: "a1",
      scopeVersion: "s1",
      bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
    }
  } as unknown as CanvasNodeData;
  source.nodeData.camera = {
    worldCamera: {
      kind: "world-camera",
      version: "shared-world-v1",
      cameraId: "cam-1",
      settingsVersion: "cam-1-v1",
      position: { u: 2, v: 2, h: 1.5 },
      rotation: [0, 0, 0, 1],
      projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
      captureMode: { kind: "static" },
      aspect: { width: 16, height: 9 },
      boundInstanceId: null
    }
  } as unknown as CanvasNodeData;
  woohaa3CanvasStore.getState().applyRemoteCanvas(source);

  const dom = harness();
  const { runtime } = runtimeCapturing({ pointHit: () => ({ kind: "node", nodeId: "camera" }) });
  const controller = installInteractionController({
    canvas: dom.canvas,
    getRuntime: () => runtime,
    getSession: () => getSession() as never,
    target: dom.target as never,
    isWritable: () => true
  });
  controller.flush();

  dom.fire("pointerdown", { clientX: 150, clientY: 150 });
  dom.fire("pointerup", { clientX: 150, clientY: 150 });
  expect(nodeSelectionStore.getSnapshot().nodeIds).toEqual(["camera"]);
  controller.dispose();
});
