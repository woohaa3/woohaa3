/**
 * 场景区地面包含判定（change: 2026-11-01-rebuild-canvas-shared-world-authoring，
 * design D3；契约修复见 contract-repair-v4）。
 *
 * 只消费权威世界地面 AABB 与地面定位点：不读取 viewport、zoom、屏幕卡片矩形或运行状态，
 * 也不产生存储 / 网络副作用。完整包含、边界接触与容差规则由 shared-world.ts 固定；
 * 本模块只实现该纯几何判定，不授予写资格。
 */
import {
  SCENE_FOOTPRINT_TOLERANCE_METERS,
  type GroundAabb,
  type GroundPoint,
  type SceneCameraPointQuery,
  type SceneContainment,
  type SceneFootprintFunctions,
  type SceneFootprintQuery,
  type WorldPoint
} from "./shared-world.js";

const TOLERANCE = SCENE_FOOTPRINT_TOLERANCE_METERS;

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyVersion(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Validates an untrusted ground point without importing codec or I/O concerns. */
function readGroundPoint(value: unknown): GroundPoint | null {
  if (typeof value !== "object" || value === null) return null;
  const point = value as GroundPoint;
  if (!finiteNumber(point.u) || !finiteNumber(point.v)) return null;
  return point;
}

/** Camera anchors retain height for validity, but containment deliberately ignores it. */
function readWorldPoint(value: unknown): WorldPoint | null {
  if (typeof value !== "object" || value === null) return null;
  const point = value as WorldPoint;
  if (!finiteNumber(point.u) || !finiteNumber(point.v) || !finiteNumber(point.h)) return null;
  return point;
}

/** Ordered AABB is valid even when degenerate (min equals max on one or both axes). */
function readAabb(value: unknown): GroundAabb | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { min?: unknown; max?: unknown };
  const min = readGroundPoint(candidate.min);
  const max = readGroundPoint(candidate.max);
  if (!min || !max) return null;
  if (min.u > max.u || min.v > max.v) return null;
  return { min, max };
}

function containsOnAxis(min: number, max: number, areaMin: number, areaMax: number): boolean {
  return min >= areaMin - TOLERANCE && max <= areaMax + TOLERANCE;
}

function intersectsOnAxis(min: number, max: number, areaMin: number, areaMax: number): boolean {
  return max >= areaMin - TOLERANCE && min <= areaMax + TOLERANCE;
}

/**
 * Classifies a ready footprint against a scene area.
 * A missing, stale, unready, version-mismatched or non-finite/unordered footprint is unknown;
 * unknown never grants write access. Degenerate footprints remain points or lines and are
 * still classified rather than treated as empty objects.
 */
export function classifyFootprint(input: SceneFootprintQuery): SceneContainment {
  if (typeof input !== "object" || input === null) return "unknown";

  const area = readAabb(input.area);
  if (!area) return "unknown";
  if (!nonEmptyVersion(input.contentVersion) || !nonEmptyVersion(input.transformVersion)) return "unknown";

  const footprint = input.footprint;
  if (!footprint || footprint.status !== "ready") return "unknown";
  if (!nonEmptyVersion(footprint.contentVersion) || !nonEmptyVersion(footprint.transformVersion)) return "unknown";
  if (footprint.contentVersion !== input.contentVersion || footprint.transformVersion !== input.transformVersion) return "unknown";

  const bounds = readAabb(footprint.bounds);
  if (!bounds) return "unknown";

  const complete =
    containsOnAxis(bounds.min.u, bounds.max.u, area.min.u, area.max.u) &&
    containsOnAxis(bounds.min.v, bounds.max.v, area.min.v, area.max.v);
  if (complete) return "complete";

  const intersects =
    intersectsOnAxis(bounds.min.u, bounds.max.u, area.min.u, area.max.u) &&
    intersectsOnAxis(bounds.min.v, bounds.max.v, area.min.v, area.max.v);
  return intersects ? "partial" : "outside";
}

/**
 * Classifies a camera by its authoritative spatial anchor projected onto the ground.
 * Height never affects containment and card layout is never read; only u/v participate.
 * An invalid area or a position with non-finite coordinates is unknown.
 */
export function classifyCameraPoint(input: SceneCameraPointQuery): SceneContainment {
  if (typeof input !== "object" || input === null) return "unknown";

  const area = readAabb(input.area);
  if (!area) return "unknown";
  const position = readWorldPoint(input.position);
  if (!position) return "unknown";

  const inside =
    position.u >= area.min.u - TOLERANCE &&
    position.u <= area.max.u + TOLERANCE &&
    position.v >= area.min.v - TOLERANCE &&
    position.v <= area.max.v + TOLERANCE;
  return inside ? "complete" : "outside";
}

/** Single object form for consumers that receive the T01 pure-function surface. */
export const sceneFootprintFunctions: SceneFootprintFunctions = {
  classifyFootprint,
  classifyCameraPoint
};
