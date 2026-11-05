import { expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { createDefaultWorldCameraData, decodeWorldCamera, worldToRendererRotation } from "@woohaa3/contracts";
import { cameraAngles, composeCamera, defaultOrbitCenter, withCameraAngle } from "./composition-motion.js";

const camera = createDefaultWorldCameraData("camera", "v1", { u: 0, v: 0 });
const center = defaultOrbitCenter(camera);
const position = (c: typeof camera) => new Vector3(c.position.u, c.position.h, -c.position.v);
const pivot = new Vector3(center.u, center.h, -center.v);
const forward = (c: typeof camera) => new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...worldToRendererRotation(c.rotation)));

it("turns in place and dollies along the lens without changing FoV", () => {
  const turned = composeCamera(camera, "turn", 80, 20, 600, center);
  expect(turned.position).toEqual(camera.position);
  expect(turned.rotation).not.toEqual(camera.rotation);
  const moved = composeCamera(camera, "dolly", 0, -60, 600, center);
  expect(moved.projection).toBe(camera.projection);
  expect(moved.rotation).toBe(camera.rotation);
  const delta = position(moved).sub(position(camera));
  expect(delta.clone().normalize().distanceTo(forward(camera))).toBeLessThan(1e-8);
  expect(position(moved).distanceTo(pivot)).toBeLessThan(position(camera).distanceTo(pivot));
});

it("pans in the camera plane and preserves orientation and projection", () => {
  const moved = composeCamera(camera, "pan", 40, 30, 600, center);
  expect(position(moved).sub(position(camera)).dot(forward(camera))).toBeCloseTo(0);
  expect(moved.rotation).toBe(camera.rotation);
  expect(moved.projection).toBe(camera.projection);
});

it("orbits without changing radius or losing the chosen target", () => {
  const moved = composeCamera(camera, "orbit", 140, -30, 600, center);
  expect(position(moved).distanceTo(pivot)).toBeCloseTo(position(camera).distanceTo(pivot));
  expect(forward(moved).distanceTo(pivot.clone().sub(position(moved)).normalize())).toBeLessThan(1e-8);
  expect(moved.projection).toBe(camera.projection);
  expect(decodeWorldCamera(moved).ok).toBe(true);
});

it("edits yaw/pitch/roll precisely and clamps pole crossings", () => {
  const tilted = withCameraAngle(withCameraAngle(camera, "roll", 15), "pitch", 120);
  expect(cameraAngles(tilted).pitch).toBeCloseTo(89.9);
  expect(cameraAngles(tilted).roll).toBeCloseTo(15);
  expect(tilted.position).toBe(camera.position);
  expect(decodeWorldCamera(tilted).ok).toBe(true);
  expect(composeCamera(camera, "pan", NaN, 0, 600, center)).toBe(camera);
});
