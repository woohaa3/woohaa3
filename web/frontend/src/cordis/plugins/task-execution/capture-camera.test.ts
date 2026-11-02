import { describe, expect, it } from "vitest";
import { createEmptyWoohaa3ServerCanvas, type CanvasTaskCatalogModel } from "@woohaa3/contracts";
import { modelAcceptsWorldCaptureReference, resolveDefaultCaptureCameraId } from "./capture-camera.js";

function cameraCamera(id: string, bound?: string) {
  return {
    kind: "world-camera",
    version: "shared-world-v1",
    cameraId: id,
    settingsVersion: `${id}-v1`,
    position: { u: 0, v: 0, h: 1 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    ...(bound ? { boundInstanceId: bound } : {})
  };
}

function canvasWith(cameras: Array<{ nodeId: string; cameraId: string; bound?: string }>) {
  const canvas = createEmptyWoohaa3ServerCanvas("canvas-1", "2026-01-01T00:00:00Z");
  canvas.document.nodes.push(...cameras.map(({ nodeId }) => ({ id: nodeId, type: "world-camera", position: { x: 0, y: 0 } })));
  for (const camera of cameras) {
    canvas.nodeData[camera.nodeId] = { worldCamera: cameraCamera(camera.cameraId, camera.bound) } as never;
  }
  return canvas;
}

describe("T10 generation entry camera resolution", () => {
  it("uses only an unbound world camera and never substitutes a bound one", () => {
    expect(resolveDefaultCaptureCameraId(canvasWith([
      { nodeId: "c1", cameraId: "bound", bound: "instance-1" },
      { nodeId: "c2", cameraId: "world" }
    ]))).toBe("world");
    expect(resolveDefaultCaptureCameraId(canvasWith([
      { nodeId: "c1", cameraId: "only", bound: "instance-1" }
    ]))).toBeUndefined();
    expect(resolveDefaultCaptureCameraId(canvasWith([{ nodeId: "card", cameraId: "" } as never]))).toBeUndefined();
  });

  it("only opts in image models that declare a reference_image binding", () => {
    const base = { modelKey: "m", providerId: "p", providerModelId: "m", title: "M", inputSchema: {}, defaultInput: {}, taskTimeoutMs: 1 } as const;
    const imageModel = {
      ...base,
      modelType: "image",
      interaction: { id: "generic-model", version: 1 },
      bindings: [{ field: "refs", semantic: "reference-image", roles: ["reference_image"], mediaKinds: ["image"], mediaTypes: ["image/png"], maxItems: 1, valueFormat: "url" }]
    } as unknown as CanvasTaskCatalogModel;
    const textModel = {
      ...base,
      modelType: "video",
      interaction: { id: "generic-model", version: 1 },
      bindings: imageModel.bindings
    } as unknown as CanvasTaskCatalogModel;
    expect(modelAcceptsWorldCaptureReference(imageModel)).toBe(true);
    expect(modelAcceptsWorldCaptureReference(textModel)).toBe(false);
    expect(modelAcceptsWorldCaptureReference({ ...imageModel, bindings: [] })).toBe(false);
  });
});
