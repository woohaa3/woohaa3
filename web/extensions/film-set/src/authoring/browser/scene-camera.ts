import type { CompositeAssetAdapter } from "@woohaa3/frontend/extension-api";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";
import { MODEL_CAMERA_ASPECTS, type ModelCameraAspect, readFilmSetGroupMarker, decodeFilmSetNodeData, type FilmSetNodeData, filmSetAnimationsOf, filmSetClipPrecondition } from "@woohaa3/contracts";

/** The selected shot is the camera source for both the editor and its canvas card. */
export function filmSetEditorCameras(data: unknown, selectedClipId: string | null) {
  const marker = readFilmSetGroupMarker(data);
  if (marker) {
    const clip = selectedClipId === null ? marker.clips?.find(clip => clip.id === marker.activeClip) ?? marker.clips?.[0] : marker.clips?.find(clip => clip.id === selectedClipId);
    if (selectedClipId !== null && !clip) return [];
    const camera = marker.cameras?.find(camera => camera.id === clip?.cameraId) ?? marker.cameras?.[0];
    return camera ? [{ ...camera, id: clip ? `clip:${clip.id}` : "scene-camera", name: clip?.name ?? "场景镜头", order: 0, aspect: (MODEL_CAMERA_ASPECTS as readonly string[]).includes(camera.aspect ?? "") ? camera.aspect as ModelCameraAspect : "16:9" as const }] : [];
  }
  const decoded = decodeFilmSetNodeData(data);
  if (!decoded.ok) return [];
  const collection = filmSetAnimationsOf(decoded.value);
  const clip = collection.clips.find(entry => entry.id === selectedClipId)
    ?? collection.clips.find(entry => entry.id === collection.defaultClipId)
    ?? collection.clips[0];
  const camera = clip?.initialCamera ?? decoded.value.sceneCamera;
  return [{ ...camera, id: clip ? `clip:${clip.id}` : "scene-camera", name: clip?.name ?? "场景镜头", order: 0, elevation: camera.elevation ?? 0, aspect: (MODEL_CAMERA_ASPECTS as readonly string[]).includes(camera.aspect ?? "") ? camera.aspect as ModelCameraAspect : "16:9" as const }];
}

export function sceneCameraWriter(
  submit: FilmSetHostContext["canvasSession"]["submitCommands"],
  readData: (nodeId: string) => unknown,
  readProjection?: (nodeId: string) => FilmSetNodeData | null,
  record?: FilmSetHostContext["canvasEdit"]["record"]
): NonNullable<CompositeAssetAdapter["writeCameras"]> {
  const write = (commands: Parameters<typeof submit>[0], commandId: string) => record
    ? record(commands, "修改拍摄镜头构图").then(result => result.ok)
    : submit(commands, commandId).ok;
  return (nodeId, cameras) => {
    if (cameras.length !== 1) return false;
    const camera = cameras[0];
    const marker = readFilmSetGroupMarker(readData(nodeId));
    if (!camera || !marker) return false;
    if (camera.id === "scene-camera" && !(marker.clips?.length)) {
      const existing = marker.cameras?.[0];
      if (!existing) return false;
      const { azimuth, elevation, distance, aspect, focusOffset } = camera;
      return write([{ type: "nodeData.patch", nodeId, value: { filmSetGroup: { ...marker, cameras: [{ ...existing, azimuth, elevation, distance, aspect, focusOffset: focusOffset ?? { x: 0, y: 0, z: 0 } }] } } as never }], `film-set-camera-${crypto.randomUUID()}`);
    }
    const projected = readProjection?.(nodeId);
    const decoded = projected ? { ok: true as const, value: projected } : decodeFilmSetNodeData(readData(nodeId));
    if (!camera || !decoded.ok) return false;
    const collection = filmSetAnimationsOf(decoded.value);
    const clip = collection.clips.find(entry => `clip:${entry.id}` === camera.id);
    // A removed/switched shot must never fall back to overwriting another shot.
    if (!clip && (camera.id !== "scene-camera" || collection.clips.length > 0)) return false;
    const { azimuth, elevation, distance, aspect } = camera;
    const initialCamera = { azimuth, elevation, distance, aspect, focusOffset: camera.focusOffset ?? { x: 0, y: 0, z: 0 } };
    return write([
      ...(!readFilmSetGroupMarker(readData(nodeId)) ? [{ type: "nodeData.patch" as const, nodeId, value: { sceneCamera: initialCamera } as never }] : []),
      ...(clip ? [{ type: "filmSet.clipPatch" as const, nodeId, clipId: clip.id,
        op: { kind: "camera" as const, initialCamera },
        expectedHash: filmSetClipPrecondition(collection, clip.id, { kind: "camera", initialCamera }) }] : [])
    ], `film-set-camera-${crypto.randomUUID()}`);
  };
}
