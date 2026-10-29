import { createFilmSetGroupMarker, defaultInitialShotCamera } from "@woohaa3/contracts";
import { FILM_SET_LABEL } from "./identity.js";

export function createFilmSetNodeData() {
  return { title: FILM_SET_LABEL, filmSetGroup: createFilmSetGroupMarker({
    cameras: [{ id: "camera-default", ...defaultInitialShotCamera(null) }],
    clips: [{ id: "shot-default", name: "拍摄镜头", cameraId: "camera-default", duration: 0 }],
    activeClip: "shot-default"
  }) };
}
