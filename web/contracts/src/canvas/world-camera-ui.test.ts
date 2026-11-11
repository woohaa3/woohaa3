import { describe, expect, it } from "vitest";
import { createDefaultWorldCameraData, initialCameraCardPosition, worldCameraRotationLookingAt, worldCameraView } from "./world-camera-ui.js";
import { worldToCanvasPoint } from "./model-focus/canvas-projection.js";
import { worldToRendererPosition } from "./shared-world.js";

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

describe("initialCameraCardPosition", () => {
  it("hangs the card above the camera body's projected canvas point", () => {
    const camera = createDefaultWorldCameraData("camera-a", "v1", { u: 12, v: 7 });
    const card = initialCameraCardPosition(camera);
    const renderer = worldToRendererPosition(camera.position);
    const body = worldToCanvasPoint([renderer[0], renderer[1], renderer[2]]);
    expect(card.x).toBeCloseTo(body.x + 56, 9);
    expect(card.y).toBeCloseTo(body.y - 156 - 56, 9);
  });

  it("moves with the camera instead of returning a fixed canvas slot", () => {
    const near = initialCameraCardPosition({ position: { u: 0, v: 0, h: 1 } });
    const far = initialCameraCardPosition({ position: { u: 40, v: 25, h: 1 } });
    expect(far.x).not.toBeCloseTo(near.x, 3);
    expect(far.y).not.toBeCloseTo(near.y, 3);
  });
});
