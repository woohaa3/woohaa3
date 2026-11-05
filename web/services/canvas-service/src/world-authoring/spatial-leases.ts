import type { ServerCanvas, WorldObjectIdentity, WorldObjectVersion, WorldScopeVersion } from "@woohaa3/contracts";

export interface LeaseIntent {
  requestId: string; canvasId: string; runId: string; epoch: number;
  executionId: string; scope: WorldScopeVersion;
  writable: WorldObjectVersion[]; readOnly: WorldObjectVersion[];
}

/** Implementations are host-owned authority adapters, never request payloads. */
export interface SpatialLeaseAuthority {
  eligible(intent: LeaseIntent, targets: WorldObjectVersion[]): boolean;
  stopped(identity: { canvasId: string; runId: string; epoch: number; executionId: string }, evidence: unknown): boolean;
}

/** Host resolver must derive versions and scope from the canonical projections. */
export interface SpatialCommitAuthority extends SpatialLeaseAuthority {
  resolve(intent: LeaseIntent, before: ServerCanvas, after: ServerCanvas, targets: WorldObjectIdentity[]): {
    scope: WorldScopeVersion; previous: WorldObjectVersion[]; next: WorldObjectVersion[];
    /**
     * 这次提交**确实写入了**作用域本体（改导演区范围），因此 scope 版本推进是它有据可依的结果，
     * 而不是解析出的版本与签约时不一致。缺省 false：只有显式范围写入才允许在同一批里推进 scope。
     */
    advancedScope?: boolean;
  } | null;
}

/** Opaque, process-local capability. It is never accepted from a transport payload. */
export type SpatialWriteContext = object;

export type LeaseState = "active" | "cancelled" | "stopped";
export interface LeaseRecord { intent: LeaseIntent; state: LeaseState; }

/**
 * Persistent run identity returned by the public acquire port.
 *
 * It is read from the durable lease record, so a retried request keeps the original
 * `runId` / `epoch` / `executionId` even when the caller supplies new identity fields
 * or reopens the host. `state` is the current durable lease state.
 */
export interface SpatialRunSnapshot {
  canvasId: string;
  requestId: string;
  runId: string;
  epoch: number;
  executionId: string;
  state: LeaseState;
}

/**
 * Public acquire result.
 *
 * `run` is always the persistent run information. `capability` is only present while
 * this process still holds the process-local write capability for an active run:
 * returning recovered run information never re-issues write authority, so after a
 * restart (or cancellation) the caller must reconcile the run before committing.
 */
export interface SpatialAcquireResult {
  run: SpatialRunSnapshot;
  /** True when an existing durable run was returned instead of creating a new one. */
  retry: boolean;
  capability: SpatialWriteContext | null;
}
export type LeaseErrorCode = "invalid-data" | "unavailable" | "request-conflict" | "lease-conflict" | "stale-epoch" | "cancelled" | "outside-scope" | "version-conflict" | "unverified-stop";
export interface LeaseConflict { target: WorldObjectIdentity; runId: string; epoch: number; }

/**
 * Durable lock fact for one in-scope object. `cancelled` runs still own their locks
 * until exact stop is confirmed; there is no time-based expiry.
 */
export interface SpatialOccupancyLock {
  target: WorldObjectIdentity;
  runId: string;
  epoch: number;
  state: "active" | "cancelled";
}

/** A missing/unreadable durable store is reported, never flattened to an empty set. */
export type SpatialOccupancyReadResult =
  | { ok: true; locks: SpatialOccupancyLock[] }
  | { ok: false; reason: "store-unavailable" };
export class SpatialLeaseError extends Error {
  constructor(public readonly code: LeaseErrorCode, public readonly conflict?: LeaseConflict) { super(code); }
}

export function objectKey(target: WorldObjectIdentity): string {
  return JSON.stringify([target.kind, target.kind === "instance" ? target.instanceId : target.cameraId]);
}
