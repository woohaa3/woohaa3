import type { WorldObjectIdentity, WorldObjectVersion, WorldScopeVersion } from "@woohaa3/contracts";

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

export type LeaseState = "active" | "cancelled" | "stopped";
export interface LeaseRecord { intent: LeaseIntent; state: LeaseState; }
export type LeaseErrorCode = "invalid-data" | "unavailable" | "request-conflict" | "lease-conflict" | "stale-epoch" | "cancelled" | "outside-scope" | "version-conflict" | "unverified-stop";
export interface LeaseConflict { target: WorldObjectIdentity; runId: string; epoch: number; }
export class SpatialLeaseError extends Error {
  constructor(public readonly code: LeaseErrorCode, public readonly conflict?: LeaseConflict) { super(code); }
}

export function objectKey(target: WorldObjectIdentity): string {
  return JSON.stringify([target.kind, target.kind === "instance" ? target.instanceId : target.cameraId]);
}
