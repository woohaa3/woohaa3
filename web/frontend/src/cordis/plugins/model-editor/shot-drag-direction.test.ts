import { expect, it } from "vitest";
import { makeFocusProjector, type Vec3 } from "@woohaa3/contracts";
import { shotDragDirection } from "./shot-drag-direction.js";

it("观察相机与 rig 在前后不同方位时，向右拖都使相机本体在屏幕上向右移动", () => {
  for (const yaw of [0, 0.8, Math.PI, -1.2]) {
    const project = makeFocusProjector({
      camera: { target: [0, 0, 0], yaw, pitch: -0.4, distance: 30, flySpeed: 6 },
      surface: { width: 1000, height: 800 }, fov: 0.87
    });
    for (const azimuth of [0, 0.5, 2, Math.PI, 4.2]) {
      const position = (angle: number): Vec3 => [Math.sin(angle) * 5, 5, Math.cos(angle) * 5];
      const from = position(azimuth);
      const sign = shotDragDirection([0, 0, 0], from, project);
      expect(project(position(azimuth + sign * 0.001))!.x).toBeGreaterThan(project(from)!.x);
    }
  }
});
