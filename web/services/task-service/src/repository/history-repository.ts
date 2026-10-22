/**
 * Durable execution history read model公共入口
 * （change: split-web-runtime-services，任务 4.2 / 4.7 / 4.9；
 *   change: 2026-10-06-improve-task-history-experience，任务 1.1–1.3、2.1–2.3；
 *   change: 2026-10-09-refactor-large-source-files-and-remove-compatibility R04 —— 拆分为
 *   类型、行映射、脱敏、cursor、迁移与查询子模块，本文件保留 repository owner）。
 *
 * 全局历史页与 Canvas 补偿的**唯一事实源**。repository 独占 db connection、transaction、
 * cursor 与 prune floor；抽出的 SQL 操作接受同一连接/transaction context，禁止方法之间自动
 * 开始新事务。
 *
 * 安全：写入时即做白名单裁剪，绝不落 prompt、provider 原始 input/output、bytes、签名 URL、
 * Authorization、堆栈或凭据。
 */
import type { DatabaseSync } from "node:sqlite";
import {
  isTerminalTaskState,
  type CanvasTaskActivity,
  type CanvasTaskActivityQuery,
  type CanvasTaskActivitySnapshot,
  type TaskExecutionDetail,
  type TaskExecutionState,
  type TaskExecutionSummary,
  type TaskHistoryCandidateQuery,
  type TaskHistoryCandidates,
  type TaskHistoryIncrementalBatch,
  type TaskHistoryQuery
} from "@woohaa3/contracts";
import { loadNodeSqlite } from "./sqlite-loader.js";
import { migrate } from "./history/migrations.js";
import {
  sanitizeDetail,
  sanitizeError,
  sanitizeRequest,
  sanitizeResult
} from "./history/sanitization.js";
import {
  canvasHasActivity,
  countHistoryStates,
  eventRowsToEvents,
  getHistoryDetail,
  listCanvasActivity,
  listCanvasActivitySince,
  listHistory,
  listHistoryCandidates,
  listHistorySince,
  listUnsettled,
  listUnsettledBefore,
  type HistoryListResult,
  type HistoryQueryContext
} from "./history/queries.js";
import { toSummary } from "./history/row-mapping.js";
import type {
  EventRow,
  HistoryEventInput,
  HistoryRecordInput,
  RecordRow,
  TaskHistoryRepositoryOptions
} from "./history/types.js";

export type {
  HistoryRecordInput,
  HistoryEventInput,
  TaskHistoryRepositoryOptions
} from "./history/types.js";
export type { HistoryListResult } from "./history/queries.js";
export {
  sanitizeResult,
  sanitizeError,
  sanitizeRequest,
  sanitizeDetail,
  TASK_REQUEST_PROMPT_LIMIT,
  TASK_REQUEST_PARAMETER_BUDGET
} from "./history/sanitization.js";
export { encodeCursor, decodeCursor } from "./history/cursor.js";

export class SqliteTaskHistoryRepository {
  private readonly db: DatabaseSync;
  private readonly maxEventsPerRecord: number;
  private readonly listeners = new Set<(record: TaskExecutionSummary, cursor: number) => void>();

  constructor(options: TaskHistoryRepositoryOptions) {
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(options.path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.maxEventsPerRecord = options.maxEventsPerRecord ?? 200;
    migrate(this.db);
  }

  /** repository owner 持有的受控查询上下文（同一 db/transaction）。 */
  private get queryContext(): HistoryQueryContext {
    return {
      db: this.db,
      maxEventsPerRecord: this.maxEventsPerRecord,
      currentCursor: () => this.currentCursor(),
      prunedFloor: () => this.prunedFloor(),
      row: (taskKey) => this.row(taskKey),
      events: (taskKey) => this.events(taskKey)
    };
  }

  /**
   * Upsert 一条执行记录并推进 history cursor，返回可恢复的 cursor。
   */
  upsertRecord(input: HistoryRecordInput): number {
    const existing = this.row(input.taskKey);
    const terminalIdentity =
      input.terminalIdentity ??
      existing?.terminal_identity ??
      (isTerminalTaskState(input.state) ? `${input.state}:${input.finishedAt ?? input.updatedAt}` : null);
    const cursor = this.nextCursor();
    this.db
      .prepare(
        `INSERT INTO task_execution_records
           (task_key, state, provider_id, provider_name, model_type, model_key, model_title,
            canvas_id, canvas_title, node_id, node_title, run_id, job_id, upstream_task_id,
            progress, attempt, result_json, error_json, request_json, request_truncated, full_text,
            source, extension_id, catalog_revision, schema_revision, config_version, extension_config_version,
            created_at, started_at, updated_at, finished_at,
            duration_ms, terminal_identity, cursor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_key) DO UPDATE SET
           state = excluded.state,
           progress = excluded.progress,
           attempt = excluded.attempt,
           result_json = excluded.result_json,
           error_json = excluded.error_json,
           request_json = COALESCE(excluded.request_json, task_execution_records.request_json),
           request_truncated = COALESCE(excluded.request_truncated, task_execution_records.request_truncated),
           full_text = COALESCE(excluded.full_text, task_execution_records.full_text),
           provider_name = COALESCE(task_execution_records.provider_name, excluded.provider_name),
           model_type = COALESCE(excluded.model_type, task_execution_records.model_type),
           model_title = COALESCE(task_execution_records.model_title, excluded.model_title),
           canvas_id = COALESCE(excluded.canvas_id, task_execution_records.canvas_id),
           canvas_title = COALESCE(task_execution_records.canvas_title, excluded.canvas_title),
           node_id = COALESCE(excluded.node_id, task_execution_records.node_id),
           node_title = COALESCE(task_execution_records.node_title, excluded.node_title),
           upstream_task_id = COALESCE(excluded.upstream_task_id, task_execution_records.upstream_task_id),
           source = COALESCE(task_execution_records.source, excluded.source),
           extension_id = COALESCE(task_execution_records.extension_id, excluded.extension_id),
           catalog_revision = COALESCE(task_execution_records.catalog_revision, excluded.catalog_revision),
           schema_revision = COALESCE(task_execution_records.schema_revision, excluded.schema_revision),
           config_version = COALESCE(task_execution_records.config_version, excluded.config_version),
           extension_config_version = COALESCE(task_execution_records.extension_config_version, excluded.extension_config_version),
           updated_at = excluded.updated_at,
           started_at = COALESCE(excluded.started_at, task_execution_records.started_at),
           finished_at = COALESCE(excluded.finished_at, task_execution_records.finished_at),
           duration_ms = excluded.duration_ms,
           terminal_identity = COALESCE(task_execution_records.terminal_identity, excluded.terminal_identity),
           cursor = excluded.cursor`
      )
      .run(
        input.taskKey,
        input.state,
        input.providerId,
        input.providerName ?? null,
        input.modelType ?? null,
        input.modelKey ?? null,
        input.modelTitle ?? null,
        input.canvasId ?? null,
        input.canvasTitle ?? null,
        input.nodeId ?? null,
        input.nodeTitle ?? null,
        input.runId ?? null,
        input.jobId ?? null,
        input.upstreamTaskId ?? null,
        input.progress ?? null,
        input.attempt ?? null,
        input.result ? JSON.stringify(sanitizeResult(input.result)) : null,
        input.error ? JSON.stringify(sanitizeError(input.error)) : null,
        input.request ? JSON.stringify(sanitizeRequest(input.request)) : null,
        input.requestTruncated === undefined ? null : input.requestTruncated ? 1 : 0,
        input.resultFullText !== undefined
          ? input.resultFullText
          : input.result?.mediaKind === "text" && input.result.text !== undefined
            ? input.result.text
            : null,
        input.source ?? null,
        input.extensionId ?? null,
        input.admission?.catalogRevision ?? null,
        input.admission?.schemaRevision ?? null,
        input.admission?.configVersion ?? null,
        input.admission?.extensionConfigVersion ?? null,
        input.createdAt,
        input.startedAt ?? null,
        input.updatedAt,
        input.finishedAt ?? null,
        input.durationMs,
        terminalIdentity,
        cursor
      );
    this.notify(input.taskKey, cursor);
    return cursor;
  }

  /** 追加一条有界事件；超过上限时裁剪最旧事件（保留最新时间线）。 */
  appendEvent(input: HistoryEventInput): number {
    const nextSequence =
      ((
        this.db
          .prepare("SELECT COALESCE(MAX(sequence), -1) AS max_seq FROM task_execution_events WHERE task_key = ?")
          .get(input.taskKey) as { max_seq: number }
      ).max_seq ?? -1) + 1;
    const detail = sanitizeDetail(input.detail);
    this.db
      .prepare(
        `INSERT INTO task_execution_events (task_key, sequence, kind, stage, detail_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(input.taskKey, nextSequence, input.kind, input.stage, detail ? JSON.stringify(detail) : null, input.occurredAt);
    this.db
      .prepare(
        `DELETE FROM task_execution_events
          WHERE task_key = ? AND sequence <= (
            SELECT COALESCE(MAX(sequence), -1) FROM task_execution_events WHERE task_key = ?
          ) - ?`
      )
      .run(input.taskKey, input.taskKey, this.maxEventsPerRecord);
    const cursor = this.nextCursor();
    this.db
      .prepare("UPDATE task_execution_records SET cursor = ?, last_event_sequence = ? WHERE task_key = ?")
      .run(cursor, nextSequence, input.taskKey);
    this.notify(input.taskKey, cursor);
    return cursor;
  }

  /**
   * 最近一条已持久化事件的时刻（ISO）与该时刻已有的条数。
   *
   * 投影每次只拿得到累计快照，靠它增量追加新事件而不是重写整条时间线：
   * 用时刻定位，避免事件超上限被裁剪后索引错位；用同刻条数兜住同一毫秒内的连续状态变化。
   */
  /** 最新一条已落库事件的阶段与时刻（进度事件限流用）。 */
  lastEvent(taskKey: string): { stage: string; occurredAt: string } | undefined {
    const row = this.db
      .prepare("SELECT stage, occurred_at FROM task_execution_events WHERE task_key = ? ORDER BY sequence DESC LIMIT 1")
      .get(taskKey) as { stage: string; occurred_at: string } | undefined;
    return row ? { stage: row.stage, occurredAt: row.occurred_at } : undefined;
  }

  lastEventTail(taskKey: string): { occurredAt: string; count: number } | undefined {
    const row = this.db
      .prepare(
        `SELECT occurred_at AS occurred_at, COUNT(*) AS count
           FROM task_execution_events WHERE task_key = ?
          GROUP BY occurred_at ORDER BY occurred_at DESC LIMIT 1`
      )
      .get(taskKey) as { occurred_at: string; count: number } | undefined;
    return row ? { occurredAt: row.occurred_at, count: row.count } : undefined;
  }

  /**
   * 读取单条详情。
   */
  get(taskKey: string, options: { includeRequest?: boolean; fullText?: boolean } = {}): TaskExecutionDetail | undefined {
    return getHistoryDetail(this.queryContext, taskKey, options);
  }

  /**
   * 稳定分页：`(createdAt DESC, taskKey DESC)`，cursor 编码排序位置与**规范化查询指纹**。
   */
  list(query: TaskHistoryQuery): HistoryListResult {
    return listHistory(this.queryContext, query);
  }

  /**
   * 自 cursor 起读取变更记录的快照（history 补偿与事件流共用，可重复读取）。
   */
  listSince(cursor: number, limit = 200): TaskHistoryIncrementalBatch {
    return listHistorySince(this.queryContext, cursor, limit);
  }

  /** 全局状态计数（change: 2026-10-13-...，任务 7.4；恢复自迁移前的 `history-repository.ts`）。 */
  countStates(): Record<import("@woohaa3/contracts").TaskExecutionState, number> {
    return countHistoryStates(this.queryContext);
  }

  currentCursor(): number {
    return (
      (this.db.prepare("SELECT sequence FROM task_history_cursor WHERE id = 1").get() as { sequence: number }).sequence
    );
  }

  private prunedFloor(): number {
    const row = this.db.prepare("SELECT pruned_floor FROM task_history_cursor WHERE id = 1").get() as
      | { pruned_floor: number }
      | undefined;
    return row?.pruned_floor ?? 0;
  }

  /**
   * 有界筛选候选：保留期内出现过的 Provider 与模型（含已下线模型）。
   */
  candidates(query: TaskHistoryCandidateQuery = {}): TaskHistoryCandidates {
    return listHistoryCandidates(this.queryContext, query);
  }

  /**
   * Canvas-scoped 活动快照
   * （change: 2026-09-29-add-canvas-task-activity-feed，任务 1.2 / 1.3 / design D3）。
   */
  listCanvasActivity(canvasId: string, query: CanvasTaskActivityQuery = {}): CanvasTaskActivitySnapshot {
    return listCanvasActivity(this.queryContext, canvasId, query);
  }

  /**
   * 自 cursor 起的画布活动变更（可恢复事件流与断线补偿共用，可重复读取）。
   */
  listCanvasActivitySince(canvasId: string, cursor: number, limit = 200): { items: CanvasTaskActivity[]; cursor: number } {
    return listCanvasActivitySince(this.queryContext, canvasId, cursor, limit);
  }

  /** 画布是否有任何活动/最近记录（用于 ACL 前置判定后的空快照短路，不泄露计数）。 */
  canvasHasActivity(canvasId: string): boolean {
    return canvasHasActivity(this.queryContext, canvasId);
  }

  subscribe(listener: (record: TaskExecutionSummary, cursor: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 列出处于非终态、且处于 `before` 之前的**候选**记录。
   */
  listUnsettledBefore(before: string): TaskExecutionSummary[] {
    return listUnsettledBefore(this.queryContext, before);
  }

  /**
   * 列出全部非终态记录（重启后终态对账的候选集）。
   */
  listUnsettled(limit?: number): TaskExecutionSummary[] {
    return listUnsettled(this.queryContext, limit);
  }

  /** 记录当前状态（对账写入前的并发检查用，不构造详情）。 */
  stateOf(taskKey: string): TaskExecutionState | undefined {
    return this.row(taskKey)?.state as import("@woohaa3/contracts").TaskExecutionState | undefined;
  }

  /**
   * 把一个「从未真正调度」的孤儿记录落成 failed 终态，并推进 cursor。
   */
  settleOrphanFailure(taskKey: string, input: { message: string; updatedAt: string }): boolean {
    const current = this.row(taskKey);
    if (!current) return false;
    if (current.state !== "queued" && current.state !== "pending" && current.state !== "running") return false;
    const cursor = this.nextCursor();
    this.db
      .prepare(
        `UPDATE task_execution_records
            SET state = 'failed', error_json = ?, finished_at = ?, updated_at = ?,
                terminal_identity = ?, cursor = ?, duration_ms = 0
          WHERE task_key = ? AND state IN ('queued','pending','running')`
      )
      .run(
        JSON.stringify(sanitizeError({ name: "OrphanedSubmission", message: input.message })),
        input.updatedAt,
        input.updatedAt,
        `failed:${input.updatedAt}`,
        cursor,
        taskKey
      );
    this.notify(taskKey, cursor);
    return true;
  }

  /** 删除超过保留期的终态记录；不触碰调度 store、Canvas 或 COS 对象。 */
  pruneTerminalBefore(isoCutoff: string): number {
    const before = this.currentCursor();
    const result = this.db
      .prepare(
        `DELETE FROM task_execution_records
          WHERE state IN ('succeeded','failed','cancelled') AND created_at < ?`
      )
      .run(isoCutoff);
    if (Number(result.changes) > 0) this.raisePrunedFloor(before);
    return Number(result.changes);
  }

  /** 超过最大记录数时删除最旧的终态记录。 */
  enforceMaxRecords(maxRecords: number): number {
    const total = (this.db.prepare("SELECT COUNT(*) AS n FROM task_execution_records").get() as { n: number }).n;
    const excess = total - maxRecords;
    if (excess <= 0) return 0;
    const before = this.currentCursor();
    const result = this.db
      .prepare(
        `DELETE FROM task_execution_records
          WHERE state IN ('succeeded','failed','cancelled')
            AND task_key IN (
              SELECT task_key FROM task_execution_records
               WHERE state IN ('succeeded','failed','cancelled')
               ORDER BY created_at ASC, task_key ASC
               LIMIT ?
            )`
      )
      .run(excess);
    if (Number(result.changes) > 0) this.raisePrunedFloor(before);
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }

  private raisePrunedFloor(floor: number): void {
    this.db.prepare("UPDATE task_history_cursor SET pruned_floor = MAX(pruned_floor, ?) WHERE id = 1").run(floor);
  }

  private row(taskKey: string): RecordRow | undefined {
    return this.db.prepare("SELECT * FROM task_execution_records WHERE task_key = ?").get(taskKey) as RecordRow | undefined;
  }

  private events(taskKey: string): import("@woohaa3/contracts").TaskExecutionEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM task_execution_events WHERE task_key = ? ORDER BY sequence ASC")
      .all(taskKey) as EventRow[];
    return eventRowsToEvents(rows);
  }

  private nextCursor(): number {
    this.db.prepare("UPDATE task_history_cursor SET sequence = sequence + 1 WHERE id = 1").run();
    return this.currentCursor();
  }

  private notify(taskKey: string, cursor: number): void {
    const row = this.row(taskKey);
    if (!row) return;
    const summary = toSummary(row);
    for (const listener of this.listeners) {
      try {
        listener(summary, cursor);
      } catch {
        // observers must not affect persistence
      }
    }
  }
}

export function createSqliteTaskHistoryRepository(options: TaskHistoryRepositoryOptions): SqliteTaskHistoryRepository {
  return new SqliteTaskHistoryRepository(options);
}
