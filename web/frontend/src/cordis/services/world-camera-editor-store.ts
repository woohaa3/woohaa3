import { Quaternion, Vector3 } from "three";
import { decodeWorldCamera, WORLD_CAMERA_DEFAULT_DISTANCE_METERS, worldCameraSettingsEqual, worldCameraUiSettingsOf, worldToRendererRotation, withWorldCameraProjectionKind, withWorldCameraFraming, type WorldCameraData } from "@woohaa3/contracts";

export type WorldCameraEditSession = {
  canvasId: string;
  nodeId: string;
  source: WorldCameraData;
  draft: WorldCameraData;
  phase: "editing" | "confirm" | "saving";
  error: string | null;
  /** Editor-only presentation; never included in saved camera settings. */
  showHelpers: boolean;
};

/** Page-local camera draft. Never writes the canvas; only explicit save persists it. */
export function createWorldCameraEditorStore() {
  let value: WorldCameraEditSession | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: WorldCameraEditSession | null) => {
    value = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    begin(canvasId: string, nodeId: string, camera: WorldCameraData) {
      if (value) return false;
      publish({ canvasId, nodeId, source: camera, draft: perspectiveDraft(camera), phase: "editing", error: null, showHelpers: true });
      return true;
    },
    update(draft: WorldCameraData) {
      if (!value || value.phase !== "editing" || draft.cameraId !== value.source.cameraId || !decodeWorldCamera(draft).ok) return;
      publish({ ...value, draft: perspectiveDraft(draft), error: null });
    },
    changed() {
      return !!value && !worldCameraSettingsEqual(worldCameraUiSettingsOf(value.source), worldCameraUiSettingsOf(value.draft));
    },
    patch(patch: Partial<Pick<WorldCameraEditSession, "phase" | "error" | "showHelpers">>) {
      if (value) publish({ ...value, ...patch });
    },
    close() { publish(null); }
  };
}

/** Keep the pose and match framing at the ground target when starting a free flight. */
function perspectiveDraft(camera: WorldCameraData): WorldCameraData {
  if (camera.projection.kind === "perspective") return camera;
  const forward = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...worldToRendererRotation(camera.rotation)));
  const groundDistance = -camera.position.h / forward.y;
  const distance = Number.isFinite(groundDistance) && groundDistance > 0
    ? groundDistance : WORLD_CAMERA_DEFAULT_DISTANCE_METERS;
  const fovDegrees = 2 * Math.atan(camera.projection.verticalSizeMeters / (2 * distance)) * 180 / Math.PI;
  return { ...camera, ...withWorldCameraFraming(
    withWorldCameraProjectionKind(worldCameraUiSettingsOf(camera), "perspective"), fovDegrees
  ) };
}

export const worldCameraEditorStore = createWorldCameraEditorStore();
