import { describe, expect, it } from "vitest";
import {
  WORLD_CAMERA_HISTORY_VERSION,
  decodeWorldCamera,
  decodeWorldCameraHistorySnapshot,
  encodeWorldCamera,
  encodeWorldCameraHistorySnapshot,
  worldCameraCompletionKey
} from "./world-camera-codec.js";
import { SharedWorldCodecError } from "./shared-world-codec.js";
import {
  SHARED_WORLD_VERSION,
  WORLD_ROTATION_UNIT_TOLERANCE,
  rendererToWorldRotation,
  worldToRendererRotation,
  type SharedWorldDecodeResult
} from "./shared-world.js";

type Vec3 = readonly [number, number, number];

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

function perspectiveCamera(): Record<string, unknown> {
  return {
    kind: "world-camera",
    version: SHARED_WORLD_VERSION,
    cameraId: "camera-1",
    settingsVersion: "settings-7",
    position: { u: -2, v: 4, h: 1.7 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: Math.PI / 3, nearMeters: 0.1, farMeters: 80 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    boundInstanceId: "instance-1"
  };
}

function isometricCamera(rotation: readonly number[]): Record<string, unknown> {
  return {
    ...perspectiveCamera(),
    cameraId: "camera-iso",
    rotation: [...rotation],
    projection: { kind: "isometric", verticalSizeMeters: 12, nearMeters: 0.05, farMeters: 200 }
  };
}

function completion(camera: Record<string, unknown>): Record<string, unknown> {
  return {
    canvasId: "canvas-1",
    runId: "run-1",
    completionId: "completion-1",
    cameraId: camera.cameraId,
    settingsVersion: camera.settingsVersion
  };
}

function historySnapshot(camera: Record<string, unknown> = perspectiveCamera()): Record<string, unknown> {
  return { version: WORLD_CAMERA_HISTORY_VERSION, completion: completion(camera), camera };
}

function normalize(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Quaternion of an orthonormal column basis [right, up, back]. */
function quatFromBasis(right: Vec3, up: Vec3, back: Vec3): [number, number, number, number] {
  const m00 = right[0], m01 = up[0], m02 = back[0];
  const m10 = right[1], m11 = up[1], m12 = back[1];
  const m20 = right[2], m21 = up[2], m22 = back[2];
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
}

/** Renderer rotation looking along `forward` with the given world-up hint. */
function rendererRotationFor(forward: Vec3, upHint: Vec3 = [0, 1, 0]): [number, number, number, number] {
  const back = normalize([-forward[0], -forward[1], -forward[2]]);
  const right = normalize(cross(upHint, back));
  const up = cross(back, right);
  return quatFromBasis(right, up, back);
}

/** World quaternion equivalent to a renderer-space rotation. */
function worldRotationFor(forward: Vec3, upHint: Vec3 = [0, 1, 0]): number[] {
  return [...rendererToWorldRotation(rendererRotationFor(forward, upHint))];
}

/** Renderer-space local -Z forward of a world rotation. */
function rendererForward(worldRotation: readonly number[]): Vec3 {
  const [x, y, z, w] = worldToRendererRotation(worldRotation as [number, number, number, number]);
  return normalize([-2 * (x * z + w * y), -2 * (y * z - w * x), 2 * (x * x + y * y) - 1]);
}

describe("world camera codec", () => {
  it("round-trips every perspective field and copies mutable references", () => {
    const input = deepFreeze(perspectiveCamera());
    const value = expectDecoded(decodeWorldCamera(input));
    expect(value).toMatchObject({
      kind: "world-camera",
      version: SHARED_WORLD_VERSION,
      cameraId: "camera-1",
      settingsVersion: "settings-7",
      boundInstanceId: "instance-1",
      position: { u: -2, v: 4, h: 1.7 },
      rotation: [0, 0, 0, 1],
      projection: { kind: "perspective", verticalFovRadians: Math.PI / 3, nearMeters: 0.1, farMeters: 80 },
      captureMode: { kind: "static" },
      aspect: { width: 16, height: 9 }
    });

    const encoded = encodeWorldCamera(value);
    expect(encoded).toEqual(input);
    expect(encoded).not.toBe(value);
    expect(expectDecoded(decodeWorldCamera(encoded))).toEqual(value);

    expect(value.position).not.toBe((input as { position: unknown }).position);
    expect(value.rotation).not.toBe((input as { rotation: unknown }).rotation);
    expect(value.projection).not.toBe((input as { projection: unknown }).projection);
    expect(value.aspect).not.toBe((input as { aspect: unknown }).aspect);
    expect(value.captureMode).not.toBe((input as { captureMode: unknown }).captureMode);

    (value.rotation as unknown as number[])[0] = 0.5;
    expect((input as { rotation: number[] }).rotation).toEqual([0, 0, 0, 1]);
    expect(expectDecoded(decodeWorldCamera(input)).rotation).toEqual([0, 0, 0, 1]);
  });

  it("round-trips isometric poses that point along an equal-axis direction", () => {
    const directions: Vec3[] = [
      [1, 1, -1],
      [1, -1, -1],
      [-1, -1, -1],
      [1, 1, 1]
    ];
    for (const direction of directions) {
      const rotation = worldRotationFor(direction);
      const input = deepFreeze(isometricCamera(rotation));
      const value = expectDecoded(decodeWorldCamera(input));
      expect(value.projection).toEqual({ kind: "isometric", verticalSizeMeters: 12, nearMeters: 0.05, farMeters: 200 });
      expect(value.rotation).toEqual(rotation);

      const forward = rendererForward(value.rotation);
      expect(Math.abs(forward[0])).toBeCloseTo(1 / Math.sqrt(3), 12);
      expect(Math.abs(forward[1])).toBeCloseTo(1 / Math.sqrt(3), 12);
      expect(Math.abs(forward[2])).toBeCloseTo(1 / Math.sqrt(3), 12);
      // Real rotation direction: local -Z follows the requested forward octant.
      expect(Math.sign(forward[0])).toBe(Math.sign(direction[0]));
      expect(Math.sign(forward[1])).toBe(Math.sign(direction[1]));
      expect(Math.sign(forward[2])).toBe(Math.sign(direction[2]));

      expect(encodeWorldCamera(value)).toEqual(input);
    }
  });

  it("accepts a grid-aligned downward isometric pose", () => {
    const rotation = worldRotationFor([0, -0.5, 1]);
    const input = deepFreeze(isometricCamera(rotation));
    const value = expectDecoded(decodeWorldCamera(input));
    const forward = rendererForward(value.rotation);
    expect(forward[1]).toBeLessThan(0);
    expect(Math.abs(forward[0])).toBeLessThan(1e-9);
    expect(encodeWorldCamera(value)).toEqual(input);
  });

  it("keeps an unresolved binding id instead of clearing it", () => {
    const input = deepFreeze({ ...perspectiveCamera(), boundInstanceId: "deleted-instance" });
    const value = expectDecoded(decodeWorldCamera(input));
    expect(value.boundInstanceId).toBe("deleted-instance");
    expect(encodeWorldCamera(value)).toEqual(input);
    expect(expectDecoded(decodeWorldCamera(encodeWorldCamera(value))).boundInstanceId).toBe("deleted-instance");

    const unbound = expectDecoded(decodeWorldCamera({ ...perspectiveCamera(), boundInstanceId: null }));
    expect(unbound.boundInstanceId).toBeNull();
  });

  it("rejects a non-isometric direction and a non-unit pose", () => {
    const identity = isometricCamera([0, 0, 0, 1]);
    expectRejected(decodeWorldCamera(identity), "invalid-data", identity);

    // Forward (0,0,-1) with a roll around it is still not an isometric direction.
    const rolled = isometricCamera([0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]);
    expectRejected(decodeWorldCamera(rolled), "invalid-data", rolled);

    const offAxis = isometricCamera(worldRotationFor([1, 1, -0.5]));
    expectRejected(decodeWorldCamera(offAxis), "invalid-data", offAxis);

    const scale = 1 + WORLD_ROTATION_UNIT_TOLERANCE * 4;
    const nonUnit = { ...perspectiveCamera(), rotation: [0, 0, 0, scale] };
    expectRejected(decodeWorldCamera(nonUnit), "invalid-data", nonUnit);
    // The same identity pose remains valid for perspective projection.
    expect(expectDecoded(decodeWorldCamera(perspectiveCamera())).rotation).toEqual([0, 0, 0, 1]);
  });

  it("rejects invalid fields at every allowlist layer", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["non-finite position", { position: { u: 0, v: Number.NaN, h: 0 } }],
      ["extra position axis", { position: { u: 0, v: 0, h: 0, w: 0 } }],
      ["empty camera id", { cameraId: "  " }],
      ["empty settings version", { settingsVersion: "" }],
      ["missing binding", { boundInstanceId: undefined }],
      ["empty binding", { boundInstanceId: "" }],
      ["unknown camera kind", { kind: "shot-camera" }],
      ["unknown camera field", { gpuHandle: "runtimeref" }],
      ["unknown capture mode", { captureMode: { kind: "loop" } }],
      ["capture mode extra field", { captureMode: { kind: "static", interval: 1 } }],
      ["non-positive aspect width", { aspect: { width: 0, height: 9 } }],
      ["non-finite aspect height", { aspect: { width: 16, height: Number.POSITIVE_INFINITY } }],
      ["aspect extra field", { aspect: { width: 16, height: 9, mode: "fit" } }],
      ["unknown projection mode", { projection: { kind: "orthographic", size: 4, nearMeters: 0.1, farMeters: 10 } }],
      ["isometric zero size", { projection: { kind: "isometric", verticalSizeMeters: 0, nearMeters: 0.1, farMeters: 10 } }],
      ["isometric extra field", { projection: { kind: "isometric", verticalSizeMeters: 12, nearMeters: 0.1, farMeters: 10, fov: 1 } }],
      ["near zero", { projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 0, farMeters: 10 } }],
      ["far equals near", { projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 10, farMeters: 10 } }],
      ["far lower than near", { projection: { kind: "perspective", verticalFovRadians: 1, nearMeters: 20, farMeters: 10 } }],
      ["fov zero", { projection: { kind: "perspective", verticalFovRadians: 0, nearMeters: 0.1, farMeters: 10 } }],
      ["fov pi", { projection: { kind: "perspective", verticalFovRadians: Math.PI, nearMeters: 0.1, farMeters: 10 } }],
      ["non-finite fov", { projection: { kind: "perspective", verticalFovRadians: Number.NaN, nearMeters: 0.1, farMeters: 10 } }],
      ["non-finite far", { projection: { kind: "isometric", verticalSizeMeters: 12, nearMeters: 0.1, farMeters: Number.NaN } }]
    ];
    for (const [label, patch] of cases) {
      const input = { ...perspectiveCamera(), ...patch };
      const result = decodeWorldCamera(input);
      expect(result.ok, label).toBe(false);
    }
  });

  it("reports unknown versions separately and rejects non-object input", () => {
    const unknownVersion = { ...perspectiveCamera(), version: "shared-world-v2" };
    expectRejected(decodeWorldCamera(unknownVersion), "unsupported-version", unknownVersion);
    const missingVersion = { ...perspectiveCamera() };
    delete (missingVersion as { version?: unknown }).version;
    expectRejected(decodeWorldCamera(missingVersion), "invalid-data", missingVersion);
    for (const input of [null, undefined, 3, "camera", [], new Date()]) {
      expectRejected(decodeWorldCamera(input), "invalid-data", input);
    }
  });

  it("throws from the camera encoder instead of silently repairing invalid data", () => {
    const invalid = isometricCamera([0, 0, 0, 1]) as unknown as Parameters<typeof encodeWorldCamera>[0];
    expect(() => encodeWorldCamera(invalid)).toThrow(SharedWorldCodecError);
    const alsoInvalid = { ...perspectiveCamera(), aspect: { width: 0, height: 9 } } as unknown as Parameters<typeof encodeWorldCamera>[0];
    expect(() => encodeWorldCamera(alsoInvalid)).toThrow(SharedWorldCodecError);
  });
});

describe("world camera history snapshot codec", () => {
  it("round-trips exactly completion and camera without world or runtime state", () => {
    const input = deepFreeze(historySnapshot());
    const value = expectDecoded(decodeWorldCameraHistorySnapshot(input));
    expect(value.version).toBe(WORLD_CAMERA_HISTORY_VERSION);
    expect(value.completion).toEqual({
      canvasId: "canvas-1",
      runId: "run-1",
      completionId: "completion-1",
      cameraId: "camera-1",
      settingsVersion: "settings-7"
    });
    expect(value.camera.cameraId).toBe("camera-1");
    expect(value.camera.boundInstanceId).toBe("instance-1");
    expect(Object.keys(value).sort()).toEqual(["camera", "completion", "version"]);

    const encoded = encodeWorldCameraHistorySnapshot(value);
    expect(encoded).toEqual(input);
    expect(expectDecoded(decodeWorldCameraHistorySnapshot(encoded))).toEqual(value);

    expect(value.completion).not.toBe((input as { completion: unknown }).completion);
    expect(value.camera).not.toBe((input as { camera: unknown }).camera);
    expect(value.camera.rotation).not.toBe((input as { camera: { rotation: unknown } }).camera.rotation);
  });

  it("requires completion camera identity and settings version to match the camera", () => {
    const wrongCamera = historySnapshot();
    (wrongCamera.completion as Record<string, unknown>).cameraId = "camera-2";
    expectRejected(decodeWorldCameraHistorySnapshot(wrongCamera), "invalid-data", wrongCamera);

    const wrongSettings = historySnapshot();
    (wrongSettings.completion as Record<string, unknown>).settingsVersion = "settings-8";
    expectRejected(decodeWorldCameraHistorySnapshot(wrongSettings), "invalid-data", wrongSettings);
  });

  it("rejects unknown history versions and any extra or missing field", () => {
    const unknownVersion = { ...historySnapshot(), version: "world-camera-history-v2" };
    expectRejected(decodeWorldCameraHistorySnapshot(unknownVersion), "unsupported-version", unknownVersion);

    const missingVersion = historySnapshot();
    delete (missingVersion as { version?: unknown }).version;
    expectRejected(decodeWorldCameraHistorySnapshot(missingVersion), "invalid-data", missingVersion);

    const extraTop = { ...historySnapshot(), world: { version: "x" } };
    expectRejected(decodeWorldCameraHistorySnapshot(extraTop), "invalid-data", extraTop);

    const extraCompletion = historySnapshot();
    (extraCompletion.completion as Record<string, unknown>).worldContentVersion = "v9";
    expectRejected(decodeWorldCameraHistorySnapshot(extraCompletion), "invalid-data", extraCompletion);

    const missingCompletion = historySnapshot();
    delete (missingCompletion.completion as Record<string, unknown>).runId;
    expectRejected(decodeWorldCameraHistorySnapshot(missingCompletion), "invalid-data", missingCompletion);

    for (const field of ["canvasId", "runId", "completionId", "cameraId", "settingsVersion"]) {
      const empty = historySnapshot();
      (empty.completion as Record<string, unknown>)[field] = "";
      expectRejected(decodeWorldCameraHistorySnapshot(empty), "invalid-data", empty);
    }
  });

  it("propagates a camera layer failure and throws from the encoder", () => {
    const badCamera = historySnapshot();
    (badCamera.camera as Record<string, unknown>).projection = {
      kind: "perspective", verticalFovRadians: Math.PI, nearMeters: 0.1, farMeters: 10
    };
    expectRejected(decodeWorldCameraHistorySnapshot(badCamera), "invalid-data", badCamera);

    const badVersionCamera = historySnapshot();
    (badVersionCamera.camera as Record<string, unknown>).version = "shared-world-v2";
    expectRejected(decodeWorldCameraHistorySnapshot(badVersionCamera), "unsupported-version", badVersionCamera);

    const invalid = { ...historySnapshot(), version: "nope" } as unknown as Parameters<typeof encodeWorldCameraHistorySnapshot>[0];
    expect(() => encodeWorldCameraHistorySnapshot(invalid)).toThrow(SharedWorldCodecError);
  });
});

describe("world camera completion key", () => {
  const base = {
    canvasId: "canvas-1",
    runId: "run-1",
    completionId: "completion-1",
    cameraId: "camera-1",
    settingsVersion: "settings-7"
  };

  it("serializes the stable four-field completion identity", () => {
    expect(worldCameraCompletionKey(base)).toBe(JSON.stringify(["canvas-1", "run-1", "completion-1", "camera-1"]));
    expect(worldCameraCompletionKey({ ...base })).toBe(worldCameraCompletionKey(base));
    expect(worldCameraCompletionKey({ ...base, settingsVersion: "settings-8" })).toBe(worldCameraCompletionKey(base));
    expect(worldCameraCompletionKey({ ...base, completionId: "completion-2" })).not.toBe(worldCameraCompletionKey(base));
  });

  it("does not collide when ids contain separator characters", () => {
    const joined = worldCameraCompletionKey({
      canvasId: "a,b", runId: "c", completionId: "d", cameraId: "e", settingsVersion: "s"
    });
    const split = worldCameraCompletionKey({
      canvasId: "a", runId: "b,c", completionId: "d", cameraId: "e", settingsVersion: "s"
    });
    expect(joined).not.toBe(split);
  });

  it("throws for an invalid completion identity", () => {
    expect(() => worldCameraCompletionKey({ ...base, canvasId: "" })).toThrow(SharedWorldCodecError);
    expect(() => worldCameraCompletionKey({ ...base, runId: "  " })).toThrow(SharedWorldCodecError);
  });

  it("stays fully synchronous", () => {
    const value = expectDecoded(decodeWorldCamera(perspectiveCamera()));
    expect(encodeWorldCamera(value)).not.toBeInstanceOf(Promise);
    expect(decodeWorldCamera(perspectiveCamera())).not.toBeInstanceOf(Promise);
    expect(decodeWorldCameraHistorySnapshot(historySnapshot())).not.toBeInstanceOf(Promise);
    expect(encodeWorldCameraHistorySnapshot(expectDecoded(decodeWorldCameraHistorySnapshot(historySnapshot())))).not.toBeInstanceOf(Promise);
    expect(worldCameraCompletionKey(base)).not.toBeInstanceOf(Promise);
  });
});
