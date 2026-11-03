import { describe, expect, it } from "vitest";
import { canvasPointToGround, newWorldInstance } from "./creation-scopes-ui.js";
import { worldToCanvasPoint } from "./model-focus/canvas-projection.js";
import { worldToRendererPosition } from "./shared-world.js";

describe("canvas ground creation", () => {
  it("projects the clicked point to height zero and back", () => {
    const click = { x: 235, y: -180 };
    const ground = canvasPointToGround(click);
    const projected = worldToCanvasPoint([...worldToRendererPosition({ ...ground, h: 0 })]);
    expect(projected.x).toBeCloseTo(click.x);
    expect(projected.y).toBeCloseTo(click.y);
    expect(newWorldInstance("instance", click)).toMatchObject({ instanceId: "instance", transform: { position: { ...ground, h: 0 }, scale: 1 } });
  });
});
