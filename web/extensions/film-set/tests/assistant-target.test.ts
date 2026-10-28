import { describe, expect, it } from "vitest";
import { filmSetClipHash, staticShotCameraMotion, type FilmSetAnimationClip } from "@woohaa3/contracts";
import { resolveFilmSetAssistantTarget } from "../src/authoring/browser/assistant-target.js";

describe("film-set task target", () => {
  const clip: FilmSetAnimationClip = {
    id: "clip-1",
    name: "镜头一",
    kind: "static",
    timeline: { duration: 0, loop: false },
    initialCamera: { azimuth: 0, elevation: 0.5, distance: 5, aspect: "16:9", focusOffset: { x: 0, y: 0, z: 0 } },
    cameraMotion: staticShotCameraMotion(),
    bindings: []
  };
  const context: Parameters<typeof resolveFilmSetAssistantTarget>[0] = { tab: "camera", clip, selectedItemId: "object-a", selectedCameraId: "camera-a", cameras: [{ id: "camera-a", name: "Camera A", order: 0, azimuth: 0, elevation: 0, distance: 5, aspect: "16:9" }] };
  it("freezes the film-set clip instead of a separate camera target", () => {
    const target = resolveFilmSetAssistantTarget({ ...context, tab: "camera" });
    expect(target).toMatchObject({ mode: "film-set", clipId: "clip-1", selectedCameraId: null, itemId: null, blockedReason: null });
    expect(target.expectedContentHash).toBe(filmSetClipHash(clip));
  });
  it("rejects missing or stale selections without picking a replacement", () => {
    expect(resolveFilmSetAssistantTarget({ ...context, tab: "camera", selectedCameraId: "deleted" }).blockedReason).toBeTruthy();
    expect(resolveFilmSetAssistantTarget({ ...context, tab: "camera", selectedCameraId: null }).blockedReason).toBeTruthy();
    expect(resolveFilmSetAssistantTarget({ ...context, tab: "object" }).blockedReason).toBeTruthy();
  });
  it("permits an empty camera collection without inventing a selection", () => {
    expect(resolveFilmSetAssistantTarget({ ...context, tab: "camera", selectedCameraId: null, cameras: [] })).toMatchObject({ mode: "film-set", selectedCameraId: null, blockedReason: null });
  });
});
