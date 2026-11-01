import { canvasPointToWorld } from "./model-focus/canvas-projection.js";
import { modelLayoutAabbRelative } from "./model-focus/model-bounds.js";
import type { Aabb } from "./model-transform.js";
import { rendererToWorldPosition, SHARED_WORLD_VERSION, type WorldTransform } from "./shared-world.js";

/** Project the legacy card anchor onto the renderer ground plane. */
export function legacyModelGroundTransform(input: {
  x: number; y: number; width: number; height: number;
  bounds: Aabb; placement: { scale: number; yaw: number; offset: { x: number; y: number; z: number } };
}): WorldTransform {
  const { placement, bounds } = input;
  const relative = modelLayoutAabbRelative({ sceneVersion: "", ops: [], extent: 1, aabb: bounds, placement });
  if (!relative || ![input.x, input.y, input.width, input.height, placement.scale, placement.yaw,
    placement.offset.x, placement.offset.y, ...bounds.min, ...bounds.max].every(Number.isFinite) ||
    input.width <= 0 || input.height <= 0 || placement.scale <= 0 ||
    bounds.min.some((value, index) => value > bounds.max[index]!)) throw new Error("invalid conversion geometry");
  const cx = input.x + input.width / 2 + placement.offset.x * 64;
  const cy = input.y + input.height + 40 + Math.max(0, relative.max[1]) - placement.offset.y * 64;
  const origin = canvasPointToWorld(cx, cy, 0);
  const direction = canvasPointToWorld(0, 0, 1);
  const depth = -origin[1] / direction[1];
  const ground = canvasPointToWorld(cx, cy, depth);
  const halfYaw = placement.yaw * Math.PI / 360;
  return { version: SHARED_WORLD_VERSION, position: rendererToWorldPosition([ground[0], 0, ground[2]]),
    rotation: [0, 0, Math.sin(halfYaw), Math.cos(halfYaw)], scale: placement.scale };
}
