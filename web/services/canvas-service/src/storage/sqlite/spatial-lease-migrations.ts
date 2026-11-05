import type { DatabaseSync } from "node:sqlite";

export function migrateSpatialLeases(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS spatial_lease_runs (
    canvas_id TEXT NOT NULL, request_id TEXT NOT NULL, run_id TEXT NOT NULL,
    epoch INTEGER NOT NULL, execution_id TEXT NOT NULL, original_intent_json TEXT NOT NULL, intent_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active','cancelled','stopped')),
    PRIMARY KEY (canvas_id, request_id), UNIQUE (canvas_id, run_id, epoch)
  );
  CREATE TABLE IF NOT EXISTS spatial_lease_locks (
    canvas_id TEXT NOT NULL, kind TEXT NOT NULL, object_id TEXT NOT NULL,
    run_id TEXT NOT NULL, epoch INTEGER NOT NULL,
    PRIMARY KEY (canvas_id, kind, object_id)
  );`);
}
