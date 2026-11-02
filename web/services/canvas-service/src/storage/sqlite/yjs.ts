/**
 * SQLite Yjs 持久化（任务 3.2 / design D7；
 *  change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R22 —— 抽出迁移、
 *  行 codec 与 writer lock store，本文件保留 repository 事务读写）。
 *
 * 表结构（design D7）：
 * ```
 * canvas_yjs_documents(canvas_id PK, format_version, room_epoch,
 *                      snapshot BLOB, snapshot_seq, revision,
 *                      projection_json, created_at, updated_at)
 * canvas_yjs_updates(canvas_id, seq, update BLOB, sha256, created_at, PK(canvas_id, seq))
 * canvas_yjs_commands(canvas_id, command_id, payload_hash, revision, changed,
 *                     actor_id, created_at, PK(canvas_id, command_id))
 * ```
 *
 * 关键性质：
 * - `commitYjsCommand` 在**单个 `BEGIN IMMEDIATE` 事务**内写 update、sequence、派生 JSON
 *   与 command result（design D6 步骤 3）；任一失败全回滚。
 * - 有独立 schema 版本（`SQLITE_YJS_SCHEMA_VERSION`），与前置 canvas schema 分开演进。
 * - **不含媒体 bytes**：只有 Yjs update 与 JSON projection。
 */
import type { YjsArchiveSnapshot } from "../../sync/archive-publication.js";
import type { DatabaseSync } from "node:sqlite";
import type { ServerCanvas } from "@woohaa3/contracts";
import { computeUpdateSha256 } from "../../sync/yjs-repository.js";
import { writerLockHolderIsStale } from "../../sync/writer-lock.js";
import { type YjsCommandCommit, type YjsCommandRecord, type YjsCommitResult, type YjsDocumentRepository, type YjsLoadedState, type YjsRepositoryHealth } from "../../sync/index.js";
import { CanvasStorageError } from "../core/index.js";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { migrateYjsSchema, safe } from "./yjs-migrations.js";
import { inImmediateTransaction, toBlob, toBytes, decodeCommandRow, type CommandRow, type DocumentRow, type UpdateRow } from "./yjs-row-codec.js";
import { SqliteSpatialLeaseStore } from "./spatial-leases.js";
import { affectedWorldObjects } from "../../world-authoring/affected-objects.js";
import { objectKey, SpatialLeaseError, type LeaseIntent, type SpatialAcquireResult, type SpatialCommitAuthority, type SpatialWriteContext } from "../../world-authoring/spatial-leases.js";

export { SQLITE_YJS_SCHEMA_VERSION } from "./yjs-migrations.js";

export type SqliteYjsRepositoryOptions = {
  path: string;
  readOnly?: boolean;
  busyTimeoutMs?: number;
  now?: () => string;
  /** 注入写失败（测试用），在事务中途抛错以验证全回滚。 */
  failWrites?: () => boolean;
  spatialAuthority?: SpatialCommitAuthority;
};

/**
 * SQLite Yjs 文档仓储。
 *
 * 与 `SqliteCanvasRepository` **共享同一数据库文件**（不同表）：画布聚合与 Yjs 文档
 * 需要同库以便在切换/恢复时保持一致性。构造时独立打开连接并运行自己的迁移。
 */
export class SqliteYjsRepository implements YjsDocumentRepository {
  private readonly db: DatabaseSync;
  private readonly now: () => string;
  private readonly failWrites: () => boolean;
  private readonly spatialLeases: SqliteSpatialLeaseStore;
  private readonly spatialAuthority?: SpatialCommitAuthority;
  private readonly contexts = new WeakMap<SpatialWriteContext, LeaseIntent>();
  private readonly issuedContexts = new Map<string, SpatialWriteContext>();
  private closed = false;

  constructor(options: SqliteYjsRepositoryOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.failWrites = options.failWrites ?? (() => false);
    this.spatialAuthority = options.spatialAuthority;
    try {
      const sqlite = loadNodeSqlite();
      this.db = new sqlite.DatabaseSync(options.path, {
        readOnly: options.readOnly ?? false,
        enableForeignKeyConstraints: true
      });
    } catch (error) {
      throw new CanvasStorageError("NOT_READY", `无法打开 SQLite 数据库：${safe(error)}`);
    }

    try {
      if (!options.readOnly) {
        this.db.exec("PRAGMA journal_mode = WAL");
      }
      this.db.exec("PRAGMA foreign_keys = ON");
      this.db.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs ?? 5_000}`);
      migrateYjsSchema(this.db, () => this.now());
      this.spatialLeases = new SqliteSpatialLeaseStore(this.db, options.spatialAuthority);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // 关闭失败不影响诊断
      }
      if (error instanceof CanvasStorageError) throw error;
      throw new CanvasStorageError("NOT_READY", `SQLite Yjs 初始化失败：${safe(error)}`);
    }
  }

  /**
   * Public acquire port.
   *
   * A retry with the same `requestId` and the same semantic intent (canvas, scope,
   * writable and read-only target sets) always returns the original durable run
   * identity and state, including after the host reopens. A different intent is still
   * rejected. The process-local capability is only returned while this process holds
   * it for an active run; a recovered/retried run after reopen stays reconcile-first
   * and cannot commit until the host has verified execution.
   */
  acquireSpatialRun(intent: LeaseIntent): SpatialAcquireResult {
    if (!this.spatialAuthority) throw new SpatialLeaseError("unavailable");
    const { record, created } = this.spatialLeases.acquireWithStatus(intent);
    const run = {
      canvasId: record.intent.canvasId,
      requestId: record.intent.requestId,
      runId: record.intent.runId,
      epoch: record.intent.epoch,
      executionId: record.intent.executionId,
      state: record.state
    };
    const key = JSON.stringify([record.intent.canvasId, record.intent.requestId]);
    if (!created) {
      const issued = record.state === "active" ? this.issuedContexts.get(key) ?? null : null;
      if (record.state !== "active") this.issuedContexts.delete(key);
      return { run, retry: true, capability: issued };
    }
    if (record.state !== "active") return { run, retry: false, capability: null };
    const context = Object.freeze({});
    this.contexts.set(context, record.intent);
    this.issuedContexts.set(key, context);
    return { run, retry: false, capability: context };
  }

  cancelSpatialRun(canvasId: string, requestId: string): void {
    this.spatialLeases.cancel(canvasId, requestId);
    this.issuedContexts.delete(JSON.stringify([canvasId, requestId]));
  }
  confirmSpatialStopped(canvasId: string, requestId: string, runId: string, epoch: number, executionId: string, evidence: unknown): void {
    this.spatialLeases.confirmStopped(canvasId, requestId, runId, epoch, executionId, evidence);
    this.issuedContexts.delete(JSON.stringify([canvasId, requestId]));
  }
  pendingSpatialRuns() { return this.spatialLeases.listPending(); }

  async loadYjsState(canvasId: string): Promise<YjsLoadedState | null> {
    const document = this.db
      .prepare("SELECT * FROM canvas_yjs_documents WHERE canvas_id = ?")
      .get(canvasId) as DocumentRow | undefined;
    if (!document) return null;

    const updates = this.db
      .prepare("SELECT canvas_id, seq, update_bytes AS update_bytes, sha256, created_at FROM canvas_yjs_updates WHERE canvas_id = ? ORDER BY seq ASC")
      .all(canvasId) as UpdateRow[];

    return {
      canvasId: document.canvas_id,
      formatVersion: document.format_version,
      roomEpoch: document.room_epoch,
      checkpoint: toBytes(document.snapshot),
      checkpointSeq: document.snapshot_seq,
      updates: updates.map((entry) => ({
        seq: entry.seq,
        update: toBytes(entry.update_bytes),
        sha256: entry.sha256
      })),
      storageSeq: updates.length === 0
        ? document.snapshot_seq
        : Math.max(document.snapshot_seq, updates[updates.length - 1].seq),
      projection: document.projection_json ? JSON.parse(document.projection_json) as ServerCanvas : null,
      createdAt: document.created_at,
      updatedAt: document.updated_at
    };
  }

  async commitYjsCommand(commit: YjsCommandCommit): Promise<YjsCommitResult> {
    // 幂等优先：先查既有记录，再校验 sequence。
    const existing = await this.getCommandRecord(commit.canvasId, commit.command.commandId);
    if (existing) {
      if (existing.payloadHash !== commit.command.payloadHash) {
        return { ok: false, code: "command-id-reused", existingHash: existing.payloadHash };
      }
      const current = this.storageSeqOf(commit.canvasId);
      return { ok: true, storageSeq: current, revision: existing.revision, duplicate: true };
    }

    // 真实 SHA-256 在事务**之前**算好：持久化段必须同步（node:sqlite 是同步 API），
    // 而 Web Crypto 是异步的。checksum 用于恢复校验（任务 3.5）。
    const sha256 = await computeUpdateSha256(commit.update);

    if (commit.signal?.aborted) throw new DOMException("Commit cancelled", "AbortError");

    try { return inImmediateTransaction(this.db, () => {
      const duplicate = this.db.prepare("SELECT * FROM canvas_yjs_commands WHERE canvas_id = ? AND command_id = ?").get(commit.canvasId, commit.command.commandId) as CommandRow | undefined;
      if (duplicate) {
        const prior = decodeCommandRow(duplicate);
        if (prior.payloadHash !== commit.command.payloadHash) return { ok: false, code: "command-id-reused", existingHash: prior.payloadHash } satisfies YjsCommitResult;
        return { ok: false, code: "storage-seq-conflict", currentSeq: this.storageSeqOf(commit.canvasId) } satisfies YjsCommitResult;
      }
      const document = this.db
        .prepare("SELECT snapshot_seq, projection_json FROM canvas_yjs_documents WHERE canvas_id = ?")
        .get(commit.canvasId) as { snapshot_seq: number; projection_json: string | null } | undefined;
      if (!document) {
        throw new CanvasStorageError("CANVAS_NOT_FOUND", `Yjs 文档 ${commit.canvasId} 不存在`);
      }
      const currentSeq = this.storageSeqOf(commit.canvasId);
      if (currentSeq !== commit.expectedStorageSeq) {
        return { ok: false, code: "storage-seq-conflict", currentSeq } satisfies YjsCommitResult;
      }

      if (!document.projection_json) throw new CanvasStorageError("REPOSITORY_FAILURE", "缺少权威画布投影");
      const before = JSON.parse(document.projection_json) as ServerCanvas;
      const targets = affectedWorldObjects(before, commit.projection);
      let advance: (() => void) | undefined;
      if (commit.spatialContext !== undefined) {
        const intent = this.contexts.get(commit.spatialContext);
        if (!intent || intent.canvasId !== commit.canvasId || !this.spatialAuthority) throw new SpatialLeaseError("unavailable");
        const resolved = this.spatialAuthority.resolve(intent, before, commit.projection, targets);
        if (!resolved) throw new SpatialLeaseError("outside-scope");
        const keys = targets.map(objectKey).sort();
        if (JSON.stringify(resolved.previous.map(objectKey).sort()) !== JSON.stringify(keys) || JSON.stringify(resolved.next.map(objectKey).sort()) !== JSON.stringify(keys)) throw new SpatialLeaseError("invalid-data");
        const current = this.spatialLeases.lookup(intent.canvasId, intent.requestId);
        if (!current) throw new SpatialLeaseError("stale-epoch");
        const granted = new Set(current.intent.writable.map(objectKey));
        const nextByKey = new Map(resolved.next.map(target => [objectKey(target), target]));
        // A target that did not exist in the source is a new object: its grant is
        // the validated post-state version, and the lock is acquired atomically
        // with this commit. Existing targets keep their source version.
        const additions = resolved.previous
          .filter(target => !granted.has(objectKey(target)))
          .map(target => ({ ...target, version: nextByKey.get(objectKey(target))?.version ?? target.version }));
        if (additions.length) this.spatialLeases.extendForCommit(intent.canvasId, intent.requestId, additions);
        const expected = resolved.previous.map(target => {
          const next = nextByKey.get(objectKey(target));
          return target.version === "absent" && next ? { ...target, version: next.version } : target;
        });
        this.spatialLeases.validateForCommit(intent.canvasId, intent.requestId, intent.runId, intent.epoch, intent.executionId, resolved.scope, expected);
        advance = () => this.spatialLeases.advanceVersionsForCommit(intent.canvasId, intent.requestId, intent.runId, intent.epoch, intent.executionId, resolved.scope, expected, resolved.next);
      } else {
        this.spatialLeases.validateUnoccupied(commit.canvasId, targets);
      }

      if (this.failWrites()) {
        throw new CanvasStorageError("REPOSITORY_FAILURE", "注入的写失败");
      }

      const nextSeq = currentSeq + 1;
      this.db
        .prepare(
          "INSERT INTO canvas_yjs_updates (canvas_id, seq, update_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?)"
        )
        .run(commit.canvasId, nextSeq, toBlob(commit.update), sha256, commit.updatedAt);
      this.db
        .prepare(
          "UPDATE canvas_yjs_documents SET revision = ?, projection_json = ?, updated_at = ? WHERE canvas_id = ?"
        )
        .run(commit.revision, JSON.stringify(commit.projection), commit.updatedAt, commit.canvasId);
      advance?.();
      this.db
        .prepare(
          `INSERT INTO canvas_yjs_commands
             (canvas_id, command_id, payload_hash, revision, changed, actor_id, created_at, script_meta_json, model_batch_json, world_authoring_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          commit.canvasId,
          commit.command.commandId,
          commit.command.payloadHash,
          commit.command.revision,
          commit.command.changed ? 1 : 0,
          commit.command.actorId,
          commit.command.createdAt,
          commit.command.script ? JSON.stringify(commit.command.script) : null,
          commit.command.modelBatch ? JSON.stringify(commit.command.modelBatch) : null,
          commit.command.worldAuthoring ? JSON.stringify(commit.command.worldAuthoring) : null
        );

      return { ok: true, storageSeq: nextSeq, revision: commit.revision, duplicate: false } satisfies YjsCommitResult;
    }); } catch (error) {
      if (error instanceof SpatialLeaseError) {
        if (error.code === "lease-conflict") return { ok: false, code: "lease-conflict", conflict: error.conflict };
        return { ok: false, code: "spatial-rejected", reason: error.code, conflict: error.conflict };
      }
      throw error;
    }
  }

  async getCommandRecord(canvasId: string, commandId: string): Promise<YjsCommandRecord | null> {
    const row = this.db
      .prepare("SELECT * FROM canvas_yjs_commands WHERE canvas_id = ? AND command_id = ?")
      .get(canvasId, commandId) as CommandRow | undefined;
    if (!row) return null;
    return decodeCommandRow(row);
  }

  async findLatestWorldAuthoringCommand(canvasId: string, operationId: string): Promise<YjsCommandRecord | null> {
    const escaped = JSON.stringify(operationId).replace(/[\\%_]/g, character => `\\${character}`);
    const rows = this.db
      .prepare(
        `SELECT * FROM canvas_yjs_commands
         WHERE canvas_id = ? AND world_authoring_json IS NOT NULL
           AND world_authoring_json LIKE ? ESCAPE '\\'
         ORDER BY rowid DESC`
      )
      .all(canvasId, `%"operationId":${escaped}%`) as CommandRow[];
    for (const row of rows) {
      const record = decodeCommandRow(row);
      if (record.worldAuthoring?.operationId === operationId) return record;
    }
    return null;
  }

  async replaceCheckpoint(input: {
    canvasId: string;
    cutoffSeq: number;
    checkpoint: Uint8Array;
    updatedAt: string;
  }): Promise<void> {
    inImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE canvas_yjs_documents SET snapshot = ?, snapshot_seq = ?, updated_at = ? WHERE canvas_id = ?"
        )
        .run(toBlob(input.checkpoint), input.cutoffSeq, input.updatedAt, input.canvasId);
      // 只删被覆盖的 updates；cutoff 之后保留（design D8）。command 记录不删。
      this.db
        .prepare("DELETE FROM canvas_yjs_updates WHERE canvas_id = ? AND seq <= ?")
        .run(input.canvasId, input.cutoffSeq);
    });
  }

  async createYjsDocument(input: {
    canvasId: string;
    formatVersion: string;
    roomEpoch: string;
    checkpoint: Uint8Array;
    projection: ServerCanvas;
    revision: number;
    createdAt: string;
  }): Promise<void> {
    inImmediateTransaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO canvas_yjs_documents
             (canvas_id, format_version, room_epoch, snapshot, snapshot_seq, revision, projection_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
        )
        .run(
          input.canvasId,
          input.formatVersion,
          input.roomEpoch,
          toBlob(input.checkpoint),
          input.revision,
          JSON.stringify(input.projection),
          input.createdAt,
          input.createdAt
        );
    });
  }

  async deleteYjsDocument(canvasId: string): Promise<void> {
    inImmediateTransaction(this.db, () => {
      this.spatialLeases.validateCanvasUnoccupied(canvasId);
      // 外键级联删除 updates 与 commands。
      this.db.prepare("DELETE FROM canvas_yjs_documents WHERE canvas_id = ?").run(canvasId);
    });
  }

  async captureArchiveState(canvasId: string): Promise<YjsArchiveSnapshot | null> {
    const state = await this.loadYjsState(canvasId);
    if (!state) return null;
    const document = this.db.prepare("SELECT revision FROM canvas_yjs_documents WHERE canvas_id = ?").get(canvasId) as { revision: number };
    const rows = this.db.prepare("SELECT * FROM canvas_yjs_commands WHERE canvas_id = ?").all(canvasId) as CommandRow[];
    return { state, revision: document.revision, commands: rows.map(decodeCommandRow) };
  }

  async replaceArchiveState(canvasId: string, snapshot: YjsArchiveSnapshot | null): Promise<void> {
    inImmediateTransaction(this.db, () => {
      this.spatialLeases.validateCanvasUnoccupied(canvasId);
      this.db.prepare("DELETE FROM canvas_yjs_documents WHERE canvas_id = ?").run(canvasId);
      if (!snapshot) return;
      if (this.failWrites()) throw new Error("injected archive write failure");
      const { state, revision, commands } = snapshot;
      this.db.prepare(`INSERT INTO canvas_yjs_documents
        (canvas_id, format_version, room_epoch, snapshot, snapshot_seq, revision, projection_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(canvasId, state.formatVersion, state.roomEpoch,
          toBlob(state.checkpoint), state.checkpointSeq, revision,
          state.projection ? JSON.stringify(state.projection) : null, state.createdAt, state.updatedAt);
      const update = this.db.prepare("INSERT INTO canvas_yjs_updates (canvas_id, seq, update_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const entry of state.updates) update.run(canvasId, entry.seq, toBlob(entry.update), entry.sha256, state.updatedAt);
      const command = this.db.prepare(`INSERT INTO canvas_yjs_commands
        (canvas_id, command_id, payload_hash, revision, changed, actor_id, created_at, script_meta_json, model_batch_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const entry of commands) command.run(canvasId, entry.commandId, entry.payloadHash,
        entry.revision, entry.changed ? 1 : 0, entry.actorId, entry.createdAt,
        entry.script ? JSON.stringify(entry.script) : null, entry.modelBatch ? JSON.stringify(entry.modelBatch) : null);
    });
  }

  async health(): Promise<YjsRepositoryHealth> {
    try {
      this.db.prepare("SELECT COUNT(*) AS total FROM canvas_yjs_documents").get();
      return { ok: true, backend: "sqlite" };
    } catch (error) {
      return { ok: false, backend: "sqlite", reason: safe(error) };
    }
  }

  async tryAcquireWriterLock(instanceId: string, now: string): Promise<boolean> {
    try {
      return inImmediateTransaction(this.db, () => {
        const row = this.db
          .prepare("SELECT holder FROM canvas_writer_lock WHERE id = 1")
          .get() as { holder: string } | undefined;
        if (row && row.holder !== instanceId) {
          // 强杀留下的陈旧锁（同主机进程已不存在）允许接管，避免 readiness 永久 503（缺陷 D3）。
          if (!writerLockHolderIsStale(row.holder)) return false;
          this.db
            .prepare("UPDATE canvas_writer_lock SET holder = ?, since = ? WHERE id = 1")
            .run(instanceId, now);
          return true;
        }
        this.db
          .prepare(
            `INSERT INTO canvas_writer_lock (id, holder, since) VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, since = excluded.since`
          )
          .run(instanceId, now);
        return true;
      });
    } catch {
      return false;
    }
  }

  async currentWriterLock(): Promise<{ instanceId: string; since: string } | null> {
    const row = this.db
      .prepare("SELECT holder, since FROM canvas_writer_lock WHERE id = 1")
      .get() as { holder: string; since: string } | undefined;
    return row ? { instanceId: row.holder, since: row.since } : null;
  }

  async releaseWriterLock(instanceId: string): Promise<void> {
    inImmediateTransaction(this.db, () => {
      this.db.prepare("DELETE FROM canvas_writer_lock WHERE id = 1 AND holder = ?").run(instanceId);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** 测试用：直接查询。 */
  debugQuery<T = unknown>(sql: string): T[] {
    return this.db.prepare(sql).all() as T[];
  }

  private storageSeqOf(canvasId: string): number {
    const row = this.db
      .prepare("SELECT MAX(seq) AS seq FROM canvas_yjs_updates WHERE canvas_id = ?")
      .get(canvasId) as { seq: number | null } | undefined;
    const snapshot = this.db
      .prepare("SELECT snapshot_seq FROM canvas_yjs_documents WHERE canvas_id = ?")
      .get(canvasId) as { snapshot_seq: number } | undefined;
    return Math.max(row?.seq ?? 0, snapshot?.snapshot_seq ?? 0);
  }
}

/**
 * SQLite 部署级 writer lock store（任务 3.7 / 8.4）。
 */
export { createSqliteWriterLockStore } from "./yjs-writer-lock.js";
