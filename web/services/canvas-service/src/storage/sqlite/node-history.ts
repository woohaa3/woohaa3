/**
 * SQLite 节点生成历史仓库
 * （change: add-canvas-node-generation-history，任务 1.2 / design D1、D6）。
 *
 * 独立于画布聚合、operation 与 Yjs 表：自己的迁移表 `node_history_schema_migrations` 与
 * `node_generation_history`。历史事务**绝不**触碰画布表或 Y.Doc，因此不会推进 canvas
 * revision 或广播 room update。
 *
 * 幂等：`entry_id` 为主键，重复登记返回 duplicate。容量清理按
 * `(canvas_id, created_at, entry_id)` 升序（最旧优先）删索引行。
 */
import type { DatabaseSync } from "node:sqlite";
import type { NodeGenerationHistoryEntry, NodeHistoryKindCounts } from "@woohaa3/contracts";
import { emptyNodeHistoryKindCounts } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { CanvasStorageError } from "../core/errors.js";
import {
  nodeHistoryEntryBytes,
  type NodeHistoryCanvasListInput,
  type NodeHistoryCanvasStats,
  type NodeHistoryIndexRow,
  type NodeHistoryInsertResult,
  type NodeHistoryListInput,
  type NodeHistoryListResult,
  type NodeHistoryRepository
} from "../core/node-history-contracts.js";

export const SQLITE_NODE_HISTORY_SCHEMA_VERSION = 2;

export type SqliteNodeHistoryRepositoryOptions = {
  path: string;
  readOnly?: boolean;
  busyTimeoutMs?: number;
  now?: () => string;
  failWrites?: () => boolean;
};

type Row = {
  entry_id: string;
  canvas_id: string;
  node_id: string;
  kind: string;
  created_at: string;
  source_identity: string;
  current_identity: string;
  recoverable: number;
  previewable: number;
  payload_json: string;
  source_json: string;
  bytes: number;
};

export class SqliteNodeHistoryRepository implements NodeHistoryRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly failWrites: () => boolean;
  private closed = false;

  constructor(options: SqliteNodeHistoryRepositoryOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.failWrites = options.failWrites ?? (() => false);
    try {
      const sqlite = loadNodeSqlite();
      this.db = new sqlite.DatabaseSync(options.path, {
        readOnly: options.readOnly ?? false,
        enableForeignKeyConstraints: true
      });
    } catch (error) {
      throw new CanvasStorageError("NOT_READY", `无法打开 SQLite 数据库：${safeMessage(error)}`);
    }
    try {
      if (!options.readOnly) {
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA busy_timeout = " + (options.busyTimeoutMs ?? 5_000));
      }
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      if (error instanceof CanvasStorageError) throw error;
      throw new CanvasStorageError("NOT_READY", `节点历史初始化失败：${safeMessage(error)}`);
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS node_history_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);
    const row = this.db.prepare("SELECT MAX(version) AS version FROM node_history_schema_migrations").get() as
      | { version: number | null }
      | undefined;
    if ((row?.version ?? 0) >= SQLITE_NODE_HISTORY_SCHEMA_VERSION) return;
    this.inImmediateTransaction(() => {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS node_generation_history (
          entry_id TEXT PRIMARY KEY,
          canvas_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          created_at TEXT NOT NULL,
          source_identity TEXT NOT NULL,
          current_identity TEXT NOT NULL,
          recoverable INTEGER NOT NULL,
          previewable INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          source_json TEXT NOT NULL,
          bytes INTEGER NOT NULL
        )
      `);
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_ngh_node_order ON node_generation_history(canvas_id, node_id, created_at DESC, entry_id DESC)"
      );
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_ngh_canvas_order ON node_generation_history(canvas_id, created_at ASC, entry_id ASC)"
      );
      // 画布级倒序分页索引（change: add-canvas-generation-history-dialog）。
      this.db.exec(
        "CREATE INDEX IF NOT EXISTS idx_ngh_canvas_order_desc ON node_generation_history(canvas_id, created_at DESC, entry_id DESC)"
      );
      this.db
        .prepare("INSERT OR IGNORE INTO node_history_schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(SQLITE_NODE_HISTORY_SCHEMA_VERSION, this.now());
    });
  }

  async insert(entry: NodeGenerationHistoryEntry): Promise<NodeHistoryInsertResult> {
    return this.inImmediateTransaction(() => {
      const existing = this.db.prepare("SELECT * FROM node_generation_history WHERE entry_id = ?").get(entry.entryId) as
        | Row
        | undefined;
      if (existing) return { status: "duplicate", entry: rowToEntry(existing) };
      this.db
        .prepare(
          `INSERT INTO node_generation_history
             (entry_id, canvas_id, node_id, kind, created_at, source_identity, current_identity,
              recoverable, previewable, payload_json, source_json, bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entry.entryId,
          entry.canvasId,
          entry.nodeId,
          entry.kind,
          entry.createdAt,
          entry.sourceIdentity,
          entry.currentIdentity,
          entry.recoverable ? 1 : 0,
          entry.previewable ? 1 : 0,
          JSON.stringify(entry.payload),
          JSON.stringify(entry.source),
          nodeHistoryEntryBytes(entry)
        );
      return { status: "inserted", entry };
    });
  }

  async get(canvasId: string, nodeId: string, entryId: string): Promise<NodeGenerationHistoryEntry | null> {
    const row = this.db
      .prepare("SELECT * FROM node_generation_history WHERE entry_id = ? AND canvas_id = ? AND node_id = ?")
      .get(entryId, canvasId, nodeId) as Row | undefined;
    return row ? rowToEntry(row) : null;
  }

  async markUnrecoverable(canvasId: string, nodeId: string, entryId: string): Promise<void> {
    this.inImmediateTransaction(() => {
      this.db
        .prepare(
          "UPDATE node_generation_history SET recoverable = 0, previewable = 0 WHERE entry_id = ? AND canvas_id = ? AND node_id = ?"
        )
        .run(entryId, canvasId, nodeId);
    });
  }

  async list(input: NodeHistoryListInput): Promise<NodeHistoryListResult> {
    const totalRow = this.db
      .prepare("SELECT COUNT(*) AS total FROM node_generation_history WHERE canvas_id = ? AND node_id = ?")
      .get(input.canvasId, input.nodeId) as { total: number };
    const rows = input.cursor
      ? (this.db
          .prepare(
            `SELECT * FROM node_generation_history
             WHERE canvas_id = ? AND node_id = ?
               AND (created_at < ? OR (created_at = ? AND entry_id < ?))
             ORDER BY created_at DESC, entry_id DESC
             LIMIT ?`
          )
          .all(input.canvasId, input.nodeId, input.cursor.createdAt, input.cursor.createdAt, input.cursor.entryId, input.limit) as Row[])
      : (this.db
          .prepare(
            `SELECT * FROM node_generation_history
             WHERE canvas_id = ? AND node_id = ?
             ORDER BY created_at DESC, entry_id DESC
             LIMIT ?`
          )
          .all(input.canvasId, input.nodeId, input.limit) as Row[]);
    const items = rows.map(rowToEntry);
    const last = items[items.length - 1];
    const seen = this.db
      .prepare("SELECT COUNT(*) AS total FROM node_generation_history WHERE canvas_id = ? AND node_id = ?")
      .get(input.canvasId, input.nodeId) as { total: number };
    return {
      items,
      nextCursor: last ? { createdAt: last.createdAt, entryId: last.entryId } : null,
      total: totalRow.total ?? seen.total ?? 0
    };
  }

  async listCanvas(input: NodeHistoryCanvasListInput): Promise<NodeHistoryListResult> {
    if (input.summary) {
      const rows = this.db.prepare(`SELECT * FROM (
        SELECT *,
          ROW_NUMBER() OVER (PARTITION BY node_id ORDER BY created_at DESC, entry_id DESC) AS newest,
          ROW_NUMBER() OVER (PARTITION BY node_id, json_extract(payload_json, '$.kind'), json_extract(payload_json, '$.outcome') ORDER BY created_at DESC, entry_id DESC) AS outcome_position,
          ROW_NUMBER() OVER (PARTITION BY node_id, current_identity, json_extract(payload_json, '$.kind') ORDER BY created_at DESC, entry_id DESC) AS current_position
        FROM node_generation_history WHERE canvas_id = ? AND (? IS NULL OR node_id = ?) AND (? IS NULL OR kind = ?)
      ) WHERE newest <= 24
        OR (json_extract(payload_json, '$.kind') = 'failure' AND json_extract(payload_json, '$.outcome') = 'failed' AND outcome_position = 1)
        OR (current_position = 1 AND json_extract(payload_json, '$.kind') != 'failure' AND EXISTS (
          SELECT 1 FROM json_each(?) AS identities WHERE identities.key = node_id AND identities.value = current_identity
        ))
      ORDER BY created_at DESC, entry_id DESC`).all(input.canvasId, input.summaryNodeId ?? null, input.summaryNodeId ?? null, input.kind ?? null, input.kind ?? null, JSON.stringify(input.currentIdentities ?? {})) as Row[];
      return { items: rows.map(rowToEntry), nextCursor: null, total: rows.length };
    }
    const kindClause = input.kind ? " AND kind = ?" : "";
    const kindParams = input.kind ? [input.kind] : [];
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS total FROM node_generation_history WHERE canvas_id = ?${kindClause}`)
      .get(input.canvasId, ...kindParams) as { total: number };
    // 多取一行以判定是否仍有后续页，保证与内存实现的「末页 nextCursor 为 null」一致。
    const fetchLimit = input.limit + 1;
    const rows = input.cursor
      ? (this.db
          .prepare(
            `SELECT * FROM node_generation_history
             WHERE canvas_id = ?${kindClause}
               AND (created_at < ? OR (created_at = ? AND entry_id < ?))
             ORDER BY created_at DESC, entry_id DESC
             LIMIT ?`
          )
          .all(
            input.canvasId,
            ...kindParams,
            input.cursor.createdAt,
            input.cursor.createdAt,
            input.cursor.entryId,
            fetchLimit
          ) as Row[])
      : (this.db
          .prepare(
            `SELECT * FROM node_generation_history
             WHERE canvas_id = ?${kindClause}
             ORDER BY created_at DESC, entry_id DESC
             LIMIT ?`
          )
          .all(input.canvasId, ...kindParams, fetchLimit) as Row[]);
    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const items = page.map(rowToEntry);
    const last = hasMore ? items[items.length - 1] : undefined;
    return {
      items,
      nextCursor: last ? { createdAt: last.createdAt, entryId: last.entryId } : null,
      total: totalRow.total ?? 0
    };
  }

  async canvasKindCounts(canvasId: string): Promise<NodeHistoryKindCounts> {
    const counts = emptyNodeHistoryKindCounts();
    const rows = this.db
      .prepare("SELECT kind, COUNT(*) AS total FROM node_generation_history WHERE canvas_id = ? GROUP BY kind")
      .all(canvasId) as Array<{ kind: string; total: number }>;
    for (const row of rows) {
      if (row.kind in counts) counts[row.kind as keyof NodeHistoryKindCounts] = row.total;
    }
    return counts;
  }

  async listForNode(canvasId: string, nodeId: string): Promise<NodeGenerationHistoryEntry[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM node_generation_history WHERE canvas_id = ? AND node_id = ? ORDER BY created_at DESC, entry_id DESC"
      )
      .all(canvasId, nodeId) as Row[];
    return rows.map(rowToEntry);
  }

  async listCanvasIndex(canvasId: string): Promise<NodeHistoryIndexRow[]> {
    const rows = this.db
      .prepare(
        `SELECT entry_id, canvas_id, node_id, created_at, current_identity, bytes
         FROM node_generation_history WHERE canvas_id = ? ORDER BY created_at ASC, entry_id ASC`
      )
      .all(canvasId) as Array<{
      entry_id: string;
      canvas_id: string;
      node_id: string;
      created_at: string;
      current_identity: string;
      bytes: number;
    }>;
    return rows.map((row) => ({
      entryId: row.entry_id,
      canvasId: row.canvas_id,
      nodeId: row.node_id,
      createdAt: row.created_at,
      currentIdentity: row.current_identity,
      bytes: row.bytes
    }));
  }

  async canvasStats(canvasId: string): Promise<NodeHistoryCanvasStats> {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM node_generation_history WHERE canvas_id = ?")
      .get(canvasId) as { count: number; bytes: number };
    return { count: row.count ?? 0, bytes: row.bytes ?? 0 };
  }

  async delete(canvasId: string, entryIds: readonly string[]): Promise<void> {
    if (entryIds.length === 0) return;
    this.inImmediateTransaction(() => {
      const statement = this.db.prepare("DELETE FROM node_generation_history WHERE entry_id = ? AND canvas_id = ?");
      for (const entryId of entryIds) statement.run(entryId, canvasId);
    });
  }

  async deleteNode(canvasId: string, nodeId: string): Promise<void> {
    this.inImmediateTransaction(() => {
      this.db.prepare("DELETE FROM node_generation_history WHERE canvas_id = ? AND node_id = ?").run(canvasId, nodeId);
    });
  }

  async deleteCanvas(canvasId: string): Promise<void> {
    this.inImmediateTransaction(() => {
      this.db.prepare("DELETE FROM node_generation_history WHERE canvas_id = ?").run(canvasId);
    });
  }

  async health(): Promise<{ ok: boolean; backend: string; reason?: string }> {
    try {
      this.db.prepare("SELECT COUNT(*) AS total FROM node_generation_history").get();
      return { ok: true, backend: "sqlite" };
    } catch (error) {
      return { ok: false, backend: "sqlite", reason: safeMessage(error) };
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  debugQuery<T = unknown>(sql: string): T[] {
    return this.db.prepare(sql).all() as T[];
  }

  private inImmediateTransaction<T>(run: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw translateWriteError(error);
    }
    try {
      if (this.failWrites()) throw new CanvasStorageError("REPOSITORY_FAILURE", "注入的写失败");
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      safeRollback(this.db);
      throw translateWriteError(error);
    }
  }
}

function rowToEntry(row: Row): NodeGenerationHistoryEntry {
  return {
    version: "woohaa-node-generation-history-v1",
    entryId: row.entry_id,
    canvasId: row.canvas_id,
    nodeId: row.node_id,
    kind: row.kind as NodeGenerationHistoryEntry["kind"],
    createdAt: row.created_at,
    sourceIdentity: row.source_identity,
    currentIdentity: row.current_identity,
    recoverable: row.recoverable === 1,
    previewable: row.previewable === 1,
    source: JSON.parse(row.source_json) as NodeGenerationHistoryEntry["source"],
    payload: JSON.parse(row.payload_json) as NodeGenerationHistoryEntry["payload"]
  };
}

function translateWriteError(error: unknown): unknown {
  if (error instanceof CanvasStorageError) return error;
  const message = safeMessage(error);
  if (/UNIQUE constraint failed/i.test(message)) {
    return new CanvasStorageError("REPOSITORY_FAILURE", "唯一性约束冲突");
  }
  if (/readonly|read-only|attempt to write/i.test(message)) {
    return new CanvasStorageError("REPOSITORY_FAILURE", "数据库不可写");
  }
  if (/locked|busy/i.test(message)) {
    return new CanvasStorageError("REPOSITORY_FAILURE", "数据库被锁定");
  }
  if (/no such table|malformed|not a database|corrupt/i.test(message)) {
    return new CanvasStorageError("NOT_READY", "数据库 schema 无效或已损坏");
  }
  return new CanvasStorageError("REPOSITORY_FAILURE", "数据库写入失败");
}

function safeRollback(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // ignore
  }
}

function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\/[^\s'"]+/g, "<path>").slice(0, 200);
}
