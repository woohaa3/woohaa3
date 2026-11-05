import { Quaternion, Vector3 } from "three";
import { rendererToWorldRotation, worldToRendererRotation, type WorldCameraData } from "@woohaa3/contracts";

const UP = new Vector3(0, 1, 0);
const LOOK_SENSITIVITY = 0.0025;
const MAX_PITCH = Math.PI / 2 - 0.05;

/** WASD follows the lens; Z/X moves along world height, independent of its pitch. */
export function moveCamera(camera: WorldCameraData, forward: number, right: number, seconds: number, fast = false, up = 0): WorldCameraData {
  if (!forward && !right && !up) return camera;
  const rotation = new Quaternion(...worldToRendererRotation(camera.rotation));
  const direction = new Vector3(0, 0, -1).applyQuaternion(rotation);
  const side = new Vector3(1, 0, 0).applyQuaternion(rotation);
  const step = direction.multiplyScalar(forward).addScaledVector(side, right).addScaledVector(UP, up).normalize()
    .multiplyScalar(Math.min(Math.max(seconds, 0), 0.05) * (fast ? 8 : 2));
  return { ...camera, position: { u: camera.position.u + step.x, v: camera.position.v - step.z, h: camera.position.h + step.y } };
}

/** World-up yaw + camera-right pitch; clamped by absolute pitch, so it cannot flip. */
export function lookCamera(camera: WorldCameraData, dx: number, dy: number): WorldCameraData {
  if (camera.projection.kind === "isometric" || (!dx && !dy) || !Number.isFinite(dx + dy)) return camera;
  const rotation = new Quaternion(...worldToRendererRotation(camera.rotation));
  const forward = new Vector3(0, 0, -1).applyQuaternion(rotation);
  const pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)));
  const nextPitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch - dy * LOOK_SENSITIVITY));
  rotation.premultiply(new Quaternion().setFromAxisAngle(UP, -dx * LOOK_SENSITIVITY));
  rotation.multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), nextPitch - pitch)).normalize();
  return { ...camera, rotation: rendererToWorldRotation(rotation.toArray()) };
}

export function turnIsometricCamera(camera: WorldCameraData, direction: -1 | 1): WorldCameraData {
  const rotation = new Quaternion(...worldToRendererRotation(camera.rotation));
  rotation.premultiply(new Quaternion().setFromAxisAngle(UP, direction * Math.PI / 2)).normalize();
  return { ...camera, rotation: rendererToWorldRotation(rotation.toArray()) };
}
