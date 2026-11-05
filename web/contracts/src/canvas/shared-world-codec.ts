/**
 * Shared-world v1 pure codecs (OC01).
 *
 * These functions only serialize/validate the frozen T01 DTOs in `shared-world.ts`.
 * They perform no I/O and never consult storage, network or runtime state. A payload
 * is accepted only when every field is in the v1 allowlist, every number is finite,
 * the version is exactly `shared-world-v1` and the values satisfy the T01 rules:
 *
 * - world positions are meters `(u, v, h)`, ids/versions are nonempty strings;
 * - rotations are unit quaternions `[u, v, h, w]` within
 *   `WORLD_ROTATION_UNIT_TOLERANCE` (squared norm), scale is finite and positive;
 * - unknown versions report `unsupported-version`, everything else `invalid-data`.
 *
 * The camera payload codec belongs to OC05; a `world-camera` payload therefore does
 * not decode through the instance/creation-scope helpers. The full `SharedWorldCodec`
 * (including camera) is composed by T03/OC05 from these per-kind codecs.
 *
 * Decoders copy accepted values and never keep references to untrusted input, so a
 * failed decode leaves the caller's previous state and the original input untouched.
 * Encoders re-validate the typed value and throw `SharedWorldCodecError` instead of
 * emitting non-JSON numbers such as `NaN` or extra runtime/GPU fields.
 */

import {
  SHARED_WORLD_VERSION,
  WORLD_ROTATION_UNIT_TOLERANCE,
  type SharedWorldDecodeResult,
  type WorldInstanceData,
  type WorldPoint,
  type WorldRotation,
  type WorldTransform
} from "./shared-world.js";

export type SharedWorldCodecFailureCode = "unsupported-version" | "invalid-data";

export class SharedWorldCodecError extends Error {
  readonly code: SharedWorldCodecFailureCode;

  constructor(code: SharedWorldCodecFailureCode, message: string) {
    super(message);
    this.name = "SharedWorldCodecError";
    this.code = code;
  }
}

export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Own enumerable property only; inherited values never satisfy required fields. */
export function ownField(record: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

export function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every(key => allowed.has(key));
}

export function isNonEmptyWorldId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isFiniteWorldNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** `null` when the version is exactly v1; otherwise the failure code to report. */
export function readSharedWorldVersion(record: Record<string, unknown>): SharedWorldCodecFailureCode | null {
  const version = ownField(record, "version");
  if (typeof version !== "string" || version.length === 0) return "invalid-data";
  return version === SHARED_WORLD_VERSION ? null : "unsupported-version";
}

export function decodeFailure<T>(code: SharedWorldCodecFailureCode, input: unknown): SharedWorldDecodeResult<T> {
  return { ok: false, code, input };
}

export function codecFailureError(code: SharedWorldCodecFailureCode, label: string): SharedWorldCodecError {
  return new SharedWorldCodecError(code, `${label} 不是可持久化的 ${SHARED_WORLD_VERSION} 配置：${code}`);
}

/**
 * Common header for kind-discriminated node payloads: structure, discriminant,
 * version and top-level allowlist. Value validation stays with each codec.
 */
export function readKindedRecord(
  input: unknown,
  kind: string,
  keys: readonly string[]
): { ok: true; record: Record<string, unknown> } | { ok: false; code: SharedWorldCodecFailureCode } {
  if (!isJsonRecord(input)) return { ok: false, code: "invalid-data" };
  if (ownField(input, "kind") !== kind) return { ok: false, code: "invalid-data" };
  const versionFailure = readSharedWorldVersion(input);
  if (versionFailure) return { ok: false, code: versionFailure };
  if (!hasOnlyKeys(input, keys)) return { ok: false, code: "invalid-data" };
  return { ok: true, record: input };
}

const POINT_KEYS = ["u", "v", "h"] as const;
const ROTATION_LENGTH = 4;
const TRANSFORM_KEYS = ["version", "position", "rotation", "scale"] as const;
const WORLD_INSTANCE_KIND = "world-instance";
const WORLD_INSTANCE_KEYS = ["kind", "version", "instanceId", "transform"] as const;

/** Finite `(u, v, h)` meters; extra axis keys are rejected. */
export function decodeWorldPoint(input: unknown): WorldPoint | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, POINT_KEYS)) return null;
  const u = ownField(input, "u");
  const v = ownField(input, "v");
  const h = ownField(input, "h");
  if (!isFiniteWorldNumber(u) || !isFiniteWorldNumber(v) || !isFiniteWorldNumber(h)) return null;
  return { u, v, h };
}

/** Finite unit quaternion `[u, v, h, w]`; only the squared-norm tolerance is relaxed. */
export function decodeWorldRotation(input: unknown): WorldRotation | null {
  if (!Array.isArray(input) || input.length !== ROTATION_LENGTH) return null;
  const values: number[] = [];
  for (const value of input) {
    if (!isFiniteWorldNumber(value)) return null;
    values.push(value);
  }
  const [u, v, h, w] = values as [number, number, number, number];
  const squaredNorm = u * u + v * v + h * h + w * w;
  if (Math.abs(squaredNorm - 1) > WORLD_ROTATION_UNIT_TOLERANCE) return null;
  return [u, v, h, w];
}

/** Decode a v1 world transform; the coordinate adapter is applied by consumers. */
export function decodeWorldTransform(input: unknown): SharedWorldDecodeResult<WorldTransform> {
  if (!isJsonRecord(input)) return decodeFailure("invalid-data", input);
  const versionFailure = readSharedWorldVersion(input);
  if (versionFailure) return decodeFailure(versionFailure, input);
  if (!hasOnlyKeys(input, TRANSFORM_KEYS)) return decodeFailure("invalid-data", input);
  const position = decodeWorldPoint(ownField(input, "position"));
  const rotation = decodeWorldRotation(ownField(input, "rotation"));
  const rawScale = ownField(input, "scale");
  const scale = isFiniteWorldNumber(rawScale) && rawScale > 0 ? rawScale : null;
  if (!position || !rotation || scale === null) return decodeFailure("invalid-data", input);
  return { ok: true, value: { version: SHARED_WORLD_VERSION, position, rotation, scale } };
}

/** Decode `sharedWorldInstance` node data; legacy layout/GPU fields are unknown keys. */
export function decodeWorldInstanceData(input: unknown): SharedWorldDecodeResult<WorldInstanceData> {
  const read = readKindedRecord(input, WORLD_INSTANCE_KIND, WORLD_INSTANCE_KEYS);
  if (!read.ok) return decodeFailure(read.code, input);
  const instanceId = ownField(read.record, "instanceId");
  if (!isNonEmptyWorldId(instanceId)) return decodeFailure("invalid-data", input);
  const transform = decodeWorldTransform(ownField(read.record, "transform"));
  if (!transform.ok) return decodeFailure(transform.code, input);
  return {
    ok: true,
    value: { kind: WORLD_INSTANCE_KIND, version: SHARED_WORLD_VERSION, instanceId, transform: transform.value }
  };
}

/** Canonical JSON for a transform; throws when the typed value is not v1-valid. */
export function encodeWorldTransform(value: WorldTransform): unknown {
  const decoded = decodeWorldTransform(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界变换");
  return decoded.value;
}

export function encodeWorldPoint(value: WorldPoint): unknown {
  const decoded = decodeWorldPoint(value);
  if (!decoded) throw codecFailureError("invalid-data", "世界位置");
  return decoded;
}

export function encodeWorldRotation(value: WorldRotation): unknown {
  const decoded = decodeWorldRotation(value);
  if (!decoded) throw codecFailureError("invalid-data", "世界姿态");
  return decoded;
}

export function encodeWorldInstanceData(value: WorldInstanceData): unknown {
  const decoded = decodeWorldInstanceData(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界实例");
  return decoded.value;
}
