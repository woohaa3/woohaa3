import type { DatabaseSync } from "node:sqlite";
import type {
  AgentEntryIntent,
  AgentConnectionBinding,
  AssistantTextRun,
  PreparedAssistantText,
} from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";
export type AssistantTextRecord = {
  owner: string;
  requestId: string;
  inputHash: string;
  entry: AgentEntryIntent;
  connection: AgentConnectionBinding;
  prepared: PreparedAssistantText;
  run: AssistantTextRun;
  turnId?: string;
  stage:
    | "prepared"
    | "accepted"
    | "begun"
    | "calling"
    | "candidate"
    | "committing"
    | "done"
    | "failed"
    | "cancelled";
  candidate?: { text: string; checksum: string };
  error?: string;
};
/** Private phases of the existing conversation delivery; never synchronized in Y.Doc. */
export class AssistantTextStore {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new (loadNodeSqlite().DatabaseSync)(path);
    this.db.exec(
      "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS assistant_text_deliveries(owner TEXT NOT NULL, request_id TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(owner, request_id));",
    );
    this.migrateLegacyStage();
  }
  /** 旧版本可能把无法确认写成 `unknown`；读取前统一迁移为 failed，并保留候选与错误。 */
  private migrateLegacyStage(): void {
    const rows = this.db
      .prepare("SELECT owner, request_id, record_json FROM assistant_text_deliveries WHERE json_extract(record_json,'$.stage')='unknown'")
      .all() as Array<{ owner: string; request_id: string; record_json: string }>;
    const update = this.db.prepare("UPDATE assistant_text_deliveries SET record_json=? WHERE owner=? AND request_id=?");
    for (const row of rows) {
      try {
        const record = JSON.parse(row.record_json) as AssistantTextRecord;
        update.run(JSON.stringify({
          ...record,
          stage: "failed",
          error: record.error ?? "无法确认保存结果，候选已保留；重试前请核对原提交。"
        }), row.owner, row.request_id);
      } catch { /* 保留无法解析的旧行，交给读取路径按失败处理 */ }
    }
  }
  get(owner: string, requestId: string): AssistantTextRecord | null {
    const row = this.db
      .prepare(
        "SELECT record_json FROM assistant_text_deliveries WHERE owner=? AND request_id=?",
      )
      .get(owner, requestId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) : null;
  }
  findRun(
    owner: string,
    canvasId: string,
    nodeId: string,
    runId: string,
  ): AssistantTextRecord | null {
    const row = this.db
      .prepare(
        "SELECT record_json FROM assistant_text_deliveries WHERE owner=? AND json_extract(record_json,'$.run.canvasId')=? AND json_extract(record_json,'$.run.targetNodeId')=? AND json_extract(record_json,'$.run.runId')=?",
      )
      .get(owner, canvasId, nodeId, runId) as
      { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) : null;
  }
  insert(record: AssistantTextRecord): AssistantTextRecord {
    this.db
      .prepare("INSERT OR IGNORE INTO assistant_text_deliveries VALUES(?,?,?)")
      .run(record.owner, record.requestId, JSON.stringify(record));
    return this.get(record.owner, record.requestId)!;
  }
  save(record: AssistantTextRecord) {
    this.db
      .prepare(
        "UPDATE assistant_text_deliveries SET record_json=? WHERE owner=? AND request_id=?",
      )
      .run(JSON.stringify(record), record.owner, record.requestId);
  }
  close() {
    this.db.close();
  }
}
