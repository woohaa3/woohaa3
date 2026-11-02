import type { DatabaseSync } from "node:sqlite";
import type { WorldObjectIdentity, WorldObjectVersion, WorldScopeVersion } from "@woohaa3/contracts";
import { objectKey, SpatialLeaseError, type LeaseIntent, type LeaseRecord, type LeaseState, type SpatialLeaseAuthority } from "../../world-authoring/spatial-leases.js";
import { migrateSpatialLeases } from "./spatial-lease-migrations.js";

type Row = { intent_json: string; state: LeaseState };
const id = (t: WorldObjectIdentity) => t.kind === "instance" ? t.instanceId : t.cameraId;
const nonempty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
function normalizeTargets(targets: WorldObjectVersion[]): WorldObjectVersion[] {
  if (!Array.isArray(targets)) throw new SpatialLeaseError("invalid-data");
  const seen = new Set<string>();
  return targets.map(t => {
    if (!t || (t.kind !== "instance" && t.kind !== "camera") || !nonempty(id(t)) || !nonempty(t.version)) throw new SpatialLeaseError("invalid-data");
    const key = objectKey(t);
    if (seen.has(key)) throw new SpatialLeaseError("invalid-data");
    seen.add(key);
    return t.kind === "instance" ? { kind: t.kind, instanceId: t.instanceId, version: t.version } : { kind: t.kind, cameraId: t.cameraId, version: t.version };
  }).sort((a, b) => objectKey(a) < objectKey(b) ? -1 : objectKey(a) > objectKey(b) ? 1 : 0);
}
function normalize(input: LeaseIntent): LeaseIntent {
  const s = input.scope;
  if (![input.requestId, input.canvasId, input.runId, input.executionId, s?.scopeVersion].every(nonempty) || !Number.isSafeInteger(input.epoch) || input.epoch < 0 || !s?.scope || !((s.scope.kind === "scene-area" && nonempty(s.scope.areaId)) || (s.scope.kind === "workflow-group-2d" && nonempty(s.scope.groupId)))) throw new SpatialLeaseError("invalid-data");
  const scope: WorldScopeVersion = { scope: s.scope.kind === "scene-area" ? { kind: s.scope.kind, areaId: s.scope.areaId } : { kind: s.scope.kind, groupId: s.scope.groupId }, scopeVersion: s.scopeVersion };
  const writable = normalizeTargets(input.writable), readOnly = normalizeTargets(input.readOnly);
  const keys = new Set(readOnly.map(objectKey));
  if (writable.some(t => keys.has(objectKey(t)))) throw new SpatialLeaseError("outside-scope");
  return { requestId: input.requestId, canvasId: input.canvasId, runId: input.runId, epoch: input.epoch, executionId: input.executionId, scope, writable, readOnly };
}

/** The authority must be installed by the host. No expiry or startup reconciliation releases locks. */
export class SqliteSpatialLeaseStore {
  constructor(readonly db: DatabaseSync, private readonly authority?: SpatialLeaseAuthority, private readonly onWrite?: () => void) { migrateSpatialLeases(db); }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private eligible(intent: LeaseIntent, targets: WorldObjectVersion[]): void {
    if (!this.authority) throw new SpatialLeaseError("unavailable");
    if (!this.authority.eligible(intent, targets)) throw new SpatialLeaseError("outside-scope");
  }
  lookup(canvasId: string, requestId: string): LeaseRecord | null {
    const row = this.db.prepare("SELECT intent_json, state FROM spatial_lease_runs WHERE canvas_id = ? AND request_id = ?").get(canvasId, requestId) as Row | undefined;
    return row ? { intent: JSON.parse(row.intent_json) as LeaseIntent, state: row.state } : null;
  }
  listPending(): LeaseRecord[] {
    return (this.db.prepare("SELECT intent_json, state FROM spatial_lease_runs WHERE state != 'stopped' ORDER BY canvas_id, request_id").all() as Row[]).map(row => ({ intent: JSON.parse(row.intent_json) as LeaseIntent, state: row.state }));
  }
  private lock(intent: LeaseIntent, targets: WorldObjectVersion[]): void {
    const lookup = this.db.prepare("SELECT run_id, epoch FROM spatial_lease_locks WHERE canvas_id = ? AND kind = ? AND object_id = ?");
    const insert = this.db.prepare("INSERT INTO spatial_lease_locks VALUES (?, ?, ?, ?, ?)");
    for (const target of targets) {
      const existing = lookup.get(intent.canvasId, target.kind, id(target)) as { run_id: string; epoch: number } | undefined;
      if (existing && (existing.run_id !== intent.runId || existing.epoch !== intent.epoch)) throw new SpatialLeaseError("lease-conflict");
      if (!existing) { insert.run(intent.canvasId, target.kind, id(target), intent.runId, intent.epoch); this.onWrite?.(); }
    }
  }
  acquire(input: LeaseIntent): LeaseRecord {
    const intent = normalize(input);
    return this.transaction(() => {
      const prior = this.lookup(intent.canvasId, intent.requestId);
      if (prior) {
        const row = this.db.prepare("SELECT original_intent_json FROM spatial_lease_runs WHERE canvas_id = ? AND request_id = ?").get(intent.canvasId, intent.requestId) as { original_intent_json: string };
        if (row.original_intent_json !== JSON.stringify(intent)) throw new SpatialLeaseError("request-conflict");
        return prior;
      }
      this.eligible(intent, intent.writable);
      this.db.prepare("INSERT INTO spatial_lease_runs VALUES (?, ?, ?, ?, ?, ?, ?, 'active')").run(intent.canvasId, intent.requestId, intent.runId, intent.epoch, intent.executionId, JSON.stringify(intent), JSON.stringify(intent));
      this.onWrite?.();
      this.lock(intent, intent.writable);
      return { intent, state: "active" };
    });
  }
  extend(canvasId: string, requestId: string, additions: WorldObjectVersion[]): LeaseRecord {
    return this.transaction(() => {
      const record = this.lookup(canvasId, requestId);
      if (!record || record.state !== "active") throw new SpatialLeaseError("cancelled");
      const extra = normalizeTargets(additions);
      const old = new Set([...record.intent.writable, ...record.intent.readOnly].map(objectKey));
      if (extra.some(t => old.has(objectKey(t)))) throw new SpatialLeaseError("outside-scope");
      this.eligible(record.intent, extra);
      this.lock(record.intent, extra);
      record.intent.writable = normalizeTargets([...record.intent.writable, ...extra]);
      this.db.prepare("UPDATE spatial_lease_runs SET intent_json = ? WHERE canvas_id = ? AND request_id = ?").run(JSON.stringify(record.intent), canvasId, requestId);
      return record;
    });
  }
  cancel(canvasId: string, requestId: string): void {
    this.transaction(() => { this.db.prepare("UPDATE spatial_lease_runs SET state = 'cancelled' WHERE canvas_id = ? AND request_id = ? AND state = 'active'").run(canvasId, requestId); });
  }
  confirmStopped(canvasId: string, requestId: string, runId: string, epoch: number, executionId: string, evidence: unknown): void {
    this.transaction(() => {
      const record = this.lookup(canvasId, requestId);
      if (!record || record.intent.runId !== runId || record.intent.epoch !== epoch || record.intent.executionId !== executionId) throw new SpatialLeaseError("stale-epoch");
      if (record.state === "stopped") return;
      if (!this.authority) throw new SpatialLeaseError("unavailable");
      if (!this.authority.stopped({ canvasId, runId, epoch, executionId }, evidence)) throw new SpatialLeaseError("unverified-stop");
      this.db.prepare("DELETE FROM spatial_lease_locks WHERE canvas_id = ? AND run_id = ? AND epoch = ?").run(canvasId, runId, epoch);
      this.db.prepare("UPDATE spatial_lease_runs SET state = 'stopped' WHERE canvas_id = ? AND request_id = ?").run(canvasId, requestId);
    });
  }
  /** Manual writes must call this in their canonical transaction as well. */
  validateUnoccupied(canvasId: string, targets: WorldObjectIdentity[]): void {
    const query = this.db.prepare("SELECT 1 FROM spatial_lease_locks WHERE canvas_id = ? AND kind = ? AND object_id = ?");
    for (const target of targets) if (query.get(canvasId, target.kind, id(target))) throw new SpatialLeaseError("lease-conflict");
  }
  /** Call synchronously inside the same transaction as the canonical write. */
  validateForCommit(canvasId: string, requestId: string, runId: string, epoch: number, scope: WorldScopeVersion, targets: WorldObjectVersion[]): void {
    const record = this.lookup(canvasId, requestId);
    if (!record || record.intent.runId !== runId || record.intent.epoch !== epoch) throw new SpatialLeaseError("stale-epoch");
    if (record.state !== "active") throw new SpatialLeaseError("cancelled");
    if (JSON.stringify(normalize({ ...record.intent, scope }).scope) !== JSON.stringify(record.intent.scope)) throw new SpatialLeaseError("version-conflict");
    const normalized = normalizeTargets(targets);
    const granted = new Map(record.intent.writable.map(t => [objectKey(t), t.version]));
    for (const target of normalized) {
      if (granted.get(objectKey(target)) !== target.version) throw new SpatialLeaseError("version-conflict");
      const lock = this.db.prepare("SELECT run_id, epoch FROM spatial_lease_locks WHERE canvas_id = ? AND kind = ? AND object_id = ?").get(canvasId, target.kind, id(target)) as { run_id: string; epoch: number } | undefined;
      if (!lock || lock.run_id !== runId || lock.epoch !== epoch) throw new SpatialLeaseError("lease-conflict");
    }
    this.eligible(record.intent, normalized);
  }
}
