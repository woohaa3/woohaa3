/** Shared-world v1 is independent of card layout and legacy modelPlacement. */
import type { WorldAnimationScript } from "./world-animation-script.js";

export const SHARED_WORLD_VERSION = "shared-world-v1" as const;
export const SHARED_WORLD_UNITS_PER_METER = 64;
export const WORKFLOW_GROUP_2D_NODE_TYPE = "workflow-group-2d" as const;
export const SCENE_AREA_NODE_TYPE = "scene-area" as const;
export const WORLD_CAMERA_NODE_TYPE = "world-camera" as const;
/**
 * Fixed metric tolerance for scene-area containment (never scaled by zoom).
 *
 * Models often carry thin decorative geometry (arch ribs, trims) whose projected
 * AABB sticks a few centimetres past what the user sees as the model edge. A
 * user-sized director area around that visible edge must still count as "fully
 * contained", otherwise the whole model silently leaves the move/edit set. The
 * tolerance stays small enough that genuinely partial models remain read-only.
 */
export const SCENE_FOOTPRINT_TOLERANCE_METERS = 0.05;
export const WORLD_ROTATION_UNIT_TOLERANCE = 1e-6;
/**
 * Authoring-input tolerance for a supplied rotation (squared norm). Storage stays
 * strict (`WORLD_ROTATION_UNIT_TOLERANCE`); a slightly off unit quaternion from a
 * human or model author is normalized before it is written instead of rejected.
 */
export const WORLD_ROTATION_INPUT_TOLERANCE = 1e-3;
/** Reserved nodeData keys for T03 registration; no legacy key is reinterpreted. */
export const SHARED_WORLD_NODE_DATA_KEYS = {
  instance: "sharedWorldInstance", group: "workflowGroup2d", area: "sceneArea", camera: "worldCamera"
} as const;

export type WorldPoint = { u: number; v: number; h: number };
/** Right-handed quaternion [u, v, h, w], unit length. */
export type WorldRotation = readonly [number, number, number, number];
export type RendererVector = readonly [number, number, number];
export type RendererRotation = readonly [number, number, number, number];

/** Position in meters; uniform positive scale. Rotation acts after asset-local transforms.
 * Quaternion composition is parent * child (child applied first). Asset local coordinates
 * remain Y-up; conjugate a world rotation by the basis change before applying it in Bevy.
 */
export interface WorldTransform {
  version: typeof SHARED_WORLD_VERSION;
  position: WorldPoint;
  rotation: WorldRotation;
  scale: number;
}

/** These adapters operate on already validated finite values; codecs own rejection. */
export function worldToRendererPosition(p: WorldPoint): RendererVector {
  return [p.u * SHARED_WORLD_UNITS_PER_METER, p.h * SHARED_WORLD_UNITS_PER_METER, -p.v * SHARED_WORLD_UNITS_PER_METER];
}
export function rendererToWorldPosition(p: RendererVector): WorldPoint {
  return { u: p[0] / SHARED_WORLD_UNITS_PER_METER, v: -p[2] / SHARED_WORLD_UNITS_PER_METER, h: p[1] / SHARED_WORLD_UNITS_PER_METER };
}
export function worldToRendererRotation(q: WorldRotation): RendererRotation {
  return [q[0], q[2], -q[1], q[3]];
}
export function rendererToWorldRotation(q: RendererRotation): WorldRotation {
  return [q[0], -q[2], q[1], q[3]];
}

/** Stable IDs are nonempty strings; versions are opaque nonempty strings, not counters. */
export type WorldId = string;
export type WorldVersion = string;
export interface GroundPoint { u: number; v: number }
/** Finite ordered endpoints, in meters. Zero width/height is valid, not empty. */
export interface GroundAabb { min: GroundPoint; max: GroundPoint }

/** New nodeData fields; keys here are the complete v1 allowlist for each payload.
 * Structural node layout remains separate. Never infer these from legacy group/shot.
 */
export interface WorldInstanceData { kind: "world-instance"; version: typeof SHARED_WORLD_VERSION; instanceId: WorldId; transform: WorldTransform }
/** Membership or group identity changes replace scopeVersion; card layout, viewport and
 * hover changes do not. Membership is an organizational context, not 3D write access. */
export interface WorkflowGroupData { kind: "workflow-group-2d"; version: typeof SHARED_WORLD_VERSION; groupId: WorldId; scopeVersion: WorldVersion; memberNodeIds: WorldId[] }
/** Bounds or area identity changes replace scopeVersion. Object pose, footprint and
 * content changes require fresh eligibility against object/content versions even when
 * this scopeVersion is unchanged. */
export interface SceneAreaData {
  kind: "scene-area";
  version: typeof SHARED_WORLD_VERSION;
  areaId: WorldId;
  scopeVersion: WorldVersion;
  bounds: GroundAabb;
  /**
   * Stable ground origin for the area's animation position tracks. Track `u`/`v`
   * are offsets from this point; `h` remains an absolute height. Moving the area
   * translates both `bounds` and this origin; resizing leaves it untouched.
   * Missing on legacy areas: `sceneAreaAnimationOrigin` falls back to the bounds
   * center (the same point new areas are created with).
   */
  animationOrigin?: GroundPoint;
  /** Clockwise quarter turns of area-relative animation position tracks; absent means zero. */
  animationQuarterTurns?: number;
  /** 导演区统一动画脚本（模型实例 + 镜头）；位置轨道相对 `animationOrigin`，播放时钟属于浏览器本地，不写回规范数据。 */
  animationScript?: WorldAnimationScript;
}

/** Stable animation origin; legacy areas without one use their bounds center. */
export function sceneAreaAnimationOrigin(area: SceneAreaData): GroundPoint {
  if (area.animationOrigin) return { ...area.animationOrigin };
  return {
    u: (area.bounds.min.u + area.bounds.max.u) / 2,
    v: (area.bounds.min.v + area.bounds.max.v) / 2
  };
}
export type WorldCameraProjection =
  | { kind: "isometric"; verticalSizeMeters: number; nearMeters: number; farMeters: number }
  | { kind: "perspective"; verticalFovRadians: number; nearMeters: number; farMeters: number };
/** Dynamic sampling semantics are specified by the later animation contract. */
export type WorldCameraCaptureMode = { kind: "static" } | { kind: "dynamic" };
export interface WorldCameraData {
  kind: "world-camera"; version: typeof SHARED_WORLD_VERSION; cameraId: WorldId;
  settingsVersion: WorldVersion; position: WorldPoint; rotation: WorldRotation;
  projection: WorldCameraProjection; captureMode: WorldCameraCaptureMode; aspect: { width: number; height: number };
  /** null means unbound; a missing bound target must never be treated as null. */
  boundInstanceId: WorldId | null;
}
/** Camera local -Z is forward and +Y is up in the Y-up renderer. Isometric uses
 * orthographic projection and accepts either the canonical equal-axis octants (equal
 * absolute forward components on all renderer axes) or a grid-aligned downward pose
 * whose horizontal forward component follows one isometric grid axis. This keeps the
 * initial lens along a grid line instead of pointing straight into the screen.
 */
export type SharedWorldNodeData = WorldInstanceData | WorkflowGroupData | SceneAreaData | WorldCameraData;

/** OC01 implements these; unknown versions, extra fields, non-finite numbers, non-unit
 * rotations (absolute difference of squared norm from 1 greater than
 * WORLD_ROTATION_UNIT_TOLERANCE), non-positive scale/aspect and invalid projection
 * ranges reject atomically. Projection requires 0 < near < far; perspective FOV is
 * strictly between 0 and pi; isometric vertical size is positive and its pose follows the
 * direction rule above. IDs and versions must be nonempty; group members must be unique.
 * A document-context validator must reject group members that resolve to groups; the
 * pure codec cannot determine member types from IDs alone.
 * A failed decode preserves the caller's previous state and the original input.
 */
export type SharedWorldDecodeResult<T> = { ok: true; value: T } | { ok: false; code: "unsupported-version" | "invalid-data"; input: unknown };
export interface SharedWorldCodec {
  decodeTransform(input: unknown): SharedWorldDecodeResult<WorldTransform>;
  decodeNodeData(input: unknown): SharedWorldDecodeResult<SharedWorldNodeData>;
  encodeTransform(value: WorldTransform): unknown;
  encodeNodeData(value: SharedWorldNodeData): unknown;
}

/** Authority supplies a conservative world-space ground AABB, not a screen bbox.
 * Versions identify the exact content and pose used to compute it. Stale, missing,
 * non-finite, unordered or unready data is unknown and never grants write access.
 */
export type SceneFootprintInput =
  | { status: "ready"; bounds: GroundAabb; contentVersion: WorldVersion; transformVersion: WorldVersion }
  | { status: "missing" | "stale" | "unready" };
export type SceneContainment = "complete" | "partial" | "outside" | "unknown";
export interface SceneFootprintQuery { area: GroundAabb; footprint: SceneFootprintInput; contentVersion: WorldVersion; transformVersion: WorldVersion }
export interface SceneCameraPointQuery { area: GroundAabb; position: WorldPoint }
/** T02 implements these. Complete includes boundary contact within the fixed tolerance;
 * Specifically complete means footprint.min >= area.min - tolerance and
 * footprint.max <= area.max + tolerance on both axes. Otherwise partial means
 * footprint.max >= area.min - tolerance and footprint.min <= area.max + tolerance
 * on both axes; otherwise outside.
 * A degenerate AABB is still a point/line. Invalid area or point yields unknown.
 * Camera point returns complete or outside (or unknown), ignoring height and card layout.
 */
export interface SceneFootprintFunctions {
  classifyFootprint(input: SceneFootprintQuery): SceneContainment;
  classifyCameraPoint(input: SceneCameraPointQuery): SceneContainment;
}

/** Lock keys are (canvasId, kind, id): camera and instance IDs have separate namespaces. */
export type WorldObjectIdentity =
  | { kind: "instance"; instanceId: WorldId }
  | { kind: "camera"; cameraId: WorldId };
export type WorldObjectVersion = WorldObjectIdentity & { version: WorldVersion };
/** Scope IDs are namespaced by kind; a group and area may have the same ID. */
export type WorldScopeIdentity =
  | { kind: "workflow-group-2d"; groupId: WorldId }
  | { kind: "scene-area"; areaId: WorldId }
  | { kind: "world-camera"; cameraId: WorldId };
export interface WorldScopeVersion { scope: WorldScopeIdentity; scopeVersion: WorldVersion }
export interface SpatialLeaseIdentity { canvasId: WorldId; runId: WorldId; epoch: number; target: WorldObjectIdentity }
export interface SpatialLeaseRequest { requestId: WorldId; canvasId: WorldId; runId: WorldId; epoch: number; scope: WorldScopeVersion; targets: WorldObjectVersion[] }
export interface SpatialLeaseConflict { target: WorldObjectIdentity; runId: WorldId; epoch: number }
export type SpatialLeaseResult = { ok: true; leases: SpatialLeaseIdentity[] } | { ok: false; code: SharedWorldFailureCode; conflicts?: SpatialLeaseConflict[] };
export interface WorldToolWritableTarget { target: WorldObjectVersion; lease: SpatialLeaseIdentity }
/** Issued by the host after eligibility and atomic lease acquisition, never trusted from
 * assistant input. Each writable target has exactly one matching lease with this context's
 * canvasId, runId, epoch and typed target identity. Targets are unique and the writable
 * and read-only sets are disjoint; read-only references acquire no write lease. Partial
 * containment is read-only. A 2D group's membership alone grants no world write access.
 * Each submission revalidates the scope, target versions, current spatial eligibility and
 * leases. Scope, object, content or pose changes invalidate affected eligibility; an old
 * context cannot implicitly expand its grant. New objects or expanded grants require a
 * fresh eligibility check and atomic lease acquisition. Cancellation invalidates the grant;
 * locks remain until execution is confirmed stopped, even if a target leaves the scope.
 */
export interface WorldToolContext {
  allowSceneAreaExpansion?: boolean;
  contextId: WorldId;
  canvasId: WorldId;
  runId: WorldId;
  epoch: number;
  scope: WorldScopeVersion;
  writableTargets: WorldToolWritableTarget[];
  readOnlyReferences: WorldObjectVersion[];
}
export interface WorldCompletion { canvasId: WorldId; runId: WorldId; completionId: WorldId; cameraId: WorldId; settingsVersion: WorldVersion }
export interface WorldCaptureVersionKey { canvasId: WorldId; cameraId: WorldId; worldContentVersion: WorldVersion; cameraSettingsVersion: WorldVersion; bindingVersion: WorldVersion; outputVersion: WorldVersion }
export interface WorldCaptureInput { key: WorldCaptureVersionKey; mediaId: WorldId; checksum: string }
export type SharedWorldFailureCode = "unsupported-version" | "invalid-data" | "not-ready" | "version-conflict" | "lease-conflict" | "stale-epoch" | "outside-scope" | "target-unavailable" | "capture-stale" | "cancelled";

/** Commands describe atomic intent; implementation, authorization and undo are downstream.
 * For single-object writes the lease target must equal the command target. */
export type SharedWorldCommand =
  | { kind: "set-world-transform"; operationId: WorldId; target: Extract<WorldObjectVersion, { kind: "instance" }>; transform: WorldTransform; lease: SpatialLeaseIdentity }
  | { kind: "move-scene-area"; operationId: WorldId; areaId: WorldId; scopeVersion: WorldVersion; targets: WorldObjectVersion[]; delta: GroundPoint }
  | { kind: "resize-scene-area"; operationId: WorldId; areaId: WorldId; scopeVersion: WorldVersion; bounds: GroundAabb }
  | { kind: "delete-scene-area"; operationId: WorldId; areaId: WorldId; scopeVersion: WorldVersion; targets: WorldObjectVersion[] }
  | { kind: "set-world-camera"; operationId: WorldId; target: Extract<WorldObjectVersion, { kind: "camera" }>; camera: WorldCameraData; lease: SpatialLeaseIdentity };
