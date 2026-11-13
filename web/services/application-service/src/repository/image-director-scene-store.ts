import type { DatabaseSync } from "node:sqlite";
import type { AgentConnectionBinding, AgentEntryIntent, FrozenImageDirectorSource, ImageDirectorSceneReceipt, ImageDirectorSceneRequest, ImageDirectorSceneReservation, ImageDirectorSceneStage } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";

export interface ImageDirectorSceneRecord {
  owner: string;
  canvasId: string;
  request: ImageDirectorSceneRequest;
  inputHash: string;
  source: FrozenImageDirectorSource;
  reservation?: ImageDirectorSceneReservation;
  imageBase64: string;
  beforeNodeIds: string[];
  connectionVersion: string;
  connection?: AgentConnectionBinding;
  conversationId?: string;
  entry?: AgentEntryIntent;
  stage: ImageDirectorSceneStage;
  parentTurnId?: string;
  activeAttemptId?: string;
  receipt?: ImageDirectorSceneReceipt;
  revision?: number;
  error?: string;
}

/** Private durable state; bytes and connection identity never enter public events. */
export class ImageDirectorSceneStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new (loadNodeSqlite().DatabaseSync)(path);
    this.db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS image_director_scenes(owner TEXT NOT NULL, canvas_id TEXT NOT NULL, request_id TEXT NOT NULL, input_hash TEXT NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(owner, canvas_id, request_id));");
  }
  get(owner: string, canvasId: string, requestId: string): ImageDirectorSceneRecord | null {
    const row = this.db.prepare("SELECT record_json FROM image_director_scenes WHERE owner=? AND canvas_id=? AND request_id=?").get(owner, canvasId, requestId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ImageDirectorSceneRecord : null;
  }
  insert(record: ImageDirectorSceneRecord): { record: ImageDirectorSceneRecord; reused: boolean } {
    const result = this.db.prepare("INSERT OR IGNORE INTO image_director_scenes VALUES(?,?,?,?,?)").run(record.owner, record.canvasId, record.request.requestId, record.inputHash, JSON.stringify(record));
    const saved = this.get(record.owner, record.canvasId, record.request.requestId)!;
    if (saved.inputHash !== record.inputHash) throw new Error("request-id-conflict");
    return { record: saved, reused: Number(result.changes) === 0 };
  }
  save(record: ImageDirectorSceneRecord): void {
    const result = this.db.prepare("UPDATE image_director_scenes SET record_json=? WHERE owner=? AND canvas_id=? AND request_id=? AND input_hash=?").run(JSON.stringify(record), record.owner, record.canvasId, record.request.requestId, record.inputHash);
    if (Number(result.changes) !== 1) throw new Error("request-id-conflict");
  }
  close(): void { this.db.close(); }
}
