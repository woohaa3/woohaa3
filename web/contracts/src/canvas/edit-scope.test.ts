import { describe, expect, it } from "vitest";
import {
  canvasEditScopeCategoryOf,
  canvasEditScopeHidden,
  normalizeCanvasEditScope
} from "./edit-scope.js";

describe("canvas edit scope", () => {
  it("classifies valid shared-world payloads as 3D and legacy model cards as 2D", () => {
    const model = { type: "model3d" } as const;
    expect(canvasEditScopeCategoryOf(model, { sharedWorldInstance: {
      kind: "world-instance", version: "shared-world-v1", instanceId: "i",
      transform: { version: "shared-world-v1", position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 }
    } } as never)).toBe("3d");
    expect(canvasEditScopeCategoryOf(model, { sharedWorldInstance: { kind: "broken" } } as never)).toBe("2d");
    expect(canvasEditScopeCategoryOf({ type: "world-camera" }, { worldCamera: {
      kind: "world-camera", version: "shared-world-v1", cameraId: "camera",
      settingsVersion: "v1", position: { u: 0, v: 0, h: 1 }, rotation: [0, 0, 0, 1],
      projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 10 },
      captureMode: { kind: "static" }, aspect: { width: 16, height: 9 }, boundInstanceId: null
    } } as never)).toBe("2d");
  });

  it("normalizes malformed state and treats hidden as a category filter", () => {
    const value = normalizeCanvasEditScope({ "2d": "hidden", "3d": "bad" });
    expect(value).toEqual({ "2d": "hidden", "3d": "edit" });
    expect(canvasEditScopeHidden(value, "2d")).toBe(true);
    expect(canvasEditScopeHidden(value, "3d")).toBe(false);
  });
});
