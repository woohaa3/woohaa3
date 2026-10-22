/**
 * Durable task store（change: split-web-runtime-services，任务 4.2 / design D3）。
 *
 * 实现 `PptaskTaskStore` 契约（原子 create-if-absent、原子 claimReady、claimToken 围栏、
 * 终态优先 cancel），用 SQLite 持久化。**不得**用 Canvas DB 表充当 Task store。
 *
 * 单进程单 dispatcher（change: replace-worker-db-polling-with-dispatcher，D9）：SQLite
 * profile 只允许一个拥有 dispatcher 的 Task Service 进程。多进程部署必须替换为具备
 * `SELECT ... FOR UPDATE SKIP LOCKED` 语义的后端，这里的接口保持不变。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PptaskTaskRecord,
  PptaskTaskStatus,
  PptaskTaskStore } from "@sdppp/pptask-worker-server";
import { loadNodeSqlite } from "./sqlite-loader.js";

type TaskRow = {
  key: string;
  provider_id: string;
  params_json: string | null;
  context_json: string | null;
  state_json: string | null;
  result_json: string | null;
  owner_id: string | null;
  status: string;
  claim_token: string | null;
  lease_until: number | null;
  next_run_at: number | null;
  attempt: number;
  consecutive_failures: number;
  created_at: number;
  updated_at: number;
};

export type SqliteTaskStoreOptions = {
  path: string;
  now?: () => Date;
};

const TERMINAL: readonly PptaskTaskStatus[] = ["completed", "failed", "cancelled"];

export class SqliteTaskStore implements PptaskTaskStore {
  private readonly db: DatabaseSync;
  private readonly listeners = new Set<(record: PptaskTaskRecord) => void>();

  constructor(options: SqliteTaskStoreOptions) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_records (
        key TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        params_json TEXT,
        context_json TEXT,
        state_json TEXT,
        result_json TEXT,
        owner_id TEXT,
        status TEXT NOT NULL,
        claim_token TEXT,
        lease_until INTEGER,
        next_run_at INTEGER,
        attempt INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_records_due
        ON task_records(status, next_run_at, lease_until);
      -- Scheduling deadline lookups (nextWakeAt) read the earliest future
      -- nextRunAt / lease deadline; these stay compatible with existing rows.
      CREATE INDEX IF NOT EXISTS task_records_retry_deadline
        ON task_records(status, next_run_at);
      CREATE INDEX IF NOT EXISTS task_records_lease_deadline
        ON task_records(status, lease_until);
    `);
  }

  async submit(input: Parameters<PptaskTaskStore["submit"]>[0]) {
    const existing = this.read(input.key);
    if (existing) return { record: existing, created: false };
    const now = input.now.getTime();
    const status: PptaskTaskStatus = input.state !== undefined ? "queued" : "submitting";
    this.db
      .prepare(
        `INSERT INTO task_records
           (key, provider_id, params_json, context_json, state_json, status, attempt, consecutive_failures, created_at, updated_at, owner_id, next_run_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`
      )
      .run(
        input.key,
        input.providerId,
        json(input.params),
        json(input.context),
        json(input.state),
        status,
        now,
        now,
        input.ownerId ?? null,
        now
      );
    const record = this.read(input.key)!;
    this.publish(record);
    return { record, created: true };
  }

  async find(key: string): Promise<PptaskTaskRecord | null> {
    return this.read(key);
  }

  async claimReady(input: { now: Date; leaseUntil: Date }): Promise<PptaskTaskRecord | null> {
    const now = input.now.getTime();
    const row = this.db
      .prepare(
        `SELECT * FROM task_records
          WHERE ((status IN ('submitting','queued') AND (next_run_at IS NULL OR next_run_at <= ?))
                 OR (status = 'executing' AND lease_until IS NOT NULL AND lease_until <= ?))
          ORDER BY COALESCE(next_run_at, created_at) ASC, created_at ASC, key ASC
          LIMIT 1`
      )
      .get(now, now) as TaskRow | undefined;
    if (!row) return null;

    const token = randomUUID();
    // Compare-and-set on the observed (status, claim_token): a concurrent
    // claim — duplicate wake, dispatcher re-entry or lease takeover — loses
    // the race and gets `changes = 0` instead of a second valid claim.
    const result = this.db
      .prepare(
        `UPDATE task_records
            SET status = 'executing', claim_token = ?, lease_until = ?, attempt = attempt + 1, updated_at = ?
          WHERE key = ? AND status = ? AND COALESCE(claim_token, '') = COALESCE(?, '')`
      )
      .run(token, input.leaseUntil.getTime(), now, row.key, row.status, row.claim_token);
    if (result.changes === 0) return null;
    const record = this.read(row.key);
    if (record) this.publish(record);
    return record;
  }

  async claimDue(input: { now: Date; leaseUntil: Date }): Promise<PptaskTaskRecord | null> {
    return this.claimReady(input);
  }

  /**
   * Earliest future deadline a dispatch timer must wake for: the smallest
   * future `next_run_at` among non-terminal tasks, plus the smallest future
   * `lease_until` among executing tasks. Past deadlines are already ready and
   * will be picked up by the current drain, so they are excluded.
   */
  async nextWakeAt(input: { now: Date }): Promise<Date | null> {
    const now = input.now.getTime();
    const row = this.db
      .prepare(
        `SELECT MIN(deadline) AS deadline FROM (
           SELECT next_run_at AS deadline FROM task_records
             WHERE status IN ('submitting','queued') AND next_run_at IS NOT NULL AND next_run_at > ?
           UNION ALL
           SELECT lease_until AS deadline FROM task_records
             WHERE status = 'executing' AND lease_until IS NOT NULL AND lease_until > ?
         )`
      )
      .get(now, now) as { deadline: number | null } | undefined;
    const deadline = row?.deadline ?? null;
    return deadline === null ? null : new Date(deadline);
  }

  async heartbeat(input: { key: string; claimToken: string; leaseUntil: Date; now: Date }): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE task_records
            SET lease_until = ?, updated_at = ?
          WHERE key = ? AND claim_token = ? AND status = 'executing'`
      )
      .run(input.leaseUntil.getTime(), input.now.getTime(), input.key, input.claimToken);
    if (result.changes === 0) return false;
    const record = this.read(input.key);
    if (record) this.publish(record);
    return true;
  }

  async save(record: PptaskTaskRecord): Promise<void> {
    // 围栏：陈旧 claim 的写入被忽略。
    const current = this.read(record.key);
    if (current && (current.claimToken ?? "") !== (record.claimToken ?? "")) return;
    this.db
      .prepare(
        `UPDATE task_records
            SET provider_id = ?, params_json = ?, context_json = ?, state_json = ?, result_json = ?,
                status = ?, claim_token = ?, lease_until = ?, next_run_at = ?, attempt = ?,
                consecutive_failures = ?, updated_at = ?
          WHERE key = ?`
      )
      .run(
        record.providerId,
        json(record.params),
        json(record.context),
        json(record.state),
        json(record.result),
        record.status,
        record.claimToken ?? null,
        record.leaseUntil?.getTime() ?? null,
        record.nextRunAt?.getTime() ?? null,
        record.attempt,
        record.consecutiveFailures,
        record.updatedAt.getTime(),
        record.key
      );
    const saved = this.read(record.key);
    if (saved) this.publish(saved);
  }

  async cancel(key: string, now: Date): Promise<PptaskTaskRecord | null> {
    const current = this.read(key);
    if (!current) return null;
    if (TERMINAL.includes(current.status)) return current;
    this.db
      .prepare(
        `UPDATE task_records
            SET status = 'cancelled', claim_token = ?, lease_until = NULL, next_run_at = NULL, updated_at = ?
          WHERE key = ?`
      )
      .run(randomUUID(), now.getTime(), key);
    const record = this.read(key);
    if (record) this.publish(record);
    return record;
  }

  subscribe(listener: (record: PptaskTaskRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.db.close();
  }

  private read(key: string): PptaskTaskRecord | null {
    const row = this.db.prepare("SELECT * FROM task_records WHERE key = ?").get(key) as TaskRow | undefined;
    return row ? toRecord(row) : null;
  }

  private publish(record: PptaskTaskRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(record));
      } catch {
        // observers must not affect persistence
      }
    }
  }
}

function toRecord(row: TaskRow): PptaskTaskRecord {
  return {
    key: row.key,
    providerId: row.provider_id,
    ...(row.params_json !== null ? { params: parseJson(row.params_json) } : {}),
    ...(row.context_json !== null ? { context: parseJson(row.context_json) } : {}),
    ...(row.state_json !== null ? { state: parseJson(row.state_json) } : {}),
    ...(row.result_json !== null ? { result: parseJson(row.result_json) } : {}),
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    status: row.status as PptaskTaskStatus,
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    ...(row.lease_until !== null ? { leaseUntil: new Date(row.lease_until) } : {}),
    ...(row.next_run_at !== null ? { nextRunAt: new Date(row.next_run_at) } : {}),
    attempt: row.attempt,
    consecutiveFailures: row.consecutive_failures,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  };
}

export function createSqliteTaskStore(options: SqliteTaskStoreOptions): SqliteTaskStore {
  return new SqliteTaskStore(options);
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
