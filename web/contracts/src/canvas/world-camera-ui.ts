/**
 * World-camera settings UI contract (shared-world authoring).
 *
 * Pure, side-effect-free helpers shared by the canvas menu, the camera settings panel
 * and their tests. This module never talks to storage, the canvas service or the
 * renderer: it only describes editable camera settings and derives validated values
 * that the authoritative `world-camera-save` / `world-camera-restore` ports accept.
 *
 * Product rules encoded here:
 *
 * - a camera always has a concrete projection (`isometric` or `perspective`);
 * - isometric is a real pose requirement, not "perspective off" (see
 *   `world-camera-codec.ts`); switching to isometric from an arbitrary perspective
 *   pose therefore resets the rotation to the canonical viewing octant;
 * - aspect and framing are camera settings only, never card geometry;
 * - an unbound camera sees the whole shared world; a bound camera names at most one
 *   world-model instance. A missing bound target stays bound (never silently becomes
 *   the whole world) so the UI can report it and offer an explicit unbind.
 */
import {
  SHARED_WORLD_VERSION,
  WORLD_ROTATION_UNIT_TOLERANCE,
  rendererToWorldRotation,
  worldToRendererRotation,
  type GroundPoint,
  type RendererRotation,
  type RendererVector,
  type WorldCameraCaptureMode,
  type WorldCameraData,
  type WorldCameraProjection,
  type WorldId,
  type WorldPoint,
  type WorldRotation
} from "./shared-world.js";
import { decodeWorldInstanceData } from "./shared-world-codec.js";

/** Camera cards stay independent of framing; this is presentation card geometry only. */
export const WORLD_CAMERA_CARD_SIZE = { width: 248, height: 156 } as const;

/** Default camera distance from the picked ground point (meters). The position is derived
 * from the canonical isometric forward direction so the creation point stays centered. */
export const WORLD_CAMERA_DEFAULT_DISTANCE_METERS = 12;
export const WORLD_CAMERA_DEFAULT_VERTICAL_SIZE_METERS = 8;
export const WORLD_CAMERA_DEFAULT_FOV_RADIANS = Math.PI / 3;
export const WORLD_CAMERA_DEFAULT_NEAR_METERS = 0.1;
export const WORLD_CAMERA_DEFAULT_FAR_METERS = 500;

export type WorldCameraUiSettings = {
  position: WorldPoint;
  rotation: WorldRotation;
  projection: WorldCameraProjection;
  captureMode: WorldCameraCaptureMode;
  aspect: { width: number; height: number };
  boundInstanceId: WorldId | null;
};

export type WorldCameraAspectPreset = Readonly<{
  id: "16:9" | "4:3" | "1:1" | "9:16";
  label: string;
  width: number;
  height: number;
}>;

export const WORLD_CAMERA_ASPECT_PRESETS: readonly WorldCameraAspectPreset[] = [
  { id: "16:9", label: "16:9", width: 16, height: 9 },
  { id: "4:3", label: "4:3", width: 4, height: 3 },
  { id: "1:1", label: "1:1", width: 1, height: 1 },
  { id: "9:16", label: "9:16", width: 9, height: 16 }
];

export type WorldCameraBindingTarget =
  | { status: "unbound" }
  | { status: "bound"; instanceId: WorldId; nodeId: string; label: string }
  | { status: "missing"; instanceId: WorldId; label: string };

export type WorldCameraBindingOption = Readonly<{ value: string; label: string }>;

/** Minimal canvas shape needed for binding options; keeps this module free of I/O. */
export type WorldCameraUiCanvas = Readonly<{
  document: Readonly<{ nodes: readonly Readonly<{ id: string; type: string }>[] }>;
  nodeData: Readonly<Record<string, unknown>>;
}>;

/**
 * Default camera pose: look down and toward the lower-left screen direction, with the
 * horizontal component following the `-v` isometric grid axis. The camera therefore
 * sits above/right of its target and its lens points along the grid line instead of
 * straight into the screen.
 */
export function defaultIsometricCameraRotation(): WorldRotation {
  const forward = normalize([0, -0.5, 1]);
  return [...rendererToWorldRotation(rendererRotationFor(forward))];
}

export function isWorldCameraIsometricRotation(rotation: WorldRotation): boolean {
  const forward = rendererForwardOf(rotation);
  const expected = 1 / Math.sqrt(3);
  if (forward.every((value) => Math.abs(Math.abs(value) - expected) <= WORLD_ROTATION_UNIT_TOLERANCE)) {
    return true;
  }
  const horizontal = Math.hypot(forward[0], forward[2]);
  if (horizontal <= WORLD_ROTATION_UNIT_TOLERANCE || forward[1] >= 0) return false;
  return Math.abs(forward[0]) <= WORLD_ROTATION_UNIT_TOLERANCE
    || Math.abs(forward[2]) <= WORLD_ROTATION_UNIT_TOLERANCE;
}

export function defaultWorldCameraProjection(kind: "isometric" | "perspective" = "perspective"): WorldCameraProjection {
  return kind === "isometric"
    ? {
        kind: "isometric",
        verticalSizeMeters: WORLD_CAMERA_DEFAULT_VERTICAL_SIZE_METERS,
        nearMeters: WORLD_CAMERA_DEFAULT_NEAR_METERS,
        farMeters: WORLD_CAMERA_DEFAULT_FAR_METERS
      }
    : {
        kind: "perspective",
        verticalFovRadians: WORLD_CAMERA_DEFAULT_FOV_RADIANS,
        nearMeters: WORLD_CAMERA_DEFAULT_NEAR_METERS,
        farMeters: WORLD_CAMERA_DEFAULT_FAR_METERS
      };
}

/** Full, codec-valid camera payload for a freshly created card. */
export function createDefaultWorldCameraData(
  cameraId: WorldId,
  settingsVersion: WorldId,
  ground: Readonly<{ u: number; v: number }>
): WorldCameraData {
  const rotation = defaultIsometricCameraRotation();
  const forward = worldForwardOf(rotation);
  const distance = WORLD_CAMERA_DEFAULT_DISTANCE_METERS;
  return {
    kind: "world-camera",
    version: SHARED_WORLD_VERSION,
    cameraId,
    settingsVersion,
    position: {
      u: ground.u - forward.u * distance,
      v: ground.v - forward.v * distance,
      h: -forward.h * distance
    },
    rotation,
    projection: defaultWorldCameraProjection("perspective"),
    captureMode: { kind: "static" },
    aspect: { width: WORLD_CAMERA_ASPECT_PRESETS[0].width, height: WORLD_CAMERA_ASPECT_PRESETS[0].height },
    boundInstanceId: null
  };
}

/**
 * Rotation whose forward axis points from `from` toward `target` (world meters).
 * Returns `null` when the points coincide or the direction is straight up/down,
 * because the right axis would be undefined. Used by the authoring tools so callers
 * can name a subject instead of hand-writing a quaternion.
 */
export function worldCameraRotationLookingAt(from: WorldPoint, target: WorldPoint): WorldRotation | null {
  const du = target.u - from.u;
  const dv = target.v - from.v;
  const dh = target.h - from.h;
  const length = Math.hypot(du, dh, dv);
  if (!Number.isFinite(length) || length <= 1e-9) return null;
  if (Math.hypot(du, dv) <= 1e-9) return null;
  const forward: RendererVector = [du / length, dh / length, -dv / length];
  return [...rendererToWorldRotation(rendererRotationFor(forward))];
}

/**
 * Where a camera actually looks, derived from its pose (world meters).
 *
 * Agent tools hand this back after a camera write so the caller can check the
 * framing instead of assuming "the write succeeded" means "it points at the
 * subject": `forward` is the unit view direction and `groundIntersection` is
 * where that axis meets `h = 0` (null when level or looking upward).
 */
export type WorldCameraView = {
  forward: WorldPoint;
  groundIntersection: GroundPoint | null;
};

export function worldCameraView(settings: Pick<WorldCameraUiSettings, "position" | "rotation">): WorldCameraView {
  const renderer = rotateRenderer(worldToRendererRotation(settings.rotation), [0, 0, -1]);
  const forward: WorldPoint = { u: renderer[0], v: -renderer[2], h: renderer[1] };
  const groundIntersection = forward.h < -1e-9 && settings.position.h > 0
    ? {
        u: settings.position.u + forward.u * (settings.position.h / -forward.h),
        v: settings.position.v + forward.v * (settings.position.h / -forward.h)
      }
    : null;
  return { forward, groundIntersection };
}

/** Rotate a renderer vector by a renderer rotation `[x, y, z, w]` (Hamilton product). */
function rotateRenderer(q: RendererRotation, v: RendererVector): RendererVector {
  const [x, y, z, w] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx)
  ];
}


export function worldCameraUiSettingsOf(camera: WorldCameraData): WorldCameraUiSettings {
  return {
    position: { ...camera.position },
    rotation: [...camera.rotation] as WorldRotation,
    projection: { ...camera.projection },
    captureMode: { ...camera.captureMode },
    aspect: { ...camera.aspect },
    boundInstanceId: camera.boundInstanceId
  };
}

export function worldCameraSettingsEqual(a: WorldCameraUiSettings, b: WorldCameraUiSettings): boolean {
  return a.position.u === b.position.u && a.position.v === b.position.v && a.position.h === b.position.h
    && a.rotation[0] === b.rotation[0] && a.rotation[1] === b.rotation[1]
    && a.rotation[2] === b.rotation[2] && a.rotation[3] === b.rotation[3]
    && a.projection.kind === b.projection.kind
    && projectionNumbers(a.projection).every((value, index) => value === projectionNumbers(b.projection)[index])
    && a.captureMode.kind === b.captureMode.kind
    && a.aspect.width === b.aspect.width && a.aspect.height === b.aspect.height
    && a.boundInstanceId === b.boundInstanceId;
}

export function withWorldCameraProjectionKind(
  settings: WorldCameraUiSettings,
  kind: WorldCameraProjection["kind"]
): WorldCameraUiSettings {
  if (settings.projection.kind === kind) return settings;
  const near = settings.projection.nearMeters;
  const far = settings.projection.farMeters;
  if (kind === "isometric") {
    return {
      ...settings,
      rotation: isWorldCameraIsometricRotation(settings.rotation) ? settings.rotation : defaultIsometricCameraRotation(),
      projection: {
        kind: "isometric",
        verticalSizeMeters: WORLD_CAMERA_DEFAULT_VERTICAL_SIZE_METERS,
        nearMeters: near,
        farMeters: far
      }
    };
  }
  return {
    ...settings,
    projection: {
      kind: "perspective",
      verticalFovRadians: WORLD_CAMERA_DEFAULT_FOV_RADIANS,
      nearMeters: near,
      farMeters: far
    }
  };
}

export type WorldCameraFramingControl = Readonly<{
  kind: WorldCameraProjection["kind"];
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  unit: string;
}>;

/** User-facing framing control: isometric vertical size or perspective vertical FOV. */
export function worldCameraFramingControl(settings: WorldCameraUiSettings): WorldCameraFramingControl {
  if (settings.projection.kind === "isometric") {
    return {
      kind: "isometric",
      value: settings.projection.verticalSizeMeters,
      min: 0.5,
      max: 80,
      step: 0.5,
      label: "取景范围",
      unit: "m"
    };
  }
  return {
    kind: "perspective",
    value: Math.round((settings.projection.verticalFovRadians * 180 / Math.PI) * 10) / 10,
    min: 10,
    max: 120,
    step: 1,
    label: "垂直视野",
    unit: "°"
  };
}

export function withWorldCameraFraming(settings: WorldCameraUiSettings, value: number): WorldCameraUiSettings {
  if (!Number.isFinite(value)) return settings;
  const control = worldCameraFramingControl(settings);
  const clamped = Math.min(control.max, Math.max(control.min, value));
  if (settings.projection.kind === "isometric") {
    return { ...settings, projection: { ...settings.projection, verticalSizeMeters: clamped } };
  }
  return {
    ...settings,
    projection: {
      ...settings.projection,
      verticalFovRadians: Math.min(Math.PI - 1e-6, clamped * Math.PI / 180)
    }
  };
}

export function worldCameraAspectPresetId(settings: WorldCameraUiSettings): WorldCameraAspectPreset["id"] | "custom" {
  const ratio = settings.aspect.width / settings.aspect.height;
  const preset = WORLD_CAMERA_ASPECT_PRESETS.find((candidate) =>
    Math.abs(candidate.width / candidate.height - ratio) <= 1e-9);
  return preset?.id ?? "custom";
}

export function withWorldCameraAspect(
  settings: WorldCameraUiSettings,
  presetId: string
): WorldCameraUiSettings {
  const preset = WORLD_CAMERA_ASPECT_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset) return settings;
  return { ...settings, aspect: { width: preset.width, height: preset.height } };
}

export function withWorldCameraCaptureMode(
  settings: WorldCameraUiSettings,
  kind: WorldCameraCaptureMode["kind"]
): WorldCameraUiSettings {
  return { ...settings, captureMode: { kind } };
}

/** `null` is the explicit unbind the save port preserves. */
export function withWorldCameraBinding(
  settings: WorldCameraUiSettings,
  boundInstanceId: WorldId | null
): WorldCameraUiSettings {
  return { ...settings, boundInstanceId };
}

/**
 * Binding options list every shared-world model instance in the canvas. Scene areas do
 * not filter this list: an unbound camera may see the whole world, and a bound camera
 * may reference any one instance regardless of area containment.
 */
export function worldCameraBindingOptions(
  canvas: WorldCameraUiCanvas,
  missingInstanceId?: WorldId | null
): WorldCameraBindingOption[] {
  const options: WorldCameraBindingOption[] = [{ value: "", label: "不绑定：拍摄整个共享世界" }];
  const seen = new Set<string>();
  for (const node of canvas.document.nodes) {
    const data = canvas.nodeData[node.id];
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const decoded = decodeWorldInstanceData((data as Record<string, unknown>).sharedWorldInstance);
    if (!decoded.ok || seen.has(decoded.value.instanceId)) continue;
    seen.add(decoded.value.instanceId);
    const title = typeof (data as Record<string, unknown>).title === "string"
      ? ((data as Record<string, unknown>).title as string).trim()
      : "";
    options.push({
      value: decoded.value.instanceId,
      label: title || `3D 模型 ${decoded.value.instanceId}`
    });
  }
  if (missingInstanceId && !seen.has(missingInstanceId)) {
    options.push({ value: missingInstanceId, label: `模型不可用（${missingInstanceId}）` });
  }
  return options;
}

export function worldCameraBoundTarget(
  canvas: WorldCameraUiCanvas,
  boundInstanceId: WorldId | null
): WorldCameraBindingTarget {
  if (boundInstanceId === null) return { status: "unbound" };
  for (const node of canvas.document.nodes) {
    const data = canvas.nodeData[node.id];
    if (!data || typeof data !== "object" || Array.isArray(data)) continue;
    const decoded = decodeWorldInstanceData((data as Record<string, unknown>).sharedWorldInstance);
    if (!decoded.ok || decoded.value.instanceId !== boundInstanceId) continue;
    const title = typeof (data as Record<string, unknown>).title === "string"
      ? ((data as Record<string, unknown>).title as string).trim()
      : "";
    return { status: "bound", instanceId: boundInstanceId, nodeId: node.id, label: title || `3D 模型 ${boundInstanceId}` };
  }
  return { status: "missing", instanceId: boundInstanceId, label: `模型不可用（${boundInstanceId}）` };
}

/** Stable user-facing explanation for authority failures; keeps raw detail as suffix. */
export function worldCameraFailureText(code: string, message?: string): string {
  switch (code) {
    case "version-conflict": return "镜头配置已被其他操作更新，请载入最新配置后重试。";
    case "operation-conflict": return "同一保存操作已用于不同配置，请重新提交。";
    case "lease-conflict": return "镜头正在被其他运行占用，结束该运行后再保存。";
    case "target-unavailable": return "绑定的模型已不存在或不可用，请解除绑定或选择其他模型。";
    case "not-found": return "镜头不存在或已被删除。";
    case "not-ready": return "镜头服务尚未就绪，请稍后重试。";
    case "write-forbidden": return "当前无权修改该镜头。";
    case "outside-scope": return "当前操作范围没有该镜头的写权限。";
    case "cancelled": return "操作已取消。";
    default: return message?.trim() || "镜头操作失败。";
  }
}

function projectionNumbers(projection: WorldCameraProjection): number[] {
  return projection.kind === "isometric"
    ? [projection.verticalSizeMeters, projection.nearMeters, projection.farMeters]
    : [projection.verticalFovRadians, projection.nearMeters, projection.farMeters];
}

/** Renderer-space normalized forward direction of a world rotation. */
function rendererForwardOf(rotation: WorldRotation): RendererVector {
  const [x, y, z, w] = worldToRendererRotation(rotation);
  return normalize([-2 * (x * z + w * y), -2 * (y * z - w * x), 2 * (x * x + y * y) - 1]);
}

/** World-space forward direction in meters; renderer [x,y,z] maps to world [u,h,-v]. */
function worldForwardOf(rotation: WorldRotation): WorldPoint {
  const [x, y, z] = rendererForwardOf(rotation);
  return { u: x, v: -z, h: y };
}

function normalize(vector: RendererVector): RendererVector {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a: RendererVector, b: RendererVector): RendererVector {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Quaternion of an orthonormal renderer basis [right, up, back]. */
function quatFromBasis(right: RendererVector, up: RendererVector, back: RendererVector): RendererRotation {
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

/** Renderer rotation looking along `forward` with the world-up hint. */
function rendererRotationFor(forward: RendererVector): RendererRotation {
  const back = normalize([-forward[0], -forward[1], -forward[2]]);
  const right = normalize(cross([0, 1, 0], back));
  const up = cross(back, right);
  return quatFromBasis(right, up, back);
}
