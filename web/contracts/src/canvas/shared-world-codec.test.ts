import { describe, expect, it } from "vitest";
import fixture from "../../../../bevy/tests/fixtures/shared-world/coordinates.json";
import {
  SharedWorldCodecError,
  decodeWorldInstanceData,
  decodeWorldRotation,
  decodeWorldTransform,
  encodeWorldInstanceData,
  encodeWorldTransform
} from "./shared-world-codec.js";
import {
  SHARED_WORLD_VERSION,
  WORLD_ROTATION_UNIT_TOLERANCE,
  worldToRendererPosition,
  worldToRendererRotation,
  type SharedWorldDecodeResult,
  type WorldTransform
} from "./shared-world.js";

type FixtureCase = (typeof fixture.cases)[number];

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function fixtureTransform(input: FixtureCase): Record<string, unknown> {
  return {
    version: SHARED_WORLD_VERSION,
    position: { u: input.world[0]!, v: input.world[1]!, h: input.world[2]! },
    rotation: [...input.rotation],
    scale: input.scale
  };
}

function validTransform(): Record<string, unknown> {
  return { version: SHARED_WORLD_VERSION, position: { u: 1, v: 2, h: 3 }, rotation: [0, 0, 0, 1], scale: 1 };
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

describe("shared-world transform codec", () => {
  it("round-trips every frozen coordinate fixture through the shared adapter", () => {
    for (const input of fixture.cases) {
      const raw = deepFreeze(fixtureTransform(input));
      const value = expectDecoded(decodeWorldTransform(raw));
      expect(value.version).toBe(SHARED_WORLD_VERSION);
      expect(value.scale).toBe(input.scale);
      expect(value.position).toEqual({ u: input.world[0], v: input.world[1], h: input.world[2] });
      expect(value.rotation).toEqual(input.rotation);
      // The codec must not introduce a second coordinate rule: the frozen adapter
      // still maps the decoded meters and quaternion onto the renderer basis.
      worldToRendererPosition(value.position).forEach((component, index) => {
        expect(component).toBeCloseTo(input.renderer[index]!, 12);
      });
      worldToRendererRotation(value.rotation).forEach((component, index) => {
        expect(component).toBeCloseTo(input.renderer_rotation[index]!, 12);
      });

      const encoded = encodeWorldTransform(value);
      expect(Object.keys(encoded as object).sort()).toEqual(["position", "rotation", "scale", "version"]);
      expect(encoded).toEqual(raw);
      expect(expectDecoded(decodeWorldTransform(encoded))).toEqual(value);
    }
  });

  it("matches the frozen rejection fixtures and keeps the original input", () => {
    for (const rejection of fixture.codecRejections) {
      const input = deepFreeze(rejection.input as unknown);
      expectRejected(decodeWorldTransform(input), rejection.reason as "invalid-data" | "unsupported-version", input);
    }
  });

  it("rejects non-JSON numbers in every numeric field", () => {
    for (const token of fixture.nonJsonNumberRejections) {
      const value = Number(token);
      const mutations: Array<(input: Record<string, unknown>) => void> = [
        input => { (input.position as Record<string, unknown>).u = value; },
        input => { (input.position as Record<string, unknown>).v = value; },
        input => { (input.position as Record<string, unknown>).h = value; },
        input => { (input.rotation as unknown[])[0] = value; },
        input => { (input.rotation as unknown[])[1] = value; },
        input => { (input.rotation as unknown[])[2] = value; },
        input => { (input.rotation as unknown[])[3] = value; },
        input => { input.scale = value; }
      ];
      for (const mutate of mutations) {
        const input = validTransform();
        mutate(input);
        expectRejected(decodeWorldTransform(input), "invalid-data", input);
      }
    }
  });

  it("enforces the exact v1 version", () => {
    const missing = validTransform();
    delete missing.version;
    expectRejected(decodeWorldTransform(missing), "invalid-data", missing);
    const numeric = { ...validTransform(), version: 1 };
    expectRejected(decodeWorldTransform(numeric), "invalid-data", numeric);
    const empty = { ...validTransform(), version: "" };
    expectRejected(decodeWorldTransform(empty), "invalid-data", empty);
    const future = { ...validTransform(), version: "shared-world-v2" };
    expectRejected(decodeWorldTransform(future), "unsupported-version", future);
    const blank = { ...validTransform(), version: "  " };
    expectRejected(decodeWorldTransform(blank), "unsupported-version", blank);
  });

  it("rejects unknown fields, including legacy layout and runtime/GPU state", () => {
    const extras: Record<string, unknown>[] = [
      { ...validTransform(), nodeId: "node-1" },
      { ...validTransform(), offset: { x: 0, y: 0, z: 0 } },
      { ...validTransform(), modelPlacement: { x: 0, y: 0 } },
      { ...validTransform(), matrix: [1, 0, 0] },
      { ...validTransform(), gpuHandle: 7 },
      { ...validTransform(), lease: { runId: "run-1" } },
      { ...validTransform(), position: { u: 1, v: 2, h: 3, z: 4 } },
      { ...validTransform(), position: { u: 1, v: 2 } }
    ];
    for (const input of extras) {
      expectRejected(decodeWorldTransform(deepFreeze(input)), "invalid-data", input);
    }
  });

  it("accepts rotations inside the squared-norm tolerance and rejects the rest", () => {
    const inside = Math.sqrt(1 + WORLD_ROTATION_UNIT_TOLERANCE * 0.5);
    const outside = Math.sqrt(1 + WORLD_ROTATION_UNIT_TOLERANCE * 2);
    const accepted = decodeWorldRotation([0, 0, 0, inside]);
    expect(accepted).not.toBeNull();
    expect(accepted?.[3]).toBe(inside);
    const below = Math.sqrt(1 - WORLD_ROTATION_UNIT_TOLERANCE * 0.5);
    expect(decodeWorldRotation([0, 0, 0, below])).not.toBeNull();
    expect(decodeWorldRotation([0, 0, 0, outside])).toBeNull();
    expect(decodeWorldRotation([0, 0, 0, Math.sqrt(1 + WORLD_ROTATION_UNIT_TOLERANCE * 10)])).toBeNull();
    expect(decodeWorldRotation([0, 0, 0])).toBeNull();
    expect(decodeWorldRotation([0, 0, 0, 1, 0])).toBeNull();
    expect(decodeWorldRotation([0, 0, 0, "1"])).toBeNull();
    expect(decodeWorldRotation({ w: 1 })).toBeNull();
  });

  it("requires a finite positive scale without clamping legitimate values", () => {
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null]) {
      const input = { ...validTransform(), scale };
      expectRejected(decodeWorldTransform(input), "invalid-data", input);
    }
    expect(expectDecoded(decodeWorldTransform({ ...validTransform(), scale: 1e-9 })).scale).toBe(1e-9);
    expect(expectDecoded(decodeWorldTransform({ ...validTransform(), scale: 1e9 })).scale).toBe(1e9);
  });

  it("returns fresh values and never mutates or aliases untrusted input", () => {
    const input = deepFreeze(validTransform());
    const value = expectDecoded(decodeWorldTransform(input));
    expect(value).not.toBe(input);
    expect(value.position).not.toBe((input as Record<string, unknown>).position);
    expect(value.rotation).not.toBe((input as Record<string, unknown>).rotation);
    (value.position as { u: number }).u = 99;
    expect((input as { position: { u: number } }).position.u).toBe(1);

    const failed = deepFreeze({ ...validTransform(), scale: -2 });
    expectRejected(decodeWorldTransform(failed), "invalid-data", failed);
    expect((failed as { scale: number }).scale).toBe(-2);

    expectRejected(decodeWorldTransform(null), "invalid-data", null);
    const arrayInput = [validTransform()];
    expectRejected(decodeWorldTransform(arrayInput), "invalid-data", arrayInput);
  });

  it("refuses to encode values outside the allowlist instead of emitting them", () => {
    const base = expectDecoded(decodeWorldTransform(validTransform()));
    expect(() => encodeWorldTransform({ ...base, scale: Number.NaN })).toThrow(SharedWorldCodecError);
    const extended = { ...base, gpuHandle: 7 } as unknown as WorldTransform;
    try {
      encodeWorldTransform(extended);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SharedWorldCodecError);
      expect((error as SharedWorldCodecError).code).toBe("invalid-data");
    }
    const future = { ...base, version: "shared-world-v2" } as unknown as WorldTransform;
    try {
      encodeWorldTransform(future);
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as SharedWorldCodecError).code).toBe("unsupported-version");
    }
  });
});

describe("world-instance node codec", () => {
  function instanceInput(): Record<string, unknown> {
    return {
      kind: "world-instance",
      version: SHARED_WORLD_VERSION,
      instanceId: "instance-1",
      transform: validTransform()
    };
  }

  it("round-trips the frozen payload with only its allowlisted keys", () => {
    const input = deepFreeze(instanceInput());
    const value = expectDecoded(decodeWorldInstanceData(input));
    expect(value.kind).toBe("world-instance");
    expect(value.instanceId).toBe("instance-1");
    expect(value.transform).toEqual(expectDecoded(decodeWorldTransform(validTransform())));
    const encoded = encodeWorldInstanceData(value);
    expect(Object.keys(encoded as object).sort()).toEqual(["instanceId", "kind", "transform", "version"]);
    expect(encoded).toEqual(input);
  });

  it("rejects legacy kinds and unknown layout/runtime fields", () => {
    for (const kind of ["group", "shot", "world-camera", "model3d", undefined]) {
      const input = { ...instanceInput(), kind };
      expectRejected(decodeWorldInstanceData(input), "invalid-data", input);
    }
    const extras = [
      { ...instanceInput(), nodeId: "node-1" },
      { ...instanceInput(), modelPlacement: { x: 0, y: 0 } },
      { ...instanceInput(), offset: { x: 0, y: 0, z: 0 } },
      { ...instanceInput(), lease: { runId: "run-1" } },
      { ...instanceInput(), gpuHandle: 1 },
      { ...instanceInput(), transform: { ...validTransform(), gpuMatrix: [] } }
    ];
    for (const input of extras) expectRejected(decodeWorldInstanceData(deepFreeze(input)), "invalid-data", input);
  });

  it("requires a nonempty instance id and propagates nested transform failures", () => {
    for (const instanceId of ["", "   ", 1, null]) {
      const input = { ...instanceInput(), instanceId };
      expectRejected(decodeWorldInstanceData(input), "invalid-data", input);
    }
    const future = { ...instanceInput(), transform: { ...validTransform(), version: "shared-world-v2" } };
    expectRejected(decodeWorldInstanceData(future), "unsupported-version", future);
    const nonFinite = { ...instanceInput(), transform: { ...validTransform(), scale: Number.POSITIVE_INFINITY } };
    expectRejected(decodeWorldInstanceData(nonFinite), "invalid-data", nonFinite);
    const missingTransform = instanceInput();
    delete missingTransform.transform;
    expectRejected(decodeWorldInstanceData(missingTransform), "invalid-data", missingTransform);
  });

  it("refuses to encode an invalid typed instance", () => {
    const value = expectDecoded(decodeWorldInstanceData(instanceInput()));
    expect(() => encodeWorldInstanceData({ ...value, instanceId: " " })).toThrow(SharedWorldCodecError);
    expect(() => encodeWorldInstanceData({ ...value, gpuHandle: 1 } as never)).toThrow(SharedWorldCodecError);
  });
});
