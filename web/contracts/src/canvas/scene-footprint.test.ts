import { describe, expect, it } from "vitest";
import { classifyCameraPoint, classifyFootprint, sceneFootprintFunctions } from "./scene-footprint.js";
import {
  SCENE_FOOTPRINT_TOLERANCE_METERS,
  type GroundAabb,
  type SceneCameraPointQuery,
  type SceneFootprintInput,
  type SceneFootprintQuery,
  type WorldPoint
} from "./shared-world.js";

const TOLERANCE = SCENE_FOOTPRINT_TOLERANCE_METERS;

function aabb(minU: number, minV: number, maxU: number, maxV: number): GroundAabb {
  return { min: { u: minU, v: minV }, max: { u: maxU, v: maxV } };
}

function area(): GroundAabb {
  return aabb(0, 0, 10, 10);
}

function ready(bounds: GroundAabb, contentVersion = "content-1", transformVersion = "pose-1"): SceneFootprintInput {
  return { status: "ready", bounds, contentVersion, transformVersion };
}

function footprintQuery(bounds: GroundAabb, target: GroundAabb = area()): SceneFootprintQuery {
  return { area: target, footprint: ready(bounds), contentVersion: "content-1", transformVersion: "pose-1" };
}

function point(u: number, v: number, h = 0): WorldPoint {
  return { u, v, h };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

describe("classifyFootprint", () => {
  it("reports complete for a strictly contained footprint", () => {
    expect(classifyFootprint(footprintQuery(aabb(1, 2, 8, 9)))).toBe("complete");
  });

  it("reports complete when the footprint equals the area", () => {
    expect(classifyFootprint(footprintQuery(area()))).toBe("complete");
  });

  it("treats boundary contact within the fixed metric tolerance as complete", () => {
    expect(classifyFootprint(footprintQuery(aabb(-TOLERANCE, -TOLERANCE, 10 + TOLERANCE, 10 + TOLERANCE)))).toBe("complete");
    expect(classifyFootprint(footprintQuery(aabb(0, 0, 10 + TOLERANCE, 10)))).toBe("complete");
  });

  it("does not widen completion beyond the fixed tolerance", () => {
    expect(classifyFootprint(footprintQuery(aabb(0, 0, 10 + TOLERANCE * 2, 10)))).toBe("partial");
    expect(classifyFootprint(footprintQuery(aabb(-TOLERANCE * 2, 0, 10, 10)))).toBe("partial");
  });

  it("absorbs a few-centimetre decorative overhang inside the fixed metric tolerance", () => {
    // Thin arch ribs/trims can project past the edge the user sees; the model must
    // still count as contained or it silently drops out of the area move/edit set.
    expect(TOLERANCE).toBeGreaterThanOrEqual(0.03);
    expect(classifyFootprint(footprintQuery(aabb(-0.03, 2, 10, 8)))).toBe("complete");
    expect(classifyFootprint(footprintQuery(aabb(-TOLERANCE - 0.01, 2, 10, 8)))).toBe("partial");
  });

  it("reports partial when the footprint crosses one or both area edges", () => {
    expect(classifyFootprint(footprintQuery(aabb(5, 2, 15, 8)))).toBe("partial");
    expect(classifyFootprint(footprintQuery(aabb(2, 5, 8, 15)))).toBe("partial");
    expect(classifyFootprint(footprintQuery(aabb(-5, -5, 5, 5)))).toBe("partial");
  });

  it("reports partial when the footprint fully covers the area", () => {
    expect(classifyFootprint(footprintQuery(aabb(-1, -1, 11, 11)))).toBe("partial");
  });

  it("reports partial for a corner-touching footprint at the tolerance edge", () => {
    expect(classifyFootprint(footprintQuery(aabb(10 + TOLERANCE, 10 + TOLERANCE, 12, 12)))).toBe("partial");
  });

  it("reports outside when the gap exceeds the tolerance on either axis", () => {
    expect(classifyFootprint(footprintQuery(aabb(10 + TOLERANCE * 2, 2, 12, 8)))).toBe("outside");
    expect(classifyFootprint(footprintQuery(aabb(2, -12, 8, -TOLERANCE * 2)))).toBe("outside");
    expect(classifyFootprint(footprintQuery(aabb(20, 20, 30, 30)))).toBe("outside");
  });

  it("classifies degenerate thin footprints instead of treating them as empty", () => {
    const verticalLine = aabb(5, 2, 5, 8);
    const horizontalLine = aabb(2, 5, 8, 5);
    const singlePoint = aabb(5, 5, 5, 5);

    expect(classifyFootprint(footprintQuery(verticalLine))).toBe("complete");
    expect(classifyFootprint(footprintQuery(horizontalLine))).toBe("complete");
    expect(classifyFootprint(footprintQuery(singlePoint))).toBe("complete");
    expect(classifyFootprint(footprintQuery(aabb(10 + TOLERANCE * 2, 5, 10 + TOLERANCE * 2, 5)))).toBe("outside");
  });

  it("treats a degenerate area as a point rather than rejecting a matching point", () => {
    const degenerateArea = aabb(3, 4, 3, 4);
    expect(classifyFootprint(footprintQuery(aabb(3, 4, 3, 4), degenerateArea))).toBe("complete");
    expect(classifyFootprint(footprintQuery(aabb(3, 4, 3, 4), aabb(0, 0, 0, 0)))).toBe("outside");
  });

  it("returns unknown for missing, stale or unready footprints", () => {
    for (const status of ["missing", "stale", "unready"] as const) {
      expect(classifyFootprint({ area: area(), footprint: { status }, contentVersion: "content-1", transformVersion: "pose-1" })).toBe("unknown");
    }
    expect(classifyFootprint({ area: area(), footprint: { status: "unknown" } as unknown as SceneFootprintInput, contentVersion: "content-1", transformVersion: "pose-1" })).toBe("unknown");
  });

  it("returns unknown when footprint versions do not match the query", () => {
    const query = footprintQuery(aabb(1, 1, 2, 2));
    expect(classifyFootprint({ ...query, contentVersion: "content-2" })).toBe("unknown");
    expect(classifyFootprint({ ...query, transformVersion: "pose-2" })).toBe("unknown");
    expect(classifyFootprint({ ...query, contentVersion: "" })).toBe("unknown");
    expect(classifyFootprint({ ...query, footprint: ready(aabb(1, 1, 2, 2), "", "pose-1") })).toBe("unknown");
  });

  it("returns unknown for non-finite or unordered bounds and areas", () => {
    expect(classifyFootprint(footprintQuery(aabb(Number.NaN, 0, 1, 1)))).toBe("unknown");
    expect(classifyFootprint(footprintQuery(aabb(0, 0, Number.POSITIVE_INFINITY, 1)))).toBe("unknown");
    expect(classifyFootprint(footprintQuery(aabb(0, 0, 1, Number.NEGATIVE_INFINITY)))).toBe("unknown");
    expect(classifyFootprint(footprintQuery(aabb(5, 0, 4, 1)))).toBe("unknown");
    expect(classifyFootprint(footprintQuery(aabb(1, 1, 2, 2), aabb(10, 0, 0, 10)))).toBe("unknown");
    expect(classifyFootprint(footprintQuery(aabb(1, 1, 2, 2), aabb(0, Number.NaN, 10, 10)))).toBe("unknown");
  });

  it("returns unknown for malformed ready footprints rather than granting access", () => {
    const malformed = { status: "ready", contentVersion: "content-1", transformVersion: "pose-1" } as unknown as SceneFootprintInput;
    expect(classifyFootprint({ area: area(), footprint: malformed, contentVersion: "content-1", transformVersion: "pose-1" })).toBe("unknown");
  });

  it("is deterministic, side-effect free and independent of viewport or zoom", () => {
    const query = deepFreeze(footprintQuery(aabb(5, 2, 15, 8)));
    const snapshot = JSON.stringify(query);

    const base = classifyFootprint(query);
    expect(base).toBe("partial");
    expect(classifyFootprint({ ...query, viewport: { x: -900, y: 40, zoom: 0.02 }, zoom: 0.02 } as SceneFootprintQuery)).toBe(base);
    expect(classifyFootprint({ ...query, viewport: { x: 10, y: 10, zoom: 16 }, zoom: 16 } as SceneFootprintQuery)).toBe(base);
    expect(sceneFootprintFunctions.classifyFootprint(query)).toBe(base);
    expect(sceneFootprintFunctions.classifyCameraPoint({ area: area(), position: point(5, 5) })).toBe("complete");
    expect(JSON.stringify(query)).toBe(snapshot);
  });
});

describe("classifyCameraPoint", () => {
  it("reports complete for a ground anchor inside the area", () => {
    expect(classifyCameraPoint({ area: area(), position: point(5, 5) })).toBe("complete");
    expect(classifyCameraPoint({ area: area(), position: point(0, 10) })).toBe("complete");
  });

  it("accepts boundary contact within the fixed tolerance", () => {
    expect(classifyCameraPoint({ area: area(), position: point(10 + TOLERANCE, 5) })).toBe("complete");
    expect(classifyCameraPoint({ area: area(), position: point(5, -TOLERANCE) })).toBe("complete");
    expect(classifyCameraPoint({ area: area(), position: point(10 + TOLERANCE * 2, 5) })).toBe("outside");
  });

  it("reports outside for anchors beyond the area", () => {
    expect(classifyCameraPoint({ area: area(), position: point(-1, 5) })).toBe("outside");
    expect(classifyCameraPoint({ area: area(), position: point(5, 11) })).toBe("outside");
  });

  it("ignores height and card layout", () => {
    const low = classifyCameraPoint({ area: area(), position: point(5, 5, -100) });
    const high = classifyCameraPoint({ area: area(), position: point(5, 5, 250) });
    expect(low).toBe("complete");
    expect(high).toBe(low);
    expect(classifyCameraPoint({ area: area(), position: point(5, 5), cardRect: { x: 900, y: 900, width: 10, height: 10 } } as SceneCameraPointQuery)).toBe("complete");
    expect(classifyCameraPoint({ area: area(), position: point(50, 50), cardRect: { x: 0, y: 0, width: 10, height: 10 } } as SceneCameraPointQuery)).toBe("outside");
  });

  it("supports a degenerate area and returns unknown for invalid input", () => {
    expect(classifyCameraPoint({ area: aabb(3, 4, 3, 4), position: point(3, 4) })).toBe("complete");
    expect(classifyCameraPoint({ area: aabb(3, 4, 3, 4), position: point(3 + TOLERANCE * 2, 4) })).toBe("outside");
    expect(classifyCameraPoint({ area: aabb(10, 0, 0, 10), position: point(3, 4) })).toBe("unknown");
    expect(classifyCameraPoint({ area: area(), position: point(Number.NaN, 4) })).toBe("unknown");
    expect(classifyCameraPoint({ area: area(), position: point(4, Number.POSITIVE_INFINITY) })).toBe("unknown");
    expect(classifyCameraPoint({ area: area(), position: point(4, 4, Number.NaN) })).toBe("unknown");
    expect(classifyCameraPoint({ area: area(), position: { u: 4, v: 4 } as unknown as WorldPoint })).toBe("unknown");
  });
});
