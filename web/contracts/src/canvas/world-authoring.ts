/**
 * Scene-area authority DTOs (T06).
 *
 * These types are the transport/port surface shared by the authoritative canvas
 * service, the local host HTTP entry and later UI/assistant consumers. They are
 * deliberately free of storage, planning or version algorithms:
 *
 * - `WorldAuthoritySnapshot` is produced by the host from the canonical canvas
 *   projection. Membership is already classified through `scene-footprint.ts` and
 *   each object version is the version a lease/plan must carry.
 * - `WorldAuthoringReceipt` is written in the same command transaction as the
 *   canvas edit. It freezes the plan, the source node data and the produced
 *   versions, so undo/redo replay the same fixed set.
 * - `WorldToolContext` itself lives in `shared-world.ts`; issuing/revoking is a
 *   host-owned process concern and is never trusted from assistant input.
 */

import type {
  GroundAabb,
  WorldObjectIdentity,
  WorldObjectVersion,
  WorldScopeVersion,
  WorldToolContext
} from "./shared-world.js";
import type { SceneAreaPlan, SceneAreaPlanMemberSet, SceneAreaPlanRequest } from "./scene-area-plan-contract.js";
import type { Woohaa3CanvasJsonObject } from "./domain/index.js";

export const WORLD_AUTHORING_VERSION = "world-authoring-v1" as const;
export const WORLD_AUTHORING_RECEIPT_VERSION = "world-authoring-receipt-v1" as const;
export const WORLD_SCOPE_OCCUPANCY_VERSION = "world-scope-occupancy-v1" as const;

/** One canonical object as seen by the authority. Unknown is never writable. */
export type WorldObjectContainment = "writable" | "read-only" | "outside" | "unknown";

export interface WorldObjectAuthorityEntry {
  identity: WorldObjectIdentity;
  /** Canonical node that owns this world object; absent for `unknown` inputs. */
  nodeId: string | null;
  /** Current object version (content + pose for instances, settings for cameras). */
  version: string;
  containment: WorldObjectContainment;
  contentVersion?: string;
  transformVersion?: string;
}

/**
 * One durable lease lock currently covering an object classified into the selected
 * scope. `cancelled` still owns the lock until exact stop is confirmed; locks are
 * never expired by time.
 */
export interface WorldScopeOccupancyLock {
  target: WorldObjectIdentity;
  runId: string;
  epoch: number;
  state: "active" | "cancelled";
}

/**
 * Read-only occupancy view attached to `scene-area-prepare`.
 *
 * - `idle` is only valid when the durable store was read and returned no lock for any
 *   in-scope object;
 * - `occupied` carries every in-scope lock with its run/epoch/state;
 * - `unknown` means the store could not be read (or a legacy response omitted the
 *   field) and MUST NOT be treated as idle.
 *
 * It deliberately contains no process capability, request or execution identity.
 */
export interface WorldScopeOccupancySnapshot {
  version: typeof WORLD_SCOPE_OCCUPANCY_VERSION;
  scope: WorldScopeVersion;
  state: "idle" | "occupied" | "unknown";
  locks: WorldScopeOccupancyLock[];
  reason?: "store-unavailable" | "not-reported";
}

/** Exact gesture-start snapshot. `members` is ready to feed OC04 unchanged. */
export interface WorldAuthoritySnapshot {
  version: typeof WORLD_AUTHORING_VERSION;
  canvasId: string;
  revision: number;
  scope: WorldScopeVersion;
  areaNodeId: string;
  area: import("./scene-area-plan-contract.js").SceneAreaPlanAreaSource;
  bounds: GroundAabb;
  writable: WorldObjectVersion[];
  readOnly: WorldObjectVersion[];
  members: SceneAreaPlanMemberSet;
  objects: WorldObjectAuthorityEntry[];
}

/**
 * 2D workflow group context. Membership is organizational only: the writable set is
 * always empty and members may only appear as read-only references.
 */
export interface WorldGroupAuthoritySnapshot {
  version: typeof WORLD_AUTHORING_VERSION;
  canvasId: string;
  revision: number;
  scope: WorldScopeVersion;
  writable: [];
  readOnly: WorldObjectVersion[];
  objects: WorldObjectAuthorityEntry[];
}

export type WorldAuthorityScopeSnapshot = WorldAuthoritySnapshot | WorldGroupAuthoritySnapshot;

/**
 * Production prepare snapshot. The occupancy view is filled from the authoritative
 * durable locks for the same scope; it is a display/preflight fact and never replaces
 * the commit-time gate.
 */
export interface WorldPreparedAuthoritySnapshot extends WorldAuthoritySnapshot {
  occupancy: WorldScopeOccupancySnapshot;
}

export type WorldToolContextRequest = {
  canvasId: string;
  requestId: string;
  runId: string;
  epoch: number;
  executionId: string;
  scope: WorldScopeVersion["scope"];
};

export interface WorldToolContextRun {
  canvasId: string;
  requestId: string;
  runId: string;
  epoch: number;
  executionId: string;
  state: "active" | "cancelled" | "stopped";
}

export type WorldAuthoringFailureCode =
  | "invalid-data"
  | "not-ready"
  | "outside-scope"
  | "version-conflict"
  | "operation-conflict"
  | "lease-conflict"
  | "stale-epoch"
  | "cancelled"
  | "not-found"
  | "unsupported-version"
  | "spatial-rejected"
  | "write-forbidden";

/** Occupying run reported by a lease conflict; the target and run identity stay visible. */
export interface WorldAuthoringConflict {
  target: WorldObjectIdentity;
  /** Current target version when the rejecting authority could read it; null if unknown. */
  version: string | null;
  runId: string;
  epoch: number;
}

export interface WorldAuthoringFailure {
  ok: false;
  code: WorldAuthoringFailureCode;
  message: string;
  conflicts?: WorldAuthoringConflict[];
  spatialReason?: string;
}

export type WorldAuthoringPrepareOutcome =
  | { ok: true; snapshot: WorldPreparedAuthoritySnapshot }
  | WorldAuthoringFailure;

/** One frozen edge removed together with a node; re-added by undo after its endpoints. */
export interface WorldAuthoringEdgeSnapshot {
  id: string;
  source: string;
  target: string;
  sourceHandle: string | null;
  targetHandle: string | null;
  data: Woohaa3CanvasJsonObject;
}

/** One frozen node snapshot used by undo to restore exactly what was removed. */
export interface WorldAuthoringNodeSnapshot {
  nodeId: string;
  /** Structural node row (position/width/height/parent/type only). */
  node: unknown;
  /** Full nodeData value at the frozen source state. */
  nodeData: unknown;
  /**
   * Edges incident to this node at the frozen source state. `node.remove` also
   * removes incident edges, so undo must restore them explicitly.
   */
  edges?: WorldAuthoringEdgeSnapshot[];
}

export interface WorldAuthoringSourceSnapshot {
  area: WorldAuthoringNodeSnapshot;
  members: Array<WorldAuthoringNodeSnapshot & { identity: WorldObjectIdentity }>;
  /** 2D groups whose membership was updated by deleting a member. */
  groups?: WorldAuthoringNodeSnapshot[];
}

/** Immutable receipt written with its command. One per command record. */
export interface WorldAuthoringReceipt {
  version: typeof WORLD_AUTHORING_RECEIPT_VERSION;
  canvasId: string;
  operationId: string;
  intent: SceneAreaPlan["intent"];
  direction: "forward" | "undo" | "redo";
  /** Stable semantic intent; reusing an operationId with another intent is rejected. */
  intentHash: string;
  previousCommandId: string | null;
  plan: SceneAreaPlan;
  source: WorldAuthoringSourceSnapshot;
  deletedNodes: WorldAuthoringNodeSnapshot[];
  /** Post-command versions; undo/redo require the current state to match. */
  produced: {
    areaScopeVersion: string | null;
    targets: WorldObjectVersion[];
  };
  revision: number;
  createdAt: string;
}

export interface WorldAuthoringExecuteInput {
  canvasId: string;
  /** Pure OC04 request frozen by the caller from a prepared snapshot. */
  request: SceneAreaPlanRequest;
  /** Omit for an ordinary user write; then occupancy is checked without a grant. */
  contextId?: string;
  actorId?: string;
  operationId?: string;
}

export type WorldAuthoringExecuteOutcome =
  | {
      ok: true;
      canvasId: string;
      operationId: string;
      commandId: string;
      revision: number;
      duplicate: boolean;
      plan: SceneAreaPlan;
      receipt: WorldAuthoringReceipt;
    }
  | WorldAuthoringFailure;

export interface WorldAuthoringHistoryInput {
  canvasId: string;
  operationId: string;
  contextId?: string;
  actorId?: string;
}

export type WorldAuthoringHistoryOutcome =
  | {
      ok: true;
      canvasId: string;
      operationId: string;
      commandId: string;
      revision: number;
      duplicate: boolean;
      direction: "undo" | "redo";
      plan: SceneAreaPlan;
      receipt: WorldAuthoringReceipt;
    }
  | WorldAuthoringFailure;

export type WorldToolContextOutcome =
  | { ok: true; context: WorldToolContext; run: WorldToolContextRun; retry: boolean }
  | WorldAuthoringFailure;

export interface WorldToolContextRevokeInput {
  canvasId: string;
  contextId: string;
}

/** Optional command-batch receipt carried through the Yjs commit transaction. */
export type WorldAuthoringCommandReceipt = WorldAuthoringReceipt;
