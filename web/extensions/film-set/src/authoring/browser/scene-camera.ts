import type { CompositeAssetAdapter } from "@woohaa3/frontend/extension-api";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";
import { decodeFilmSetNodeData, filmSetAnimationsOf, filmSetClipPrecondition } from "@woohaa3/contracts";

/** The selected shot is the camera source for both the editor and its canvas card. */
export function filmSetEditorCameras(data: unknown, selectedClipId: string | null) {
  const decoded = decodeFilmSetNodeData(data);
  if (!decoded.ok) return [];
  const collection = filmSetAnimationsOf(decoded.value);
  const clip = collection.clips.find(entry => entry.id === selectedClipId)
    ?? collection.clips.find(entry => entry.id === collection.defaultClipId)
    ?? collection.clips[0];
  const camera = clip?.initialCamera ?? decoded.value.sceneCamera;
  return [{ ...camera, id: clip ? `clip:${clip.id}` : "scene-camera", name: clip?.name ?? "场景镜头", order: 0, elevation: camera.elevation ?? 0, aspect: camera.aspect ?? "16:9" }];
}

export function sceneCameraWriter(
  submit: FilmSetHostContext["canvasSession"]["submitCommands"],
  readData: (nodeId: string) => unknown
): NonNullable<CompositeAssetAdapter["writeCameras"]> {
  return (nodeId, cameras) => {
    if (cameras.length !== 1) return false;
    const camera = cameras[0];
    const decoded = decodeFilmSetNodeData(readData(nodeId));
    if (!camera || !decoded.ok) return false;
    const collection = filmSetAnimationsOf(decoded.value);
    const clip = collection.clips.find(entry => `clip:${entry.id}` === camera.id);
    // A removed/switched shot must never fall back to overwriting another shot.
    if (!clip && (camera.id !== "scene-camera" || collection.clips.length > 0)) return false;
    const { azimuth, elevation, distance, aspect } = camera;
    const initialCamera = { azimuth, elevation, distance, aspect, focusOffset: camera.focusOffset ?? { x: 0, y: 0, z: 0 } };
    return submit([
      { type: "nodeData.patch", nodeId, value: { sceneCamera: initialCamera } as never },
      ...(clip ? [{ type: "filmSet.clipPatch" as const, nodeId, clipId: clip.id,
        op: { kind: "camera" as const, initialCamera },
        expectedHash: filmSetClipPrecondition(collection, clip.id, { kind: "camera", initialCamera }) }] : [])
    ], `film-set-camera-${crypto.randomUUID()}`).ok;
  };
}
