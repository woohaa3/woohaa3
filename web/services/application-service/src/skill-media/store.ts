/**
 * Skill 媒体步骤/尝试/事件 SQLite 仓库
 * （change: 2026-10-28-add-agent-skill-media-regeneration，任务 2.1）。
 *
 * 与 Agent 会话共用应用服务数据库文件，但保持独立表：步骤 ledger 不是 Y.Doc 字段，也不是
 * Task/Canvas 的第二事实源。写操作由 service 用 `atomic` 组合成单个应用层事务。
 */
import type { DatabaseSync } from "node:sqlite";
import { loadNodeSqlite } from "../repository/sqlite-loader.js";
import {
  attemptFromRow,
  skillEventFromRow,
  stepFromRow,
  type SkillMediaAttemptKey,
  type SkillMediaAttemptRecord,
  type SkillMediaAttemptRow,
  type SkillMediaEventRecord,
  type SkillMediaEventRow,
  type SkillMediaStepKey,
  type SkillMediaStepRecord,
  type SkillMediaStepRow
} from "./records.js";

const ATTEMPT_PATCH_COLUMNS = {
  jobId: "job_id",
  state: "state",
  mediaKind: "media_kind",
  error: "error",
  supersededByAttempt: "superseded_by_attempt",
  supersededByRunId: "superseded_by_run_id",
  updatedAt: "updated_at",
  settledAt: "settled_at"
} as const;

const STEP_PATCH_COLUMNS = {
  nodeId: "node_id",
  rootGroupId: "root_group_id",
  scopeEpoch: "scope_epoch",
  currentAttempt: "current_attempt",
  currentRequestId: "current_request_id",
  currentRunId: "current_run_id",
  promptRevision: "prompt_revision",
  latestSuccessfulRunId: "latest_successful_run_id",
  updatedAt: "updated_at"
} as const;

export class SqliteSkillMediaStore {
  private readonly db: DatabaseSync;

  constructor(options: { path: string }) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    // `CREATE TABLE IF NOT EXISTS` 让既有应用数据库（只含会话表）原地升级；步骤表之间由
    // service 事务保证一致性，不用外键（SQLite 连接各自持有，跨表写入顺序由 service 固定）。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skill_media_steps (
        owner TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        root_group_id TEXT,
        scope_epoch INTEGER,
        skill_run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        current_attempt INTEGER NOT NULL,
        current_request_id TEXT,
        current_run_id TEXT,
        prompt_revision INTEGER NOT NULL,
        latest_successful_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner, canvas_id, skill_run_id, step_id)
      );
      CREATE INDEX IF NOT EXISTS skill_media_steps_node ON skill_media_steps(owner, canvas_id, node_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS skill_media_steps_run ON skill_media_steps(canvas_id, current_run_id);

      CREATE TABLE IF NOT EXISTS skill_media_attempts (
        owner TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        skill_run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        run_id TEXT NOT NULL,
        job_id TEXT,
        prompt_revision INTEGER NOT NULL,
        prompt_hash TEXT NOT NULL,
        prompt TEXT NOT NULL,
        model_key TEXT,
        state TEXT NOT NULL,
        media_kind TEXT,
        error TEXT,
        superseded_by_attempt INTEGER,
        superseded_by_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        settled_at TEXT,
        PRIMARY KEY (owner, canvas_id, skill_run_id, step_id, attempt)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS skill_media_attempts_request
        ON skill_media_attempts(owner, request_id);
      CREATE UNIQUE INDEX IF NOT EXISTS skill_media_attempts_run
        ON skill_media_attempts(canvas_id, run_id);

      CREATE TABLE IF NOT EXISTS skill_media_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        canvas_id TEXT NOT NULL,
        skill_run_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS skill_media_events_step
        ON skill_media_events(owner, canvas_id, skill_run_id, step_id, sequence);
    `);
  }

  atomic<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be closed */ }
      throw error;
    }
  }

  getStep(key: SkillMediaStepKey): SkillMediaStepRecord | null {
    const row = this.db.prepare(`SELECT * FROM skill_media_steps
      WHERE owner = ? AND canvas_id = ? AND skill_run_id = ? AND step_id = ?`)
      .get(key.owner, key.canvasId, key.skillRunId, key.stepId) as SkillMediaStepRow | undefined;
    return row ? stepFromRow(row) : null;
  }

  findStepByNode(scope: { owner: string; canvasId: string; nodeId: string }): SkillMediaStepRecord | null {
    const row = this.db.prepare(`SELECT * FROM skill_media_steps
      WHERE owner = ? AND canvas_id = ? AND node_id = ? ORDER BY updated_at DESC LIMIT 1`)
      .get(scope.owner, scope.canvasId, scope.nodeId) as SkillMediaStepRow | undefined;
    return row ? stepFromRow(row) : null;
  }

  /** 画布内最近的步骤（活动面板投影用；有界，不返回全库）。 */
  listStepsByCanvas(scope: { owner: string; canvasId: string; limit?: number }): SkillMediaStepRecord[] {
    const limit = Math.min(200, Math.max(1, scope.limit ?? 50));
    const rows = this.db.prepare(`SELECT * FROM skill_media_steps
      WHERE owner = ? AND canvas_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(scope.owner, scope.canvasId, limit) as SkillMediaStepRow[];
    return rows.map(stepFromRow);
  }

  insertStep(record: SkillMediaStepRecord): void {
    this.db.prepare(`INSERT INTO skill_media_steps
      (owner, canvas_id, root_group_id, scope_epoch, skill_run_id, step_id, node_id,
       current_attempt, current_request_id, current_run_id, prompt_revision, latest_successful_run_id,
       created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.owner, record.canvasId, record.rootGroupId, record.scopeEpoch, record.skillRunId,
        record.stepId, record.nodeId, record.currentAttempt, record.currentRequestId, record.currentRunId,
        record.promptRevision, record.latestSuccessfulRunId, record.createdAt, record.updatedAt);
  }

  updateStep(key: SkillMediaStepKey, patch: Partial<Omit<SkillMediaStepRecord, keyof SkillMediaStepKey>>): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [field, column] of Object.entries(STEP_PATCH_COLUMNS)) {
      const value = patch[field as keyof typeof patch];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE skill_media_steps SET ${sets.join(", ")}
      WHERE owner = ? AND canvas_id = ? AND skill_run_id = ? AND step_id = ?`)
      .run(...values, key.owner, key.canvasId, key.skillRunId, key.stepId);
  }

  insertAttempt(record: SkillMediaAttemptRecord): void {
    this.db.prepare(`INSERT INTO skill_media_attempts
      (owner, canvas_id, skill_run_id, step_id, attempt, request_id, request_hash, run_id, job_id,
       prompt_revision, prompt_hash, prompt, model_key, state, media_kind, error,
       superseded_by_attempt, superseded_by_run_id, created_at, updated_at, settled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.owner, record.canvasId, record.skillRunId, record.stepId, record.attempt,
        record.requestId, record.requestHash, record.runId, record.jobId, record.promptRevision,
        record.promptHash, record.prompt, record.modelKey, record.state, record.mediaKind, record.error,
        record.supersededByAttempt, record.supersededByRunId, record.createdAt, record.updatedAt, record.settledAt);
  }

  updateAttempt(key: SkillMediaAttemptKey, patch: Partial<Omit<SkillMediaAttemptRecord, keyof SkillMediaAttemptKey>>): void {
    const sets: string[] = [];
    const values: Array<string | number | null> = [];
    for (const [field, column] of Object.entries(ATTEMPT_PATCH_COLUMNS)) {
      const value = patch[field as keyof typeof patch];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value as string | number | null);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE skill_media_attempts SET ${sets.join(", ")}
      WHERE owner = ? AND canvas_id = ? AND skill_run_id = ? AND step_id = ? AND attempt = ?`)
      .run(...values, key.owner, key.canvasId, key.skillRunId, key.stepId, key.attempt);
  }

  getAttempt(key: SkillMediaAttemptKey): SkillMediaAttemptRecord | null {
    const row = this.db.prepare(`SELECT * FROM skill_media_attempts
      WHERE owner = ? AND canvas_id = ? AND skill_run_id = ? AND step_id = ? AND attempt = ?`)
      .get(key.owner, key.canvasId, key.skillRunId, key.stepId, key.attempt) as SkillMediaAttemptRow | undefined;
    return row ? attemptFromRow(row) : null;
  }

  /** 请求身份在 owner 内全局唯一：同 requestId 换步骤/提示词同样必须拒绝。 */
  getAttemptByRequest(owner: string, requestId: string): SkillMediaAttemptRecord | null {
    const row = this.db.prepare("SELECT * FROM skill_media_attempts WHERE owner = ? AND request_id = ? LIMIT 1")
      .get(owner, requestId) as SkillMediaAttemptRow | undefined;
    return row ? attemptFromRow(row) : null;
  }

  listAttempts(key: SkillMediaStepKey): SkillMediaAttemptRecord[] {
    const rows = this.db.prepare(`SELECT * FROM skill_media_attempts
      WHERE owner = ? AND canvas_id = ? AND skill_run_id = ? AND step_id = ? ORDER BY attempt ASC`)
      .all(key.owner, key.canvasId, key.skillRunId, key.stepId) as SkillMediaAttemptRow[];
    return rows.map(attemptFromRow);
  }

  /** 受信任 settlement 回调按运行身份定位；canvasId+runId 由 Canvas 权威派生。 */
  findAttemptByRun(canvasId: string, runId: string): SkillMediaAttemptRecord | null {
    const row = this.db.prepare("SELECT * FROM skill_media_attempts WHERE canvas_id = ? AND run_id = ? LIMIT 1")
      .get(canvasId, runId) as SkillMediaAttemptRow | undefined;
    return row ? attemptFromRow(row) : null;
  }

  appendEvent(record: Omit<SkillMediaEventRecord, "sequence">): number {
    const result = this.db.prepare(`INSERT INTO skill_media_events
      (owner, canvas_id, skill_run_id, step_id, attempt, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(record.owner, record.canvasId, record.skillRunId, record.stepId, record.attempt,
        record.type, record.payloadJson, record.createdAt);
    return Number(result.lastInsertRowid);
  }

  listEvents(key: SkillMediaStepKey, after: number, limit: number): SkillMediaEventRecord[] {
    const rows = this.db.prepare(`SELECT * FROM skill_media_events
      WHERE owner = ? AND canvas_id = ? AND skill_run_id = ? AND step_id = ? AND sequence > ?
      ORDER BY sequence ASC LIMIT ?`)
      .all(key.owner, key.canvasId, key.skillRunId, key.stepId, after, limit) as SkillMediaEventRow[];
    return rows.map(skillEventFromRow);
  }

  minEventSequence(key: SkillMediaStepKey): number | null {
    const row = this.db.prepare(`SELECT MIN(sequence) AS sequence FROM skill_media_events
      WHERE owner = ? AND canvas_id = ? AND skill_run_id = ? AND step_id = ?`)
      .get(key.owner, key.canvasId, key.skillRunId, key.stepId) as { sequence: number | null };
    return row.sequence ?? null;
  }

  maxEventSequence(key: SkillMediaStepKey): number {
    const row = this.db.prepare(`SELECT MAX(sequence) AS sequence FROM skill_media_events
      WHERE owner = ? AND canvas_id = ? AND skill_run_id = ? AND step_id = ?`)
      .get(key.owner, key.canvasId, key.skillRunId, key.stepId) as { sequence: number | null };
    return row.sequence ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

export function openSkillMediaStore(path: string): SqliteSkillMediaStore {
  return new SqliteSkillMediaStore({ path });
}
