/**
 * Scene-area batch operation planner (OC04).
 *
 * Pure, deterministic command conversion for the frozen
 * `scene-area-plan-contract.ts` interface. The caller has already verified
 * eligibility, leases and the authoritative world snapshot; this module never
 * reads viewport, containment, storage, locks or clocks. It only turns the fixed
 * gesture-time member set and intent into one atomic forward plan plus its exact
 * inverse snapshot.
 *
 * Validation follows `SCENE_AREA_PLAN_FAILURE_PRECEDENCE` in the contract module.
 * The authority-only `operation-intent-reuse` rule is deliberately not decided
 * here: a stateless planner has no persisted intent to compare with.
 */

import {
  SCENE_AREA_PLAN_CONTRACT_VERSION,
  type SceneAreaPlan,
  type SceneAreaPlanAreaSource,
  type SceneAreaPlanCameraMember,
  type SceneAreaPlanCommand,
  type SceneAreaPlanFailureCode,
  type SceneAreaPlanInstanceMember,
  type SceneAreaPlanIntent,
  type SceneAreaPlanInverseCommand,
  type SceneAreaPlanMemberSet,
  type SceneAreaPlanPlanner,
  type SceneAreaPlanRequest,
  type SceneAreaPlanResult
} from "./scene-area-plan-contract.js";
import {
  SHARED_WORLD_VERSION,
  type GroundAabb,
  type GroundPoint,
  type WorldCameraData,
  type WorldPoint,
  type WorldRotation,
  type WorldTransform
} from "./shared-world.js";

type JsonRecord = Record<string, unknown>;

const INTENTS: readonly SceneAreaPlanIntent[] = [
  "move",
  "resize",
  "delete-area",
  "delete-area-with-contents"
];

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function field(record: JsonRecord | null, key: string): unknown {
  return record && Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIntent(value: unknown): value is SceneAreaPlanIntent {
  return typeof value === "string" && INTENTS.includes(value as SceneAreaPlanIntent);
}

function hasNonFiniteNumber(value: unknown, seen: Set<object> = new Set()): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((entry) => hasNonFiniteNumber(entry, seen));
  return Object.values(value as JsonRecord).some((entry) => hasNonFiniteNumber(entry, seen));
}

function hasOwn(record: JsonRecord | null, key: string): boolean {
  return record !== null && Object.prototype.hasOwnProperty.call(record, key);
}

function hasOwnNumber(record: JsonRecord | null, key: string): boolean {
  return hasOwn(record, key) && typeof record?.[key] === "number";
}

function isReadableGroundPoint(value: unknown): boolean {
  const point = asRecord(value);
  return hasOwnNumber(point, "u") && hasOwnNumber(point, "v");
}

function isReadableBounds(value: unknown): boolean {
  const bounds = asRecord(value);
  return isReadableGroundPoint(field(bounds, "min")) && isReadableGroundPoint(field(bounds, "max"));
}

function isReadableWorldPoint(value: unknown): boolean {
  const point = asRecord(value);
  return hasOwnNumber(point, "u") && hasOwnNumber(point, "v") && hasOwnNumber(point, "h");
}

function isReadableRotation(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((entry, index) => index in value && typeof entry === "number")
  );
}

/** Payloads are required snapshots, not optional decorations: every field the plan
 * copies must exist before conversion. Present-but-non-finite numbers stay in the
 * later shape stage so the frozen `non-finite-number` classification wins. */
function isReadableTransform(value: unknown): boolean {
  const transform = asRecord(value);
  return (
    transform !== null &&
    isNonEmptyString(field(transform, "version")) &&
    isReadableWorldPoint(field(transform, "position")) &&
    isReadableRotation(field(transform, "rotation")) &&
    hasOwnNumber(transform, "scale")
  );
}

function isReadableProjection(value: unknown): boolean {
  const projection = asRecord(value);
  if (!projection) return false;
  const kind = field(projection, "kind");
  const hasRange = hasOwnNumber(projection, "nearMeters") && hasOwnNumber(projection, "farMeters");
  if (kind === "perspective") {
    return hasRange && hasOwnNumber(projection, "verticalFovRadians");
  }
  if (kind === "isometric") {
    return hasRange && hasOwnNumber(projection, "verticalSizeMeters");
  }
  return false;
}

function isReadableCamera(value: unknown): boolean {
  const camera = asRecord(value);
  if (!camera) return false;
  const captureMode = asRecord(field(camera, "captureMode"));
  const aspect = asRecord(field(camera, "aspect"));
  return (
    isNonEmptyString(field(camera, "version")) &&
    isNonEmptyString(field(camera, "settingsVersion")) &&
    isReadableWorldPoint(field(camera, "position")) &&
    isReadableRotation(field(camera, "rotation")) &&
    isReadableProjection(field(camera, "projection")) &&
    captureMode !== null &&
    isNonEmptyString(field(captureMode, "kind")) &&
    aspect !== null &&
    hasOwnNumber(aspect, "width") &&
    hasOwnNumber(aspect, "height") &&
    hasOwn(camera, "boundInstanceId") &&
    field(camera, "boundInstanceId") !== undefined
  );
}

function memberArrays(record: JsonRecord | null): { instances: unknown[]; cameras: unknown[] } | null {
  const members = asRecord(field(record, "members"));
  const instances = field(members, "instances");
  const cameras = field(members, "cameras");
  if (!Array.isArray(instances) || !Array.isArray(cameras)) return null;
  return { instances, cameras };
}

function identityId(record: JsonRecord | null, key: "instanceId" | "cameraId"): unknown {
  return field(asRecord(field(record, "identity")), key);
}

function memberVersion(record: JsonRecord | null): unknown {
  return field(record, "version");
}

function transformOf(record: JsonRecord | null): unknown {
  return field(record, "transform");
}

function cameraOf(record: JsonRecord | null): unknown {
  return field(record, "camera");
}

function areaOf(record: JsonRecord | null): JsonRecord | null {
  return asRecord(field(record, "area"));
}

function boundsOf(record: JsonRecord | null): JsonRecord | null {
  if (!record) return null;
  return asRecord(field(record, "bounds"));
}

function hasUnorderedBounds(bounds: JsonRecord | null): boolean {
  if (!bounds) return true;
  const min = asRecord(field(bounds, "min"));
  const max = asRecord(field(bounds, "max"));
  if (!min || !max) return true;
  const minU = field(min, "u");
  const maxU = field(max, "u");
  const minV = field(min, "v");
  const maxV = field(max, "v");
  if (!isFiniteNumber(minU) || !isFiniteNumber(maxU) || !isFiniteNumber(minV) || !isFiniteNumber(maxV)) {
    return true;
  }
  return minU > maxU || minV > maxV;
}

interface VersionMap {
  versions: Map<string, Set<unknown>>;
  counts: Map<string, number>;
}

function collectVersions(
  entries: readonly unknown[],
  readId: (record: JsonRecord | null) => unknown
): VersionMap[] {
  const map: VersionMap = { versions: new Map(), counts: new Map() };
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = readId(record);
    if (typeof id !== "string") continue;
    const seen = map.versions.get(id) ?? new Set<unknown>();
    seen.add(memberVersion(record));
    map.versions.set(id, seen);
    map.counts.set(id, (map.counts.get(id) ?? 0) + 1);
  }
  return [map];
}

function hasDuplicateSameVersion(entries: readonly unknown[], readId: (record: JsonRecord | null) => unknown): boolean {
  for (const map of collectVersions(entries, readId)) {
    for (const [id, seen] of map.versions) {
      if (seen.size === 1 && (map.counts.get(id) ?? 0) > 1) return true;
    }
  }
  return false;
}

function hasConflictingVersions(entries: readonly unknown[], readId: (record: JsonRecord | null) => unknown): boolean {
  for (const map of collectVersions(entries, readId)) {
    for (const seen of map.versions.values()) {
      if (seen.size > 1) return true;
    }
  }
  return false;
}

function failure(code: SceneAreaPlanFailureCode, operationId: unknown): SceneAreaPlanResult {
  return { ok: false, code, operationId: typeof operationId === "string" ? operationId : "" };
}

/**
 * Validate the frozen request against the contract taxonomy, in precedence order.
 * Returns `null` when the request is safe to convert, otherwise the first matching
 * failure. No value is repaired, defaulted or newly discovered.
 */
export function classifySceneAreaPlanRequest(request: unknown): SceneAreaPlanFailureCode | null {
  const record = asRecord(request);
  if (!record) return "invalid-input";

  const area = areaOf(record);
  const members = memberArrays(record);
  const instances = members?.instances ?? [];
  const cameras = members?.cameras ?? [];
  const operationId = field(record, "operationId");

  // Version stage.
  if (field(record, "contractVersion") !== SCENE_AREA_PLAN_CONTRACT_VERSION) return "unsupported-version";
  for (const entry of instances) {
    const transform = transformOf(asRecord(entry));
    if (transform === undefined) continue;
    const payload = asRecord(transform);
    // A present transform must declare the supported version. An explicit
    // `version: undefined`, a missing key and a non-string value all fail here;
    // absent payloads stay in the snapshot stage as `unknown-input`.
    if (payload !== null && field(payload, "version") !== SHARED_WORLD_VERSION) return "unsupported-version";
  }
  for (const entry of cameras) {
    const camera = cameraOf(asRecord(entry));
    if (camera === undefined) continue;
    const payload = asRecord(camera);
    if (!payload) continue;
    const kind = field(payload, "kind");
    if (kind !== undefined && kind !== "world-camera") return "unsupported-version";
    // A camera payload without any version stays in the snapshot stage, where
    // `isReadableCamera` classifies it as `unknown-input`.
    const version = field(payload, "version");
    if (version !== undefined && version !== SHARED_WORLD_VERSION) return "unsupported-version";
  }

  // Snapshot stage. Unknown never degrades into an empty writable set: every
  // payload the plan copies must be readable before conversion starts.
  if (!area || !isNonEmptyString(field(area, "scopeVersion"))) return "unknown-input";
  if (!members) return "unknown-input";
  for (const entry of [...instances, ...cameras]) {
    if (!isNonEmptyString(memberVersion(asRecord(entry)))) return "unknown-input";
  }
  for (const entry of instances) {
    const payload = transformOf(asRecord(entry));
    if (!isReadableTransform(payload)) return "unknown-input";
  }
  for (const entry of cameras) {
    const payload = cameraOf(asRecord(entry));
    if (!asRecord(payload) || field(asRecord(payload), "kind") !== "world-camera") return "unknown-input";
    if (!isReadableCamera(payload)) return "unknown-input";
  }
  if (!isReadableBounds(field(area, "bounds"))) return "unknown-input";

  // Shape stage.
  if (!isNonEmptyString(field(record, "canvasId"))) return "invalid-input";
  if (!isNonEmptyString(operationId)) return "invalid-input";
  if (!isNonEmptyString(field(area, "areaId"))) return "invalid-input";
  for (const entry of instances) {
    const member = asRecord(entry);
    const identity = asRecord(field(member, "identity"));
    if (field(identity, "kind") !== "instance" || !isNonEmptyString(identityId(member, "instanceId"))) {
      return "invalid-input";
    }
  }
  for (const entry of cameras) {
    const member = asRecord(entry);
    const identity = asRecord(field(member, "identity"));
    if (field(identity, "kind") !== "camera" || !isNonEmptyString(identityId(member, "cameraId"))) {
      return "invalid-input";
    }
  }
  if (hasNonFiniteNumber(request)) return "invalid-input";
  const intent = field(record, "intent");
  if (!isIntent(intent)) return "invalid-input";
  if (intent === "resize") {
    if (hasUnorderedBounds(boundsOf(record))) return "invalid-input";
  } else if (hasUnorderedBounds(boundsOf(area))) {
    return "invalid-input";
  }
  if (intent === "move") {
    const delta = asRecord(field(record, "delta"));
    if (!delta || !isFiniteNumber(field(delta, "u")) || !isFiniteNumber(field(delta, "v"))) {
      return "invalid-input";
    }
  }
  if (hasDuplicateSameVersion(instances, (entry) => identityId(entry, "instanceId"))) return "invalid-input";
  if (hasDuplicateSameVersion(cameras, (entry) => identityId(entry, "cameraId"))) return "invalid-input";
  for (const entry of cameras) {
    const member = asRecord(entry);
    const camera = asRecord(cameraOf(member));
    if (identityId(member, "cameraId") !== field(camera, "cameraId")) return "invalid-input";
  }

  // Contradiction stage.
  if (hasConflictingVersions(instances, (entry) => identityId(entry, "instanceId"))) {
    return "source-version-conflict";
  }
  if (hasConflictingVersions(cameras, (entry) => identityId(entry, "cameraId"))) {
    return "source-version-conflict";
  }
  for (const entry of cameras) {
    const member = asRecord(entry);
    const camera = asRecord(cameraOf(member));
    if (memberVersion(member) !== field(camera, "settingsVersion")) return "source-version-conflict";
  }

  // `operation-intent-reuse` belongs to the authority receipt, not this planner.
  return null;
}

function copyGroundPoint(point: GroundPoint): GroundPoint {
  return { u: point.u, v: point.v };
}

function copyBounds(bounds: GroundAabb): GroundAabb {
  return { min: copyGroundPoint(bounds.min), max: copyGroundPoint(bounds.max) };
}

function copyWorldPoint(point: WorldPoint): WorldPoint {
  return { u: point.u, v: point.v, h: point.h };
}

function copyRotation(rotation: WorldRotation): WorldRotation {
  return [rotation[0], rotation[1], rotation[2], rotation[3]];
}

function copyTransform(transform: WorldTransform): WorldTransform {
  return {
    version: transform.version,
    position: copyWorldPoint(transform.position),
    rotation: copyRotation(transform.rotation),
    scale: transform.scale
  };
}

function copyCamera(camera: WorldCameraData): WorldCameraData {
  const projection: WorldCameraData["projection"] =
    camera.projection.kind === "isometric"
      ? {
          kind: "isometric",
          verticalSizeMeters: camera.projection.verticalSizeMeters,
          nearMeters: camera.projection.nearMeters,
          farMeters: camera.projection.farMeters
        }
      : {
          kind: "perspective",
          verticalFovRadians: camera.projection.verticalFovRadians,
          nearMeters: camera.projection.nearMeters,
          farMeters: camera.projection.farMeters
        };
  return {
    kind: camera.kind,
    version: camera.version,
    cameraId: camera.cameraId,
    settingsVersion: camera.settingsVersion,
    position: copyWorldPoint(camera.position),
    rotation: copyRotation(camera.rotation),
    projection,
    captureMode: { kind: camera.captureMode.kind },
    aspect: { width: camera.aspect.width, height: camera.aspect.height },
    boundInstanceId: camera.boundInstanceId
  };
}

function copyInstance(instance: SceneAreaPlanInstanceMember): SceneAreaPlanInstanceMember {
  return {
    identity: { kind: "instance", instanceId: instance.identity.instanceId },
    version: instance.version,
    transform: copyTransform(instance.transform)
  };
}

function copyCameraMember(member: SceneAreaPlanCameraMember): SceneAreaPlanCameraMember {
  return {
    identity: { kind: "camera", cameraId: member.identity.cameraId },
    version: member.version,
    camera: copyCamera(member.camera)
  };
}

function copyMembers(members: SceneAreaPlanMemberSet): SceneAreaPlanMemberSet {
  return {
    instances: members.instances.map(copyInstance),
    cameras: members.cameras.map(copyCameraMember)
  };
}

function copyArea(area: SceneAreaPlanAreaSource): SceneAreaPlanAreaSource {
  return { areaId: area.areaId, scopeVersion: area.scopeVersion, bounds: copyBounds(area.bounds) };
}

function translatedBounds(bounds: GroundAabb, delta: GroundPoint): GroundAabb {
  return {
    min: { u: bounds.min.u + delta.u, v: bounds.min.v + delta.v },
    max: { u: bounds.max.u + delta.u, v: bounds.max.v + delta.v }
  };
}

function movedTransform(transform: WorldTransform, delta: GroundPoint): WorldTransform {
  return {
    version: transform.version,
    position: { u: transform.position.u + delta.u, v: transform.position.v + delta.v, h: transform.position.h },
    rotation: copyRotation(transform.rotation),
    scale: transform.scale
  };
}

function movedCameraPose(camera: WorldCameraData, delta: GroundPoint): { position: WorldPoint; rotation: WorldRotation } {
  return {
    position: { u: camera.position.u + delta.u, v: camera.position.v + delta.v, h: camera.position.h },
    rotation: copyRotation(camera.rotation)
  };
}

function buildMovePlan(
  request: Extract<SceneAreaPlanRequest, { intent: "move" }>,
  source: { area: SceneAreaPlanAreaSource; members: SceneAreaPlanMemberSet }
): SceneAreaPlan {
  const commands: SceneAreaPlanCommand[] = [
    {
      kind: "set-scene-area-bounds",
      areaId: request.area.areaId,
      expectedScopeVersion: request.area.scopeVersion,
      bounds: translatedBounds(request.area.bounds, request.delta)
    },
    ...request.members.instances.map(
      (member): SceneAreaPlanCommand => ({
        kind: "set-instance-transform",
        target: { kind: "instance", instanceId: member.identity.instanceId },
        expectedVersion: member.version,
        transform: movedTransform(member.transform, request.delta)
      })
    ),
    ...request.members.cameras.map(
      (member): SceneAreaPlanCommand => ({
        kind: "set-world-camera-pose",
        target: { kind: "camera", cameraId: member.identity.cameraId },
        expectedVersion: member.version,
        ...movedCameraPose(member.camera, request.delta)
      })
    )
  ];

  const inverse: SceneAreaPlanInverseCommand[] = [
    {
      kind: "restore-scene-area-bounds",
      areaId: request.area.areaId,
      scopeVersion: request.area.scopeVersion,
      bounds: copyBounds(request.area.bounds)
    },
    ...request.members.instances.map(
      (member): SceneAreaPlanInverseCommand => ({
        kind: "restore-instance",
        target: { kind: "instance", instanceId: member.identity.instanceId },
        version: member.version,
        transform: copyTransform(member.transform)
      })
    ),
    ...request.members.cameras.map(
      (member): SceneAreaPlanInverseCommand => ({
        kind: "restore-world-camera",
        target: { kind: "camera", cameraId: member.identity.cameraId },
        version: member.version,
        camera: copyCamera(member.camera)
      })
    )
  ];

  return {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId: request.canvasId,
    operationId: request.operationId,
    intent: "move",
    source,
    commands,
    inverse
  };
}

function buildResizePlan(
  request: Extract<SceneAreaPlanRequest, { intent: "resize" }>,
  source: { area: SceneAreaPlanAreaSource; members: SceneAreaPlanMemberSet }
): SceneAreaPlan {
  return {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId: request.canvasId,
    operationId: request.operationId,
    intent: "resize",
    source,
    commands: [
      {
        kind: "set-scene-area-bounds",
        areaId: request.area.areaId,
        expectedScopeVersion: request.area.scopeVersion,
        bounds: copyBounds(request.bounds)
      }
    ],
    inverse: [
      {
        kind: "restore-scene-area-bounds",
        areaId: request.area.areaId,
        scopeVersion: request.area.scopeVersion,
        bounds: copyBounds(request.area.bounds)
      }
    ]
  };
}

function buildDeleteAreaPlan(
  request: Extract<SceneAreaPlanRequest, { intent: "delete-area" }>,
  source: { area: SceneAreaPlanAreaSource; members: SceneAreaPlanMemberSet }
): SceneAreaPlan {
  return {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId: request.canvasId,
    operationId: request.operationId,
    intent: "delete-area",
    source,
    commands: [
      {
        kind: "delete-scene-area",
        areaId: request.area.areaId,
        expectedScopeVersion: request.area.scopeVersion
      }
    ],
    inverse: [
      {
        kind: "restore-scene-area",
        areaId: request.area.areaId,
        scopeVersion: request.area.scopeVersion,
        bounds: copyBounds(request.area.bounds)
      }
    ]
  };
}

function buildDeleteContentsPlan(
  request: Extract<SceneAreaPlanRequest, { intent: "delete-area-with-contents" }>,
  source: { area: SceneAreaPlanAreaSource; members: SceneAreaPlanMemberSet }
): SceneAreaPlan {
  const commands: SceneAreaPlanCommand[] = [
    ...request.members.instances.map(
      (member): SceneAreaPlanCommand => ({
        kind: "delete-instance",
        target: { kind: "instance", instanceId: member.identity.instanceId },
        expectedVersion: member.version
      })
    ),
    ...request.members.cameras.map(
      (member): SceneAreaPlanCommand => ({
        kind: "delete-world-camera",
        target: { kind: "camera", cameraId: member.identity.cameraId },
        expectedVersion: member.version
      })
    ),
    {
      kind: "delete-scene-area",
      areaId: request.area.areaId,
      expectedScopeVersion: request.area.scopeVersion
    }
  ];

  const inverse: SceneAreaPlanInverseCommand[] = [
    {
      kind: "restore-scene-area",
      areaId: request.area.areaId,
      scopeVersion: request.area.scopeVersion,
      bounds: copyBounds(request.area.bounds)
    },
    ...request.members.instances.map(
      (member): SceneAreaPlanInverseCommand => ({
        kind: "restore-instance",
        target: { kind: "instance", instanceId: member.identity.instanceId },
        version: member.version,
        transform: copyTransform(member.transform)
      })
    ),
    ...request.members.cameras.map(
      (member): SceneAreaPlanInverseCommand => ({
        kind: "restore-world-camera",
        target: { kind: "camera", cameraId: member.identity.cameraId },
        version: member.version,
        camera: copyCamera(member.camera)
      })
    )
  ];

  return {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId: request.canvasId,
    operationId: request.operationId,
    intent: "delete-area-with-contents",
    source,
    commands,
    inverse
  };
}

/**
 * Build one atomic forward plan and its exact inverse from a frozen request.
 * The request is never mutated and the plan never shares mutable sub-values with
 * it: every bounds, point, rotation, transform and camera payload is copied.
 */
export function planSceneAreaOperation(request: SceneAreaPlanRequest): SceneAreaPlanResult {
  const code = classifySceneAreaPlanRequest(request);
  if (code) return failure(code, (request as { operationId?: unknown } | null | undefined)?.operationId);

  const typed = request as SceneAreaPlanRequest;
  const source = {
    area: copyArea(typed.area),
    members: copyMembers(typed.members)
  };

  switch (typed.intent) {
    case "move":
      return { ok: true, plan: buildMovePlan(typed, source) };
    case "resize":
      return { ok: true, plan: buildResizePlan(typed, source) };
    case "delete-area":
      return { ok: true, plan: buildDeleteAreaPlan(typed, source) };
    case "delete-area-with-contents":
      return { ok: true, plan: buildDeleteContentsPlan(typed, source) };
  }
}

/** Factory for consumers that depend on the frozen `SceneAreaPlanPlanner` port. */
export function createSceneAreaPlanPlanner(): SceneAreaPlanPlanner {
  return { plan: planSceneAreaOperation };
}

/** Shared stateless implementation; safe because planning holds no state. */
export const sceneAreaPlanPlanner: SceneAreaPlanPlanner = createSceneAreaPlanPlanner();

export default planSceneAreaOperation;
