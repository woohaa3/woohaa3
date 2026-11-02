/**
 * 画布导入：单连接 SQLite 原子存储
 * （change: 2026-10-12-add-extension-online-canvas-migration，任务 4.5、4.6、4.9、7.2 / design D6、D9、D11）。
 *
 * **整画布原子性**：结构化聚合（`canvases`）、Yjs checkpoint 文档（`canvas_yjs_documents`）、
 * 导入 ACL、节点历史、导入收据/job/诊断**在同一个 `BEGIN IMMEDIATE` 事务内**写入同一
 * SQLite 连接；任一失败全回滚。COMMIT 之后调用方才发布 room。
 *
 * 不与既有服务 writer lock 竞争：导入是**一次性**直接写入目标表（不调用 archive
 * replace/restore、不占用 `canvas_writer_lock`）；并发串行化由 `CanvasImportService` 在进程内
 * 按画布串行 + room 失效保证。
 *
 * schema 迁移与行解码分别在 `canvas-import-schema.ts` / `canvas-import-rows.ts`。
 */
import type { DatabaseSync } from "node:sqlite";
import type {
  CanvasSourceBinding,
  ImportedCanvasAccess,
  CanvasImportDiagnosticEntry,
  ServerCanvas
} from "@woohaa3/contracts";
import { CanvasStorageError } from "../core/index.js";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { assertImportBaseTables, migrateImportSchema } from "./canvas-import-schema.js";
import { SqliteSpatialLeaseStore } from "./spatial-leases.js";
import { parseArray, parseHistoryEntries, rowToJob, rowToReceipt, translate } from "./canvas-import-rows.js";
import type {
  CanvasImportDiagnosticSummary,
  CanvasImportJobRecord,
  CanvasImportReceipt
} from "../../import/contracts.js";

export { SQLITE_CANVAS_IMPORT_SCHEMA_VERSION } from "./canvas-import-schema.js";

export type CanvasImportReceiptState = "ready" | "deleted";

export type SqliteCanvasImportStoreOptions = {
  path: string;
  now?: () => string;
  /** 测试注入：在事务内写入前返回 true 使提交失败（验证全目标回滚）。 */
  failWrites?: () => boolean;
  /** 测试注入：在每个写入点之后调用（抛出即验证该点的全目标回滚）。 */
  onWritePoint?: (point: string) => void;
};

export type CreateImportJobInput = {
  jobId: string;
  targetCanvasId: string;
  binding: CanvasSourceBinding;
  subject: string;
  totalMedia: number;
};

export type CommitImportInput = {
  jobId: string;
  /** attempt fence；与当前 job 行不一致则拒绝（旧 attempt 不提交）。 */
  fence: number;
  candidateCanvas: ServerCanvas;
  /** 由 Canvas 用当前 Yjs codec 构建的 checkpoint（新 epoch，storageSeq=0）。 */
  checkpoint: Uint8Array;
  roomEpoch: string;
  formatVersion: string;
  access: ImportedCanvasAccess;
  historyJson: string;
  diagnostics: CanvasImportDiagnosticEntry[];
  diagSummary: CanvasImportDiagnosticSummary;
  now: string;
};

export class SqliteCanvasImportStore {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly failWrites: () => boolean;
  private readonly onWritePoint: (point: string) => void;
  private readonly spatialLeases: SqliteSpatialLeaseStore;
  private closed = false;

  constructor(options: SqliteCanvasImportStoreOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.failWrites = options.failWrites ?? (() => false);
    this.onWritePoint = options.onWritePoint ?? (() => undefined);
    try {
      const sqlite = loadNodeSqlite();
      this.db = new sqlite.DatabaseSync(options.path, { readOnly: false, enableForeignKeyConstraints: true });
    } catch (error) {
      throw new CanvasStorageError("NOT_READY", `无法打开导入 SQLite 数据库：${safe(error)}`);
    }
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA foreign_keys = ON");
      migrateImportSchema(this.db, this.now, (run) => this.inTransaction(run));
      assertImportBaseTables(this.db);
      this.spatialLeases = new SqliteSpatialLeaseStore(this.db);
    } catch (error) {
      try { this.db.close(); } catch { /* 忽略 */ }
      if (error instanceof CanvasStorageError) throw error;
      throw new CanvasStorageError("NOT_READY", `导入存储初始化失败：${safe(error)}`);
    }
  }

  private inTransaction<T>(run: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw translate(error);
    }
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* 忽略 */ }
      throw translate(error);
    }
  }

  // ---------------------------------------------------------------- 收据 / 访问

  getReceipt(targetCanvasId: string): CanvasImportReceipt | null {
    const row = this.db
      .prepare("SELECT * FROM canvas_import_receipts WHERE target_canvas_id = ? AND state = 'ready'")
      .get(targetCanvasId) as Record<string, unknown> | undefined;
    return row ? rowToReceipt(row) : null;
  }

  /** 是否存在任意 receipt 行（含 deleted tombstone）；用于目标冲突判定。 */
  hasReceiptRow(targetCanvasId: string): boolean {
    const row = this.db
      .prepare("SELECT target_canvas_id FROM canvas_import_receipts WHERE target_canvas_id = ?")
      .get(targetCanvasId) as { target_canvas_id: string } | undefined;
    return row !== undefined;
  }

  getImportedAccess(canvasId: string): { access: ImportedCanvasAccess; sourceAclVersion: string } | null {
    const row = this.db.prepare("SELECT * FROM canvas_imported_access WHERE canvas_id = ?").get(canvasId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      access: {
        ownerSubject: String(row.owner_subject),
        sharingMode: row.sharing_mode as ImportedCanvasAccess["sharingMode"],
        readSubjects: parseArray(row.read_subjects_json),
        writeSubjects: parseArray(row.write_subjects_json),
        sourceAclVersion: String(row.source_acl_version)
      },
      sourceAclVersion: String(row.source_acl_version)
    };
  }

  /** 全部导入目标的 ACL（任务 5.9 发现集合并集用；数量与导入画布同阶）。 */
  listImportedAccess(): Array<{ canvasId: string; access: ImportedCanvasAccess }> {
    const rows = this.db.prepare("SELECT * FROM canvas_imported_access ORDER BY canvas_id ASC").all() as Record<string, unknown>[];
    return rows.map((row) => ({
      canvasId: String(row.canvas_id),
      access: {
        ownerSubject: String(row.owner_subject),
        sharingMode: row.sharing_mode as ImportedCanvasAccess["sharingMode"],
        readSubjects: parseArray(row.read_subjects_json),
        writeSubjects: parseArray(row.write_subjects_json),
        sourceAclVersion: String(row.source_acl_version)
      }
    }));
  }

  getDiagnostics(canvasId: string): CanvasImportDiagnosticEntry[] {
    const row = this.db.prepare("SELECT entries_json FROM canvas_import_diagnostics WHERE canvas_id = ?").get(canvasId) as
      | { entries_json: string }
      | undefined;
    if (!row) return [];
    try {
      const parsed = JSON.parse(row.entries_json);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  listReceipts(): CanvasImportReceipt[] {
    const rows = this.db
      .prepare("SELECT * FROM canvas_import_receipts WHERE state = 'ready' ORDER BY committed_at DESC, target_canvas_id ASC")
      .all() as Record<string, unknown>[];
    return rows.map(rowToReceipt);
  }

  // ---------------------------------------------------------------- 作业

  /** 同来源同一旧画布的活动（未完成）作业；用于幂等与 fencing。 */
  findActiveJob(sourceId: string, sourceCanvasId: string): CanvasImportJobRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM canvas_import_jobs
         WHERE source_id = ? AND source_canvas_id = ? AND state IN ('pending', 'running')
         ORDER BY attempt DESC LIMIT 1`
      )
      .get(sourceId, sourceCanvasId) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  /** 按旧画布 id 查找任意来源的活动作业（status 用；无需预先知道 sourceId）。 */
  findActiveJobByCanvas(sourceCanvasId: string): CanvasImportJobRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM canvas_import_jobs
         WHERE source_canvas_id = ? AND state IN ('pending', 'running')
         ORDER BY updated_at DESC LIMIT 1`
      )
      .get(sourceCanvasId) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  /** 按旧画布 id 查找最近一次作业（含失败终态）。 */
  latestJobByCanvas(sourceCanvasId: string): CanvasImportJobRecord | null {
    const row = this.db
      .prepare("SELECT * FROM canvas_import_jobs WHERE source_canvas_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(sourceCanvasId) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  /** 目标画布是否已作为导入结果存在（结构化行存在）。 */
  hasCanvas(canvasId: string): boolean {
    const row = this.db.prepare("SELECT id FROM canvases WHERE id = ?").get(canvasId) as { id: string } | undefined;
    return row !== undefined;
  }

  getJob(jobId: string): CanvasImportJobRecord | null {
    const row = this.db.prepare("SELECT * FROM canvas_import_jobs WHERE job_id = ?").get(jobId) as
      | Record<string, unknown>
      | undefined;
    return row ? rowToJob(row) : null;
  }

  /** 创建新 attempt（幂等：同 jobId 已存在则原样返回，不重开 attempt）。 */
  createJob(input: CreateImportJobInput): CanvasImportJobRecord {
    return this.inTransaction(() => {
      const existing = this.getJob(input.jobId);
      if (existing) return existing;
      const timestamp = this.now();
      this.db
        .prepare(
          `INSERT INTO canvas_import_jobs
             (job_id, target_canvas_id, source_id, source_canvas_id, cutover_generation, extension_id,
              config_version, converter_version, source_version, subject, state, phase, attempt, fence,
              completed_media, total_media, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'admitted', 1, 1, 0, ?, ?, ?)`
        )
        .run(
          input.jobId,
          input.targetCanvasId,
          input.binding.sourceId,
          input.binding.sourceCanvasId,
          input.binding.cutoverGeneration,
          input.binding.extensionId,
          input.binding.configVersion,
          input.binding.converterVersion,
          input.binding.sourceVersion,
          input.subject,
          input.totalMedia,
          timestamp,
          timestamp
        );
      return this.getJob(input.jobId)!;
    });
  }

  /** 开始新 attempt：推进 fence（旧 attempt 提交将被拒绝）。 */
  beginAttempt(jobId: string, phase: string): CanvasImportJobRecord {
    return this.inTransaction(() => {
      const current = this.getJob(jobId);
      if (!current) throw new CanvasStorageError("CANVAS_NOT_FOUND", `导入作业 ${jobId} 不存在`);
      this.db
        .prepare(
          "UPDATE canvas_import_jobs SET state = 'running', phase = ?, attempt = attempt + 1, fence = fence + 1, updated_at = ? WHERE job_id = ?"
        )
        .run(phase, this.now(), jobId);
      return this.getJob(jobId)!;
    });
  }

  updateProgress(jobId: string, input: { phase: string; completedMedia: number; totalMedia: number }): void {
    this.inTransaction(() => {
      this.db
        .prepare(
          "UPDATE canvas_import_jobs SET phase = ?, completed_media = ?, total_media = ?, updated_at = ? WHERE job_id = ?"
        )
        .run(input.phase, input.completedMedia, input.totalMedia, this.now(), jobId);
    });
  }

  /** 标记失败（终态，可被后续 attempt 以新 job 取代）。 */
  markFailed(jobId: string, input: { code: string; retryable: boolean; message: string; superseded?: boolean }): void {
    this.inTransaction(() => {
      this.db
        .prepare(
          "UPDATE canvas_import_jobs SET state = ?, phase = 'failed', error_code = ?, error_retryable = ?, error_message = ?, updated_at = ? WHERE job_id = ?"
        )
        .run(input.superseded ? "superseded" : "failed", input.code, input.retryable ? 1 : 0, input.message, this.now(), jobId);
    });
  }

  /**
   * 配置版本/转换器版本变更时，把同来源同画布**其它**活动作业标记为 superseded。
   *
   * 让在途旧绑定作业不能继续提交（draining），新绑定重新开始。
   */
  supersedeOtherActiveJobs(sourceId: string, sourceCanvasId: string, keepJobId: string): number {
    return this.inTransaction(() => {
      const result = this.db
        .prepare(
          `UPDATE canvas_import_jobs SET state = 'superseded', phase = 'superseded', updated_at = ?
           WHERE source_id = ? AND source_canvas_id = ? AND job_id <> ? AND state IN ('pending', 'running')`
        )
        .run(this.now(), sourceId, sourceCanvasId, keepJobId);
      return Number(result.changes ?? 0);
    });
  }

  /** 重启恢复：把所有 running 作业降回 pending（fence 保留，强制新 attempt）。 */
  recoverInterruptedJobs(): number {
    return this.inTransaction(() => {
      const result = this.db
        .prepare("UPDATE canvas_import_jobs SET state = 'pending', phase = 'admitted', updated_at = ? WHERE state = 'running'")
        .run(this.now());
      return Number(result.changes ?? 0);
    });
  }

  // ---------------------------------------------------------------- 原子提交

  /**
   * 整画布原子提交：结构化聚合 + Yjs checkpoint + ACL + 历史 + 收据/job/诊断**同一事务**。
   *
   * 前置：目标 `canvases` 行**不存在**（存在即 `TARGET_CONFLICT`，绝不覆盖）；job 的 fence
   * 与当前行一致（否则 `SOURCE_CHANGED`）。任一失败全回滚，room 不会被发布。
   */
  commitImport(input: CommitImportInput): CanvasImportReceipt {
    return this.inTransaction(() => {
      const job = this.getJob(input.jobId);
      if (!job) throw new CanvasStorageError("CANVAS_NOT_FOUND", `导入作业 ${input.jobId} 不存在`);
      if (job.fence !== input.fence) {
        throw new CanvasStorageError("SOURCE_CHANGED", "导入 attempt 已被更新的 attempt 取代");
      }
      if (job.state === "committed") {
        const receipt = this.getReceipt(job.targetCanvasId);
        if (receipt) return receipt;
      }

      const target = this.db.prepare("SELECT revision FROM canvases WHERE id = ?").get(job.targetCanvasId);
      const existingReceipt = this.db
        .prepare("SELECT target_canvas_id FROM canvas_import_receipts WHERE target_canvas_id = ?")
        .get(job.targetCanvasId);
      if (target || existingReceipt) {
        throw new CanvasStorageError("TARGET_CONFLICT", `目标画布 ${job.targetCanvasId} 已有权威记录，拒绝覆盖`);
      }
      const yjsExisting = this.db
        .prepare("SELECT canvas_id FROM canvas_yjs_documents WHERE canvas_id = ?")
        .get(job.targetCanvasId);
      if (yjsExisting) throw new CanvasStorageError("TARGET_CONFLICT", "目标 Yjs 文档已存在，拒绝覆盖");

      if (this.failWrites()) throw new CanvasStorageError("REPOSITORY_FAILURE", "注入的写失败");

      const canvas = { ...input.candidateCanvas, revision: 1 };
      this.db
        .prepare(
          `INSERT INTO canvases (id, revision, title, canvas_json, created_at, updated_at)
           VALUES (?, 1, ?, ?, ?, ?)`
        )
        .run(canvas.id, canvas.title ?? "", JSON.stringify(canvas), input.now, input.now);
      this.onWritePoint("canvases");

      // 新 epoch、storageSeq=0；不复制旧 update/operation 到当前空间。
      this.db
        .prepare(
          `INSERT INTO canvas_yjs_documents
             (canvas_id, format_version, room_epoch, snapshot, snapshot_seq, revision, projection_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, 1, ?, ?, ?)`
        )
        .run(
          canvas.id,
          input.formatVersion,
          input.roomEpoch,
          new Uint8Array(input.checkpoint),
          JSON.stringify(canvas),
          input.now,
          input.now
        );
      this.onWritePoint("yjs");

      for (const entry of parseHistoryEntries(input.historyJson)) {
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
            JSON.stringify(entry).length
          );
      }
      this.onWritePoint("history");

      this.db
        .prepare(
          `INSERT INTO canvas_imported_access
             (canvas_id, owner_subject, sharing_mode, read_subjects_json, write_subjects_json, source_acl_version, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          canvas.id,
          input.access.ownerSubject,
          input.access.sharingMode,
          JSON.stringify(input.access.readSubjects),
          JSON.stringify(input.access.writeSubjects),
          input.access.sourceAclVersion,
          input.now
        );
      this.onWritePoint("acl");

      this.db
        .prepare("INSERT INTO canvas_import_diagnostics (canvas_id, entries_json) VALUES (?, ?)")
        .run(canvas.id, JSON.stringify(input.diagnostics.slice(0, 2_048)));
      this.onWritePoint("diagnostics");

      this.db
        .prepare(
          `INSERT INTO canvas_import_receipts
             (target_canvas_id, source_id, source_canvas_id, cutover_generation, extension_id, config_version,
              converter_version, source_version, owner_subject, sharing_mode, read_subjects_json,
              write_subjects_json, source_acl_version, ready_media_count, restored_history_count,
              unrecovered_record_count, committed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          canvas.id,
          job.binding.sourceId,
          job.binding.sourceCanvasId,
          job.binding.cutoverGeneration,
          job.binding.extensionId,
          job.binding.configVersion,
          job.binding.converterVersion,
          job.binding.sourceVersion,
          input.access.ownerSubject,
          input.access.sharingMode,
          JSON.stringify(input.access.readSubjects),
          JSON.stringify(input.access.writeSubjects),
          input.access.sourceAclVersion,
          input.diagSummary.readyMediaCount,
          input.diagSummary.restoredHistoryCount,
          input.diagSummary.unrecoveredRecordCount,
          input.now
        );
      this.onWritePoint("receipt");

      this.db
        .prepare(
          "UPDATE canvas_import_jobs SET state = 'committed', phase = 'committed', updated_at = ? WHERE job_id = ?"
        )
        .run(input.now, input.jobId);

      return this.getReceipt(canvas.id)!;
    });
  }

  /** 删除导入目标（含 ACL/诊断/历史/canonical/Yjs），并在**同一事务**写持久 deleted tombstone。 */
  deleteImportedCanvas(canvasId: string): void {
    this.inTransaction(() => {
      this.spatialLeases.validateCanvasUnoccupied(canvasId);
      // 来源绑定**不**被目标级联删除：receipt 保留并标 state=deleted（权威删除记录）。
      this.db.prepare("UPDATE canvas_import_receipts SET state = 'deleted' WHERE target_canvas_id = ?").run(canvasId);
      this.db.prepare("DELETE FROM node_generation_history WHERE canvas_id = ?").run(canvasId);
      this.db.prepare("DELETE FROM canvas_yjs_documents WHERE canvas_id = ?").run(canvasId);
      this.db.prepare("DELETE FROM canvases WHERE id = ?").run(canvasId);
      this.db.prepare("DELETE FROM canvas_imported_access WHERE canvas_id = ?").run(canvasId);
      this.db.prepare("DELETE FROM canvas_import_diagnostics WHERE canvas_id = ?").run(canvasId);
    });
  }

  /** 删除 tombstone 状态（供 prepare/status 判定；不重新读取旧来源）。 */
  getReceiptState(targetCanvasId: string): CanvasImportReceiptState | null {
    const row = this.db
      .prepare("SELECT state FROM canvas_import_receipts WHERE target_canvas_id = ?")
      .get(targetCanvasId) as { state: string } | undefined;
    if (!row) return null;
    return row.state === "deleted" ? "deleted" : "ready";
  }

  debugQuery<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...(params as never[])) as T[];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function safe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\/[^\s'"]+/g, "<path>").slice(0, 300);
}

export type { CanvasSourceBinding };
