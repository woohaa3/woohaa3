/**
 * 本机遥测的 SQLite 存储（change: 2026-10-20-add-local-client-telemetry，design D4/D5）。
 *
 * 为什么是单表 SQLite 而不是 JSONL：异常判定要 `GROUP BY name`、要分位数、要按窗口切片、要按
 * `error_code` 去重计数。JSONL 在这些查询上只能全量读进内存，20 万行时变成启动与查询负担，
 * 而且没有索引、没有"形状之外"的约束。设计取舍见 design.md D4。
 *
 * 时间口径：排序、窗口、保留**一律认 `received_at`**（宿主接收时间）；`occurred_at` 来自上报端
 * 时钟，只做展示。上报端时钟不可信这一点与服务端同一判断（proto 的 `received_at` 也是服务端生成）。
 * 查询侧由调用方传入已经裁到保留期内的 `[since, until]`，所以"过期行不可见"不依赖清理是否跑过。
 */
import fs from "node:fs";
import path from "node:path";
import type {
  TelemetryAttributeKey,
  TelemetryBucket,
  TelemetryEvent,
  TelemetryEventName,
  TelemetryEventRecord,
  TelemetryOrigin,
  TelemetryResult,
  TelemetrySurface
} from "@woohaa3/contracts";
import { TELEMETRY_ATTRIBUTE_KEYS, TELEMETRY_PAGE_SIZE_DEFAULT, TELEMETRY_PAGE_SIZE_MAX } from "@woohaa3/contracts";
import { loadNodeSqlite } from "../../repository/sqlite-loader.js";
import {
  selectRangeStats,
  selectSummary,
  type NameWindowStats,
  type RangeStatsQuery,
  type StoredSummary
} from "./aggregate.js";
import { attributeIndexSql, parseAttributes, serializeAttributes } from "./attributes.js";
import { buildWhere, type SqlParam } from "./queries.js";

export type { ErrorCodeStats, NameWindowStats, RangeStatsQuery, StoredSummary } from "./aggregate.js";

/**
 * 本包自管的 schema 版本（`PRAGMA user_version`）。
 *
 * 建表用 `CREATE TABLE IF NOT EXISTS` 的面板式迁移（与 `config-store.ts` /
 * `generation-model-store.ts` 同风格）；版本号只为后续**加列**兜底：将来要加列时在这里按
 * `version` 分支执行 `ALTER TABLE` 并提升此常量，而不是猜字段是否已存在。
 *
 * 2：属性维度的表达式索引（change: 2026-10-25-enhance-telemetry-performance-collection）。
 * 索引 DDL 是 `IF NOT EXISTS` 的幂等语句，所以升级不需要单独的数据迁移步骤；提版本号只是
 * 让「这个库已经是带属性索引的一代」这件事可被观察。
 */
export const TELEMETRY_SCHEMA_VERSION = 2;

const TABLE = "client_telemetry_events";

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at   INTEGER NOT NULL,
    occurred_at   INTEGER NOT NULL DEFAULT 0,
    name          TEXT    NOT NULL,
    result        TEXT    NOT NULL,
    duration_ms   INTEGER,
    error_code    TEXT    NOT NULL DEFAULT '',
    origin        TEXT    NOT NULL,
    surface       TEXT    NOT NULL DEFAULT '',
    trace_id      TEXT    NOT NULL DEFAULT '',
    attributes    TEXT    NOT NULL DEFAULT '{}',
    frontend_version TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_cte_received      ON ${TABLE}(received_at);
  CREATE INDEX IF NOT EXISTS idx_cte_name_received ON ${TABLE}(name, received_at);
  CREATE INDEX IF NOT EXISTS idx_cte_error         ON ${TABLE}(error_code, received_at);
`;

/** 属性表达式索引单独建：键集合来自契约，不能在模板字符串里手抄一份。 */
const ATTRIBUTE_INDEX_SQL: readonly string[] = TELEMETRY_ATTRIBUTE_KEYS.map((key) => attributeIndexSql(TABLE, key));

/** 选列顺序固定，读回时按位置不按名字也可以，但仍用列名以贴合显式字段。 */
const SELECT_COLUMNS = "id, received_at, occurred_at, name, result, duration_ms, error_code, origin, surface, trace_id, attributes, frontend_version";

type EventRow = {
  id: number;
  received_at: number;
  occurred_at: number;
  name: string;
  result: string;
  duration_ms: number | null;
  error_code: string;
  origin: string;
  surface: string;
  trace_id: string;
  attributes: string;
  frontend_version: string;
};

export type StoredEventQuery = {
  readonly since: number;
  readonly until: number;
  readonly names?: readonly TelemetryEventName[];
  readonly results?: readonly TelemetryResult[];
  readonly errorCode?: string;
  /** 单键属性精确匹配；与 `attributeValue` 成对（契约层已保证，存储层再拒一次）。 */
  readonly attributeKey?: TelemetryAttributeKey;
  readonly attributeValue?: string;
  readonly cursor?: string;
  readonly limit?: number;
};

export type StoredEventPage = {
  readonly events: readonly TelemetryEventRecord[];
  readonly nextCursor?: string;
};

export class SqliteTelemetryStore {
  readonly path: string;
  private readonly db: import("node:sqlite").DatabaseSync;
  private closed = false;

  constructor(options: { path: string }) {
    this.path = path.resolve(options.path);
    // 目录不存在时先创建：宿主只传文件绝对路径，不负责建目录（照 `openInstanceDataScope`）。
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    const { DatabaseSync } = loadNodeSqlite();
    this.db = new DatabaseSync(this.path);
    try {
      // 三行 PRAGMA 与 `config-store.ts:112-114` 一致：WAL 让读写不互相阻塞，NORMAL 在
      // WAL 下仍然崩溃安全（代价是掉电可能丢最后一个事务，对遥测可接受），busy_timeout 兜住
      // 宿主另一个连接（例如未来的页面导库工具）持锁的场景。
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = NORMAL;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.migrate();
    } catch (error) {
      // 打开失败要关掉半开连接，但不能删文件：用户的库可能有价值，重建由用户决定（design D11）。
      try {
        this.db.close();
      } catch {
        // 关闭失败不掩盖真正的打开失败原因。
      }
      throw error;
    }
    this.restrictPermissions();
  }

  /**
   * 文件权限 0600。
   *
   * 现有几个 SQLite 库创建时都没有显式设权限、实际按 umask（常见 0644），这是既有缺口；本文件
   * 含使用痕迹，照 `instance-data-scope.ts` 备份文件的先例显式收窄。`-wal` / `-shm` 同样含数据，
   * 但它们由 SQLite 在运行期创建/删除，只能尽力而为；Windows 上没有 unix 权限位，失败也应继续。
   */
  private restrictPermissions(): void {
    for (const file of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // 见上：WAL/SHM 可能不存在，平台也可能不支持权限位。
      }
    }
  }

  private migrate(): void {
    const row = this.get<{ user_version: number }>("PRAGMA user_version");
    const version = Number(row?.user_version ?? 0);
    if (!Number.isInteger(version) || version < 0) {
      throw new Error("遥测库的 schema 版本号损坏");
    }
    if (version > TELEMETRY_SCHEMA_VERSION) {
      // 高版本库可能有不认识的列或不同的语义；写进去等于破坏用户数据，宁可整体不可用。
      throw new Error(`遥测库版本 ${version} 高于本程序支持的 ${TELEMETRY_SCHEMA_VERSION}，拒绝写入以免破坏数据`);
    }
    this.db.exec(SCHEMA_SQL);
    // 属性索引是幂等 DDL，每次打开都执行一次：旧库（schema 1）升级到这里就补齐了，
    // 不需要单独的数据迁移步骤。
    for (const sql of ATTRIBUTE_INDEX_SQL) this.db.exec(sql);
    if (version < TELEMETRY_SCHEMA_VERSION) {
      this.db.exec(`PRAGMA user_version = ${TELEMETRY_SCHEMA_VERSION}`);
    }
  }

  /** 单事务批量插入；失败整批回滚后重抛（调用方负责记 `writeErrors`）。 */
  insertBatch(events: readonly TelemetryEvent[], receivedAt: number): void {
    if (events.length === 0) return;
    const insert = this.db.prepare(
      `INSERT INTO ${TABLE} (received_at, occurred_at, name, result, duration_ms, error_code, origin, surface, trace_id, attributes, frontend_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of events) {
        insert.run(
          receivedAt,
          event.occurredAt,
          event.name,
          event.result,
          event.durationMs ?? null,
          event.errorCode ?? "",
          event.origin,
          event.surface ?? "",
          event.traceId ?? "",
          serializeAttributes(event.attributes),
          event.frontendVersion ?? ""
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 回滚失败（例如连接已坏）不掩盖原始写入错误。
      }
      throw error;
    }
  }

  /**
   * 事件列表：最新在前、`id` 降序游标分页。
   *
   * 为什么要用 `id` 而不是 `received_at` 做游标：`id` 单调且唯一，翻页期间新写入的行一定排在
   * 前面，不会把已看过的行推到下一页（design D5 的"游标即上一页最后一条的 id"）。
   */
  listEvents(query: StoredEventQuery): StoredEventPage {
    const where = buildWhere(query);
    const conditions = [...where.conditions];
    const params: SqlParam[] = [...where.params];
    const cursorId = decodeCursor(query.cursor);
    if (cursorId !== undefined) {
      conditions.push("id < ?");
      params.push(cursorId);
    }
    const limit = clampLimit(query.limit);
    const rows = this.all<EventRow>(
      `SELECT ${SELECT_COLUMNS} FROM ${TABLE}
       WHERE ${conditions.join(" AND ")}
       ORDER BY id DESC
       LIMIT ?`,
      ...params,
      limit + 1
    );
    const pageRows = rows.slice(0, limit);
    // 多取一条只为判断"还有没有下一页"；游标不携带筛选条件，筛选条件由下一次请求重新给出。
    const nextCursor = rows.length > limit && pageRows.length > 0 ? String(Number(pageRows[pageRows.length - 1]!.id)) : undefined;
    return {
      events: pageRows.map(toEventRecord),
      ...(nextCursor === undefined ? {} : { nextCursor })
    };
  }

  /** 窗口聚合：每行一个事件名，或「事件名 × 属性值」组（口径见 `aggregate.ts`）。 */
  summary(input: {
    since: number;
    until: number;
    bucket: TelemetryBucket;
    groupBy?: TelemetryAttributeKey;
  }): StoredSummary {
    return selectSummary(this, TABLE, input);
  }

  /** 一段时间范围内每个事件名（或分组）的聚合，供异常规则使用。 */
  rangeStats(query: RangeStatsQuery): readonly NameWindowStats[] {
    return selectRangeStats(this, TABLE, query);
  }

  /** 某错误码在 `[since, before)` 是否出现过；`new-error-code` 判定"从未出现"用。 */
  hasErrorCodeBefore(code: string, input: { since: number; before: number }): boolean {
    const row = this.get<{ found: number }>(
      `SELECT 1 AS found FROM ${TABLE}
       WHERE error_code = ? AND received_at >= ? AND received_at < ?
       LIMIT 1`,
      code,
      input.since,
      input.before
    );
    return row !== undefined;
  }

  /** 未过期事件数；`since` 由调用方按保留期算好。 */
  count(since: number): number {
    const row = this.get<{ total: number }>(`SELECT COUNT(*) AS total FROM ${TABLE} WHERE received_at >= ?`, since);
    return Number(row?.total ?? 0);
  }

  /** 数据库占用字节数；WAL 未 checkpoint 时主文件不含最新写入，所以一起算。 */
  sizeBytes(): number {
    let total = 0;
    for (const file of [this.path, `${this.path}-wal`]) {
      try {
        total += fs.statSync(file).size;
      } catch {
        // 文件可能刚被 checkpoint 删除。
      }
    }
    return total;
  }

  /**
   * 保留清理：先按时间、再按行数，两条上限同时生效。
   *
   * 由小时级 sweep 与启动时一次调用，而不是每次写入顺带清理——本机 flusher 是 250ms 级的，
   * 每次写入都 `COUNT(*)` 与本机低负载不符（design D4）。查询侧永远排除过期行，所以 sweep 的
   * 延迟只影响磁盘回收的及时性，不影响正确性。
   */
  prune(input: { cutoff: number; maxRows: number }): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let removed = Number(this.db.prepare(`DELETE FROM ${TABLE} WHERE received_at < ?`).run(input.cutoff).changes);
      const maxRows = Math.max(1, Math.floor(input.maxRows));
      // 保留最新的 maxRows 行：先找第 maxRows 新的 id，再删比它更旧的行。比 `NOT IN (子查询)`
      // 在 20 万行上更省，也不会因为空表产生意外语义。
      const threshold = this.get<{ id: number }>(
        `SELECT id FROM ${TABLE} ORDER BY id DESC LIMIT 1 OFFSET ?`,
        maxRows - 1
      );
      if (threshold !== undefined) {
        removed += Number(this.db.prepare(`DELETE FROM ${TABLE} WHERE id < ?`).run(Number(threshold.id)).changes);
      }
      this.db.exec("COMMIT");
      return removed;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 见上：不掩盖原始错误。
      }
      throw error;
    }
  }

  /** 清空全部记录；返回删除条数（`clear()` 路由的响应体）。 */
  clear(): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const removed = Number(this.db.prepare(`DELETE FROM ${TABLE}`).run().changes);
      this.db.exec("COMMIT");
      return removed;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 见上。
      }
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** 只读查询入口：`aggregate.ts` 通过这个窄接口拿数据，拿不到连接也就无从写库。 */
  all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TELEMETRY_PAGE_SIZE_DEFAULT;
  return Math.min(Math.max(Math.floor(limit), 1), TELEMETRY_PAGE_SIZE_MAX);
}

/**
 * 游标是上一页最后一条的 `id`（十进制串）。解析失败只可能来自手改 URL 或过期游标，降级为第一页
 * 比让整页 500 更有用；长度上限已由 `parseTelemetryEventFilter` 在 HTTP 入口校验。
 */
function decodeCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined || !/^[0-9]{1,18}$/.test(cursor)) return undefined;
  const id = Number(cursor);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function toEventRecord(row: EventRow): TelemetryEventRecord {
  const attributes = parseAttributes(row.attributes);
  const surface = typeof row.surface === "string" ? row.surface : "";
  const durationMs = row.duration_ms === null || row.duration_ms === undefined ? undefined : Number(row.duration_ms);
  return {
    id: Number(row.id),
    receivedAt: Number(row.received_at),
    name: row.name as TelemetryEventName,
    result: row.result as TelemetryResult,
    origin: row.origin as TelemetryOrigin,
    occurredAt: Number(row.occurred_at),
    ...(surface === "" ? {} : { surface: surface as TelemetrySurface }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(row.error_code === "" ? {} : { errorCode: row.error_code }),
    ...(row.trace_id === "" ? {} : { traceId: row.trace_id }),
    ...(row.frontend_version === "" ? {} : { frontendVersion: row.frontend_version }),
    ...(attributes === undefined ? {} : { attributes })
  };
}
