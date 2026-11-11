/**
 * Authoritative world-authoring HTTP success codecs.
 *
 * The transport adapter must never hand a successor an internally incomplete
 * authority response. This module validates the nine successful response
 * envelopes routed by `CanvasRemoteService`:
 *
 * - `scene-area-prepare|commit|undo|redo`
 * - `world-tool-context|world-tool-context-revoke`
 * - `world-camera-save|restore|history`
 *
 * Validation is recursive and reuses the frozen contract codecs instead of
 * re-implementing domain rules:
 *
 * - member identities are kind-typed by their array (an instance member never
 *   accepts a camera identity and vice versa);
 * - transforms use `decodeWorldTransform` (exact version, finite point, unit
 *   quaternion, strictly positive scale);
 * - cameras and history snapshots use `decodeWorldCamera` /
 *   `decodeWorldCameraHistorySnapshot`;
 * - bounds use `decodeGroundAabb`;
 * - plan commands and inverse commands validate every field declared by
 *   `SCENE_AREA_PLAN_COMMAND_KEYS` / `SCENE_AREA_PLAN_INVERSE_COMMAND_KEYS`;
 * - receipt source snapshots, deleted nodes and the nested receipt plan are
 *   validated recursively, including source members.
 *
 * Decoders accept only successful payloads. Domain failures and HTTP envelopes
 * keep their existing transport handling so a valid server error is preserved
 * instead of being reclassified as a malformed success.
 */

import type { SharedWorldDecodeResult } from "./shared-world.js";
import type {
  SpatialLeaseIdentity,
  WorldCameraData,
  WorldObjectIdentity,
  WorldObjectVersion,
  WorldScopeIdentity,
  WorldScopeVersion,
  WorldToolContext
} from "./shared-world.js";
import type {
  WorldAuthoritySnapshot,
  WorldAuthoringEdgeSnapshot,
  WorldAuthoringFailure,
  WorldAuthoringNodeSnapshot,
  WorldAuthoringPrepareOutcome,
  WorldAuthoringReceipt,
  WorldAuthoringSourceSnapshot,
  WorldPreparedAuthoritySnapshot,
  WorldScopeOccupancyLock,
  WorldScopeOccupancySnapshot,
  WorldToolContextOutcome,
  WorldToolContextRun
} from "./world-authoring.js";
import type {
  SceneAreaPlan,
  SceneAreaPlanAreaSource,
  SceneAreaPlanCameraMember,
  SceneAreaPlanCommand,
  SceneAreaPlanInstanceMember,
  SceneAreaPlanInverseCommand,
  SceneAreaPlanIntent,
  SceneAreaPlanMemberSet
} from "./scene-area-plan-contract.js";
import {
  SCENE_AREA_PLAN_AREA_KEYS,
  SCENE_AREA_PLAN_CAMERA_IDENTITY_KEYS,
  SCENE_AREA_PLAN_CAMERA_MEMBER_KEYS,
  SCENE_AREA_PLAN_COMMAND_KEYS,
  SCENE_AREA_PLAN_INSTANCE_IDENTITY_KEYS,
  SCENE_AREA_PLAN_INSTANCE_MEMBER_KEYS,
  SCENE_AREA_PLAN_INVERSE_COMMAND_KEYS,
  SCENE_AREA_PLAN_KEYS,
  SCENE_AREA_PLAN_MEMBERS_KEYS,
  SCENE_AREA_PLAN_SOURCE_KEYS
} from "./scene-area-plan-contract.js";
import { decodeGroundAabb } from "./creation-scope-codec.js";
import type { Woohaa3CanvasJsonObject } from "./domain/index.js";
import {
  decodeFailure,
  decodeWorldPoint,
  decodeWorldRotation,
  decodeWorldTransform,
  hasOnlyKeys,
  isFiniteWorldNumber,
  isJsonRecord,
  isNonEmptyWorldId,
  ownField
} from "./shared-world-codec.js";
import {
  decodeWorldCamera,
  decodeWorldCameraHistorySnapshot
} from "./world-camera-codec.js";
import type {
  WorldCameraHistoryEntry,
  WorldCameraHistoryListOutcome,
  WorldCameraRestoreOutcome,
  WorldCameraSettingsSaveOutcome
} from "./node-history/world-camera.js";

export type WorldAuthoringResponseRoute =
  | "scene-area-prepare"
  | "scene-area-commit"
  | "scene-area-undo"
  | "scene-area-redo"
  | "world-tool-context"
  | "world-tool-context-revoke"
  | "world-camera-save"
  | "world-camera-restore"
  | "world-camera-history";

type Success<T> = Extract<T, { ok: true }>;

export type WorldAuthoringSuccessOutcome =
  | Success<WorldAuthoringPrepareOutcome>
  | Success<WorldAuthoringReceiptOutcome>
  | Success<WorldToolContextOutcome>
  | { ok: true }
  | Success<WorldCameraSettingsSaveOutcome>
  | Success<WorldCameraRestoreOutcome>
  | Success<WorldCameraHistoryListOutcome>;

/** The execute and undo/redo successes share the command envelope. */
type WorldAuthoringReceiptOutcome =
  | import("./world-authoring.js").WorldAuthoringExecuteOutcome
  | import("./world-authoring.js").WorldAuthoringHistoryOutcome;

type Decode<T> = SharedWorldDecodeResult<T>;

const PREPARE_SUCCESS_KEYS = ["ok", "snapshot"] as const;
const COMMIT_SUCCESS_KEYS = [
  "ok", "canvasId", "operationId", "commandId", "revision", "duplicate", "plan", "receipt"
] as const;
const HISTORY_SUCCESS_KEYS = [...COMMIT_SUCCESS_KEYS, "direction"] as const;
const CONTEXT_SUCCESS_KEYS = ["ok", "context", "run", "retry"] as const;
const REVOKE_SUCCESS_KEYS = ["ok"] as const;
const CAMERA_SAVE_KEYS = [
  "ok", "canvasId", "cameraId", "commandId", "revision", "duplicate", "camera", "settingsVersion"
] as const;
const CAMERA_RESTORE_KEYS = [...CAMERA_SAVE_KEYS, "history"] as const;
const CAMERA_HISTORY_KEYS = ["ok", "canvasId", "cameraId", "entries"] as const;

const SNAPSHOT_KEYS = [
  "version", "canvasId", "revision", "scope", "areaNodeId", "area", "bounds",
  "writable", "readOnly", "members", "objects", "occupancy"
] as const;
const OBJECT_ENTRY_KEYS = [
  "identity", "nodeId", "version", "containment", "contentVersion", "transformVersion"
] as const;
const OCCUPANCY_KEYS = ["version", "scope", "state", "locks", "reason"] as const;
const OCCUPANCY_LOCK_KEYS = ["target", "runId", "epoch", "state"] as const;
const SCOPE_VERSION_KEYS = ["scope", "scopeVersion"] as const;
const CONTEXT_KEYS = [
  "contextId", "canvasId", "runId", "epoch", "scope", "writableTargets", "readOnlyReferences"
] as const;
const WRITABLE_TARGET_KEYS = ["target", "lease"] as const;
const LEASE_KEYS = ["canvasId", "runId", "epoch", "target"] as const;
const RUN_KEYS = ["canvasId", "requestId", "runId", "executionId", "epoch", "state"] as const;
const RECEIPT_KEYS = [
  "version", "canvasId", "operationId", "intent", "direction", "intentHash",
  "previousCommandId", "plan", "source", "deletedNodes", "produced", "revision", "createdAt"
] as const;
const RECEIPT_SOURCE_KEYS = ["area", "members", "groups"] as const;
const NODE_SNAPSHOT_KEYS = ["nodeId", "node", "nodeData", "edges"] as const;
const MEMBER_SNAPSHOT_KEYS = [...NODE_SNAPSHOT_KEYS, "identity"] as const;
const EDGE_SNAPSHOT_KEYS = ["id", "source", "target", "sourceHandle", "targetHandle", "data"] as const;
const PRODUCED_KEYS = ["areaScopeVersion", "targets"] as const;
const HISTORY_ENTRY_KEYS = [
  "completionKey", "canvasId", "cameraId", "runId", "completionId", "settingsVersion", "createdAt", "snapshot"
] as const;

const INTENTS: readonly SceneAreaPlanIntent[] = ["move", "rotate", "resize", "delete-area", "delete-area-with-contents"];
const CONTAINMENTS = ["writable", "read-only", "outside", "unknown"] as const;
const RUN_STATES: readonly WorldToolContextRun["state"][] = ["active", "cancelled", "stopped"];
const OCCUPANCY_STATES: readonly WorldScopeOccupancySnapshot["state"][] = ["idle", "occupied", "unknown"];
const OCCUPANCY_LOCK_STATES: readonly WorldScopeOccupancyLock["state"][] = ["active", "cancelled"];
const OCCUPANCY_REASONS: readonly NonNullable<WorldScopeOccupancySnapshot["reason"]>[] = ["store-unavailable", "not-reported"];
const DIRECTIONS = ["forward", "undo", "redo"] as const;

const WORLD_AUTHORING_VERSION = "world-authoring-v1";
const WORLD_AUTHORING_RECEIPT_VERSION = "world-authoring-receipt-v1";
const WORLD_SCOPE_OCCUPANCY_VERSION = "world-scope-occupancy-v1";
const SCENE_AREA_PLAN_CONTRACT_VERSION = "scene-area-plan-v1";

const invalid = <T>(input: unknown): Decode<T> => decodeFailure("invalid-data", input);
const unsupported = <T>(input: unknown): Decode<T> => decodeFailure("unsupported-version", input);
const ok = <T>(value: T): Decode<T> => ({ ok: true, value });

function recordWithKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isJsonRecord(value) && hasOnlyKeys(value, keys);
}

/** A structural row or full nodeData payload is never an empty internal object. */
function isNonEmptyRecord(value: unknown): value is Record<string, unknown> {
  return isJsonRecord(value) && Object.keys(value).length > 0;
}

function sameIdentity(left: WorldObjectIdentity, right: WorldObjectIdentity): boolean {
  return left.kind === "instance"
    ? right.kind === "instance" && left.instanceId === right.instanceId
    : right.kind === "camera" && left.cameraId === right.cameraId;
}

function decodeInstanceIdentity(value: unknown): Extract<WorldObjectIdentity, { kind: "instance" }> | null {
  if (!recordWithKeys(value, SCENE_AREA_PLAN_INSTANCE_IDENTITY_KEYS)) return null;
  if (ownField(value, "kind") !== "instance") return null;
  const instanceId = ownField(value, "instanceId");
  return isNonEmptyWorldId(instanceId) ? { kind: "instance", instanceId } : null;
}

function decodeCameraIdentity(value: unknown): Extract<WorldObjectIdentity, { kind: "camera" }> | null {
  if (!recordWithKeys(value, SCENE_AREA_PLAN_CAMERA_IDENTITY_KEYS)) return null;
  if (ownField(value, "kind") !== "camera") return null;
  const cameraId = ownField(value, "cameraId");
  return isNonEmptyWorldId(cameraId) ? { kind: "camera", cameraId } : null;
}

function decodeObjectIdentity(value: unknown): WorldObjectIdentity | null {
  if (!isJsonRecord(value)) return null;
  return ownField(value, "kind") === "instance"
    ? decodeInstanceIdentity(value)
    : ownField(value, "kind") === "camera" ? decodeCameraIdentity(value) : null;
}

function decodeObjectVersion(value: unknown): WorldObjectVersion | null {
  if (!isJsonRecord(value)) return null;
  const kind = ownField(value, "kind");
  const version = ownField(value, "version");
  if (!isNonEmptyWorldId(version)) return null;
  if (kind === "instance") {
    const instanceId = ownField(value, "instanceId");
    return isNonEmptyWorldId(instanceId) && hasOnlyKeys(value, ["kind", "instanceId", "version"])
      ? { kind, instanceId, version }
      : null;
  }
  if (kind === "camera") {
    const cameraId = ownField(value, "cameraId");
    return isNonEmptyWorldId(cameraId) && hasOnlyKeys(value, ["kind", "cameraId", "version"])
      ? { kind, cameraId, version }
      : null;
  }
  return null;
}

function decodeScopeIdentity(value: unknown): WorldScopeIdentity | null {
  if (!isJsonRecord(value)) return null;
  if (ownField(value, "kind") === "scene-area") {
    const areaId = ownField(value, "areaId");
    return isNonEmptyWorldId(areaId) && hasOnlyKeys(value, ["kind", "areaId"])
      ? { kind: "scene-area", areaId }
      : null;
  }
  if (ownField(value, "kind") === "world-camera") {
    const cameraId = ownField(value, "cameraId");
    return isNonEmptyWorldId(cameraId) && hasOnlyKeys(value, ["kind", "cameraId"])
      ? { kind: "world-camera", cameraId } : null;
  }
  if (ownField(value, "kind") === "workflow-group-2d") {
    const groupId = ownField(value, "groupId");
    return isNonEmptyWorldId(groupId) && hasOnlyKeys(value, ["kind", "groupId"])
      ? { kind: "workflow-group-2d", groupId }
      : null;
  }
  return null;
}

function decodeScopeVersion(value: unknown): WorldScopeVersion | null {
  if (!recordWithKeys(value, SCOPE_VERSION_KEYS)) return null;
  const scope = decodeScopeIdentity(ownField(value, "scope"));
  const scopeVersion = ownField(value, "scopeVersion");
  return scope && isNonEmptyWorldId(scopeVersion) ? { scope, scopeVersion } : null;
}

function decodeAreaSource(value: unknown): SceneAreaPlanAreaSource | null {
  if (!recordWithKeys(value, SCENE_AREA_PLAN_AREA_KEYS)) return null;
  const areaId = ownField(value, "areaId");
  const scopeVersion = ownField(value, "scopeVersion");
  const bounds = decodeGroundAabb(ownField(value, "bounds"));
  return isNonEmptyWorldId(areaId) && isNonEmptyWorldId(scopeVersion) && bounds
    ? { areaId, scopeVersion, bounds }
    : null;
}

function decodeInstanceMember(value: unknown): Decode<SceneAreaPlanInstanceMember> {
  if (!recordWithKeys(value, SCENE_AREA_PLAN_INSTANCE_MEMBER_KEYS)) return invalid(value);
  const identity = decodeInstanceIdentity(ownField(value, "identity"));
  const version = ownField(value, "version");
  if (!identity || !isNonEmptyWorldId(version)) return invalid(value);
  const transform = decodeWorldTransform(ownField(value, "transform"));
  if (!transform.ok) return decodeFailure(transform.code, value);
  return ok({ identity, version, transform: transform.value });
}

function decodeCameraMember(value: unknown): Decode<SceneAreaPlanCameraMember> {
  if (!recordWithKeys(value, SCENE_AREA_PLAN_CAMERA_MEMBER_KEYS)) return invalid(value);
  const identity = decodeCameraIdentity(ownField(value, "identity"));
  const version = ownField(value, "version");
  if (!identity || !isNonEmptyWorldId(version)) return invalid(value);
  const camera = decodeWorldCamera(ownField(value, "camera"));
  if (!camera.ok) return decodeFailure(camera.code, value);
  if (identity.cameraId !== camera.value.cameraId || version !== camera.value.settingsVersion) {
    return invalid(value);
  }
  return ok({ identity, version, camera: camera.value });
}

function decodeMemberSet(value: unknown): Decode<SceneAreaPlanMemberSet> {
  if (!recordWithKeys(value, SCENE_AREA_PLAN_MEMBERS_KEYS)) return invalid(value);
  const instances = decodeList(ownField(value, "instances"), decodeInstanceMember);
  if (!instances.ok) return decodeFailure(instances.code, value);
  const cameras = decodeList(ownField(value, "cameras"), decodeCameraMember);
  if (!cameras.ok) return decodeFailure(cameras.code, value);
  return ok({ instances: instances.value, cameras: cameras.value });
}

function decodePlanCommand(value: unknown): Decode<SceneAreaPlanCommand> {
  if (!isJsonRecord(value)) return invalid(value);
  const kind = ownField(value, "kind");
  if (typeof kind !== "string" || !hasOnlyKeys(value, SCENE_AREA_PLAN_COMMAND_KEYS[kind as keyof typeof SCENE_AREA_PLAN_COMMAND_KEYS] ?? [])) {
    return invalid(value);
  }
  switch (kind) {
    case "set-scene-area-bounds": {
      const areaId = ownField(value, "areaId");
      const expectedScopeVersion = ownField(value, "expectedScopeVersion");
      const bounds = decodeGroundAabb(ownField(value, "bounds"));
      return isNonEmptyWorldId(areaId) && isNonEmptyWorldId(expectedScopeVersion) && bounds
        ? ok({ kind, areaId, expectedScopeVersion, bounds })
        : invalid(value);
    }
    case "set-instance-transform": {
      const target = decodeInstanceIdentity(ownField(value, "target"));
      const expectedVersion = ownField(value, "expectedVersion");
      const transform = decodeWorldTransform(ownField(value, "transform"));
      if (!target || !isNonEmptyWorldId(expectedVersion)) return invalid(value);
      if (!transform.ok) return decodeFailure(transform.code, value);
      return ok({ kind, target, expectedVersion, transform: transform.value });
    }
    case "set-world-camera-pose": {
      const target = decodeCameraIdentity(ownField(value, "target"));
      const expectedVersion = ownField(value, "expectedVersion");
      const position = decodeWorldPoint(ownField(value, "position"));
      const rotation = decodeWorldRotation(ownField(value, "rotation"));
      return target && isNonEmptyWorldId(expectedVersion) && position && rotation
        ? ok({ kind, target, expectedVersion, position, rotation })
        : invalid(value);
    }
    case "delete-scene-area": {
      const areaId = ownField(value, "areaId");
      const expectedScopeVersion = ownField(value, "expectedScopeVersion");
      return isNonEmptyWorldId(areaId) && isNonEmptyWorldId(expectedScopeVersion)
        ? ok({ kind, areaId, expectedScopeVersion })
        : invalid(value);
    }
    case "delete-instance": {
      const target = decodeInstanceIdentity(ownField(value, "target"));
      const expectedVersion = ownField(value, "expectedVersion");
      return target && isNonEmptyWorldId(expectedVersion) ? ok({ kind, target, expectedVersion }) : invalid(value);
    }
    case "delete-world-camera": {
      const target = decodeCameraIdentity(ownField(value, "target"));
      const expectedVersion = ownField(value, "expectedVersion");
      return target && isNonEmptyWorldId(expectedVersion) ? ok({ kind, target, expectedVersion }) : invalid(value);
    }
    default:
      return invalid(value);
  }
}

function decodeInverseCommand(value: unknown): Decode<SceneAreaPlanInverseCommand> {
  if (!isJsonRecord(value)) return invalid(value);
  const kind = ownField(value, "kind");
  if (typeof kind !== "string" || !hasOnlyKeys(value, SCENE_AREA_PLAN_INVERSE_COMMAND_KEYS[kind as keyof typeof SCENE_AREA_PLAN_INVERSE_COMMAND_KEYS] ?? [])) {
    return invalid(value);
  }
  switch (kind) {
    case "restore-scene-area-bounds":
    case "restore-scene-area": {
      const areaId = ownField(value, "areaId");
      const scopeVersion = ownField(value, "scopeVersion");
      const bounds = decodeGroundAabb(ownField(value, "bounds"));
      return isNonEmptyWorldId(areaId) && isNonEmptyWorldId(scopeVersion) && bounds
        ? ok({ kind, areaId, scopeVersion, bounds })
        : invalid(value);
    }
    case "restore-instance": {
      const target = decodeInstanceIdentity(ownField(value, "target"));
      const version = ownField(value, "version");
      const transform = decodeWorldTransform(ownField(value, "transform"));
      if (!target || !isNonEmptyWorldId(version)) return invalid(value);
      if (!transform.ok) return decodeFailure(transform.code, value);
      return ok({ kind, target, version, transform: transform.value });
    }
    case "restore-world-camera": {
      const target = decodeCameraIdentity(ownField(value, "target"));
      const version = ownField(value, "version");
      if (!target || !isNonEmptyWorldId(version)) return invalid(value);
      const camera = decodeWorldCamera(ownField(value, "camera"));
      if (!camera.ok) return decodeFailure(camera.code, value);
      if (target.cameraId !== camera.value.cameraId || version !== camera.value.settingsVersion) {
        return invalid(value);
      }
      return ok({ kind, target, version, camera: camera.value });
    }
    default:
      return invalid(value);
  }
}

function decodeList<T>(value: unknown, decodeItem: (item: unknown) => Decode<T>): Decode<T[]> {
  if (!Array.isArray(value)) return invalid(value);
  const items: T[] = [];
  for (const item of value) {
    const decoded = decodeItem(item);
    if (!decoded.ok) return decodeFailure(decoded.code, value);
    items.push(decoded.value);
  }
  return ok(items);
}

function decodePlan(value: unknown): Decode<SceneAreaPlan> {
  if (!isJsonRecord(value)) return invalid(value);
  const contractVersion = ownField(value, "contractVersion");
  if (typeof contractVersion !== "string" || contractVersion.length === 0) return invalid(value);
  if (contractVersion !== SCENE_AREA_PLAN_CONTRACT_VERSION) return unsupported(value);
  if (!hasOnlyKeys(value, SCENE_AREA_PLAN_KEYS)) return invalid(value);
  const canvasId = ownField(value, "canvasId");
  const operationId = ownField(value, "operationId");
  const intent = ownField(value, "intent");
  if (!isNonEmptyWorldId(canvasId) || !isNonEmptyWorldId(operationId)) return invalid(value);
  if (typeof intent !== "string" || !INTENTS.includes(intent as SceneAreaPlanIntent)) return invalid(value);
  const source = decodePlanSource(ownField(value, "source"));
  if (!source.ok) return decodeFailure(source.code, value);
  const commands = decodeList(ownField(value, "commands"), decodePlanCommand);
  if (!commands.ok) return decodeFailure(commands.code, value);
  const inverse = decodeList(ownField(value, "inverse"), decodeInverseCommand);
  if (!inverse.ok) return decodeFailure(inverse.code, value);
  return ok({
    contractVersion: SCENE_AREA_PLAN_CONTRACT_VERSION,
    canvasId,
    operationId,
    intent: intent as SceneAreaPlanIntent,
    source: source.value,
    commands: commands.value,
    inverse: inverse.value
  });
}

function decodePlanSource(value: unknown): Decode<{ area: SceneAreaPlanAreaSource; members: SceneAreaPlanMemberSet }> {
  if (!recordWithKeys(value, SCENE_AREA_PLAN_SOURCE_KEYS)) return invalid(value);
  const area = decodeAreaSource(ownField(value, "area"));
  if (!area) return invalid(value);
  const members = decodeMemberSet(ownField(value, "members"));
  if (!members.ok) return decodeFailure(members.code, value);
  return ok({ area, members: members.value });
}

function decodeEdgeSnapshot(value: unknown): WorldAuthoringEdgeSnapshot | null {
  if (!recordWithKeys(value, EDGE_SNAPSHOT_KEYS)) return null;
  const id = ownField(value, "id");
  const source = ownField(value, "source");
  const target = ownField(value, "target");
  const sourceHandle = ownField(value, "sourceHandle");
  const targetHandle = ownField(value, "targetHandle");
  const data = ownField(value, "data");
  if (!isNonEmptyWorldId(id) || !isNonEmptyWorldId(source) || !isNonEmptyWorldId(target)) return null;
  if (sourceHandle !== null && !isNonEmptyWorldId(sourceHandle)) return null;
  if (targetHandle !== null && !isNonEmptyWorldId(targetHandle)) return null;
  if (!isJsonRecord(data)) return null;
  return { id, source, target, sourceHandle, targetHandle, data: data as Woohaa3CanvasJsonObject };
}

function decodeNodeSnapshot(value: unknown, keys: readonly string[] = NODE_SNAPSHOT_KEYS): WorldAuthoringNodeSnapshot | null {
  if (!recordWithKeys(value, keys)) return null;
  const nodeId = ownField(value, "nodeId");
  const node = ownField(value, "node");
  const nodeData = ownField(value, "nodeData");
  if (!isNonEmptyWorldId(nodeId) || !isNonEmptyRecord(node) || !isNonEmptyRecord(nodeData)) return null;
  const rawEdges = ownField(value, "edges");
  if (rawEdges === undefined) return { nodeId, node, nodeData };
  const edges = decodeList(rawEdges, item => {
    const edge = decodeEdgeSnapshot(item);
    return edge ? ok(edge) : invalid<WorldAuthoringEdgeSnapshot>(item);
  });
  return edges.ok ? { nodeId, node, nodeData, edges: edges.value } : null;
}

function decodeMemberSnapshot(value: unknown): Decode<WorldAuthoringNodeSnapshot & { identity: WorldObjectIdentity }> {
  if (!recordWithKeys(value, MEMBER_SNAPSHOT_KEYS)) return invalid(value);
  const identity = decodeObjectIdentity(ownField(value, "identity"));
  const snapshot = decodeNodeSnapshot(value, MEMBER_SNAPSHOT_KEYS);
  return identity && snapshot ? ok({ ...snapshot, identity }) : invalid(value);
}

function decodeSourceSnapshot(value: unknown): Decode<WorldAuthoringSourceSnapshot> {
  if (!recordWithKeys(value, RECEIPT_SOURCE_KEYS)) return invalid(value);
  const area = decodeNodeSnapshot(ownField(value, "area"));
  if (!area) return invalid(value);
  const members = decodeList(ownField(value, "members"), decodeMemberSnapshot);
  if (!members.ok) return decodeFailure(members.code, value);
  const rawGroups = ownField(value, "groups");
  const groups = rawGroups === undefined
    ? ok<WorldAuthoringNodeSnapshot[]>([])
    : decodeList(rawGroups, item => {
        const snapshot = decodeNodeSnapshot(item);
        return snapshot ? ok(snapshot) : invalid<WorldAuthoringNodeSnapshot>(item);
      });
  if (!groups.ok) return decodeFailure(groups.code, value);
  return ok({
    area,
    members: members.value,
    ...(rawGroups === undefined ? {} : { groups: groups.value })
  });
}

function decodeReceipt(value: unknown): Decode<WorldAuthoringReceipt> {
  if (!isJsonRecord(value)) return invalid(value);
  const version = ownField(value, "version");
  if (typeof version !== "string" || version.length === 0) return invalid(value);
  if (version !== WORLD_AUTHORING_RECEIPT_VERSION) return unsupported(value);
  if (!hasOnlyKeys(value, RECEIPT_KEYS)) return invalid(value);
  const canvasId = ownField(value, "canvasId");
  const operationId = ownField(value, "operationId");
  const intent = ownField(value, "intent");
  const direction = ownField(value, "direction");
  const intentHash = ownField(value, "intentHash");
  const previousCommandId = ownField(value, "previousCommandId");
  const revision = ownField(value, "revision");
  const createdAt = ownField(value, "createdAt");
  if (!isNonEmptyWorldId(canvasId) || !isNonEmptyWorldId(operationId) || !isNonEmptyWorldId(intentHash)) {
    return invalid(value);
  }
  if (typeof intent !== "string" || !INTENTS.includes(intent as SceneAreaPlanIntent)) return invalid(value);
  if (typeof direction !== "string" || !DIRECTIONS.includes(direction as typeof DIRECTIONS[number])) return invalid(value);
  if (previousCommandId !== null && !isNonEmptyWorldId(previousCommandId)) return invalid(value);
  if (!isFiniteWorldNumber(revision) || !isNonEmptyWorldId(createdAt)) return invalid(value);
  const plan = decodePlan(ownField(value, "plan"));
  if (!plan.ok) return decodeFailure(plan.code, value);
  const source = decodeSourceSnapshot(ownField(value, "source"));
  if (!source.ok) return decodeFailure(source.code, value);
  const deletedNodes = decodeList(ownField(value, "deletedNodes"), item => {
    const snapshot = decodeNodeSnapshot(item);
    return snapshot ? ok(snapshot) : invalid<WorldAuthoringNodeSnapshot>(item);
  });
  if (!deletedNodes.ok) return decodeFailure(deletedNodes.code, value);
  const produced = ownField(value, "produced");
  if (!recordWithKeys(produced, PRODUCED_KEYS)) return invalid(value);
  const areaScopeVersion = ownField(produced, "areaScopeVersion");
  if (areaScopeVersion !== null && !isNonEmptyWorldId(areaScopeVersion)) return invalid(value);
  const targets = decodeList(ownField(produced, "targets"), item => {
    const target = decodeObjectVersion(item);
    return target ? ok(target) : invalid<WorldObjectVersion>(item);
  });
  if (!targets.ok) return decodeFailure(targets.code, value);
  return ok({
    version: WORLD_AUTHORING_RECEIPT_VERSION,
    canvasId,
    operationId,
    intent: intent as SceneAreaPlanIntent,
    direction: direction as typeof DIRECTIONS[number],
    intentHash,
    previousCommandId,
    plan: plan.value,
    source: source.value,
    deletedNodes: deletedNodes.value,
    produced: { areaScopeVersion, targets: targets.value },
    revision,
    createdAt
  });
}

function decodeObjectEntry(value: unknown): Decode<WorldAuthoritySnapshot["objects"][number]> {
  if (!recordWithKeys(value, OBJECT_ENTRY_KEYS)) return invalid(value);
  const identity = decodeObjectIdentity(ownField(value, "identity"));
  const nodeId = ownField(value, "nodeId");
  const version = ownField(value, "version");
  const containment = ownField(value, "containment");
  const contentVersion = ownField(value, "contentVersion");
  const transformVersion = ownField(value, "transformVersion");
  if (!identity || !isNonEmptyWorldId(version)) return invalid(value);
  if (nodeId !== null && !isNonEmptyWorldId(nodeId)) return invalid(value);
  if (typeof containment !== "string" || !CONTAINMENTS.includes(containment as typeof CONTAINMENTS[number])) {
    return invalid(value);
  }
  if (contentVersion !== undefined && !isNonEmptyWorldId(contentVersion)) return invalid(value);
  if (transformVersion !== undefined && !isNonEmptyWorldId(transformVersion)) return invalid(value);
  return ok({
    identity,
    nodeId,
    version,
    containment: containment as typeof CONTAINMENTS[number],
    ...(contentVersion === undefined ? {} : { contentVersion }),
    ...(transformVersion === undefined ? {} : { transformVersion })
  });
}

function sameScopeVersion(left: WorldScopeVersion, right: WorldScopeVersion): boolean {
  if (left.scopeVersion !== right.scopeVersion) return false;
  if (left.scope.kind !== right.scope.kind) return false;
  if (left.scope.kind === "world-camera") return right.scope.kind === "world-camera" && left.scope.cameraId === right.scope.cameraId;
  return left.scope.kind === "scene-area"
    ? right.scope.kind === "scene-area" && left.scope.areaId === right.scope.areaId
    : right.scope.kind === "workflow-group-2d" && left.scope.groupId === right.scope.groupId;
}

function inScopeObject(
  target: WorldObjectIdentity,
  objects: WorldAuthoritySnapshot["objects"]
): boolean {
  return objects.some(entry =>
    sameIdentity(entry.identity, target) &&
    (entry.containment === "writable" || entry.containment === "read-only")
  );
}

function decodeOccupancyLock(
  value: unknown,
  objects: WorldAuthoritySnapshot["objects"]
): Decode<WorldScopeOccupancyLock> {
  if (!recordWithKeys(value, OCCUPANCY_LOCK_KEYS)) return invalid(value);
  const target = decodeObjectIdentity(ownField(value, "target"));
  const runId = ownField(value, "runId");
  const epoch = ownField(value, "epoch");
  const state = ownField(value, "state");
  if (!target || !isNonEmptyWorldId(runId)) return invalid(value);
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) return invalid(value);
  if (typeof state !== "string" || !OCCUPANCY_LOCK_STATES.includes(state as WorldScopeOccupancyLock["state"])) {
    return invalid(value);
  }
  if (!inScopeObject(target, objects)) return invalid(value);
  return ok({ target, runId, epoch, state: state as WorldScopeOccupancyLock["state"] });
}

/** A legacy prepare response has no occupancy field; report explicit unknown, never idle. */
function legacyOccupancy(scope: WorldScopeVersion): WorldScopeOccupancySnapshot {
  return {
    version: WORLD_SCOPE_OCCUPANCY_VERSION,
    scope,
    state: "unknown",
    locks: [],
    reason: "not-reported"
  };
}

function decodeOccupancy(
  value: unknown,
  scope: WorldScopeVersion,
  objects: WorldAuthoritySnapshot["objects"]
): Decode<WorldScopeOccupancySnapshot> {
  if (!recordWithKeys(value, OCCUPANCY_KEYS)) return invalid(value);
  const version = ownField(value, "version");
  if (typeof version !== "string" || version.length === 0) return invalid(value);
  if (version !== WORLD_SCOPE_OCCUPANCY_VERSION) return unsupported(value);
  const decodedScope = decodeScopeVersion(ownField(value, "scope"));
  const state = ownField(value, "state");
  if (!decodedScope || !sameScopeVersion(decodedScope, scope)) return invalid(value);
  if (typeof state !== "string" || !OCCUPANCY_STATES.includes(state as WorldScopeOccupancySnapshot["state"])) {
    return invalid(value);
  }
  const reason = ownField(value, "reason");
  if (reason !== undefined &&
    (typeof reason !== "string" || !OCCUPANCY_REASONS.includes(reason as NonNullable<WorldScopeOccupancySnapshot["reason"]>))) {
    return invalid(value);
  }
  if (state !== "unknown" && reason !== undefined) return invalid(value);
  if (state === "unknown" && reason === undefined) return invalid(value);
  const locks = decodeList(ownField(value, "locks"), item => decodeOccupancyLock(item, objects));
  if (!locks.ok) return decodeFailure(locks.code, value);
  const seen = new Set<string>();
  for (const lock of locks.value) {
    const key = JSON.stringify([
      lock.target.kind,
      lock.target.kind === "instance" ? lock.target.instanceId : lock.target.cameraId
    ]);
    if (seen.has(key)) return invalid(value);
    seen.add(key);
  }
  if (state === "occupied" && locks.value.length === 0) return invalid(value);
  if (state !== "occupied" && locks.value.length !== 0) return invalid(value);
  return ok({
    version: WORLD_SCOPE_OCCUPANCY_VERSION,
    scope: decodedScope,
    state: state as WorldScopeOccupancySnapshot["state"],
    locks: locks.value,
    ...(reason === undefined ? {} : { reason: reason as NonNullable<WorldScopeOccupancySnapshot["reason"]> })
  });
}

function decodeAuthoritySnapshot(value: unknown): Decode<WorldPreparedAuthoritySnapshot> {
  if (!isJsonRecord(value)) return invalid(value);
  const version = ownField(value, "version");
  if (typeof version !== "string" || version.length === 0) return invalid(value);
  if (version !== WORLD_AUTHORING_VERSION) return unsupported(value);
  if (!hasOnlyKeys(value, SNAPSHOT_KEYS)) return invalid(value);
  const canvasId = ownField(value, "canvasId");
  const revision = ownField(value, "revision");
  const scope = decodeScopeVersion(ownField(value, "scope"));
  const areaNodeId = ownField(value, "areaNodeId");
  const area = decodeAreaSource(ownField(value, "area"));
  const bounds = decodeGroundAabb(ownField(value, "bounds"));
  if (!isNonEmptyWorldId(canvasId) || !isFiniteWorldNumber(revision) || !scope) return invalid(value);
  if (!isNonEmptyWorldId(areaNodeId) || !area || !bounds) return invalid(value);
  const writable = decodeList(ownField(value, "writable"), item => {
    const target = decodeObjectVersion(item);
    return target ? ok(target) : invalid<WorldObjectVersion>(item);
  });
  if (!writable.ok) return decodeFailure(writable.code, value);
  const readOnly = decodeList(ownField(value, "readOnly"), item => {
    const target = decodeObjectVersion(item);
    return target ? ok(target) : invalid<WorldObjectVersion>(item);
  });
  if (!readOnly.ok) return decodeFailure(readOnly.code, value);
  const members = decodeMemberSet(ownField(value, "members"));
  if (!members.ok) return decodeFailure(members.code, value);
  const objects = decodeList(ownField(value, "objects"), decodeObjectEntry);
  if (!objects.ok) return decodeFailure(objects.code, value);
  const occupancyValue = ownField(value, "occupancy");
  const occupancy = occupancyValue === undefined
    ? ok(legacyOccupancy(scope))
    : decodeOccupancy(occupancyValue, scope, objects.value);
  if (!occupancy.ok) return decodeFailure(occupancy.code, value);
  return ok({
    version: WORLD_AUTHORING_VERSION,
    canvasId,
    revision,
    scope,
    areaNodeId,
    area,
    bounds,
    writable: writable.value,
    readOnly: readOnly.value,
    members: members.value,
    objects: objects.value,
    occupancy: occupancy.value
  });
}

function decodeLease(value: unknown): SpatialLeaseIdentity | null {
  if (!recordWithKeys(value, LEASE_KEYS)) return null;
  const canvasId = ownField(value, "canvasId");
  const runId = ownField(value, "runId");
  const epoch = ownField(value, "epoch");
  const target = decodeObjectIdentity(ownField(value, "target"));
  return isNonEmptyWorldId(canvasId) && isNonEmptyWorldId(runId) &&
    isFiniteWorldNumber(epoch) && target
    ? { canvasId, runId, epoch, target }
    : null;
}

function decodeContext(value: unknown): Decode<WorldToolContext> {
  if (!recordWithKeys(value, CONTEXT_KEYS)) return invalid(value);
  const contextId = ownField(value, "contextId");
  const canvasId = ownField(value, "canvasId");
  const runId = ownField(value, "runId");
  const epoch = ownField(value, "epoch");
  const scope = decodeScopeVersion(ownField(value, "scope"));
  if (!isNonEmptyWorldId(contextId) || !isNonEmptyWorldId(canvasId) || !isNonEmptyWorldId(runId)) {
    return invalid(value);
  }
  if (!isFiniteWorldNumber(epoch) || !scope) return invalid(value);
  const writableTargets = decodeList(ownField(value, "writableTargets"), item => {
    if (!recordWithKeys(item, WRITABLE_TARGET_KEYS)) return invalid<WorldToolContext["writableTargets"][number]>(item);
    const target = decodeObjectVersion(ownField(item, "target"));
    const lease = decodeLease(ownField(item, "lease"));
    if (!target || !lease) return invalid<WorldToolContext["writableTargets"][number]>(item);
    if (lease.canvasId !== canvasId || lease.runId !== runId || lease.epoch !== epoch) {
      return invalid<WorldToolContext["writableTargets"][number]>(item);
    }
    if (!sameIdentity(lease.target, target)) return invalid<WorldToolContext["writableTargets"][number]>(item);
    return ok({ target, lease });
  });
  if (!writableTargets.ok) return decodeFailure(writableTargets.code, value);
  const readOnlyReferences = decodeList(ownField(value, "readOnlyReferences"), item => {
    const target = decodeObjectVersion(item);
    return target ? ok(target) : invalid<WorldObjectVersion>(item);
  });
  if (!readOnlyReferences.ok) return decodeFailure(readOnlyReferences.code, value);
  return ok({
    contextId,
    canvasId,
    runId,
    epoch,
    scope,
    writableTargets: writableTargets.value,
    readOnlyReferences: readOnlyReferences.value
  });
}

function decodeRun(value: unknown): Decode<WorldToolContextRun> {
  if (!recordWithKeys(value, RUN_KEYS)) return invalid(value);
  const canvasId = ownField(value, "canvasId");
  const requestId = ownField(value, "requestId");
  const runId = ownField(value, "runId");
  const executionId = ownField(value, "executionId");
  const epoch = ownField(value, "epoch");
  const state = ownField(value, "state");
  if (!isNonEmptyWorldId(canvasId) || !isNonEmptyWorldId(requestId) || !isNonEmptyWorldId(runId)) {
    return invalid(value);
  }
  if (!isNonEmptyWorldId(executionId) || !isFiniteWorldNumber(epoch)) return invalid(value);
  if (typeof state !== "string" || !RUN_STATES.includes(state as WorldToolContextRun["state"])) {
    return invalid(value);
  }
  return ok({ canvasId, requestId, runId, executionId, epoch, state: state as WorldToolContextRun["state"] });
}

function decodeHistoryEntry(value: unknown): Decode<WorldCameraHistoryEntry> {
  if (!recordWithKeys(value, HISTORY_ENTRY_KEYS)) return invalid(value);
  const completionKey = ownField(value, "completionKey");
  const canvasId = ownField(value, "canvasId");
  const cameraId = ownField(value, "cameraId");
  const runId = ownField(value, "runId");
  const completionId = ownField(value, "completionId");
  const settingsVersion = ownField(value, "settingsVersion");
  const createdAt = ownField(value, "createdAt");
  if (
    !isNonEmptyWorldId(completionKey) ||
    !isNonEmptyWorldId(canvasId) ||
    !isNonEmptyWorldId(cameraId) ||
    !isNonEmptyWorldId(runId) ||
    !isNonEmptyWorldId(completionId) ||
    !isNonEmptyWorldId(settingsVersion) ||
    !isNonEmptyWorldId(createdAt)
  ) {
    return invalid(value);
  }
  const snapshot = decodeWorldCameraHistorySnapshot(ownField(value, "snapshot"));
  if (!snapshot.ok) return decodeFailure(snapshot.code, value);
  const completion = snapshot.value.completion;
  if (
    completion.canvasId !== canvasId ||
    completion.runId !== runId ||
    completion.completionId !== completionId ||
    completion.cameraId !== cameraId ||
    completion.settingsVersion !== settingsVersion ||
    snapshot.value.camera.cameraId !== cameraId
  ) {
    return invalid(value);
  }
  return ok({
    completionKey,
    canvasId,
    cameraId,
    runId,
    completionId,
    settingsVersion,
    createdAt,
    snapshot: snapshot.value
  });
}

function decodeCameraValue(value: unknown): Decode<{
  ok: true;
  canvasId: string;
  cameraId: string;
  commandId: string;
  revision: number;
  duplicate: boolean;
  camera: WorldCameraData;
  settingsVersion: string;
}> {
  if (!isJsonRecord(value)) return invalid(value);
  const canvasId = ownField(value, "canvasId");
  const cameraId = ownField(value, "cameraId");
  const commandId = ownField(value, "commandId");
  const revision = ownField(value, "revision");
  const duplicate = ownField(value, "duplicate");
  const settingsVersion = ownField(value, "settingsVersion");
  if (!isNonEmptyWorldId(canvasId) || !isNonEmptyWorldId(cameraId) || !isNonEmptyWorldId(commandId)) {
    return invalid(value);
  }
  if (!isFiniteWorldNumber(revision) || typeof duplicate !== "boolean" || !isNonEmptyWorldId(settingsVersion)) {
    return invalid(value);
  }
  const camera = decodeWorldCamera(ownField(value, "camera"));
  if (!camera.ok) return decodeFailure(camera.code, value);
  if (camera.value.cameraId !== cameraId || camera.value.settingsVersion !== settingsVersion) {
    return invalid(value);
  }
  return ok({ ok: true, canvasId, cameraId, commandId, revision, duplicate, camera: camera.value, settingsVersion });
}

function isSuccessRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return recordWithKeys(value, keys) && ownField(value, "ok") === true;
}

export function decodeSceneAreaPrepareSuccess(
  value: unknown
): Decode<Success<WorldAuthoringPrepareOutcome>> {
  if (!isSuccessRecord(value, PREPARE_SUCCESS_KEYS)) return invalid(value);
  const snapshot = decodeAuthoritySnapshot(ownField(value, "snapshot"));
  if (!snapshot.ok) return decodeFailure(snapshot.code, value);
  return ok({ ok: true, snapshot: snapshot.value });
}

export function decodeSceneAreaCommitSuccess(
  value: unknown
): Decode<Success<import("./world-authoring.js").WorldAuthoringExecuteOutcome>> {
  if (!isSuccessRecord(value, COMMIT_SUCCESS_KEYS)) return invalid(value);
  const decoded = decodeCommandEnvelope(value);
  if (!decoded.ok) return decoded;
  return decoded.value.receipt.direction === "forward" ? decoded : invalid(value);
}

export function decodeSceneAreaHistorySuccess(
  value: unknown,
  direction: "undo" | "redo"
): Decode<Success<import("./world-authoring.js").WorldAuthoringHistoryOutcome>> {
  if (!isSuccessRecord(value, HISTORY_SUCCESS_KEYS)) return invalid(value);
  if (ownField(value, "direction") !== direction) return invalid(value);
  const decoded = decodeCommandEnvelope(value);
  if (!decoded.ok) return decoded;
  if (decoded.value.receipt.direction !== direction) return invalid(value);
  return ok({ ...decoded.value, direction });
}

function decodeCommandEnvelope(value: Record<string, unknown>): Decode<{
  ok: true;
  canvasId: string;
  operationId: string;
  commandId: string;
  revision: number;
  duplicate: boolean;
  plan: SceneAreaPlan;
  receipt: WorldAuthoringReceipt;
}> {
  const canvasId = ownField(value, "canvasId");
  const operationId = ownField(value, "operationId");
  const commandId = ownField(value, "commandId");
  const revision = ownField(value, "revision");
  const duplicate = ownField(value, "duplicate");
  if (!isNonEmptyWorldId(canvasId) || !isNonEmptyWorldId(operationId) || !isNonEmptyWorldId(commandId)) {
    return invalid(value);
  }
  if (!isFiniteWorldNumber(revision) || typeof duplicate !== "boolean") return invalid(value);
  const plan = decodePlan(ownField(value, "plan"));
  if (!plan.ok) return decodeFailure(plan.code, value);
  const receipt = decodeReceipt(ownField(value, "receipt"));
  if (!receipt.ok) return decodeFailure(receipt.code, value);
  return ok({ ok: true, canvasId, operationId, commandId, revision, duplicate, plan: plan.value, receipt: receipt.value });
}

export function decodeWorldToolContextSuccess(
  value: unknown
): Decode<Success<WorldToolContextOutcome>> {
  if (!isSuccessRecord(value, CONTEXT_SUCCESS_KEYS)) return invalid(value);
  const context = decodeContext(ownField(value, "context"));
  if (!context.ok) return decodeFailure(context.code, value);
  const run = decodeRun(ownField(value, "run"));
  if (!run.ok) return decodeFailure(run.code, value);
  if (typeof ownField(value, "retry") !== "boolean") return invalid(value);
  return ok({ ok: true, context: context.value, run: run.value, retry: ownField(value, "retry") as boolean });
}

export function decodeWorldToolContextRevokeSuccess(value: unknown): Decode<{ ok: true }> {
  return isSuccessRecord(value, REVOKE_SUCCESS_KEYS) ? ok({ ok: true }) : invalid(value);
}

export function decodeWorldCameraSaveSuccess(
  value: unknown
): Decode<Success<WorldCameraSettingsSaveOutcome>> {
  if (!isSuccessRecord(value, CAMERA_SAVE_KEYS)) return invalid(value);
  return decodeCameraValue(value);
}

export function decodeWorldCameraRestoreSuccess(
  value: unknown
): Decode<Success<WorldCameraRestoreOutcome>> {
  if (!isSuccessRecord(value, CAMERA_RESTORE_KEYS)) return invalid(value);
  const camera = decodeCameraValue(value);
  if (!camera.ok) return camera;
  const history = decodeHistoryEntry(ownField(value, "history"));
  if (!history.ok) return decodeFailure(history.code, value);
  if (history.value.cameraId !== camera.value.cameraId) return invalid(value);
  return ok({ ...camera.value, history: history.value });
}

export function decodeWorldCameraHistorySuccess(
  value: unknown
): Decode<Success<WorldCameraHistoryListOutcome>> {
  if (!isSuccessRecord(value, CAMERA_HISTORY_KEYS)) return invalid(value);
  const canvasId = ownField(value, "canvasId");
  const cameraId = ownField(value, "cameraId");
  if (!isNonEmptyWorldId(canvasId) || !isNonEmptyWorldId(cameraId)) return invalid(value);
  const entries = decodeList(ownField(value, "entries"), decodeHistoryEntry);
  if (!entries.ok) return decodeFailure(entries.code, value);
  if (entries.value.some(entry => entry.canvasId !== canvasId || entry.cameraId !== cameraId)) {
    return invalid(value);
  }
  return ok({ ok: true, canvasId, cameraId, entries: entries.value });
}

/** Route dispatch used by the browser transport; only successful payloads reach it. */
export function decodeWorldAuthoringResponse(
  route: WorldAuthoringResponseRoute,
  value: unknown
): Decode<WorldAuthoringSuccessOutcome> {
  switch (route) {
    case "scene-area-prepare": return decodeSceneAreaPrepareSuccess(value);
    case "scene-area-commit": return decodeSceneAreaCommitSuccess(value);
    case "scene-area-undo": return decodeSceneAreaHistorySuccess(value, "undo");
    case "scene-area-redo": return decodeSceneAreaHistorySuccess(value, "redo");
    case "world-tool-context": return decodeWorldToolContextSuccess(value);
    case "world-tool-context-revoke": return decodeWorldToolContextRevokeSuccess(value);
    case "world-camera-save": return decodeWorldCameraSaveSuccess(value);
    case "world-camera-restore": return decodeWorldCameraRestoreSuccess(value);
    case "world-camera-history": return decodeWorldCameraHistorySuccess(value);
    default: return invalid(value);
  }
}

/**
 * Domain failures are preserved, not reclassified. Only their nested conflict
 * identities are validated when present so a malformed error cannot smuggle a
 * half-typed authority target into the UI.
 */
export function decodeWorldAuthoringFailure(value: unknown): Decode<WorldAuthoringFailure> {
  if (!isJsonRecord(value) || ownField(value, "ok") !== false) return invalid(value);
  const code = ownField(value, "code");
  const message = ownField(value, "message");
  if (!isNonEmptyWorldId(code) || !isNonEmptyWorldId(message)) return invalid(value);
  const rawConflicts = ownField(value, "conflicts");
  const conflicts = rawConflicts === undefined
    ? ok<WorldAuthoringFailure["conflicts"]>(undefined)
    : decodeList(rawConflicts, item => {
        if (!isJsonRecord(item)) return invalid<NonNullable<WorldAuthoringFailure["conflicts"]>[number]>(item);
        const target = decodeObjectIdentity(ownField(item, "target"));
        const version = ownField(item, "version");
        const runId = ownField(item, "runId");
        const epoch = ownField(item, "epoch");
        if (!target || !isNonEmptyWorldId(runId) || !isFiniteWorldNumber(epoch)) {
          return invalid<NonNullable<WorldAuthoringFailure["conflicts"]>[number]>(item);
        }
        if (version !== null && !isNonEmptyWorldId(version)) {
          return invalid<NonNullable<WorldAuthoringFailure["conflicts"]>[number]>(item);
        }
        return ok({ target, version: version as string | null, runId, epoch });
      });
  if (!conflicts.ok) return decodeFailure(conflicts.code, value);
  const spatialReason = ownField(value, "spatialReason");
  if (spatialReason !== undefined && !isNonEmptyWorldId(spatialReason)) return invalid(value);
  const spatialDiagnostic = decodeSpatialDiagnostic(ownField(value, "spatialDiagnostic"));
  if (!spatialDiagnostic.ok) return decodeFailure(spatialDiagnostic.code, value);
  return ok({
    ok: false,
    code: code as WorldAuthoringFailure["code"],
    message,
    ...(conflicts.value === undefined ? {} : { conflicts: conflicts.value }),
    ...(spatialReason === undefined ? {} : { spatialReason }),
    ...(spatialDiagnostic.value === undefined ? {} : { spatialDiagnostic: spatialDiagnostic.value })
  });
}

function decodeGroundPoint(value: unknown): { u: number; v: number } | null {
  if (!isJsonRecord(value)) return null;
  const u = ownField(value, "u");
  const v = ownField(value, "v");
  return isFiniteWorldNumber(u) && isFiniteWorldNumber(v) ? { u, v } : null;
}

/** Optional out-of-scope geometry; a malformed diagnostic never smuggles half-typed bounds. */
function decodeSpatialDiagnostic(value: unknown): Decode<WorldAuthoringFailure["spatialDiagnostic"]> {
  if (value === undefined) return ok(undefined);
  if (!recordWithKeys(value, ["actual", "bounds", "anchor", "outsideAxes"])) return invalid(value);
  const actualRaw = ownField(value, "actual");
  const boundsRaw = ownField(value, "bounds");
  const anchorRaw = ownField(value, "anchor");
  const axesRaw = ownField(value, "outsideAxes");
  const actual = actualRaw === undefined ? undefined : decodeGroundAabb(actualRaw) ?? undefined;
  if (actualRaw !== undefined && !actual) return invalid(value);
  const bounds = boundsRaw === undefined ? undefined : decodeGroundAabb(boundsRaw) ?? undefined;
  if (boundsRaw !== undefined && !bounds) return invalid(value);
  const anchor = anchorRaw === undefined ? undefined : decodeGroundPoint(anchorRaw) ?? undefined;
  if (anchorRaw !== undefined && !anchor) return invalid(value);
  const outsideAxes = axesRaw === undefined
    ? undefined
    : decodeList(axesRaw, item => item === "u" || item === "v" ? ok(item as "u" | "v") : invalid<"u" | "v">(item));
  if (outsideAxes && !outsideAxes.ok) return invalid(value);
  const diagnostic: NonNullable<WorldAuthoringFailure["spatialDiagnostic"]> = {
    ...(actual === undefined ? {} : { actual }),
    ...(bounds === undefined ? {} : { bounds }),
    ...(anchor === undefined ? {} : { anchor }),
    ...(outsideAxes !== undefined && outsideAxes.ok && outsideAxes.value !== undefined ? { outsideAxes: outsideAxes.value } : {})
  };
  return ok(diagnostic);
}
