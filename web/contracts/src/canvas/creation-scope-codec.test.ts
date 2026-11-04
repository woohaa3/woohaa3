import { describe, expect, it } from "vitest";
import {
  decodeCreationScopeData,
  decodeGroundAabb,
  decodeGroundPoint,
  decodeSceneAreaData,
  decodeWorkflowGroupData,
  encodeCreationScopeData,
  encodeGroundAabb,
  encodeGroundPoint,
  encodeSceneAreaData,
  encodeWorkflowGroupData
} from "./creation-scope-codec.js";
import { SharedWorldCodecError } from "./shared-world-codec.js";
import { SHARED_WORLD_VERSION, type SharedWorldDecodeResult } from "./shared-world.js";

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function expectDecoded<T>(result: SharedWorldDecodeResult<T>): T {
  if (!result.ok) throw new Error(`expected a decoded value, got ${result.code}`);
  return result.value;
}

function expectRejected(
  result: SharedWorldDecodeResult<unknown>,
  code: "invalid-data" | "unsupported-version",
  input: unknown
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(code);
  expect(result.input).toBe(input);
}

function groupInput(): Record<string, unknown> {
  return {
    kind: "workflow-group-2d",
    version: SHARED_WORLD_VERSION,
    groupId: "group-1",
    scopeVersion: "scope-4",
    memberNodeIds: ["node-b", "node-a"]
  };
}

function areaInput(): Record<string, unknown> {
  return {
    kind: "scene-area",
    version: SHARED_WORLD_VERSION,
    areaId: "area-1",
    scopeVersion: "scope-9",
    bounds: { min: { u: -4, v: -2 }, max: { u: 8, v: 6 } }
  };
}

describe("workflow-group-2d codec", () => {
  it("round-trips membership and organization versions with only allowlisted keys", () => {
    const input = deepFreeze(groupInput());
    const value = expectDecoded(decodeWorkflowGroupData(input));
    expect(value.kind).toBe("workflow-group-2d");
    expect(value.groupId).toBe("group-1");
    expect(value.scopeVersion).toBe("scope-4");
    expect(value.memberNodeIds).toEqual(["node-b", "node-a"]);
    const encoded = encodeWorkflowGroupData(value);
    expect(Object.keys(encoded as object).sort()).toEqual(["groupId", "kind", "memberNodeIds", "scopeVersion", "version"]);
    expect(encoded).toEqual(input);
    expect(expectDecoded(decodeWorkflowGroupData(encoded))).toEqual(value);
  });

  it("keeps a group and an area with the same id string in separate namespaces", () => {
    const group = expectDecoded(decodeWorkflowGroupData({ ...groupInput(), groupId: "shared-id" }));
    const area = expectDecoded(decodeSceneAreaData({ ...areaInput(), areaId: "shared-id" }));
    expect(group.groupId).toBe("shared-id");
    expect(area.areaId).toBe("shared-id");
    expect(group.kind).not.toBe(area.kind);
    expect(expectDecoded(decodeCreationScopeData({ ...groupInput(), groupId: "shared-id" })).kind).toBe("workflow-group-2d");
    expect(expectDecoded(decodeCreationScopeData({ ...areaInput(), areaId: "shared-id" })).kind).toBe("scene-area");
  });

  it("accepts an empty member set but rejects invalid or duplicate references", () => {
    expect(expectDecoded(decodeWorkflowGroupData({ ...groupInput(), memberNodeIds: [] })).memberNodeIds).toEqual([]);
    const invalidMembers = [
      { ...groupInput(), memberNodeIds: ["node-a", "node-a"] },
      { ...groupInput(), memberNodeIds: ["node-a", "  "] },
      { ...groupInput(), memberNodeIds: ["node-a", 7] },
      { ...groupInput(), memberNodeIds: "node-a" },
      { ...groupInput(), memberNodeIds: undefined }
    ];
    for (const input of invalidMembers) {
      expectRejected(decodeWorkflowGroupData(deepFreeze(input)), "invalid-data", input);
    }
  });

  it("rejects card layout, viewport and runtime state instead of versioning them", () => {
    const extras = [
      { ...groupInput(), viewport: { x: 0, y: 0, zoom: 1 } },
      { ...groupInput(), cardLayout: { x: 0, y: 0 } },
      { ...groupInput(), position: { x: 0, y: 0 } },
      { ...groupInput(), nodeIds: ["node-a"] },
      { ...groupInput(), lease: { runId: "run-1" } },
      { ...groupInput(), gpuHandle: 3 },
      { ...groupInput(), scopeId: "scope-4" }
    ];
    for (const input of extras) expectRejected(decodeWorkflowGroupData(deepFreeze(input)), "invalid-data", input);
  });

  it("requires nonempty group and scope versions and the exact v1 kind", () => {
    for (const groupId of ["", "  ", 1]) {
      const input = { ...groupInput(), groupId };
      expectRejected(decodeWorkflowGroupData(input), "invalid-data", input);
    }
    for (const scopeVersion of ["", "  ", 4]) {
      const input = { ...groupInput(), scopeVersion };
      expectRejected(decodeWorkflowGroupData(input), "invalid-data", input);
    }
    const future = { ...groupInput(), version: "shared-world-v2" };
    expectRejected(decodeWorkflowGroupData(future), "unsupported-version", future);
    const missing = groupInput();
    delete missing.version;
    expectRejected(decodeWorkflowGroupData(missing), "invalid-data", missing);
    const legacy = { ...groupInput(), kind: "group" };
    expectRejected(decodeWorkflowGroupData(legacy), "invalid-data", legacy);
    const area = areaInput();
    expectRejected(decodeWorkflowGroupData(area), "invalid-data", area);
  });

  it("refuses to encode an invalid typed group", () => {
    const value = expectDecoded(decodeWorkflowGroupData(groupInput()));
    expect(() => encodeWorkflowGroupData({ ...value, memberNodeIds: ["a", "a"] })).toThrow(SharedWorldCodecError);
    expect(() => encodeWorkflowGroupData({ ...value, viewport: {} } as never)).toThrow(SharedWorldCodecError);
  });
});

describe("scene-area codec", () => {
  it("round-trips ground bounds with only allowlisted keys", () => {
    const input = deepFreeze(areaInput());
    const value = expectDecoded(decodeSceneAreaData(input));
    expect(value.bounds).toEqual({ min: { u: -4, v: -2 }, max: { u: 8, v: 6 } });
    const encoded = encodeSceneAreaData(value);
    expect(Object.keys(encoded as object).sort()).toEqual(["areaId", "bounds", "kind", "scopeVersion", "version"]);
    expect(encoded).toEqual(input);
    expect(expectDecoded(decodeSceneAreaData(encoded))).toEqual(value);
  });

  it("treats degenerate points and lines as valid ranges", () => {
    const point = { min: { u: 2, v: 3 }, max: { u: 2, v: 3 } };
    const line = { min: { u: 2, v: -1 }, max: { u: 2, v: 5 } };
    expect(expectDecoded(decodeSceneAreaData({ ...areaInput(), bounds: point })).bounds).toEqual(point);
    expect(expectDecoded(decodeSceneAreaData({ ...areaInput(), bounds: line })).bounds).toEqual(line);
    expect(decodeGroundAabb(point)).toEqual(point);
  });

  it("requires ordered finite bounds on both axes", () => {
    const unordered = [
      { min: { u: 5, v: 0 }, max: { u: 4, v: 1 } },
      { min: { u: 0, v: 5 }, max: { u: 1, v: 4 } }
    ];
    for (const bounds of unordered) {
      const input = { ...areaInput(), bounds };
      expectRejected(decodeSceneAreaData(input), "invalid-data", input);
    }
    const nonFiniteInput = { ...areaInput(), bounds: { min: { u: Number.NaN, v: 0 }, max: { u: 1, v: 1 } } };
    expectRejected(decodeSceneAreaData(nonFiniteInput), "invalid-data", nonFiniteInput);
    expect(decodeGroundAabb(nonFiniteInput.bounds)).toBeNull();
  });

  it("rejects card rectangles, height and runtime/GPU fields", () => {
    const extras = [
      { kind: "scene-area", version: SHARED_WORLD_VERSION, areaId: "a", scopeVersion: "s", min: { u: 0, v: 0 }, max: { u: 1, v: 1 } },
      { ...areaInput(), position: { x: 0, y: 0 } },
      { ...areaInput(), height: 0 },
      { ...areaInput(), pose: { position: { u: 0, v: 0, h: 0 } } },
      { ...areaInput(), gpuBounds: {} },
      { ...areaInput(), lease: { runId: "run-1" } },
      { ...areaInput(), bounds: { min: { u: 0, v: 0 }, max: { u: 1, v: 1 }, center: { u: 0, v: 0 } } },
      { ...areaInput(), bounds: { min: { u: 0, v: 0, h: 0 }, max: { u: 1, v: 1 } } },
      { ...areaInput(), bounds: { min: { u: 0, v: 0 } } }
    ];
    for (const input of extras) expectRejected(decodeSceneAreaData(deepFreeze(input)), "invalid-data", input);
    expect(decodeGroundPoint({ u: 0, v: 0, h: 0 })).toBeNull();
  });

  it("requires nonempty area and scope versions and the exact v1 kind", () => {
    for (const areaId of ["", "  ", null]) {
      const input = { ...areaInput(), areaId };
      expectRejected(decodeSceneAreaData(input), "invalid-data", input);
    }
    for (const scopeVersion of ["", " ", 1]) {
      const input = { ...areaInput(), scopeVersion };
      expectRejected(decodeSceneAreaData(input), "invalid-data", input);
    }
    const future = { ...areaInput(), version: "shared-world-v2" };
    expectRejected(decodeSceneAreaData(future), "unsupported-version", future);
    const legacy = { ...areaInput(), kind: "shot" };
    expectRejected(decodeSceneAreaData(legacy), "invalid-data", legacy);
    const group = groupInput();
    expectRejected(decodeSceneAreaData(group), "invalid-data", group);
  });

  it("returns fresh bounds and never aliases untrusted input", () => {
    const input = deepFreeze(areaInput());
    const value = expectDecoded(decodeSceneAreaData(input));
    expect(value.bounds).not.toBe((input as Record<string, unknown>).bounds);
    (value.bounds.min as { u: number }).u = 99;
    expect((input as { bounds: { min: { u: number } } }).bounds.min.u).toBe(-4);
  });

  it("refuses to encode an invalid typed area", () => {
    const value = expectDecoded(decodeSceneAreaData(areaInput()));
    expect(() => encodeSceneAreaData({ ...value, bounds: { min: { u: 2, v: 0 }, max: { u: 1, v: 1 } } })).toThrow(SharedWorldCodecError);
    expect(() => encodeSceneAreaData({ ...value, gpuBounds: {} } as never)).toThrow(SharedWorldCodecError);
  });
});

describe("creation-scope dispatch", () => {
  it("dispatches both scopes and rejects legacy or unrelated kinds", () => {
    expect(expectDecoded(decodeCreationScopeData(groupInput())).kind).toBe("workflow-group-2d");
    expect(expectDecoded(decodeCreationScopeData(areaInput())).kind).toBe("scene-area");
    const rejected = [
      { kind: "group", version: SHARED_WORLD_VERSION },
      { kind: "shot", version: SHARED_WORLD_VERSION },
      { kind: "world-camera", version: SHARED_WORLD_VERSION, cameraId: "camera-1" },
      { kind: "model3d", version: SHARED_WORLD_VERSION },
      { version: SHARED_WORLD_VERSION }
    ];
    for (const input of rejected) {
      expectRejected(decodeCreationScopeData(deepFreeze(input)), "invalid-data", input);
    }
    expectRejected(decodeCreationScopeData(null), "invalid-data", null);
    const array = [groupInput()];
    expectRejected(decodeCreationScopeData(array), "invalid-data", array);
  });

  it("round-trips either scope through the union encoder", () => {
    for (const input of [groupInput(), areaInput()]) {
      const value = expectDecoded(decodeCreationScopeData(input));
      expect(encodeCreationScopeData(value)).toEqual(input);
    }
    expect(() => encodeCreationScopeData({ kind: "group" } as never)).toThrow(SharedWorldCodecError);
  });
});

describe("ground point and AABB codecs", () => {
  it("accepts finite meters and rejects height, extra axes and non-finite values", () => {
    expect(decodeGroundPoint({ u: -1.5, v: 2 })).toEqual({ u: -1.5, v: 2 });
    expect(encodeGroundPoint({ u: 0, v: 0 })).toEqual({ u: 0, v: 0 });
    for (const value of [
      { u: 0, v: 0, h: 0 },
      { u: Number.POSITIVE_INFINITY, v: 0 },
      { u: 0, v: Number.NaN },
      { u: "0", v: 0 },
      null
    ]) {
      expect(decodeGroundPoint(value)).toBeNull();
    }
    expect(() => encodeGroundPoint({ u: Number.NaN, v: 0 })).toThrow(SharedWorldCodecError);
  });

  it("round-trips ordered AABBs and rejects unordered or extended ones", () => {
    const bounds = { min: { u: -1, v: -1 }, max: { u: 1, v: 1 } };
    expect(encodeGroundAabb(bounds)).toEqual(bounds);
    expect(decodeGroundAabb({ ...bounds, extra: true })).toBeNull();
    expect(decodeGroundAabb({ min: { u: 2, v: 0 }, max: { u: 1, v: 1 } })).toBeNull();
    expect(() => encodeGroundAabb({ min: { u: 2, v: 0 }, max: { u: 1, v: 1 } })).toThrow(SharedWorldCodecError);
  });
});
