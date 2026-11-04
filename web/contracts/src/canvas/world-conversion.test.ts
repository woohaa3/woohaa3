import { describe, expect, it } from "vitest";
import { worldToCanvasPoint } from "./model-focus/canvas-projection.js";
import { decodeWorldTransform } from "./shared-world-codec.js";
import { worldToRendererPosition, worldToRendererRotation } from "./shared-world.js";
import { legacyModelGroundTransform } from "./world-conversion.js";

const fixtures = [
  { x: 100, y: 200, width: 240, height: 160, bounds: { min: [-1, 0, -2] as [number, number, number], max: [1, 3, 2] as [number, number, number] }, placement: { scale: 2, yaw: 90, offset: { x: 1, y: 2, z: 999 } }, anchor: [284, 0] },
  { x: -400, y: -300, width: 80, height: 120, bounds: { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] }, placement: { scale: 0.5, yaw: -45, offset: { x: -2, y: -1, z: -20 } }, anchor: [-488, -76] }
];

describe("legacy model ground projection", () => {
  it.each(fixtures)("preserves the Bevy anchor, scale and yaw for $x, $y", (input) => {
    const before = structuredClone(input);
    const transform = legacyModelGroundTransform(input);
    const renderer = worldToRendererPosition(transform.position);
    const projected = worldToCanvasPoint([...renderer]);
    // For the first box, yaw 90 maps z to x and -x to z before the view rotation.
    const top = input.x === 100 ? 128 * (3 * Math.SQRT1_2 / 2 + 3 * Math.sqrt(3) / 2) : 0;
    const anchorY = input.x === 100 ? 272 + top : input.anchor[1]!;
    expect(projected.x).toBeCloseTo(input.anchor[0]!, 9);
    expect(projected.y).toBeCloseTo(anchorY, 9);
    expect(transform.position.h).toBe(0);
    expect(transform.scale).toBe(input.placement.scale);
    const rotation = worldToRendererRotation(transform.rotation);
    expect(rotation[1]).toBeCloseTo(Math.sin(input.placement.yaw * Math.PI / 360), 12);
    expect(rotation[3]).toBeCloseTo(Math.cos(input.placement.yaw * Math.PI / 360), 12);
    expect(decodeWorldTransform(transform).ok).toBe(true);
    expect(legacyModelGroundTransform({ ...input, placement: { ...input.placement, offset: { ...input.placement.offset, z: -12345 } } })).toEqual(transform);
    expect(input).toEqual(before);
  });

  it("rejects invalid or overflowing geometry without changing the input", () => {
    const base = fixtures[0]!;
    const invalid = [
      { ...base, width: 0 }, { ...base, height: -1 }, { ...base, x: Infinity },
      { ...base, placement: { ...base.placement, scale: 0 } },
      { ...base, placement: { ...base.placement, yaw: NaN } },
      { ...base, placement: { ...base.placement, offset: { ...base.placement.offset, z: Infinity } } },
      { ...base, bounds: { min: [2, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] } },
      { ...base, bounds: { min: [0, 0, 0] as [number, number, number], max: [Infinity, 1, 1] as [number, number, number] } },
      { ...base, x: Number.MAX_VALUE, width: Number.MAX_VALUE },
      { ...base, placement: { ...base.placement, scale: Number.MAX_VALUE } }
    ];
    for (const input of invalid) {
      const before = structuredClone(input);
      expect(() => legacyModelGroundTransform(input)).toThrow("invalid conversion geometry");
      expect(input).toEqual(before);
    }
  });
});
