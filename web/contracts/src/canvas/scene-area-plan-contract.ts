/**
 * Scene-area batch operation plan contract (T06 interface).
 *
 * This module freezes the pure plan interface consumed by OC04. It deliberately
 * contains no planner implementation: OC04 owns the algorithm in
 * `scene-area-operation-plan.ts`, while the authoritative canvas layer owns
 * eligibility, spatial leases, version checks, persistence and undo receipts.
 *
 * The caller passes a gesture-time snapshot that it has already verified against
 * the authoritative world:
 *
 * - the fixed writable member set (complete instances and cameras whose ground
 *   anchor was inside the area at gesture start);
 * - the source area scope version and bounds;
 * - each member's source object version plus its world transform / camera pose.
 *
 * The planner output is one atomic forward plan and one exact inverse plan.
 * Membership is never recomputed from the current area: objects that are only
 * partially contained, objects outside the area, and objects the gesture passes
 * over are not absorbed. Moving preserves each member's height, rotation and
 * scale; only ground `u`/`v` changes. Resizing (edge drag or explicit range mode)
 * changes only the area bounds. Default area deletion removes only the area;
 * explicit delete-with-contents removes exactly the fixed eligible member set and
 * never touches generated media or tasks.
 *
 * `operationId` is the idempotency intent. The authority compares the persisted
 * operation identity (intent + frozen source versions + frozen members) before
 * replaying. A retry with the same intent returns the original plan; reuse with a
 * different intent is `operation-conflict`. Redo replays the frozen values through
 * the authority receipt and must not recompute containment or absorb new objects.
 *
 * Failure taxonomy is declarative and ordered. OC04 applies
 * `SCENE_AREA_PLAN_FAILURE_PRECEDENCE` and returns the code registered for the
 * first matching rule in `SCENE_AREA_PLAN_FAILURE_RULES`; every rule is disjoint
 * enough that a request has exactly one classification.
 *
 * - `unsupported-version`: the plan contract, world transform or camera payload
 *   declares a version this contract does not support.
 * - `unknown-input`: a required source snapshot is absent or unreadable: an empty
 *   or missing area scope version, an empty or missing member source version, or a
 *   missing member transform/camera payload. Unknown never degrades to an empty
 *   writable set.
 * - `invalid-input`: malformed or out-of-domain request fields: empty canvas,
 *   operation, area or object identity, non-finite numbers, unordered bounds, a repeated
 *   identity that carries the same source version, or a camera identity that does
 *   not match `camera.cameraId`. Pose internals (rotation norm, scale, projection
 *   ranges) are already decoded by OC01 and are not reclassified here.
 * - `source-version-conflict`: the frozen snapshot contradicts itself: one identity
 *   carries two different source versions, or a camera member version differs from
 *   `camera.settingsVersion`.
 * - `operation-conflict`: the same `operationId` is reused for a different intent.
 *   This code is decided by the authority, not by a stateless planner.
 *
 * Occupancy, leases, commit and history remain outside this contract. The plan
 * command vocabulary contains no lease, media, task, asset or history command.
 */

import {
  SHARED_WORLD_VERSION,
  type GroundAabb,
  type GroundPoint,
  type WorldCameraData,
  type WorldId,
  type WorldObjectIdentity,
  type WorldPoint,
  type WorldRotation,
  type WorldTransform,
  type WorldVersion
} from "./shared-world.js";

export const SCENE_AREA_PLAN_CONTRACT_VERSION = "scene-area-plan-v1" as const;

export type SceneAreaPlanIntent = "move" | "resize" | "delete-area" | "delete-area-with-contents";

export type SceneAreaPlanInstanceIdentity = Extract<WorldObjectIdentity, { kind: "instance" }>;
export type SceneAreaPlanCameraIdentity = Extract<WorldObjectIdentity, { kind: "camera" }>;

/** Source area snapshot. `scopeVersion` changes when bounds or area identity change. */
export interface SceneAreaPlanAreaSource {
  areaId: WorldId;
  scopeVersion: WorldVersion;
  bounds: GroundAabb;
}

/** One complete instance fixed at gesture start, with the source object version. */
export interface SceneAreaPlanInstanceMember {
  identity: SceneAreaPlanInstanceIdentity;
  /** Source object version; the authority rejects a write when it no longer matches. */
  version: WorldVersion;
  transform: WorldTransform;
}

/** One camera whose ground anchor was inside the area at gesture start.
 * `version` must equal `camera.settingsVersion`; the card position is not used.
 */
export interface SceneAreaPlanCameraMember {
  identity: SceneAreaPlanCameraIdentity;
  version: WorldVersion;
  camera: WorldCameraData;
}

/** Complete fixed writable set. Read-only references and partial containment are
 * intentionally absent: they cannot be promoted by planning. */
export interface SceneAreaPlanMemberSet {
  instances: SceneAreaPlanInstanceMember[];
  cameras: SceneAreaPlanCameraMember[];
}

interface SceneAreaPlanRequestBase {
  contractVersion: typeof SCENE_AREA_PLAN_CONTRACT_VERSION;
  canvasId: WorldId;
  /** Idempotent intent identity; the same id with another intent is a conflict. */
  operationId: WorldId;
  area: SceneAreaPlanAreaSource;
  members: SceneAreaPlanMemberSet;
}

/** Four supported intents. `move` preserves height and relative pose; `resize`
 * is the edge drag / explicit range mode and changes bounds only; the two delete
 * intents differ only in whether the fixed member set is deleted too. */
export type SceneAreaPlanRequest =
  | (SceneAreaPlanRequestBase & { intent: "move"; delta: GroundPoint })
  | (SceneAreaPlanRequestBase & { intent: "resize"; bounds: GroundAabb })
  | (SceneAreaPlanRequestBase & { intent: "delete-area" })
  | (SceneAreaPlanRequestBase & { intent: "delete-area-with-contents" });

/** Forward commands carry the source version they expect, so the authority can
 * reject the whole batch before writing when a member or area changed. These
 * expected versions belong to the first committed attempt; an idempotent retry
 * returns the original plan, while redo binds the frozen values through the
 * authority receipt. */
export type SceneAreaPlanCommand =
  | { kind: "set-scene-area-bounds"; areaId: WorldId; expectedScopeVersion: WorldVersion; bounds: GroundAabb }
  | { kind: "set-instance-transform"; target: SceneAreaPlanInstanceIdentity; expectedVersion: WorldVersion; transform: WorldTransform }
  | { kind: "set-world-camera-pose"; target: SceneAreaPlanCameraIdentity; expectedVersion: WorldVersion; position: WorldPoint; rotation: WorldRotation }
  | { kind: "delete-scene-area"; areaId: WorldId; expectedScopeVersion: WorldVersion }
  | { kind: "delete-instance"; target: SceneAreaPlanInstanceIdentity; expectedVersion: WorldVersion }
  | { kind: "delete-world-camera"; target: SceneAreaPlanCameraIdentity; expectedVersion: WorldVersion };

/** Inverse commands replay the frozen pre-gesture values exactly, including the
 * frozen source area `scopeVersion`. The authority receipt binds the inverse to the
 * exact post-forward state it produced and rejects a stale receipt before writing,
 * so undo restores the frozen snapshot identity instead of minting a fresh version
 * and never recomputes membership. A normal forward bounds edit still replaces the
 * scope version as declared by `SceneAreaData` in `shared-world.ts`.
 *
 * Inverse member commands carry the source object versions for the same reason:
 * they describe the frozen snapshot, not a new forward write. The receipt, not the
 * planner, supplies the version that the forward commit actually produced.
 */
export type SceneAreaPlanInverseCommand =
  | { kind: "restore-scene-area-bounds"; areaId: WorldId; scopeVersion: WorldVersion; bounds: GroundAabb }
  | { kind: "restore-scene-area"; areaId: WorldId; scopeVersion: WorldVersion; bounds: GroundAabb }
  | { kind: "restore-instance"; target: SceneAreaPlanInstanceIdentity; version: WorldVersion; transform: WorldTransform }
  | { kind: "restore-world-camera"; target: SceneAreaPlanCameraIdentity; version: WorldVersion; camera: WorldCameraData };

export interface SceneAreaPlanSource {
  area: SceneAreaPlanAreaSource;
  members: SceneAreaPlanMemberSet;
}

/** One atomic operation: every forward command commits together or none does.
 * `source` is the exact gesture-time snapshot; `inverse` is its undo plan. */
export interface SceneAreaPlan {
  contractVersion: typeof SCENE_AREA_PLAN_CONTRACT_VERSION;
  canvasId: WorldId;
  operationId: WorldId;
  intent: SceneAreaPlanIntent;
  source: SceneAreaPlanSource;
  commands: SceneAreaPlanCommand[];
  inverse: SceneAreaPlanInverseCommand[];
}

export type SceneAreaPlanFailureCode =
  | "unknown-input"
  | "unsupported-version"
  | "invalid-input"
  | "source-version-conflict"
  | "operation-conflict";

export type SceneAreaPlanResult =
  | { ok: true; plan: SceneAreaPlan }
  | { ok: false; code: SceneAreaPlanFailureCode; operationId: WorldId };

/** OC04 implements this interface. Pure: no I/O, storage, lease, network or
 * mutation of the request; the returned plan is a new value. */
export interface SceneAreaPlanPlanner {
  plan(request: SceneAreaPlanRequest): SceneAreaPlanResult;
}

/** Domains that must never appear in a plan command. */
export const SCENE_AREA_PLAN_EXCLUDED_DOMAINS = [
  "lease",
  "commit",
  "storage",
  "media",
  "task",
  "asset",
  "history"
] as const;

/** Idempotency and redo boundary. The authority persists these decisions; the
 * pure planner only emits the matching plan or failure code. */
export const SCENE_AREA_PLAN_IDEMPOTENCY = {
  sameIntent: "same-operationId-with-identical-intent-and-source-returns-original-plan",
  conflictingIntent: "operation-conflict",
  redoBoundary: "redo-replays-frozen-values-through-receipt-bound-versions-without-recomputing-membership-or-containment",
  sourceCheck: "authority-compares-frozen-intent-members-and-source-versions"
} as const;

/** Deterministic command order expected from OC04:
 * - move: area bounds, instances in request order, cameras in request order;
 * - resize: area bounds only;
 * - delete-area: area only;
 * - delete-area-with-contents: instances, cameras, then area;
 * - inverse: area restore first, then instances, then cameras.
 */
export const SCENE_AREA_PLAN_COMMAND_ORDER = {
  move: ["set-scene-area-bounds", "set-instance-transform", "set-world-camera-pose"],
  resize: ["set-scene-area-bounds"],
  "delete-area": ["delete-scene-area"],
  "delete-area-with-contents": ["delete-instance", "delete-world-camera", "delete-scene-area"]
} as const;

/* ------------------------------------------------------------------------- */
/* Declarative failure taxonomy. Downstream planners follow the order.        */
/* ------------------------------------------------------------------------- */

export type SceneAreaPlanFailureRuleId =
  | "unsupported-contract-version"
  | "unsupported-transform-version"
  | "unsupported-camera-version"
  | "missing-area-scope-version"
  | "missing-member-version"
  | "missing-member-payload"
  | "empty-canvas-id"
  | "empty-operation-id"
  | "empty-area-id"
  | "empty-identity-id"
  | "non-finite-number"
  | "unordered-bounds"
  | "duplicate-member-identity"
  | "camera-identity-mismatch"
  | "duplicate-identity-version-contradiction"
  | "camera-version-contradiction"
  | "operation-intent-reuse";

export interface SceneAreaPlanFailureRule {
  readonly code: SceneAreaPlanFailureCode;
  readonly stage: "version" | "snapshot" | "shape" | "contradiction" | "authority";
  readonly description: string;
}

/** Every rule maps to exactly one failure code. The docs above and the fixtures
 * below read their codes from this table, so they cannot drift apart. */
export const SCENE_AREA_PLAN_FAILURE_RULES: Readonly<Record<SceneAreaPlanFailureRuleId, SceneAreaPlanFailureRule>> = {
  "unsupported-contract-version": {
    code: "unsupported-version",
    stage: "version",
    description: "request.contractVersion is not scene-area-plan-v1"
  },
  "unsupported-transform-version": {
    code: "unsupported-version",
    stage: "version",
    description: "a member transform declares a shared-world version this contract does not support"
  },
  "unsupported-camera-version": {
    code: "unsupported-version",
    stage: "version",
    description: "a member camera payload declares a kind or version this contract does not support"
  },
  "missing-area-scope-version": {
    code: "unknown-input",
    stage: "snapshot",
    description: "the required source area scope version is absent or empty"
  },
  "missing-member-version": {
    code: "unknown-input",
    stage: "snapshot",
    description: "a required member source version is absent or empty"
  },
  "missing-member-payload": {
    code: "unknown-input",
    stage: "snapshot",
    description: "a required member transform or camera payload is absent or unreadable"
  },
  "empty-canvas-id": {
    code: "invalid-input",
    stage: "shape",
    description: "canvasId must be a nonempty stable id"
  },
  "empty-operation-id": {
    code: "invalid-input",
    stage: "shape",
    description: "operationId must be a nonempty stable id"
  },
  "empty-area-id": {
    code: "invalid-input",
    stage: "shape",
    description: "area.areaId must be a nonempty stable id"
  },
  "empty-identity-id": {
    code: "invalid-input",
    stage: "shape",
    description: "every member identity id must be nonempty"
  },
  "non-finite-number": {
    code: "invalid-input",
    stage: "shape",
    description: "bounds, delta, pose and camera numbers must be finite"
  },
  "unordered-bounds": {
    code: "invalid-input",
    stage: "shape",
    description: "bounds.min must not exceed bounds.max on either axis; zero size is valid"
  },
  "duplicate-member-identity": {
    code: "invalid-input",
    stage: "shape",
    description: "member identities must be unique when their source versions agree"
  },
  "camera-identity-mismatch": {
    code: "invalid-input",
    stage: "shape",
    description: "camera member identity must match camera.cameraId"
  },
  "duplicate-identity-version-contradiction": {
    code: "source-version-conflict",
    stage: "contradiction",
    description: "one identity cannot carry two different source versions"
  },
  "camera-version-contradiction": {
    code: "source-version-conflict",
    stage: "contradiction",
    description: "camera member version must equal camera.settingsVersion"
  },
  "operation-intent-reuse": {
    code: "operation-conflict",
    stage: "authority",
    description: "the authority persisted this operationId with a different intent"
  }
};

/** First applicable rule wins. Version checks run before snapshot checks, snapshot
 * checks before shape checks, shape checks before contradictions, and the
 * authority-only operationId reuse check runs last (or in the authority itself). */
export const SCENE_AREA_PLAN_FAILURE_PRECEDENCE: readonly SceneAreaPlanFailureRuleId[] = [
  "unsupported-contract-version",
  "unsupported-transform-version",
  "unsupported-camera-version",
  "missing-area-scope-version",
  "missing-member-version",
  "missing-member-payload",
  "empty-canvas-id",
  "empty-operation-id",
  "empty-area-id",
  "empty-identity-id",
  "non-finite-number",
  "unordered-bounds",
  "duplicate-member-identity",
  "camera-identity-mismatch",
  "duplicate-identity-version-contradiction",
  "camera-version-contradiction",
  "operation-intent-reuse"
];

export const SCENE_AREA_PLAN_FAILURE_CODES: readonly SceneAreaPlanFailureCode[] = [
  "unknown-input",
  "unsupported-version",
  "invalid-input",
  "source-version-conflict",
  "operation-conflict"
];

/* ------------------------------------------------------------------------- */
/* Exact JSON allowlists. Downstream decoders must reject any extra key.      */
/* ------------------------------------------------------------------------- */

const REQUEST_BASE_KEYS = ["contractVersion", "canvasId", "operationId", "intent", "area", "members"] as const;

export const SCENE_AREA_PLAN_REQUEST_KEYS: Readonly<Record<SceneAreaPlanIntent, readonly string[]>> = {
  move: [...REQUEST_BASE_KEYS, "delta"],
  resize: [...REQUEST_BASE_KEYS, "bounds"],
  "delete-area": REQUEST_BASE_KEYS,
  "delete-area-with-contents": REQUEST_BASE_KEYS
};

export const SCENE_AREA_PLAN_AREA_KEYS = ["areaId", "scopeVersion", "bounds"] as const;
export const SCENE_AREA_PLAN_MEMBERS_KEYS = ["instances", "cameras"] as const;
export const SCENE_AREA_PLAN_INSTANCE_MEMBER_KEYS = ["identity", "version", "transform"] as const;
export const SCENE_AREA_PLAN_CAMERA_MEMBER_KEYS = ["identity", "version", "camera"] as const;
export const SCENE_AREA_PLAN_INSTANCE_IDENTITY_KEYS = ["kind", "instanceId"] as const;
export const SCENE_AREA_PLAN_CAMERA_IDENTITY_KEYS = ["kind", "cameraId"] as const;
export const SCENE_AREA_PLAN_KEYS = ["contractVersion", "canvasId", "operationId", "intent", "source", "commands", "inverse"] as const;
export const SCENE_AREA_PLAN_SOURCE_KEYS = ["area", "members"] as const;
export const SCENE_AREA_PLAN_RESULT_KEYS = {
  ok: ["ok", "plan"],
  failure: ["ok", "code", "operationId"]
} as const;

export const SCENE_AREA_PLAN_COMMAND_KINDS = [
  "set-scene-area-bounds",
  "set-instance-transform",
  "set-world-camera-pose",
  "delete-scene-area",
  "delete-instance",
  "delete-world-camera"
] as const;

export type SceneAreaPlanCommandKind = (typeof SCENE_AREA_PLAN_COMMAND_KINDS)[number];

export const SCENE_AREA_PLAN_INVERSE_COMMAND_KINDS = [
  "restore-scene-area-bounds",
  "restore-scene-area",
  "restore-instance",
  "restore-world-camera"
] as const;

export type SceneAreaPlanInverseCommandKind = (typeof SCENE_AREA_PLAN_INVERSE_COMMAND_KINDS)[number];

export const SCENE_AREA_PLAN_COMMAND_KEYS: Readonly<Record<SceneAreaPlanCommandKind, readonly string[]>> = {
  "set-scene-area-bounds": ["kind", "areaId", "expectedScopeVersion", "bounds"],
  "set-instance-transform": ["kind", "target", "expectedVersion", "transform"],
  "set-world-camera-pose": ["kind", "target", "expectedVersion", "position", "rotation"],
  "delete-scene-area": ["kind", "areaId", "expectedScopeVersion"],
  "delete-instance": ["kind", "target", "expectedVersion"],
  "delete-world-camera": ["kind", "target", "expectedVersion"]
};

export const SCENE_AREA_PLAN_INVERSE_COMMAND_KEYS: Readonly<Record<SceneAreaPlanInverseCommandKind, readonly string[]>> = {
  "restore-scene-area-bounds": ["kind", "areaId", "scopeVersion", "bounds"],
  "restore-scene-area": ["kind", "areaId", "scopeVersion", "bounds"],
  "restore-instance": ["kind", "target", "version", "transform"],
  "restore-world-camera": ["kind", "target", "version", "camera"]
};

/* ------------------------------------------------------------------------- */
/* Contract fixtures. These are declarative data for OC04 regressions and for */
/* reviewers; they do not implement the planner.                              */
/* ------------------------------------------------------------------------- */

export type SceneAreaPlanFixtureExpectation =
  | { kind: "plan"; commands: SceneAreaPlanCommand[]; inverse: SceneAreaPlanInverseCommand[] }
  | { kind: "failure"; code: SceneAreaPlanFailureCode };

export interface SceneAreaPlanFixture {
  readonly name: string;
  readonly request: SceneAreaPlanRequest;
  /** Failure fixtures only: the taxonomy rule this request violates. Its code is
   * always read from `SCENE_AREA_PLAN_FAILURE_RULES`, never written independently. */
  readonly rule?: SceneAreaPlanFailureRuleId;
  /** Failure fixtures only: the persisted intent an authority already holds. */
  readonly storedIntent?: SceneAreaPlanIntent;
  /** Generated media that must survive every intent. It never appears in a plan. */
  readonly preservedMediaIds?: readonly WorldId[];
  /** Traversed, partial or read-only objects that must never be absorbed. */
  readonly excludedObjectIds?: readonly WorldId[];
  readonly expected: SceneAreaPlanFixtureExpectation;
}

const FIXTURE_CANVAS_ID = "canvas-plan-fixture";
const FIXTURE_AREA: SceneAreaPlanAreaSource = {
  areaId: "area-main",
  scopeVersion: "area-scope-1",
  bounds: { min: { u: 0, v: 0 }, max: { u: 10, v: 10 } }
};

const FIXTURE_INSTANCE_A: SceneAreaPlanInstanceMember = {
  identity: { kind: "instance", instanceId: "instance-a" },
  version: "instance-a-v1",
  transform: {
    version: SHARED_WORLD_VERSION,
    position: { u: 1, v: 2, h: 1.5 },
    rotation: [0, 0, 0, 1],
    scale: 1.25
  }
};

const FIXTURE_INSTANCE_B: SceneAreaPlanInstanceMember = {
  identity: { kind: "instance", instanceId: "instance-b" },
  version: "instance-b-v1",
  transform: {
    version: SHARED_WORLD_VERSION,
    position: { u: 6, v: 7, h: 0.5 },
    rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
    scale: 1
  }
};

const FIXTURE_CAMERA_C: SceneAreaPlanCameraMember = {
  identity: { kind: "camera", cameraId: "camera-c" },
  version: "camera-c-v1",
  camera: {
    kind: "world-camera",
    version: SHARED_WORLD_VERSION,
    cameraId: "camera-c",
    settingsVersion: "camera-c-v1",
    position: { u: 4, v: 5, h: 2 },
    rotation: [0, 0, 0, 1],
    projection: { kind: "perspective", verticalFovRadians: 0.8, nearMeters: 0.1, farMeters: 100 },
    captureMode: { kind: "static" },
    aspect: { width: 16, height: 9 },
    boundInstanceId: null
  }
};

/** Objects outside the gesture-start eligible set: one traversed model and one
 * partially contained reference. They exist only to prove plans never absorb them. */
const FIXTURE_EXCLUDED_OBJECT_IDS = ["instance-traversed", "instance-partial-reference"] as const;
const FIXTURE_PRESERVED_MEDIA_IDS = ["media-generated-shot-1"] as const;

function members(...instances: SceneAreaPlanInstanceMember[]): SceneAreaPlanMemberSet {
  return { instances, cameras: [FIXTURE_CAMERA_C] };
}

function moveRequest(): SceneAreaPlanRequest {
  return {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId: FIXTURE_CANVAS_ID,
    operationId: "operation-move-1",
    intent: "move",
    area: FIXTURE_AREA,
    members: members(FIXTURE_INSTANCE_A, FIXTURE_INSTANCE_B),
    delta: { u: 4, v: -3 }
  };
}

function resizeRequest(): SceneAreaPlanRequest {
  return {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId: FIXTURE_CANVAS_ID,
    operationId: "operation-resize-1",
    intent: "resize",
    area: FIXTURE_AREA,
    members: members(FIXTURE_INSTANCE_A, FIXTURE_INSTANCE_B),
    bounds: { min: { u: -2, v: -1 }, max: { u: 12, v: 11 } }
  };
}

function deleteAreaRequest(): SceneAreaPlanRequest {
  return {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId: FIXTURE_CANVAS_ID,
    operationId: "operation-delete-area-1",
    intent: "delete-area",
    area: FIXTURE_AREA,
    members: members(FIXTURE_INSTANCE_A, FIXTURE_INSTANCE_B)
  };
}

function deleteContentsRequest(): SceneAreaPlanRequest {
  return {
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId: FIXTURE_CANVAS_ID,
    operationId: "operation-delete-contents-1",
    intent: "delete-area-with-contents",
    area: FIXTURE_AREA,
    members: members(FIXTURE_INSTANCE_A, FIXTURE_INSTANCE_B)
  };
}

const MOVE_COMMANDS: SceneAreaPlanCommand[] = [
  {
    kind: "set-scene-area-bounds",
    areaId: "area-main",
    expectedScopeVersion: "area-scope-1",
    bounds: { min: { u: 4, v: -3 }, max: { u: 14, v: 7 } }
  },
  {
    kind: "set-instance-transform",
    target: { kind: "instance", instanceId: "instance-a" },
    expectedVersion: "instance-a-v1",
    transform: {
      version: SHARED_WORLD_VERSION,
      position: { u: 5, v: -1, h: 1.5 },
      rotation: [0, 0, 0, 1],
      scale: 1.25
    }
  },
  {
    kind: "set-instance-transform",
    target: { kind: "instance", instanceId: "instance-b" },
    expectedVersion: "instance-b-v1",
    transform: {
      version: SHARED_WORLD_VERSION,
      position: { u: 10, v: 4, h: 0.5 },
      rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
      scale: 1
    }
  },
  {
    kind: "set-world-camera-pose",
    target: { kind: "camera", cameraId: "camera-c" },
    expectedVersion: "camera-c-v1",
    position: { u: 8, v: 2, h: 2 },
    rotation: [0, 0, 0, 1]
  }
];

const MOVE_INVERSE: SceneAreaPlanInverseCommand[] = [
  {
    kind: "restore-scene-area-bounds",
    areaId: "area-main",
    scopeVersion: "area-scope-1",
    bounds: FIXTURE_AREA.bounds
  },
  {
    kind: "restore-instance",
    target: { kind: "instance", instanceId: "instance-a" },
    version: "instance-a-v1",
    transform: FIXTURE_INSTANCE_A.transform
  },
  {
    kind: "restore-instance",
    target: { kind: "instance", instanceId: "instance-b" },
    version: "instance-b-v1",
    transform: FIXTURE_INSTANCE_B.transform
  },
  {
    kind: "restore-world-camera",
    target: { kind: "camera", cameraId: "camera-c" },
    version: "camera-c-v1",
    camera: FIXTURE_CAMERA_C.camera
  }
];

const DELETE_CONTENTS_COMMANDS: SceneAreaPlanCommand[] = [
  {
    kind: "delete-instance",
    target: { kind: "instance", instanceId: "instance-a" },
    expectedVersion: "instance-a-v1"
  },
  {
    kind: "delete-instance",
    target: { kind: "instance", instanceId: "instance-b" },
    expectedVersion: "instance-b-v1"
  },
  {
    kind: "delete-world-camera",
    target: { kind: "camera", cameraId: "camera-c" },
    expectedVersion: "camera-c-v1"
  },
  { kind: "delete-scene-area", areaId: "area-main", expectedScopeVersion: "area-scope-1" }
];

const DELETE_CONTENTS_INVERSE: SceneAreaPlanInverseCommand[] = [
  {
    kind: "restore-scene-area",
    areaId: "area-main",
    scopeVersion: "area-scope-1",
    bounds: FIXTURE_AREA.bounds
  },
  {
    kind: "restore-instance",
    target: { kind: "instance", instanceId: "instance-a" },
    version: "instance-a-v1",
    transform: FIXTURE_INSTANCE_A.transform
  },
  {
    kind: "restore-instance",
    target: { kind: "instance", instanceId: "instance-b" },
    version: "instance-b-v1",
    transform: FIXTURE_INSTANCE_B.transform
  },
  {
    kind: "restore-world-camera",
    target: { kind: "camera", cameraId: "camera-c" },
    version: "camera-c-v1",
    camera: FIXTURE_CAMERA_C.camera
  }
];

function failure(
  rule: SceneAreaPlanFailureRuleId,
  request: SceneAreaPlanRequest,
  extra: Omit<SceneAreaPlanFixture, "name" | "request" | "rule" | "expected"> = {}
): SceneAreaPlanFixture {
  return {
    name: `failure-${rule}`,
    request,
    rule,
    ...extra,
    expected: { kind: "failure", code: SCENE_AREA_PLAN_FAILURE_RULES[rule].code }
  };
}

export const SCENE_AREA_PLAN_FIXTURES: readonly SceneAreaPlanFixture[] = [
  {
    name: "move-fixed-members-preserve-height-and-relative-pose",
    request: moveRequest(),
    preservedMediaIds: FIXTURE_PRESERVED_MEDIA_IDS,
    excludedObjectIds: FIXTURE_EXCLUDED_OBJECT_IDS,
    expected: { kind: "plan", commands: MOVE_COMMANDS, inverse: MOVE_INVERSE }
  },
  {
    name: "resize-bounds-only",
    request: resizeRequest(),
    preservedMediaIds: FIXTURE_PRESERVED_MEDIA_IDS,
    excludedObjectIds: FIXTURE_EXCLUDED_OBJECT_IDS,
    expected: {
      kind: "plan",
      commands: [
        {
          kind: "set-scene-area-bounds",
          areaId: "area-main",
          expectedScopeVersion: "area-scope-1",
          bounds: { min: { u: -2, v: -1 }, max: { u: 12, v: 11 } }
        }
      ],
      inverse: [
        {
          kind: "restore-scene-area-bounds",
          areaId: "area-main",
          scopeVersion: "area-scope-1",
          bounds: FIXTURE_AREA.bounds
        }
      ]
    }
  },
  {
    name: "delete-area-keeps-members-and-media",
    request: deleteAreaRequest(),
    preservedMediaIds: FIXTURE_PRESERVED_MEDIA_IDS,
    excludedObjectIds: FIXTURE_EXCLUDED_OBJECT_IDS,
    expected: {
      kind: "plan",
      commands: [
        { kind: "delete-scene-area", areaId: "area-main", expectedScopeVersion: "area-scope-1" }
      ],
      inverse: [
        {
          kind: "restore-scene-area",
          areaId: "area-main",
          scopeVersion: "area-scope-1",
          bounds: FIXTURE_AREA.bounds
        }
      ]
    }
  },
  {
    name: "delete-area-with-contents-uses-fixed-eligible-set-and-keeps-media",
    request: deleteContentsRequest(),
    preservedMediaIds: FIXTURE_PRESERVED_MEDIA_IDS,
    excludedObjectIds: FIXTURE_EXCLUDED_OBJECT_IDS,
    expected: { kind: "plan", commands: DELETE_CONTENTS_COMMANDS, inverse: DELETE_CONTENTS_INVERSE }
  },
  failure("non-finite-number", { ...moveRequest(), delta: { u: Number.NaN, v: 0 } } as SceneAreaPlanRequest),
  failure("unordered-bounds", {
    ...resizeRequest(),
    bounds: { min: { u: 10, v: 0 }, max: { u: 5, v: 10 } }
  } as SceneAreaPlanRequest),
  failure("duplicate-member-identity", { ...moveRequest(), members: members(FIXTURE_INSTANCE_A, FIXTURE_INSTANCE_A) }),
  failure("empty-operation-id", { ...moveRequest(), operationId: "" }),
  failure("empty-canvas-id", { ...moveRequest(), canvasId: "" }),
  failure("empty-area-id", { ...moveRequest(), area: { ...FIXTURE_AREA, areaId: "" } }),
  failure("missing-area-scope-version", { ...moveRequest(), area: { ...FIXTURE_AREA, scopeVersion: "" } }),
  failure("missing-member-version", {
    ...moveRequest(),
    members: members({ ...FIXTURE_INSTANCE_A, version: "" }, FIXTURE_INSTANCE_B)
  }),
  failure("missing-member-payload", {
    ...moveRequest(),
    members: {
      instances: [{ ...FIXTURE_INSTANCE_A, transform: undefined } as unknown as SceneAreaPlanInstanceMember],
      cameras: [FIXTURE_CAMERA_C]
    }
  }),
  failure("empty-identity-id", {
    ...moveRequest(),
    members: {
      instances: [{ ...FIXTURE_INSTANCE_A, identity: { kind: "instance", instanceId: "" } }, FIXTURE_INSTANCE_B],
      cameras: [FIXTURE_CAMERA_C]
    }
  }),
  failure("unsupported-contract-version", {
    ...moveRequest(),
    contractVersion: "scene-area-plan-v0" as typeof SCENE_AREA_PLAN_CONTRACT_VERSION
  }),
  failure("unsupported-transform-version", {
    ...moveRequest(),
    members: members({
      ...FIXTURE_INSTANCE_A,
      transform: { ...FIXTURE_INSTANCE_A.transform, version: "shared-world-v0" as typeof SHARED_WORLD_VERSION }
    })
  }),
  failure("unsupported-camera-version", {
    ...moveRequest(),
    members: {
      instances: [FIXTURE_INSTANCE_A],
      cameras: [{ ...FIXTURE_CAMERA_C, camera: { ...FIXTURE_CAMERA_C.camera, version: "shared-world-v0" as typeof SHARED_WORLD_VERSION } }]
    }
  }),
  failure("camera-identity-mismatch", {
    ...moveRequest(),
    members: {
      instances: [FIXTURE_INSTANCE_A],
      cameras: [{ ...FIXTURE_CAMERA_C, identity: { kind: "camera", cameraId: "camera-other" } }]
    }
  }),
  failure("duplicate-identity-version-contradiction", {
    ...moveRequest(),
    members: members(FIXTURE_INSTANCE_A, { ...FIXTURE_INSTANCE_A, version: "instance-a-v2" })
  }),
  failure("camera-version-contradiction", {
    ...moveRequest(),
    members: {
      instances: [FIXTURE_INSTANCE_A],
      cameras: [{ ...FIXTURE_CAMERA_C, version: "camera-c-v2" }]
    }
  }),
  failure("operation-intent-reuse", resizeRequest(), { storedIntent: "move" })
];
