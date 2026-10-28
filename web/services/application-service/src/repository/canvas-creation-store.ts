import type { DatabaseSync } from "node:sqlite";
import type { CanvasCreationRequest, CanvasCreationView } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";

export type CanvasCreationRecord = { owner: string; inputHash: string; input: CanvasCreationRequest; view: CanvasCreationView };
/** Separate application ledger, never a field in a group or Y.Doc. */
export class CanvasCreationStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new (loadNodeSqlite().DatabaseSync)(path);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS canvas_agent_creations(owner TEXT NOT NULL, canvas_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(owner, request_id));
      CREATE INDEX IF NOT EXISTS canvas_agent_creations_canvas ON canvas_agent_creations(owner, canvas_id);
      CREATE TABLE IF NOT EXISTS canvas_agent_target_epochs(canvas_id TEXT NOT NULL, root_group_id TEXT NOT NULL, epoch INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(canvas_id, root_group_id));`);
    this.migrateLegacyStage();
  }
  /** 旧 `stage: "unknown"` 归一为失败并保留根组/回合证据。 */
  private migrateLegacyStage(): void {
    const rows = this.db.prepare("SELECT owner, request_id, record_json FROM canvas_agent_creations WHERE json_extract(record_json,'$.view.stage')='unknown'")
      .all() as Array<{ owner: string; request_id: string; record_json: string }>;
    const update = this.db.prepare("UPDATE canvas_agent_creations SET record_json=? WHERE owner=? AND request_id=?");
    for (const row of rows) {
      try {
        const record = JSON.parse(row.record_json) as CanvasCreationRecord;
        record.view = {
          ...record.view,
          stage: "failed",
          error: record.view.error ?? { code: "result-unconfirmed", message: "无法确认创建结果；根组与回合证据已保留。" }
        };
        update.run(JSON.stringify(record), row.owner, row.request_id);
      } catch { /* 保留无法解析的旧行 */ }
    }
  }
  get(owner: string, requestId: string): CanvasCreationRecord | null {
    const row = this.db.prepare("SELECT record_json FROM canvas_agent_creations WHERE owner=? AND request_id=?").get(owner, requestId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) : null;
  }
  list(owner: string, canvasId: string): CanvasCreationRecord[] {
    return (this.db.prepare("SELECT record_json FROM canvas_agent_creations WHERE owner=? AND canvas_id=? ORDER BY rowid DESC LIMIT 100").all(owner, canvasId) as { record_json: string }[]).map(row => JSON.parse(row.record_json));
  }
  insert(record: CanvasCreationRecord): CanvasCreationRecord {
    this.db.prepare("INSERT OR IGNORE INTO canvas_agent_creations VALUES(?,?,?,?,?)").run(record.owner, record.input.canvasId, record.input.requestId, record.inputHash, JSON.stringify(record));
    this.db.prepare("INSERT OR IGNORE INTO canvas_agent_target_epochs VALUES(?,?,0)").run(record.input.canvasId, record.view.rootGroupId);
    return this.get(record.owner, record.input.requestId)!;
  }
  save(record: CanvasCreationRecord): void { this.db.prepare("UPDATE canvas_agent_creations SET record_json=? WHERE owner=? AND request_id=? AND input_hash=?").run(JSON.stringify(record), record.owner, record.input.requestId, record.inputHash); }
  invalidate(canvasId: string, rootGroupId: string): number {
    this.db.prepare("INSERT OR IGNORE INTO canvas_agent_target_epochs VALUES(?,?,0)").run(canvasId, rootGroupId);
    this.db.prepare("UPDATE canvas_agent_target_epochs SET epoch=epoch+1 WHERE canvas_id=? AND root_group_id=?").run(canvasId, rootGroupId);
    return (this.db.prepare("SELECT epoch FROM canvas_agent_target_epochs WHERE canvas_id=? AND root_group_id=?").get(canvasId, rootGroupId) as { epoch: number } | undefined)?.epoch ?? 0;
  }
  epoch(canvasId: string, rootGroupId: string): number { return (this.db.prepare("SELECT epoch FROM canvas_agent_target_epochs WHERE canvas_id=? AND root_group_id=?").get(canvasId, rootGroupId) as { epoch: number } | undefined)?.epoch ?? 0; }
  close() { this.db.close(); }
}
