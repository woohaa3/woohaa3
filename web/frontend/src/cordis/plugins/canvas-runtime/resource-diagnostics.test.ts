import { describe, expect, it } from "vitest";
import { readResourceDiagnostics } from "./resource-diagnostics";

describe("cached resource diagnostics", () => {
  it("retains real zero without copying content or invalid gauges", () => {
    const raw = { models: { roots: 0, parts: 12, low: -1, high: Infinity, uniqueVertices: 1e13, script: "private" }, previews: { active: 2 } };
    const snapshot = readResourceDiagnostics(raw, 42)!;
    raw.models.parts = 99;
    expect(snapshot).toEqual({ scope: "last-reported", observedAt: 42, models: { roots: 0, parts: 12 }, previews: { active: 2 } });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.models)).toBe(true);
  });
  it("leaves missing diagnostics unavailable", () => {
    expect(readResourceDiagnostics({}, 0)).toBeUndefined();
    expect(readResourceDiagnostics({ models: { roots: 1 } }, NaN)).toBeUndefined();
  });
});

it("retains bounded nested simplification gauges as an immutable section", () => {
  const snapshot = readResourceDiagnostics({ models: { simplification: {
    active: 0, pending: 4, sourceBytes: 120, generated: 7, cancelled: 2,
    cppWorkspacePeakBytes: 300, privateGeometry: [1, 2], failure: NaN
  } } }, 10)!;
  expect(snapshot.models).toBeUndefined();
  expect(snapshot.simplification).toEqual({ active: 0, pending: 4, sourceBytes: 120,
    generated: 7, cancelled: 2, cppWorkspacePeakBytes: 300 });
  expect(Object.isFrozen(snapshot.simplification)).toBe(true);
});
