/**
 * SQLite 存储 profile（任务 3.1–3.6 / design D5）。
 *
 * 只保存**结构化**画布聚合与 operation 幂等记录。刻意没有：
 * - `canvas_asset_blobs` 表或任何 Blob 列
 * - 本地媒体目录 / staging 文件
 * - GridFS 或文件系统媒体副本
 *
 * 媒体 bytes 的唯一归属是 COS；这里只保存 `StoredAsset.metadata.storageKey`。
 *
 * 并发语义：所有写入用 `BEGIN IMMEDIATE`（避免 SQLite 的 deferred 事务在写时升级导致
 * BUSY 竞争），revision 用 `WHERE revision = expectedRevision` 条件更新实现 CAS，operation
 * 用 `(canvas_id, operation_id)` 主键去重。任何失败都 `ROLLBACK`，不留下部分写入。
 */
import type { DatabaseSync } from "node:sqlite";
import { parseCanvasAggregate, type ServerCanvas } from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { SqliteSpatialLeaseStore } from "./spatial-leases.js";
import { SpatialLeaseError } from "../../world-authoring/spatial-leases.js";
import { affectedWorldObjects } from "../../world-authoring/affected-objects.js";
import { normalizeCanvasListQuery, CanvasStorageError, runCanvasMigrationsSync, type CanvasCommandCommitResult, type CanvasListQuery, type CanvasListResult, type CanvasOperationRecord, type CanvasRepository, type CanvasRepositoryHealth, type CanvasSummary, type CommitCanvasInput } from "../core/index.js";

export const SQLITE_CANVAS_SCHEMA_VERSION = 2;

export const SQLITE_DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export type SqliteSynchronousMode = "OFF" | "NORMAL" | "FULL" | "EXTRA";

export type SqliteCanvasStorageOptions = {
  /** 数据库文件路径；`:memory:` 表示内存库（仅测试）。 */
  path: string;
  /** 只读打开：迁移与写入都会失败（用于验证 readiness 诊断）。 */
  readOnly?: boolean;
  busyTimeoutMs?: number;
  synchronous?: SqliteSynchronousMode;
  now?: () => string;
  /**
   * 注入写失败，验证事务回滚。返回 true 表示「本次应失败」，适配器在事务中途抛错。
   * 仅测试使用。
   */
  failWrites?: () => boolean;
};

type CanvasRow = {
  id: string;
  revision: number;
  title: string;
  canvas_json: string;
  created_at: string;
  updated_at: string;
};

type OperationRow = {
  canvas_id: string;
  operation_id: string;
  base_revision: number;
  result_revision: number;
  actor_id: string;
  commands_json: string;
  result_canvas_json: string;
  created_at: string;
};

/**
 * SQLite 画布仓库。
 *
 * 生命周期：构造时打开数据库、应用 PRAGMA、运行迁移。调用方负责在进程退出时
 * `close()`。构造失败（只读库、损坏 schema、版本过新）抛 `CanvasStorageError`，
 * 不含绝对路径。
 */
export class SqliteCanvasRepository implements CanvasRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly failWrites: () => boolean;
  private readonly spatialLeases: SqliteSpatialLeaseStore;
  private closed = false;

  constructor(options: SqliteCanvasStorageOptions) {
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
      this.applyPragmas(options);
      this.migrate();
      this.spatialLeases = new SqliteSpatialLeaseStore(this.db);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // 关闭失败不影响诊断
      }
      if (error instanceof CanvasStorageError) throw error;
      throw new CanvasStorageError("NOT_READY", `SQLite 初始化失败：${safeMessage(error)}`);
    }
  }

  private applyPragmas(options: SqliteCanvasStorageOptions): void {
    // 只读库无法设置 journal_mode/synchronous；跳过写型 PRAGMA，让后续写操作失败。
    if (options.readOnly) {
      this.db.exec("PRAGMA foreign_keys = ON");
      return;
    }
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`PRAGMA synchronous = ${options.synchronous ?? "NORMAL"}`);
    this.db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? SQLITE_DEFAULT_BUSY_TIMEOUT_MS}`);
  }

  /**
   * 顺序迁移（任务 7.1）。用共享 `runCanvasMigrationsSync` 保证与 Mongo 同一套语义：
   * 连续版本、排他锁、持锁后重读、失败停止、版本过新拒绝启动。
   *
   * 排他锁用 SQLite 自身的 `BEGIN EXCLUSIVE`：并发启动时第二个进程会等待/失败，
   * 不会重复执行迁移。
   */
  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    runCanvasMigrationsSync({
      targetVersion: SQLITE_CANVAS_SCHEMA_VERSION,
      migrations: [
        { version: 1, description: "initial canvases + canvas_operations", apply: () => this.migrationV1() },
        { version: 2, description: "content lifecycle receipts", apply: () => this.db.exec(`CREATE TABLE canvas_lifecycle_receipts (
          operation_id TEXT PRIMARY KEY, canvas_id TEXT NOT NULL, result_json TEXT NOT NULL
        )`) }
      ],
      readVersion: () => this.readSchemaVersion(),
      acquireLock: () => {
        this.db.exec("BEGIN EXCLUSIVE");
        return { release: () => this.db.exec("COMMIT") };
      },
      recordMigration: (migration) => {
        this.db
          .prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, this.now());
      },
      onError: (message) => new CanvasStorageError(
        message.includes("高于应用支持") ? "SCHEMA_VERSION_UNSUPPORTED" : "NOT_READY",
        message
      )
    });
  }

  private readSchemaVersion(): number {
    const row = this.db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  }

  private migrationV1(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canvases (
        id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        canvas_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS canvas_operations (
        canvas_id TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        base_revision INTEGER NOT NULL,
        result_revision INTEGER NOT NULL,
        actor_id TEXT NOT NULL,
        commands_json TEXT NOT NULL,
        result_canvas_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (canvas_id, operation_id),
        FOREIGN KEY (canvas_id) REFERENCES canvases(id) ON DELETE CASCADE
      )
    `);
    // 稳定列表排序的索引（updated_at 降序 + id 次级键）。
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_canvases_updated_at ON canvases(updated_at DESC, id ASC)");
  }

  async createCanvas(canvas: ServerCanvas, operationId?: string): Promise<ServerCanvas> {
    const created: ServerCanvas = { ...canvas, revision: 1, updatedAt: canvas.updatedAt };
    return this.inImmediateTransaction(() => {
      if (operationId) {
        const receipt = this.db.prepare("SELECT canvas_id, result_json FROM canvas_lifecycle_receipts WHERE operation_id = ?").get(`create:${operationId}`) as { canvas_id: string; result_json: string } | undefined;
        if (receipt) {
          if (receipt.canvas_id !== canvas.id) throw new CanvasStorageError("CANVAS_ALREADY_EXISTS", "operationId 已绑定其他画布");
          return JSON.parse(receipt.result_json) as ServerCanvas;
        }
      }
      const existing = this.db.prepare("SELECT id FROM canvases WHERE id = ?").get(canvas.id);
      if (existing) {
        throw new CanvasStorageError("CANVAS_ALREADY_EXISTS", `画布 ${canvas.id} 已存在`);
      }
      this.db
        .prepare(
          `INSERT INTO canvases (id, revision, title, canvas_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(created.id, created.revision, created.title ?? "", serialize(created), created.updatedAt, created.updatedAt);
      if (operationId) this.db.prepare("INSERT INTO canvas_lifecycle_receipts VALUES (?, ?, ?)").run(`create:${operationId}`, canvas.id, serialize(created));
      if (this.failWrites()) throw new Error("注入生命周期写入失败");
      return created;
    });
  }

  /**
   * 在 `BEGIN IMMEDIATE` 事务里执行 `run`，并把**任何**底层错误（包括 BEGIN 本身因
   * 数据库锁/只读失败）翻译成稳定错误码。
   *
   * 关键点：`BEGIN IMMEDIATE` 也必须落在 try 里 —— 否则「数据库被锁定」这类错误会以
   * 原始 SQLite 异常逃逸，既没有稳定 code，也可能带上路径信息。
   */
  private inImmediateTransaction<T>(run: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw translateWriteError(error);
    }
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      safeRollback(this.db);
      throw translateWriteError(error);
    }
  }

  /**
   * 幂等地为"从远端拉下来的画布"补一条结构化目录行。
   *
   * 只在本机还没有这张画布时插入；已有行时只刷新标题与时间（远端标题可能被改过），
   * **不**动 revision 与 canvas_json —— 内容以本机 Yjs 文档为准。
   */
  async ensureCanvasRow(canvas: ServerCanvas): Promise<void> {
    this.inImmediateTransaction(() => {
      const existing = this.db.prepare("SELECT id FROM canvases WHERE id = ?").get(canvas.id) as { id: string } | undefined;
      if (existing) {
        this.db
          .prepare("UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?")
          .run(canvas.title ?? "", canvas.updatedAt, canvas.id);
        return;
      }
      this.db
        .prepare(
          `INSERT INTO canvases (id, revision, title, canvas_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(canvas.id, canvas.revision, canvas.title ?? "", serialize(canvas), canvas.updatedAt, canvas.updatedAt);
    });
  }

  async getCanvas(canvasId: string): Promise<ServerCanvas | null> {
    const row = this.db
      .prepare("SELECT canvas_json FROM canvases WHERE id = ?")
      .get(canvasId) as { canvas_json: string } | undefined;
    if (!row) return null;
    return deserialize(row.canvas_json);
  }

  async getOperation(canvasId: string, operationId: string): Promise<CanvasOperationRecord | null> {
    const row = this.db
      .prepare(
        `SELECT canvas_id, operation_id, base_revision, result_revision, actor_id,
                commands_json, result_canvas_json, created_at
         FROM canvas_operations WHERE canvas_id = ? AND operation_id = ?`
      )
      .get(canvasId, operationId) as OperationRow | undefined;
    if (!row) return null;
    return rowToOperation(row);
  }

  async listOperations(canvasId: string): Promise<CanvasOperationRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT canvas_id, operation_id, base_revision, result_revision, actor_id,
                commands_json, result_canvas_json, created_at
         FROM canvas_operations WHERE canvas_id = ? ORDER BY result_revision ASC`
      )
      .all(canvasId) as OperationRow[];
    return rows.map(rowToOperation);
  }

  async listCanvases(query?: CanvasListQuery): Promise<CanvasListResult> {
    const { offset, limit, ids } = normalizeCanvasListQuery(query);
    // 白名单先过滤再分页（任务 5.5 修正）：`total` 是被授权集合的总数。
    if (ids && ids.length === 0) return { items: [], total: 0, offset, limit };
    const where = ids ? `WHERE id IN (${ids.map(() => "?").join(", ")})` : "";
    const params = ids ? [...ids] : [];
    const totalRow = this.db.prepare(`SELECT COUNT(*) AS total FROM canvases ${where}`).get(...params) as { total: number };
    const rows = this.db
      .prepare(
        `SELECT id, revision, title, canvas_json, created_at, updated_at
         FROM canvases
         ${where}
         ORDER BY updated_at DESC, id ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as CanvasRow[];
    return {
      items: rows.map(toSummary),
      total: totalRow.total,
      offset,
      limit
    };
  }

  async commitCanvas(input: CommitCanvasInput): Promise<CanvasCommandCommitResult> {
    // BEGIN 放在 try 内：数据库被锁定/只读时它也会抛，必须走同一套错误映射。
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const existing = this.db
        .prepare(
          `SELECT canvas_id, operation_id, base_revision, result_revision, actor_id,
                  commands_json, result_canvas_json, created_at
           FROM canvas_operations WHERE canvas_id = ? AND operation_id = ?`
        )
        .get(input.canvasId, input.operationId) as OperationRow | undefined;
      if (existing) {
        this.db.exec("COMMIT");
        return {
          canvas: deserialize(existing.result_canvas_json),
          revision: existing.result_revision,
          operationId: input.operationId,
          duplicate: true
        };
      }

      const current = this.db
        .prepare("SELECT revision, canvas_json FROM canvases WHERE id = ?")
        .get(input.canvasId) as { revision: number; canvas_json: string } | undefined;
      if (!current) {
        throw new CanvasStorageError("CANVAS_NOT_FOUND", `画布 ${input.canvasId} 不存在`);
      }
      if (current.revision !== input.expectedRevision) {
        throw new CanvasStorageError("REVISION_CONFLICT", "画布 revision 已变化", {
          currentRevision: current.revision
        });
      }

      this.spatialLeases.validateUnoccupied(input.canvasId, affectedWorldObjects(deserialize(current.canvas_json), input.canvas));

      if (this.failWrites()) {
        throw new CanvasStorageError("REPOSITORY_FAILURE", "注入的写失败");
      }

      const resultRevision = input.canvas.revision;
      this.db
        .prepare(
          `UPDATE canvases SET revision = ?, title = ?, canvas_json = ?, updated_at = ? WHERE id = ?`
        )
        .run(resultRevision, input.canvas.title ?? "", serialize(input.canvas), input.canvas.updatedAt, input.canvasId);

      this.db
        .prepare(
          `INSERT INTO canvas_operations
             (canvas_id, operation_id, base_revision, result_revision, actor_id, commands_json, result_canvas_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.canvasId,
          input.operationId,
          input.expectedRevision,
          resultRevision,
          input.actorId,
          JSON.stringify(input.commands),
          serialize(input.canvas),
          input.now
        );

      this.db.exec("COMMIT");
      return {
        canvas: input.canvas,
        revision: resultRevision,
        operationId: input.operationId,
        duplicate: false
      };
    } catch (error) {
      safeRollback(this.db);
      throw translateWriteError(error);
    }
  }

  async deleteCanvas(canvasId: string, expectedRevision: number, operationId?: string): Promise<void> {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      if (operationId) {
        const receipt = this.db.prepare("SELECT canvas_id, result_json FROM canvas_lifecycle_receipts WHERE operation_id = ?").get(`delete:${operationId}`) as { canvas_id: string; result_json: string } | undefined;
        if (receipt) {
          if (receipt.canvas_id !== canvasId || JSON.parse(receipt.result_json) !== expectedRevision) throw new CanvasStorageError("REVISION_CONFLICT", "删除回执与请求不符");
          this.db.exec("COMMIT"); return;
        }
      }
      const row = this.db
        .prepare("SELECT revision FROM canvases WHERE id = ?")
        .get(canvasId) as { revision: number } | undefined;
      if (!row) {
        throw new CanvasStorageError("CANVAS_NOT_FOUND", `画布 ${canvasId} 不存在`);
      }
      if (row.revision !== expectedRevision) {
        throw new CanvasStorageError("REVISION_CONFLICT", "画布 revision 已变化", {
          currentRevision: row.revision
        });
      }
      this.spatialLeases.validateCanvasUnoccupied(canvasId);
      // 只删结构化记录（operation 经外键级联删除）；不触碰任何 COS 对象。
      for (const table of ["canvas_yjs_documents", "node_generation_history", "canvas_edit_completions"]) {
        if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) {
          this.db.prepare(`DELETE FROM ${table} WHERE canvas_id = ?`).run(canvasId);
        }
      }
      this.db.prepare("DELETE FROM canvases WHERE id = ?").run(canvasId);
      if (operationId) this.db.prepare("INSERT INTO canvas_lifecycle_receipts VALUES (?, ?, ?)").run(`delete:${operationId}`, canvasId, JSON.stringify(expectedRevision));
      if (this.failWrites()) throw new Error("注入生命周期写入失败");
      this.db.exec("COMMIT");
    } catch (error) {
      safeRollback(this.db);
      throw translateWriteError(error);
    }
  }

  /** 运维恢复：按原样 upsert（保留 revision/updatedAt），不重置为 1。 */
  async restoreCanvas(canvas: ServerCanvas): Promise<void> {
    this.inImmediateTransaction(() => {
      this.spatialLeases.validateCanvasUnoccupied(canvas.id);
      this.db
        .prepare(
          `INSERT INTO canvases (id, revision, title, canvas_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             revision = excluded.revision,
             title = excluded.title,
             canvas_json = excluded.canvas_json,
             updated_at = excluded.updated_at`
        )
        .run(
          canvas.id,
          canvas.revision,
          canvas.title ?? "",
          serialize(canvas),
          canvas.updatedAt,
          canvas.updatedAt
        );
    });
  }

  /** readiness：验证 schema 存在、可读、可写事务。 */
  async health(): Promise<CanvasRepositoryHealth> {
    try {
      const row = this.db
        .prepare("SELECT COUNT(*) AS total FROM canvases")
        .get() as { total: number };
      void row;
      // 写探测：只读库在真实写入时失败（`BEGIN IMMEDIATE` 本身不落盘）。
      // 用「自赋值更新」保证探测不改变任何数据。
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare("UPDATE schema_migrations SET applied_at = applied_at WHERE version = ?")
          .run(SQLITE_CANVAS_SCHEMA_VERSION);
        this.db.exec("COMMIT");
      } catch (error) {
        safeRollback(this.db);
        throw error;
      }
      return { ok: true, backend: "sqlite" };
    } catch (error) {
      return { ok: false, backend: "sqlite", reason: safeMessage(error) };
    }
  }

  /** 关闭数据库连接。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** 测试用：直接执行 SQL（检查没有 Blob 表等）。 */
  debugQuery<T = unknown>(sql: string): T[] {
    return this.db.prepare(sql).all() as T[];
  }
}

function serialize(canvas: ServerCanvas): string {
  return JSON.stringify(canvas);
}

function rowToOperation(row: OperationRow): CanvasOperationRecord {
  return {
    canvasId: row.canvas_id,
    operationId: row.operation_id,
    baseRevision: row.base_revision,
    resultRevision: row.result_revision,
    actorId: row.actor_id,
    createdAt: row.created_at,
    resultCanvas: deserialize(row.result_canvas_json)
  };
}

function deserialize(json: string): ServerCanvas {
  const input: unknown = JSON.parse(json);
  const parsed = parseCanvasAggregate(input);
  if (!parsed.ok) throw new Error(`Invalid stored canvas: ${parsed.failure.message}`);
  return parsed.canvas;
}

function toSummary(row: CanvasRow): CanvasSummary {
  const canvas = deserialize(row.canvas_json);
  return {
    id: row.id,
    title: row.title,
    revision: row.revision,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    nodeCount: canvas.document.nodes.length,
    assetCount: canvas.assets.length
  };
}

/** 把底层 SQLite 异常翻译成稳定错误码，且**不**回显文件路径或原始栈。 */
function translateWriteError(error: unknown): unknown {
  if (error instanceof CanvasStorageError || error instanceof SpatialLeaseError) return error;
  const message = safeMessage(error);
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
    // 事务可能根本未开始或已自动回滚。
  }
}

/** 去掉可能的绝对路径/URI，只保留可诊断的短消息。 */
function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\/[^\s'"]+/g, "<path>").slice(0, 200);
}

export { SqliteYjsRepository, SQLITE_YJS_SCHEMA_VERSION, createSqliteWriterLockStore } from "./yjs.js";
export type { SqliteYjsRepositoryOptions } from "./yjs.js";
