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
  TelemetryBucket,
  TelemetryEvent,
  TelemetryEventName,
  TelemetryEventRecord,
  TelemetryOrigin,
  TelemetryResult,
  TelemetrySeriesPoint,
  TelemetrySummaryRow,
  TelemetrySurface
} from "@woohaa3/contracts";
import { TELEMETRY_PAGE_SIZE_DEFAULT, TELEMETRY_PAGE_SIZE_MAX } from "@woohaa3/contracts";
import { loadNodeSqlite } from "../../repository/sqlite-loader.js";

/**
 * 本包自管的 schema 版本（`PRAGMA user_version`）。
 *
 * 建表用 `CREATE TABLE IF NOT EXISTS` 的面板式迁移（与 `config-store.ts` /
 * `generation-model-store.ts` 同风格）；版本号只为后续**加列**兜底：将来要加列时在这里按
 * `version` 分支执行 `ALTER TABLE` 并提升此常量，而不是猜字段是否已存在。
 */
export const TELEMETRY_SCHEMA_VERSION = 1;

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

/** 选列顺序固定，读回时按位置不按名字也可以，但仍用列名以贴合显式字段。 */
const SELECT_COLUMNS = "id, received_at, occurred_at, name, result, duration_ms, error_code, origin, surface, trace_id, attributes, frontend_version";

/** `BEGIN IMMEDIATE` 事务里能绑定的参数类型子集（够用即可，不引 `node:sqlite` 的命名空间类型）。 */
type SqlParam = null | number | bigint | string;

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

/** 一个事件名在某个时间范围内的聚合（异常规则与聚合读面共用同一份口径）。 */
export type NameWindowStats = {
  readonly name: TelemetryEventName;
  readonly count: number;
  /** `failure` + `rejected`：异常规则里的"失败率"口径（`cancelled` 不算失败）。 */
  readonly failures: number;
  /** 带耗时的样本数；分位数只在样本内取位。 */
  readonly durationSamples: number;
  readonly durationP50?: number;
  readonly durationP95?: number;
  readonly durationMax?: number;
  /** 按出现次数排序的错误码；只在请求了 `withErrorCodes` 时有值。 */
  readonly errorCodes?: readonly ErrorCodeStats[];
};

export type ErrorCodeStats = {
  readonly name: TelemetryEventName;
  readonly code: string;
  readonly count: number;
  /** 该错误码在窗口内最早出现的时间；`new-error-code` 的"首次出现"证据。 */
  readonly firstSeenAt: number;
};

export type StoredEventQuery = {
  readonly since: number;
  readonly until: number;
  readonly names?: readonly TelemetryEventName[];
  readonly results?: readonly TelemetryResult[];
  readonly errorCode?: string;
  readonly cursor?: string;
  readonly limit?: number;
};

export type StoredEventPage = {
  readonly events: readonly TelemetryEventRecord[];
  readonly nextCursor?: string;
};

export type StoredSummary = {
  readonly total: number;
  readonly rows: readonly TelemetrySummaryRow[];
  readonly series: readonly TelemetrySeriesPoint[];
};

export type RangeStatsQuery = {
  readonly since: number;
  readonly until: number;
  /** 分位数只在异常规则里需要；`event-silence` 的第三个窗口只要计数，跳过可少两次按名排序查询。 */
  readonly withDurations?: boolean;
  readonly withErrorCodes?: boolean;
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
    const conditions = ["received_at >= ?", "received_at <= ?"];
    const params: SqlParam[] = [query.since, query.until];
    const cursorId = decodeCursor(query.cursor);
    if (cursorId !== undefined) {
      conditions.push("id < ?");
      params.push(cursorId);
    }
    if (query.names && query.names.length > 0) {
      conditions.push(`name IN (${query.names.map(() => "?").join(", ")})`);
      params.push(...query.names);
    }
    if (query.results && query.results.length > 0) {
      conditions.push(`result IN (${query.results.map(() => "?").join(", ")})`);
      params.push(...query.results);
    }
    if (query.errorCode) {
      conditions.push("error_code = ?");
      params.push(query.errorCode);
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

  /**
   * 窗口聚合：每个事件名一行（计数/结果分布/分位数/高频错误码），外加按分桶的时间序列。
   *
   * 分位数用"排序后取位"：`ORDER BY duration_ms LIMIT 1 OFFSET floor(p * (n - 1))`。不用近似
   * 算法——复盘时分位数自己对不上比慢几毫秒更糟（design D5）。
   */
  summary(input: { since: number; until: number; bucket: TelemetryBucket }): StoredSummary {
    const { since, until, bucket } = input;
    const counts = this.all<{ name: string; result: string; count: number }>(
      `SELECT name, result, COUNT(*) AS count FROM ${TABLE}
       WHERE received_at >= ? AND received_at <= ?
       GROUP BY name, result`,
      since,
      until
    );
    const byName = new Map<string, { count: number; results: Record<TelemetryResult, number> }>();
    let total = 0;
    for (const row of counts) {
      const name = row.name;
      const entry = byName.get(name) ?? { count: 0, results: emptyResultCounts() };
      const count = Number(row.count);
      entry.count += count;
      // `result` 已由归一保证是四个值之一；坏文件里的意外值只忽略，不让整页失败。
      if (isTelemetryResultKey(row.result)) entry.results[row.result] += count;
      byName.set(name, entry);
      total += count;
    }

    const errorCodes = this.errorCodeStats({ since, until });
    const durations = this.all<{ name: string; samples: number; max: number | null }>(
      `SELECT name, COUNT(duration_ms) AS samples, MAX(duration_ms) AS max FROM ${TABLE}
       WHERE received_at >= ? AND received_at <= ? AND duration_ms IS NOT NULL
       GROUP BY name`,
      since,
      until
    );
    const durationByName = new Map(durations.map((row) => [row.name, row]));

    const rows: TelemetrySummaryRow[] = [...byName.entries()].map(([name, entry]) => {
      const duration = durationByName.get(name);
      const samples = Number(duration?.samples ?? 0);
      return {
        name: name as TelemetryEventName,
        count: entry.count,
        results: entry.results,
        ...(samples > 0
          ? {
              durationP50: this.quantile({ name, since, until, samples, percentile: 0.5 }),
              durationP95: this.quantile({ name, since, until, samples, percentile: 0.95 }),
              durationMax: Number(duration?.max ?? 0)
            }
          : {}),
        durationSamples: samples,
        topErrorCodes: topErrorCodes(errorCodes.filter((row) => row.name === name))
      };
    });
    // 最活跃的事件名在前面，便于复盘时先看问题最多的那一类；同计数按名字稳定排序。
    rows.sort((left, right) => right.count - left.count || compareText(left.name, right.name));

    const series = this.all<{ bucket_at: number; name: string; count: number; failures: number }>(
      `SELECT (received_at - (received_at % ?)) AS bucket_at,
              name,
              COUNT(*) AS count,
              SUM(CASE WHEN result IN ('failure', 'rejected', 'cancelled') THEN 1 ELSE 0 END) AS failures
       FROM ${TABLE}
       WHERE received_at >= ? AND received_at <= ?
       GROUP BY bucket_at, name
       ORDER BY bucket_at ASC, name ASC`,
      TELEMETRY_BUCKET_MS_SAFE(bucket),
      since,
      until
    );
    return {
      total,
      rows,
      series: series.map((row) => ({
        at: Number(row.bucket_at),
        name: row.name as TelemetryEventName,
        count: Number(row.count),
        failures: Number(row.failures)
      }))
    };
  }

  /**
   * 一段时间范围内每个事件名的聚合，供异常规则使用。
   *
   * 与 `summary` 分开是因为异常要看三个相邻窗口、且只需要 p95（不要 p50/错误码列表），按需查询
   * 比先算完整聚合再丢弃更省。
   */
  rangeStats(query: RangeStatsQuery): readonly NameWindowStats[] {
    const { since, until } = query;
    const counts = this.all<{ name: string; result: string; count: number }>(
      `SELECT name, result, COUNT(*) AS count FROM ${TABLE}
       WHERE received_at >= ? AND received_at <= ?
       GROUP BY name, result`,
      since,
      until
    );
    const byName = new Map<string, { count: number; failures: number }>();
    for (const row of counts) {
      const entry = byName.get(row.name) ?? { count: 0, failures: 0 };
      const count = Number(row.count);
      entry.count += count;
      if (row.result === "failure" || row.result === "rejected") entry.failures += count;
      byName.set(row.name, entry);
    }

    const durationByName = new Map<string, { samples: number; max: number }>();
    if (query.withDurations) {
      for (const row of this.all<{ name: string; samples: number; max: number | null }>(
        `SELECT name, COUNT(duration_ms) AS samples, MAX(duration_ms) AS max FROM ${TABLE}
         WHERE received_at >= ? AND received_at <= ? AND duration_ms IS NOT NULL
         GROUP BY name`,
        since,
        until
      )) {
        durationByName.set(row.name, { samples: Number(row.samples), max: Number(row.max ?? 0) });
      }
    }

    const errorCodes = query.withErrorCodes ? this.errorCodeStats({ since, until }) : [];

    return [...byName.entries()]
      .map(([name, entry]): NameWindowStats => {
        const duration = durationByName.get(name);
        const samples = duration?.samples ?? 0;
        return {
          name: name as TelemetryEventName,
          count: entry.count,
          failures: entry.failures,
          durationSamples: samples,
          ...(query.withDurations && samples > 0
            ? {
                durationP50: this.quantile({ name, since, until, samples, percentile: 0.5 }),
                durationP95: this.quantile({ name, since, until, samples, percentile: 0.95 }),
                durationMax: duration?.max
              }
            : {}),
          ...(query.withErrorCodes
            ? { errorCodes: errorCodes.filter((row) => row.name === name) }
            : {})
        };
      })
      .sort((left, right) => compareText(left.name, right.name));
  }

  /** 窗口内每个（事件名, 错误码）的计数与首次出现时间。 */
  errorCodeStats(input: { since: number; until: number }): readonly ErrorCodeStats[] {
    return this.all<{ name: string; code: string; count: number; first_seen: number }>(
      `SELECT name, error_code AS code, COUNT(*) AS count, MIN(received_at) AS first_seen FROM ${TABLE}
       WHERE received_at >= ? AND received_at <= ? AND error_code <> ''
       GROUP BY name, error_code
       ORDER BY count DESC, code ASC`,
      input.since,
      input.until
    ).map((row) => ({
      name: row.name as TelemetryEventName,
      code: row.code,
      count: Number(row.count),
      firstSeenAt: Number(row.first_seen)
    }));
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

  /**
   * 排序取位分位数。`percentile` 是 0..1；`offset = floor(p * (n - 1))` 让 n=1 时两端都取到唯一
   * 样本、n=2 时 p50 取较小值（与常见的 nearest-rank 插值口径不同，但可复现、不引入浮点）。
   */
  private quantile(input: {
    name: string;
    since: number;
    until: number;
    samples: number;
    percentile: number;
  }): number | undefined {
    if (input.samples <= 0) return undefined;
    const offset = Math.floor(input.percentile * (input.samples - 1));
    const row = this.get<{ duration_ms: number }>(
      `SELECT duration_ms FROM ${TABLE}
       WHERE name = ? AND received_at >= ? AND received_at <= ? AND duration_ms IS NOT NULL
       ORDER BY duration_ms ASC
       LIMIT 1 OFFSET ?`,
      input.name,
      input.since,
      input.until,
      offset
    );
    return row === undefined ? undefined : Number(row.duration_ms);
  }

  private all<T>(sql: string, ...params: SqlParam[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }
}

/** 与契约的 `TELEMETRY_BUCKET_MS` 同源；这里再收敛一次，防止坏值让 SQL 除零。 */
function TELEMETRY_BUCKET_MS_SAFE(bucket: TelemetryBucket): number {
  return BUCKET_MS[bucket] ?? BUCKET_MS["1h"];
}

const BUCKET_MS: Readonly<Record<TelemetryBucket, number>> = { "1m": 60_000, "5m": 300_000, "1h": 3_600_000 };

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

function emptyResultCounts(): Record<TelemetryResult, number> {
  return { success: 0, failure: 0, cancelled: 0, rejected: 0 };
}

function isTelemetryResultKey(value: string): value is TelemetryResult {
  return value === "success" || value === "failure" || value === "cancelled" || value === "rejected";
}

function topErrorCodes(rows: readonly ErrorCodeStats[], limit = 5): readonly { code: string; count: number }[] {
  return [...rows]
    .sort((left, right) => right.count - left.count || compareText(left.code, right.code))
    .slice(0, limit)
    .map((row) => ({ code: row.code, count: row.count }));
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

function serializeAttributes(attributes: Readonly<Record<string, string | number | boolean>> | undefined): string {
  return attributes === undefined || Object.keys(attributes).length === 0 ? "{}" : JSON.stringify(attributes);
}

/**
 * 属性列是 JSON。落库内容由本包写入，理论上总是合法；但文件可能被手工改坏，一条坏行不该让整页
 * 查询失败，所以解析失败按"没有属性"处理。
 */
function parseAttributes(raw: string): Record<string, string | number | boolean> | undefined {
  if (raw === "" || raw === "{}") return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean"
    );
    return entries.length === 0 ? undefined : Object.fromEntries(entries);
  } catch {
    return undefined;
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
