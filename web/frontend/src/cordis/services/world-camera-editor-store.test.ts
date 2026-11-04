import { describe, expect, it } from "vitest";
import { createDefaultWorldCameraData, defaultWorldCameraProjection } from "@woohaa3/contracts";
import { createWorldCameraEditorStore } from "./world-camera-editor-store.js";

describe("camera editing draft", () => {
  it("opens legacy orthographic cameras as perspective drafts without changing the saved camera", () => {
    const original = { ...createDefaultWorldCameraData("c", "v1", { u: 1, v: 2 }), projection: defaultWorldCameraProjection("isometric") };
    const store = createWorldCameraEditorStore();
    store.begin("canvas", "node", original);
    const session = store.getSnapshot()!;
    expect(session.source).toBe(original);
    expect(session.draft.projection.kind).toBe("perspective");
    expect(session.draft.position).toEqual(original.position);
    expect(session.draft.rotation).toEqual(original.rotation);
    expect(store.changed()).toBe(true);
    store.close();
    expect(original.projection.kind).toBe("isometric");
  });
  it("keeps edits isolated until explicitly saved and can discard them", () => {
    const camera = createDefaultWorldCameraData("c", "v1", { u: 1, v: 2 });
    const store = createWorldCameraEditorStore();
    expect(store.begin("canvas", "node", camera)).toBe(true);
    expect(store.changed()).toBe(false);
    store.update({ ...camera, position: { ...camera.position, u: 5 } });
    expect(store.changed()).toBe(true);
    expect(camera.position.u).toBe(1);
    expect(store.begin("other", "other-node", camera)).toBe(false);
    store.patch({ phase: "confirm" });
    store.update(camera);
    expect(store.getSnapshot()?.draft.position.u).toBe(5);
    store.patch({ phase: "editing" });
    store.update(camera);
    expect(store.changed()).toBe(false);
    store.close();
    expect(store.getSnapshot()).toBeNull();
  });

  it("rejects malformed drafts and another camera identity", () => {
    const camera = createDefaultWorldCameraData("c", "v1", { u: 1, v: 2 });
    const store = createWorldCameraEditorStore();
    store.begin("canvas", "node", camera);
    store.update({ ...camera, position: { ...camera.position, u: NaN } });
    store.update({ ...camera, cameraId: "other" });
    expect(store.getSnapshot()?.draft).toBe(camera);
  });
});
