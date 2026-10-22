import { describe, expect, it } from "vitest";
import { resolveFilmSetAssistantTarget } from "../src/authoring/browser/assistant-target.js";

describe("film-set task target", () => {
  const context: Parameters<typeof resolveFilmSetAssistantTarget>[0] = { tab: "camera", clip: undefined, selectedItemId: "object-a", selectedCameraId: "camera-a", cameras: [{ id: "camera-a", name: "Camera A", order: 0, azimuth: 0, elevation: 0, distance: 5, aspect: "16:9" }] };
  it("captures camera identity even when the container is a film-set without a clip", () => {
    expect(resolveFilmSetAssistantTarget({ ...context, tab: "camera" })).toMatchObject({ mode: "camera", selectedCameraId: "camera-a", itemId: null, blockedReason: null });
  });
  it("rejects missing or stale selections without picking a replacement", () => {
    expect(resolveFilmSetAssistantTarget({ ...context, tab: "camera", selectedCameraId: "deleted" }).blockedReason).toBeTruthy();
    expect(resolveFilmSetAssistantTarget({ ...context, tab: "camera", selectedCameraId: null }).blockedReason).toBeTruthy();
    expect(resolveFilmSetAssistantTarget({ ...context, tab: "object" }).blockedReason).toBeTruthy();
  });
  it("permits the existing explicit camera creation intent only for an empty collection", () => {
    expect(resolveFilmSetAssistantTarget({ ...context, tab: "camera", selectedCameraId: null, cameras: [] })).toMatchObject({ mode: "camera", selectedCameraId: null, blockedReason: null });
  });
});
