import type { GroundAabb, GroundPoint, WorldRotation, WorldTransform } from "./shared-world.js";

/** Clockwise as seen from above the u/v ground plane. Integer turns avoid positional drift. */
export function rotateGroundQuarterTurns(point: GroundPoint, pivot: GroundPoint, turns = 1): GroundPoint {
  const u = point.u - pivot.u, v = point.v - pivot.v;
  switch ((turns % 4 + 4) % 4) {
    case 1: return { u: pivot.u + v, v: pivot.v - u };
    case 2: return { u: pivot.u - u, v: pivot.v - v };
    case 3: return { u: pivot.u - v, v: pivot.v + u };
    default: return { ...point };
  }
}

export function rotateWorldQuarterTurn(rotation: WorldRotation): WorldRotation {
  const [u, v, h, w] = rotation, s = Math.SQRT1_2;
  const next = [(u + v) * s, (v - u) * s, (h - w) * s, (w + h) * s];
  const norm = Math.hypot(...next);
  return next.map(value => value / norm) as unknown as WorldRotation;
}

export function rotateWorldTransformQuarterTurn(transform: WorldTransform, pivot: GroundPoint): WorldTransform {
  return { ...transform, position: { ...transform.position, ...rotateGroundQuarterTurns(transform.position, pivot) },
    rotation: rotateWorldQuarterTurn(transform.rotation) };
}

export function rotateGroundBoundsQuarterTurn(bounds: GroundAabb): GroundAabb {
  const u = (bounds.min.u + bounds.max.u) / 2, v = (bounds.min.v + bounds.max.v) / 2;
  const halfU = (bounds.max.u - bounds.min.u) / 2, halfV = (bounds.max.v - bounds.min.v) / 2;
  return { min: { u: u - halfV, v: v - halfU }, max: { u: u + halfV, v: v + halfU } };
}
