import { describe, expect, it } from "vitest";
import { worldCameraRotationLookingAt, worldCameraView } from "./world-camera-ui.js";

describe("worldCameraView", () => {
  it("reports the +v forward and no ground hit for a level camera", () => {
    const view = worldCameraView({ position: { u: 0, v: 0, h: 1.5 }, rotation: [0, 0, 0, 1] });
    expect(view.forward.u).toBeCloseTo(0, 9);
    expect(view.forward.v).toBeCloseTo(1, 9);
    expect(view.forward.h).toBeCloseTo(0, 9);
    expect(view.groundIntersection).toBeNull();
  });

  it("points at the named subject and reports where the axis meets the ground", () => {
    const position = { u: 34.853, v: -12.656, h: 1.85 };
    const subject = { u: 34.453, v: -15.006, h: 1 };
    const rotation = worldCameraRotationLookingAt(position, subject);
    expect(rotation).not.toBeNull();
    const view = worldCameraView({ position, rotation: rotation! });
    // The subject sits at smaller v and u than the camera, so the lens must too.
    expect(view.forward.v).toBeLessThan(0);
    expect(view.forward.u).toBeLessThan(0);
    expect(view.forward.h).toBeLessThan(0);
    expect(view.groundIntersection).not.toBeNull();
    expect(view.groundIntersection!.v).toBeLessThan(position.v);
    expect(view.groundIntersection!.u).toBeCloseTo(33.98, 1);
    expect(view.groundIntersection!.v).toBeCloseTo(-17.77, 1);
  });

  it("has no ground hit when the camera looks up", () => {
    const position = { u: 0, v: 0, h: 1 };
    const rotation = worldCameraRotationLookingAt(position, { u: 0, v: 5, h: 4 });
    expect(rotation).not.toBeNull();
    const view = worldCameraView({ position, rotation: rotation! });
    expect(view.forward.h).toBeGreaterThan(0);
    expect(view.groundIntersection).toBeNull();
  });
});
