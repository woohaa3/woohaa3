import { Euler, Quaternion, Vector3 } from "three";
import { rendererToWorldRotation, worldToRendererRotation, WORLD_CAMERA_DEFAULT_DISTANCE_METERS, type WorldCameraData, type WorldPoint } from "@woohaa3/contracts";
import { lookCamera } from "./flight-motion.js";

export type CompositionTool = "turn" | "pan" | "dolly" | "orbit";
const positionOf = (camera: WorldCameraData) => new Vector3(camera.position.u, camera.position.h, -camera.position.v);
const worldPoint = (point: Vector3): WorldPoint => ({ u: point.x, v: -point.z, h: point.y });
const rotationOf = (camera: WorldCameraData) => new Quaternion(...worldToRendererRotation(camera.rotation));

/** A stable local pivot on the viewing axis; choosing it never changes the camera. */
export function defaultOrbitCenter(camera: WorldCameraData): WorldPoint {
  const direction = new Vector3(0, 0, -1).applyQuaternion(rotationOf(camera));
  const ground = -camera.position.h / direction.y;
  const distance = Number.isFinite(ground) && ground > 0 && ground < 500 ? ground : WORLD_CAMERA_DEFAULT_DISTANCE_METERS;
  return worldPoint(positionOf(camera).addScaledVector(direction, distance));
}

export function composeCamera(camera: WorldCameraData, tool: CompositionTool, dx: number, dy: number, height: number, center: WorldPoint): WorldCameraData {
  if (!Number.isFinite(dx + dy + height) || (!dx && !dy)) return camera;
  if (tool === "turn") return lookCamera(camera, dx, dy);
  const position = positionOf(camera);
  const rotation = rotationOf(camera);
  const pivot = new Vector3(center.u, center.h, -center.v);
  const distance = Math.max(0.1, position.distanceTo(pivot));
  if (tool === "orbit") {
    const next = lookCamera(camera, dx, dy);
    const delta = rotationOf(next).multiply(rotation.clone().invert());
    return { ...next, position: worldPoint(position.sub(pivot).applyQuaternion(delta).add(pivot)) };
  }
  const fov = camera.projection.kind === "perspective" ? camera.projection.verticalFovRadians : Math.PI / 3;
  const metersPerPixel = 2 * distance * Math.tan(fov / 2) / Math.max(1, height);
  if (tool === "pan") {
    position.add(new Vector3(-dx * metersPerPixel, dy * metersPerPixel, 0).applyQuaternion(rotation));
  } else {
    // An exponential drag keeps a nearby pivot in front of the lens, with no FoV change.
    const step = distance * (1 - Math.exp(Math.max(-2, Math.min(2, dy / 240))));
    position.add(new Vector3(0, 0, -step).applyQuaternion(rotation));
  }
  return { ...camera, position: worldPoint(position) };
}

export function cameraAngles(camera: WorldCameraData) {
  const euler = new Euler().setFromQuaternion(rotationOf(camera), "YXZ");
  return { yaw: euler.y * 180 / Math.PI, pitch: euler.x * 180 / Math.PI, roll: euler.z * 180 / Math.PI };
}

export function withCameraAngle(camera: WorldCameraData, axis: "yaw" | "pitch" | "roll", degrees: number): WorldCameraData {
  if (!Number.isFinite(degrees)) return camera;
  const angles = cameraAngles(camera);
  angles[axis] = axis === "pitch" ? Math.max(-89.9, Math.min(89.9, degrees)) : degrees % 360;
  const rotation = new Quaternion().setFromEuler(new Euler(angles.pitch * Math.PI / 180, angles.yaw * Math.PI / 180, angles.roll * Math.PI / 180, "YXZ"));
  return { ...camera, rotation: rendererToWorldRotation(rotation.toArray()) };
}
