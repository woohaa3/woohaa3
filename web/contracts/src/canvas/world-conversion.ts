import { canvasPointToWorld } from "./model-focus/canvas-projection.js";
import { modelLayoutAabbRelative } from "./model-focus/model-bounds.js";
import { CANVAS_UNITS_PER_METER, MODEL_CARD_GAP } from "./model-focus/types.js";
import type { Aabb } from "./model-transform.js";
import { rendererToWorldPosition, SHARED_WORLD_VERSION, type WorldTransform } from "./shared-world.js";

export type WorldConversionPrepareInput = { canvasId: string; nodeIds: string[] };
export type WorldConversionCommitInput = { canvasId: string; operationId: string; sourceVersion: string; targets: import("./shared-world.js").LegacyWorldConversionTarget[] };
export type WorldConversionReceipt = { targets: Array<import("./shared-world.js").LegacyWorldConversionTarget & { transform: WorldTransform }>; forward: import("./edit-plan.js").EditPlan["forward"]; inverse: import("./edit-plan.js").EditPlan["inverse"] };
export type WorldConversionCommitOutcome = { ok: true; canvasId: string; commandId: string; revision: number; duplicate: boolean; receipt: WorldConversionReceipt } | { ok: false; code: string; message: string };
export type WorldConversionPrepareOutcome =
  | { ok: true; canvasId: string; sourceVersion: string; nodes: Array<{ nodeId: string; nodeVersion: string; bounds: Aabb; transform: WorldTransform }> }
  | { ok: false; code: string; message: string };

/** Project the legacy card anchor onto the renderer ground plane. */
export function legacyModelGroundTransform(input: {
  x: number; y: number; width: number; height: number;
  bounds: Aabb; placement: { scale: number; yaw: number; offset: { x: number; y: number; z: number } };
}): WorldTransform {
  const { placement, bounds } = input;
  if (![input.x, input.y, input.width, input.height, placement.scale, placement.yaw,
    placement.offset.x, placement.offset.y, placement.offset.z, ...bounds.min, ...bounds.max].every(Number.isFinite) ||
    input.width <= 0 || input.height <= 0 || placement.scale <= 0 ||
    !Number.isFinite(placement.scale * CANVAS_UNITS_PER_METER) ||
    bounds.min.some((value, index) => value > bounds.max[index]!)) throw new Error("invalid conversion geometry");
  const relative = modelLayoutAabbRelative({ sceneVersion: "", ops: [], extent: 1, aabb: bounds, placement });
  if (!relative || ![...relative.min, ...relative.max].every(Number.isFinite)) throw new Error("invalid conversion geometry");
  const cx = input.x + input.width / 2 + placement.offset.x * CANVAS_UNITS_PER_METER;
  const cy = input.y + input.height + MODEL_CARD_GAP + Math.max(0, relative.max[1]) - placement.offset.y * CANVAS_UNITS_PER_METER;
  const origin = canvasPointToWorld(cx, cy, 0);
  const direction = canvasPointToWorld(0, 0, 1);
  const depth = -origin[1] / direction[1];
  const ground = canvasPointToWorld(cx, cy, depth);
  const halfYaw = placement.yaw * Math.PI / 360;
  if (![cx, cy, depth, ...ground, halfYaw].every(Number.isFinite)) throw new Error("invalid conversion geometry");
  return { version: SHARED_WORLD_VERSION, position: rendererToWorldPosition([ground[0], 0, ground[2]]),
    rotation: [0, 0, Math.sin(halfYaw), Math.cos(halfYaw)], scale: placement.scale };
}
