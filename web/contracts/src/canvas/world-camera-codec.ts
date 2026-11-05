/**
 * Shared-world camera codecs (OC05a).
 *
 * Pure, I/O-free serialization for the frozen T01 camera DTO and its assistant
 * completion history. No decoder consults storage, the database or runtime state,
 * so a binding that no longer resolves is preserved verbatim: the codec never
 * clears `boundInstanceId` just because the target is missing.
 *
 * Rules enforced here come from `shared-world.ts`:
 *
 * - every payload is an exact v1 allowlist; unknown/extra fields are rejected;
 * - ids and versions (`settingsVersion`) are nonempty strings;
 * - world positions are finite meters, rotations are finite unit quaternions
 *   `[u, v, h, w]` within `WORLD_ROTATION_UNIT_TOLERANCE` (squared norm);
 * - projection requires `0 < near < far`, positive isometric vertical size,
 *   perspective FOV strictly between 0 and pi;
 * - aspect width/height are finite and positive;
 * - an isometric pose's normalized forward direction (local -Z rotated into the
 *   Y-up renderer) has equal absolute components on all renderer axes. The pose
 *   picks the viewing octant and roll; it is not reconstructed from the angle.
 *
 * History snapshots are exactly `{version, completion, camera}`. Completion
 * carries the five stable fields and its `cameraId` / `settingsVersion` must
 * match the snapshot camera. The completion key is
 * `JSON.stringify([canvasId, runId, completionId, cameraId])`, which is stable
 * and cannot collide on separator characters in ids. Duplicate-completion
 * intent checks and durable transactions belong to T08, not this module.
 */

import {
  SHARED_WORLD_VERSION,
  WORLD_ROTATION_INPUT_TOLERANCE,
  WORLD_ROTATION_UNIT_TOLERANCE,
  worldToRendererRotation,
  type SharedWorldDecodeResult,
  type WorldCameraCaptureMode,
  type WorldCameraData,
  type WorldCameraProjection,
  type WorldCompletion,
  type WorldRotation
} from "./shared-world.js";
import {
  codecFailureError,
  decodeFailure,
  decodeWorldPoint,
  decodeWorldRotation,
  hasOnlyKeys,
  isFiniteWorldNumber,
  isJsonRecord,
  isNonEmptyWorldId,
  ownField,
  readKindedRecord
} from "./shared-world-codec.js";

export const WORLD_CAMERA_HISTORY_VERSION = "world-camera-history-v1" as const;

/** History persists only the completion intent and the camera settings. World,
 * models, captures, playback, locks and local resources are deliberately absent. */
export interface WorldCameraHistorySnapshot {
  version: typeof WORLD_CAMERA_HISTORY_VERSION;
  completion: WorldCompletion;
  camera: WorldCameraData;
}

const CAMERA_KIND = "world-camera";
const CAMERA_KEYS = [
  "kind",
  "version",
  "cameraId",
  "settingsVersion",
  "position",
  "rotation",
  "projection",
  "captureMode",
  "aspect",
  "boundInstanceId"
] as const;
const ISOMETRIC_PROJECTION_KEYS = ["kind", "verticalSizeMeters", "nearMeters", "farMeters"] as const;
const PERSPECTIVE_PROJECTION_KEYS = ["kind", "verticalFovRadians", "nearMeters", "farMeters"] as const;
const CAPTURE_MODE_KEYS = ["kind"] as const;
const ASPECT_KEYS = ["width", "height"] as const;
const HISTORY_KEYS = ["version", "completion", "camera"] as const;
const COMPLETION_KEYS = ["canvasId", "runId", "completionId", "cameraId", "settingsVersion"] as const;

/** Expected absolute component of a normalized isometric forward direction. */
const ISOMETRIC_FORWARD_COMPONENT = 1 / Math.sqrt(3);

/** Decode a `worldCamera` node payload, including the isometric direction rule. */
export function decodeWorldCamera(input: unknown): SharedWorldDecodeResult<WorldCameraData> {
  const read = readKindedRecord(input, CAMERA_KIND, CAMERA_KEYS);
  if (!read.ok) return decodeFailure(read.code, input);
  const record = read.record;
  const cameraId = ownField(record, "cameraId");
  const settingsVersion = ownField(record, "settingsVersion");
  if (!isNonEmptyWorldId(cameraId) || !isNonEmptyWorldId(settingsVersion)) {
    return decodeFailure("invalid-data", input);
  }

  const position = decodeWorldPoint(ownField(record, "position"));
  const rotation = decodeWorldRotation(ownField(record, "rotation"));
  const projection = decodeCameraProjection(ownField(record, "projection"));
  const captureMode = decodeCameraCaptureMode(ownField(record, "captureMode"));
  const aspect = decodeCameraAspect(ownField(record, "aspect"));
  const rawBinding = ownField(record, "boundInstanceId");
  const boundInstanceId = rawBinding === null ? null : isNonEmptyWorldId(rawBinding) ? rawBinding : undefined;

  if (!position || !rotation || !projection || !captureMode || !aspect || boundInstanceId === undefined) {
    return decodeFailure("invalid-data", input);
  }
  if (projection.kind === "isometric" && !isIsometricForward(rotation)) {
    return decodeFailure("invalid-data", input);
  }

  return {
    ok: true,
    value: {
      kind: CAMERA_KIND,
      version: SHARED_WORLD_VERSION,
      cameraId,
      settingsVersion,
      position,
      rotation,
      projection,
      captureMode,
      aspect,
      boundInstanceId
    }
  };
}

/**
 * Canonicalize an author-supplied rotation: exact unit quaternions pass through,
 * a slightly off one is normalized, anything further off is rejected. Storage still
 * validates with `WORLD_ROTATION_UNIT_TOLERANCE`; this only relaxes authoring input
 * so a hand-written `0.7071` does not fail an otherwise valid camera write.
 */
export function canonicalizeWorldCameraRotation(input: unknown): WorldRotation | null {
  const strict = decodeWorldRotation(input);
  if (strict) return strict;
  if (!Array.isArray(input) || input.length !== 4) return null;
  if (!input.every(value => typeof value === "number" && Number.isFinite(value))) return null;
  const [u, v, h, w] = input as [number, number, number, number];
  const squaredNorm = u * u + v * v + h * h + w * w;
  if (!(squaredNorm > 0) || Math.abs(squaredNorm - 1) > WORLD_ROTATION_INPUT_TOLERANCE) return null;
  const scale = 1 / Math.sqrt(squaredNorm);
  return decodeWorldRotation([u * scale, v * scale, h * scale, w * scale]);
}

/** First invalid camera-settings field, in a form an author can act on. */
export type WorldCameraSettingsDiagnosis = {
  field: "position" | "rotation" | "projection" | "captureMode" | "aspect" | "boundInstanceId";
  message: string;
};

/**
 * Explain why a settings payload would fail `decodeWorldCamera`. Returns `null` when
 * the payload is writable (after rotation normalization). Pure; no I/O.
 */
export function diagnoseWorldCameraSettings(input: unknown): WorldCameraSettingsDiagnosis | null {
  if (!isJsonRecord(input)) return { field: "position", message: "镜头设置必须是对象" };
  const position = ownField(input, "position");
  if (
    !isJsonRecord(position) ||
    !isFiniteWorldNumber(ownField(position, "u")) ||
    !isFiniteWorldNumber(ownField(position, "v")) ||
    !isFiniteWorldNumber(ownField(position, "h"))
  ) {
    return { field: "position", message: "机位必须是有限数值 { u, v, h }" };
  }
  const rotationInput = ownField(input, "rotation");
  const rotation = canonicalizeWorldCameraRotation(rotationInput);
  if (!rotation) {
    return {
      field: "rotation",
      message: `旋转四元数不是单位四元数：${rotationDetail(rotationInput)}。请传全精度值（例如 0.7071067811865476），或改用 lookAt`
    };
  }
  const projection = ownField(input, "projection");
  if (!isJsonRecord(projection)) return { field: "projection", message: "镜头投影必须是对象" };
  const kind = ownField(projection, "kind");
  if (kind === "perspective") {
    const fov = ownField(projection, "verticalFovRadians");
    if (!isFiniteWorldNumber(fov) || !(fov > 0) || !(fov < Math.PI)) {
      return { field: "projection", message: "透视垂直视野 verticalFovRadians 必须在 (0, π) 弧度内" };
    }
  } else if (kind === "isometric") {
    const size = ownField(projection, "verticalSizeMeters");
    if (!isFiniteWorldNumber(size) || size <= 0) {
      return { field: "projection", message: "等距取景范围 verticalSizeMeters 必须大于 0" };
    }
    if (!isIsometricForward(rotation)) {
      return { field: "rotation", message: "等距镜头的朝向必须是等距轴方向（等轴测八分体，或沿网格轴俯视）" };
    }
  } else {
    return { field: "projection", message: "镜头投影只支持 isometric 或 perspective" };
  }
  const near = ownField(projection, "nearMeters");
  const far = ownField(projection, "farMeters");
  if (!isFiniteWorldNumber(near) || !(near > 0)) {
    return { field: "projection", message: "nearMeters 必须大于 0" };
  }
  if (!isFiniteWorldNumber(far) || !(far > near)) {
    return { field: "projection", message: "farMeters 必须大于 nearMeters" };
  }
  const captureMode = ownField(input, "captureMode");
  const captureKind = isJsonRecord(captureMode) ? ownField(captureMode, "kind") : null;
  if (captureKind !== "static" && captureKind !== "dynamic") {
    return { field: "captureMode", message: "拍摄方式只能是 static 或 dynamic" };
  }
  const aspect = ownField(input, "aspect");
  const width = isJsonRecord(aspect) ? ownField(aspect, "width") : null;
  const height = isJsonRecord(aspect) ? ownField(aspect, "height") : null;
  if (!isFiniteWorldNumber(width) || !(width > 0) || !isFiniteWorldNumber(height) || !(height > 0)) {
    return { field: "aspect", message: "画幅 width/height 必须是正数" };
  }
  const boundInstanceId = ownField(input, "boundInstanceId");
  if (boundInstanceId !== null && !isNonEmptyWorldId(boundInstanceId)) {
    return { field: "boundInstanceId", message: "boundInstanceId 必须是非空字符串或 null" };
  }
  return null;
}

function rotationDetail(input: unknown): string {
  if (!Array.isArray(input) || input.length !== 4) return "需要 [x, y, z, w] 四个数值";
  if (!input.every(value => typeof value === "number" && Number.isFinite(value))) return "包含非有限数值";
  const values = input as [number, number, number, number];
  const squaredNorm = values.reduce((sum, value) => sum + value * value, 0);
  return `平方和 ${String(Number(squaredNorm.toFixed(10)))}，允许偏差 ${WORLD_ROTATION_INPUT_TOLERANCE}`;
}

/** Re-validate and canonicalize a camera; throws instead of emitting invalid data. */
export function encodeWorldCamera(value: WorldCameraData): unknown {
  const decoded = decodeWorldCamera(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界镜头");
  return decoded.value;
}

/** Decode the frozen assistant completion history snapshot. */
export function decodeWorldCameraHistorySnapshot(
  input: unknown
): SharedWorldDecodeResult<WorldCameraHistorySnapshot> {
  if (!isJsonRecord(input)) return decodeFailure("invalid-data", input);
  const version = ownField(input, "version");
  if (typeof version !== "string" || version.length === 0) return decodeFailure("invalid-data", input);
  if (version !== WORLD_CAMERA_HISTORY_VERSION) return decodeFailure("unsupported-version", input);
  if (!hasOnlyKeys(input, HISTORY_KEYS)) return decodeFailure("invalid-data", input);

  const completion = decodeCompletion(ownField(input, "completion"));
  if (!completion) return decodeFailure("invalid-data", input);
  const camera = decodeWorldCamera(ownField(input, "camera"));
  if (!camera.ok) return decodeFailure(camera.code, input);
  if (completion.cameraId !== camera.value.cameraId || completion.settingsVersion !== camera.value.settingsVersion) {
    return decodeFailure("invalid-data", input);
  }

  return {
    ok: true,
    value: {
      version: WORLD_CAMERA_HISTORY_VERSION,
      completion,
      camera: camera.value
    }
  };
}

/** Re-validate and canonicalize a history snapshot; throws on invalid data. */
export function encodeWorldCameraHistorySnapshot(value: WorldCameraHistorySnapshot): unknown {
  const decoded = decodeWorldCameraHistorySnapshot(value);
  if (!decoded.ok) throw codecFailureError(decoded.code, "世界镜头历史");
  return decoded.value;
}

/** Stable completion key: `["canvasId","runId","completionId","cameraId"]` as JSON.
 * JSON array encoding avoids separator collisions when ids contain delimiters. */
export function worldCameraCompletionKey(completion: WorldCompletion): string {
  const decoded = decodeCompletion(completion);
  if (!decoded) throw codecFailureError("invalid-data", "镜头完成身份");
  return JSON.stringify([decoded.canvasId, decoded.runId, decoded.completionId, decoded.cameraId]);
}

function decodeCompletion(input: unknown): WorldCompletion | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, COMPLETION_KEYS)) return null;
  const canvasId = ownField(input, "canvasId");
  const runId = ownField(input, "runId");
  const completionId = ownField(input, "completionId");
  const cameraId = ownField(input, "cameraId");
  const settingsVersion = ownField(input, "settingsVersion");
  if (
    !isNonEmptyWorldId(canvasId) ||
    !isNonEmptyWorldId(runId) ||
    !isNonEmptyWorldId(completionId) ||
    !isNonEmptyWorldId(cameraId) ||
    !isNonEmptyWorldId(settingsVersion)
  ) {
    return null;
  }
  return { canvasId, runId, completionId, cameraId, settingsVersion };
}

function decodeCameraProjection(input: unknown): WorldCameraProjection | null {
  if (!isJsonRecord(input)) return null;
  const kind = ownField(input, "kind");
  if (kind === "isometric") {
    if (!hasOnlyKeys(input, ISOMETRIC_PROJECTION_KEYS)) return null;
    const size = ownField(input, "verticalSizeMeters");
    const near = ownField(input, "nearMeters");
    const far = ownField(input, "farMeters");
    if (!isFiniteWorldNumber(size) || size <= 0) return null;
    if (!isFiniteWorldNumber(near) || !isFiniteWorldNumber(far) || !(near > 0) || !(far > near)) return null;
    return { kind: "isometric", verticalSizeMeters: size, nearMeters: near, farMeters: far };
  }
  if (kind === "perspective") {
    if (!hasOnlyKeys(input, PERSPECTIVE_PROJECTION_KEYS)) return null;
    const fov = ownField(input, "verticalFovRadians");
    const near = ownField(input, "nearMeters");
    const far = ownField(input, "farMeters");
    if (!isFiniteWorldNumber(fov) || !(fov > 0) || !(fov < Math.PI)) return null;
    if (!isFiniteWorldNumber(near) || !isFiniteWorldNumber(far) || !(near > 0) || !(far > near)) return null;
    return { kind: "perspective", verticalFovRadians: fov, nearMeters: near, farMeters: far };
  }
  return null;
}

function decodeCameraCaptureMode(input: unknown): WorldCameraCaptureMode | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, CAPTURE_MODE_KEYS)) return null;
  const kind = ownField(input, "kind");
  return kind === "static" || kind === "dynamic" ? { kind } : null;
}

function decodeCameraAspect(input: unknown): { width: number; height: number } | null {
  if (!isJsonRecord(input) || !hasOnlyKeys(input, ASPECT_KEYS)) return null;
  const width = ownField(input, "width");
  const height = ownField(input, "height");
  if (!isFiniteWorldNumber(width) || !isFiniteWorldNumber(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

/**
 * Rotate the renderer-space local forward `(0, 0, -1)` by the camera rotation and
 * require its normalized absolute components to be equal on x, y and z. The world
 * quaternion is converted with the frozen adapter before the check so the rule is
 * evaluated in the Y-up renderer basis the camera actually uses.
 */
function isIsometricForward(rotation: readonly [number, number, number, number]): boolean {
  const forward = rendererForward(rotation);
  const length = Math.hypot(forward[0], forward[1], forward[2]);
  if (!Number.isFinite(length) || length === 0) return false;
  const normalized = forward.map((component) => component / length) as [number, number, number];
  // Canonical isometric octant: equal absolute components on every renderer axis.
  if (normalized.every((component) =>
    Math.abs(Math.abs(component) - ISOMETRIC_FORWARD_COMPONENT) <= WORLD_ROTATION_UNIT_TOLERANCE
  )) {
    return true;
  }
  // Grid-aligned orthographic pose: look down while the horizontal component follows
  // one of the two isometric grid axes. This keeps the initial lens pointing along a
  // grid line (screen lower-left/right) instead of straight into the screen.
  const horizontal = Math.hypot(normalized[0], normalized[2]);
  if (horizontal <= WORLD_ROTATION_UNIT_TOLERANCE || normalized[1] >= 0) return false;
  return Math.abs(normalized[0]) <= WORLD_ROTATION_UNIT_TOLERANCE
    || Math.abs(normalized[2]) <= WORLD_ROTATION_UNIT_TOLERANCE;
}

/** Renderer-space forward direction of a world rotation: local `-Z` rotated. */
function rendererForward(
  rotation: readonly [number, number, number, number]
): readonly [number, number, number] {
  const [x, y, z, w] = worldToRendererRotation(rotation);
  return [-2 * (x * z + w * y), -2 * (y * z - w * x), 2 * (x * x + y * y) - 1];
}
