import type { CompositeAssetAdapter } from "@woohaa3/frontend/extension-api";
import type { FilmSetHostContext } from "../../state/browser/host-ports.js";

export function sceneCameraWriter(submit: FilmSetHostContext["canvasSession"]["submitCommands"]): NonNullable<CompositeAssetAdapter["writeCameras"]> {
  return (nodeId, cameras) => {
        if (cameras.length !== 1 || cameras[0]?.id !== "scene-camera") return false;
        const camera = cameras[0];
        if (!camera) return false;
        const { azimuth, elevation, distance, aspect, focusOffset } = camera;
        return submit([{ type: "nodeData.patch", nodeId, value: { sceneCamera: { azimuth, elevation, distance, aspect, ...(focusOffset ? { focusOffset } : {}) } } as never }], `film-set-camera-${crypto.randomUUID()}`).ok;
      };
}
