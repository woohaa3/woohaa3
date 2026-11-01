import { describe, expect, it } from "vitest";
import { worldToCanvasPoint } from "./model-focus/canvas-projection.js";
import { modelLayoutAabbRelative } from "./model-focus/model-bounds.js";
import { worldToRendererPosition } from "./shared-world.js";
import { legacyModelGroundTransform } from "./world-conversion.js";

describe("legacy model ground projection", () => {
  it("projects the real card anchor onto ground, retaining metric scale and degree yaw", () => {
    const bounds = { min: [-1, 0, -2] as [number, number, number], max: [1, 3, 2] as [number, number, number] };
    const placement = { scale: 2, yaw: 90, offset: { x: 1, y: 2, z: 999 } };
    const input = { x: 100, y: 200, width: 240, height: 160, bounds, placement };
    const transform = legacyModelGroundTransform(input);
    const projected = worldToCanvasPoint(worldToRendererPosition(transform.position));
    const relative = modelLayoutAabbRelative({ sceneVersion: "", ops: [], extent: 1, aabb: bounds, placement })!;
    expect(projected.x).toBeCloseTo(284);
    expect(projected.y).toBeCloseTo(360 + 40 + Math.max(0, relative.max[1]) - 128);
    expect(transform.position.h).toBe(0);
    expect(transform.scale).toBe(2);
    expect(transform.rotation[2]).toBeCloseTo(Math.SQRT1_2);
    expect(transform.rotation[3]).toBeCloseTo(Math.SQRT1_2);
    expect(legacyModelGroundTransform({ ...input, placement: { ...placement, offset: { ...placement.offset, z: -10 } } })).toEqual(transform);
  });

  it("rejects invalid geometry", () => {
    expect(() => legacyModelGroundTransform({ x: 0, y: 0, width: -1, height: 1,
      bounds: { min: [0, 0, 0], max: [1, 1, 1] }, placement: { scale: 1, yaw: 0, offset: { x: 0, y: 0, z: 0 } } })).toThrow();
  });
});
