import { describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "three";
import { createDefaultWorldCameraData, decodeWorldCamera, worldToRendererRotation, withWorldCameraProjectionKind, worldCameraUiSettingsOf } from "@woohaa3/contracts";
import { lookCamera, moveCamera, turnIsometricCamera } from "./flight-motion.js";

const perspective = createDefaultWorldCameraData("camera", "v1", { u: 2, v: 3 });
const iso = { ...perspective, ...withWorldCameraProjectionKind(worldCameraUiSettingsOf(perspective), "isometric") };

describe("first-person camera movement", () => {
  it("moves forward and backward along the lens, including its pitch", () => {
    const forward = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...worldToRendererRotation(perspective.rotation)));
    const moved = moveCamera(perspective, 1, 0, 0.05);
    const step = new Vector3(moved.position.u - perspective.position.u, moved.position.h - perspective.position.h, -(moved.position.v - perspective.position.v));
    expect(step.distanceTo(forward.clone().multiplyScalar(0.1))).toBeLessThan(1e-8);
    const back = moveCamera(perspective, -1, 0, 0.05);
    expect(back.position.h - perspective.position.h).toBeCloseTo(-step.y);
    expect(perspective.position).toEqual(iso.position);
    expect(moved.rotation).toEqual(perspective.rotation);
  });

  it("normalizes diagonal speed and bounds a delayed frame", () => {
    const straight = moveCamera(perspective, 1, 0, 0.05);
    const diagonal = moveCamera(perspective, 1, 1, 10);
    const distance = (camera: typeof iso) => Math.hypot(camera.position.u - perspective.position.u, camera.position.v - perspective.position.v, camera.position.h - perspective.position.h);
    expect(distance(diagonal)).toBeCloseTo(distance(straight));
    expect(distance(moveCamera(perspective, 1, 0, 0.05, true))).toBeCloseTo(distance(straight) * 4);
    expect(distance(moveCamera(perspective, 1, 1, 0.05, false, 1))).toBeCloseTo(distance(straight));
  });

  it("Z/X changes only world height, independently of camera orientation", () => {
    for (const camera of [iso, perspective, lookCamera(perspective, 50, -100)]) {
      for (const up of [-1, 1]) {
        const moved = moveCamera(camera, 0, 0, 0.05, false, up);
        expect(moved.position).toEqual({ ...camera.position, h: camera.position.h + up * 0.1 });
        expect(moved.rotation).toEqual(camera.rotation);
      }
    }
  });

  it("clamps cumulative pitch and preserves a valid unit quaternion", () => {
    let next = perspective;
    for (let i = 0; i < 100; i++) next = lookCamera(next, 13, -200);
    const forward = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...worldToRendererRotation(next.rotation)));
    expect(Math.asin(forward.y)).toBeCloseTo(Math.PI / 2 - 0.05);
    expect(decodeWorldCamera(next).ok).toBe(true);
    expect(next.position).toEqual(perspective.position);
  });

  it("keeps isometric directions constrained and cycles through four quadrants", () => {
    expect(lookCamera(iso, 100, 100)).toBe(iso);
    let next = iso;
    for (let i = 0; i < 4; i++) {
      next = turnIsometricCamera(next, 1);
      expect(decodeWorldCamera(next).ok).toBe(true);
    }
    const a = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...worldToRendererRotation(iso.rotation)));
    const b = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(...worldToRendererRotation(next.rotation)));
    expect(a.distanceTo(b)).toBeLessThan(1e-8);
  });
});
