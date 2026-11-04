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
  WORLD_ROTATION_UNIT_TOLERANCE,
  worldToRendererRotation,
  type SharedWorldDecodeResult,
  type WorldCameraCaptureMode,
  type WorldCameraData,
  type WorldCameraProjection,
  type WorldCompletion
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
