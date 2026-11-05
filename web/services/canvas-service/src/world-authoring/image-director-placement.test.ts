import { describe, expect, it } from "vitest";
import { canvasPointToGround, createEmptyWoohaa3ServerCanvas, effectiveCanvasNodeSize, IMAGE_DIRECTOR_SCENE_VERSION, SHARED_WORLD_VERSION, worldToCanvasPoint, worldToRendererPosition, type GroundAabb } from "@woohaa3/contracts";
import { imageDirectorOccupancy, imageDirectorPlacementAnchor, planImageDirectorPlacement } from "./image-director-placement.js";
import { imageDirectorSourceGround } from "./image-director-reservation.js";
import type { PreparedImageDirectorCandidate } from "./image-director-candidate.js";

const prepared: PreparedImageDirectorCandidate = {
  candidate: { version: IMAGE_DIRECTOR_SCENE_VERSION, models: [{ key: "a", name: "a", script: "x", transform: { version: SHARED_WORLD_VERSION, position: { u: 0, v: 0, h: 0 }, rotation: [0, 0, 0, 1], scale: 1 } }], camera: { position: { u: -2, v: 0, h: 1 }, rotation: [0, 0, 0, 1], projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0.1, farMeters: 10 } } },
  footprints: [{ min: { u: 0, v: 0 }, max: { u: 1, v: 1 } }]
};
describe("image director placement", () => {
  const project = (bounds: GroundAabb) => {
    const corners = [bounds.min.u, bounds.max.u].flatMap(u => [bounds.min.v, bounds.max.v].map(v => worldToCanvasPoint([...worldToRendererPosition({ u, v, h: 0 })])));
    return { centerX: (Math.min(...corners.map(p => p.x)) + Math.max(...corners.map(p => p.x))) / 2, top: Math.min(...corners.map(p => p.y)), bottom: Math.max(...corners.map(p => p.y)) };
  };
  it.each([false, true])("centers the area below the image using its visible size and ancestor positions (nested=%s)", nested => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas");
    const image = { id: "image", type: "image", position: { x: 100, y: 200 }, ...(nested ? { width: 400, height: 300, parentId: "parent" } : {}) };
    canvas.document.nodes.push(image);
    if (nested) canvas.document.nodes.push({ id: "parent", type: "group", position: { x: 350, y: -100 }, parentId: "outer" }, { id: "outer", type: "group", position: { x: -50, y: 75 } });
    const result = planImageDirectorPlacement(prepared, [], imageDirectorSourceGround(canvas, "image"), "below-image");
    expect(result).not.toBeNull();
    const bounds = project(result!.bounds), size = effectiveCanvasNodeSize(image);
    expect(bounds.centerX).toBeCloseTo(100 + (nested ? 300 : 0) + size.width / 2);
    expect(bounds.top).toBeCloseTo(200 + (nested ? -25 : 0) + size.height + 32);
  });
  it("keeps horizontal alignment while avoiding occupied space downwards", () => {
    const origin = canvasPointToGround({ x: 450, y: 600 });
    const first = planImageDirectorPlacement(prepared, [], origin, "below-image")!;
    const second = planImageDirectorPlacement(prepared, [first.bounds], origin, "below-image")!;
    expect(project(second.bounds).centerX).toBeCloseTo(450);
    expect(project(second.bounds).top).toBeGreaterThan(project(first.bounds).bottom);
  });
  it("preserves the top-center anchor when the generated scene expands", () => {
    const reserved = planImageDirectorPlacement(prepared, [], canvasPointToGround({ x: 450, y: 600 }), "below-image")!;
    const larger = { ...prepared, footprints: [{ min: { u: -10, v: -5 }, max: { u: 8, v: 12 } }] };
    const completed = planImageDirectorPlacement(larger, [], imageDirectorPlacementAnchor(reserved.bounds), "below-image")!;
    expect(project(completed.bounds).centerX).toBeCloseTo(450);
    expect(project(completed.bounds).top).toBeCloseTo(600);
  });
  it("covers camera and models and avoids occupied space", () => {
    const result = planImageDirectorPlacement(prepared, [{ min: { u: 0, v: 0 }, max: { u: 1, v: 1 } }], { u: 0, v: 0 });
    expect(result).not.toBeNull();
    expect(result!.bounds.min.u).toBeGreaterThan(1);
    expect(-2 + result!.delta.u).toBeGreaterThan(result!.bounds.min.u);
    expect(1 + result!.delta.u).toBeLessThan(result!.bounds.max.u);
  });
  it("refuses unknown occupancy", () => {
    expect(planImageDirectorPlacement(prepared, [null], { u: 0, v: 0 })).toBeNull();
  });
  it("does not treat malformed existing world objects as empty space", async () => {
    const canvas = createEmptyWoohaa3ServerCanvas("canvas");
    canvas.document.nodes.push({ id: "camera", type: "world-camera", position: { x: 0, y: 0 } });
    expect(await imageDirectorOccupancy(canvas)).toEqual([null]);
  });
});
