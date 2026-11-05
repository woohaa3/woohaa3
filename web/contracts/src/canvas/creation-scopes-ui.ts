import { canvasPointToWorld } from "./model-focus/canvas-projection.js";
import { rendererToWorldPosition, SHARED_WORLD_VERSION, type GroundPoint } from "./shared-world.js";

/** Project a canvas point onto the same h=0 plane used by legacy conversion. */
export function canvasPointToGround(point: { x: number; y: number }): GroundPoint {
  const origin = canvasPointToWorld(point.x, point.y, 0);
  const direction = canvasPointToWorld(0, 0, 1);
  const projected = canvasPointToWorld(point.x, point.y, -origin[1] / direction[1]);
  const world = rendererToWorldPosition([projected[0], 0, projected[2]]);
  return { u: world.u, v: world.v };
}

export function newWorldInstance(instanceId: string, point: { x: number; y: number }) {
  return { kind: "world-instance" as const, version: SHARED_WORLD_VERSION, instanceId,
    transform: { version: SHARED_WORLD_VERSION, position: { ...canvasPointToGround(point), h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } };
}
