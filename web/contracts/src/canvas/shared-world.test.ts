import { describe, expect, it } from "vitest";
import fixture from "../../../../bevy/tests/fixtures/shared-world/coordinates.json";
import { rendererToWorldPosition, rendererToWorldRotation, worldToRendererPosition, worldToRendererRotation, type RendererRotation, type RendererVector, type WorldRotation } from "./shared-world.js";

// Asset points are already Y-up. Rotate in renderer space after scale, then translate.
function rotate(v: number[], q: number[]): number[] {
  const [x, y, z, w] = q as [number, number, number, number];
  const [a, b, c] = v as [number, number, number];
  const t = [2 * (y * c - z * b), 2 * (z * a - x * c), 2 * (x * b - y * a)];
  return [a + w * t[0]! + y * t[2]! - z * t[1]!, b + w * t[1]! + z * t[0]! - x * t[2]!, c + w * t[2]! + x * t[1]! - y * t[0]!];
}

describe("shared-world coordinates", () => {
  it("uses the same positions and quaternion basis as Rust", () => {
    for (const c of fixture.cases) {
      const p = { u: c.world[0]!, v: c.world[1]!, h: c.world[2]! };
      worldToRendererPosition(p).forEach((n, i) => expect(n).toBeCloseTo(c.renderer[i]!, 12));
      const back = rendererToWorldPosition(c.renderer as unknown as RendererVector);
      [back.u, back.v, back.h].forEach((n, i) => expect(n).toBeCloseTo(c.world[i]!, 12));
      worldToRendererRotation(c.rotation as unknown as WorldRotation).forEach((n, i) => expect(n).toBeCloseTo(c.renderer_rotation[i]!, 12));
      rendererToWorldRotation(c.renderer_rotation as unknown as RendererRotation).forEach((n, i) => expect(n).toBeCloseTo(c.rotation[i]!, 12));
      const rotated = rotate(c.asset_point.map(n => n * c.scale * 64), c.renderer_rotation);
      rotated.forEach((n, i) => expect(n + c.renderer[i]!).toBeCloseTo(c.renderer_point[i]!, 12));
      const relative = c.renderer_point.map((n, i) => (n - c.renderer[i]!) / (c.scale * 64));
      const inverse = c.renderer_rotation.map((n, i) => i === 3 ? n : -n);
      rotate(relative, inverse).forEach((n, i) => expect(n).toBeCloseTo(c.asset_point[i]!, 12));
    }
  });
});
