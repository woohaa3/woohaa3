/**
 * 本机遥测服务装配（change: 2026-10-20-add-local-client-telemetry，design D2/D7/D8/D11）。
 *
 * 三条不变量，改这里之前先确认不会破坏它们：
 *
 * 1. **业务路径永不等待 I/O**：`emit` 只做归一 + 入内存队列，写盘由 flusher 在定时器里成批做。
 *    这是"遥测不得影响编辑与同步"的具体落点（design D7）。
 * 2. **存储打不开就整体降级**：读面返回空、`emit` 变 no-op，业务照常；**绝不删除或重建**用户
 *    的库文件（design D11）。
 * 3. **出口只搬运**：`telemetry.export.enabled` 为 false 时根本不调用任何出口；调用失败只记
 *    日志与该出口的丢弃计数，永不抛出、永不重试（design D8：proto 没有幂等键，重试会让计数翻倍，
 *    而计数正是这条通道唯一的产出）。
 */
import path from "node:path";
import {
  SETTING_DEFINITIONS,
  TELEMETRY_WINDOW_MS,
  defaultTelemetryBucket,
  normalizeTelemetryEvent,
  type HostTelemetryService,
  type TelemetryAnomaly,
  type TelemetryAttributeKey,
  type TelemetryBucket,
  type TelemetryEvent,
  type TelemetryEventFilter,
  type TelemetryEventInput,
  type TelemetryEventPage,
  type TelemetryExport,
  type TelemetryExportStatus,
  type TelemetryReadOptions,
  type TelemetryStatus,
  type TelemetrySummary,
  type TelemetryWindow
} from "@woohaa3/contracts";
import { collectAnomalies } from "./anomalies-window.js";
import { TELEMETRY_FLUSH_BATCH, TELEMETRY_FLUSH_INTERVAL_MS, TelemetryEventQueue } from "./queue.js";
import type { TelemetrySettings } from "./settings.js";
import { SqliteTelemetryStore } from "./storage/sqlite/store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 与设计 D5 一致：缺省窗口 24h。 */
const DEFAULT_WINDOW: TelemetryWindow = "24h";
/** 保留清理的周期：与 `task-service/src/composition.ts` 的小时级 sweep 同节奏（design D4）。 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/**
 * 连续写失败到这次数就暂停 flusher。
 *
 * 250ms 的 flusher 遇到坏库（磁盘满、文件被替换）会在每秒刷 4 次失败；暂停把"持续失败"从
 * 日志风暴变成一次明确的事件，同时队列仍按容量兜住内存。成功一次后自动恢复。
 */
const MAX_CONSECUTIVE_WRITE_FAILURES = 10;
/** 每 N 次连续失败才再记一条日志（第 1 次总是记）。 */
const WRITE_FAILURE_LOG_EVERY = 100;

/**
 * 设置读取函数抛错时的兜底值。
 *
 * 直接取设置契约里的缺省值而不是在这里复制数字：设置项是唯一来源，本包只是"读不到时按缺省走"。
 */
const FALLBACK_LOCAL_ENABLED = Boolean(SETTING_DEFINITIONS["telemetry.local.enabled"].default);
const FALLBACK_RETENTION_DAYS = Number(SETTING_DEFINITIONS["telemetry.local.retentionDays"].default);
const FALLBACK_MAX_ROWS = Number(SETTING_DEFINITIONS["telemetry.local.maxRows"].default);
const FALLBACK_EXPORT_ENABLED = Boolean(SETTING_DEFINITIONS["telemetry.export.enabled"].default);

/** 出口返回的错误码必须是稳定短标识；形状不对就归为一个我们自己的稳定码，避免把外部正文带进状态面。 */
const EXPORT_CODE_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const FALLBACK_EXPORT_ERROR_CODE = "send-failed";

type ExportEntry = {
  readonly provider: TelemetryExport;
  /** 该出口累计丢弃的事件数（失败即丢弃、绝不重试）。 */
  dropped: number;
  /** 最近一次失败的稳定错误码。 */
  lastError?: string;
  /** 上一次已记日志的错误码：同一出口连续同样失败只记一次，避免刷满日志。 */
  loggedError?: string;
};

export function createTelemetryService(options: {
  /** SQLite 文件绝对路径；目录由本包创建，文件权限由本包收窄到 0600。 */
  path: string;
  settings: TelemetrySettings;
  logger?: (event: Record<string, unknown>) => void;
  now?: () => number;
}): HostTelemetryService {
  const now = options.now ?? ((): number => Date.now());
  /** 日志失败不得影响业务：宿主传入的实现可能自己抛错。 */
  const log = (event: Record<string, unknown>): void => {
    if (!options.logger) return;
    try {
      options.logger(event);
    } catch {
      // 见上。
    }
  };

  const queue = new TelemetryEventQueue();
  let store: SqliteTelemetryStore | null = null;
  try {
    store = new SqliteTelemetryStore({ path: options.path });
  } catch (error) {
    // 打不开就整体降级：文件保留原样，等用户自己处理（design D11）。
    log({ event: "telemetry-store-unavailable", path: path.resolve(options.path), message: errorMessage(error) });
  }

  let closed = false;
  let droppedInvalid = 0;
  let writeErrors = 0;
  let consecutiveWriteErrors = 0;
  let flusherPaused = false;
  let flushTimer: ReturnType<typeof setInterval> | null = null;
  let sweepTimer: ReturnType<typeof setInterval> | null = null;
  let pendingDrain: ReturnType<typeof setImmediate> | null = null;
  const exportRegistry = new Map<string, ExportEntry>();

  // ---- 设置读取：设置项都是 reload:"hot"，所以每次调用都读最新值，不做缓存。 ----

  const readLocalEnabled = (): boolean => {
    try {
      return Boolean(options.settings.localEnabled());
    } catch {
      return FALLBACK_LOCAL_ENABLED;
    }
  };
  const readExportEnabled = (): boolean => {
    try {
      return Boolean(options.settings.exportEnabled());
    } catch {
      return FALLBACK_EXPORT_ENABLED;
    }
  };
  const readNumber = (read: () => number, fallback: number): number => {
    try {
      const value = read();
      return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
    } catch {
      return fallback;
    }
  };
  const readRetentionDays = (): number => readNumber(() => options.settings.retentionDays(), FALLBACK_RETENTION_DAYS);
  const readMaxRows = (): number => readNumber(() => options.settings.maxRows(), FALLBACK_MAX_ROWS);

  /** 保留期下界：查询侧与清理都用它，保证"过期行不可见"不依赖清理是否跑过。 */
  const retentionCutoff = (at: number): number => at - readRetentionDays() * DAY_MS;

  // ---- 清理：小时级 + 启动时一次（design D4） ----

  const runSweep = (): void => {
    if (!store || closed) return;
    try {
      store.prune({ cutoff: retentionCutoff(now()), maxRows: readMaxRows() });
    } catch (error) {
      writeErrors += 1;
      log({ event: "telemetry-prune-failed", message: errorMessage(error) });
    }
  };

  // ---- 写盘与出口投递 ----

  const writeBatch = (batch: readonly TelemetryEvent[]): void => {
    if (!store) return;
    try {
      store.insertBatch(batch, now());
      consecutiveWriteErrors = 0;
      resumeFlusher();
    } catch (error) {
      writeErrors += 1;
      consecutiveWriteErrors += 1;
      if (consecutiveWriteErrors === 1 || consecutiveWriteErrors % WRITE_FAILURE_LOG_EVERY === 0) {
        log({ event: "telemetry-write-failed", failures: consecutiveWriteErrors, message: errorMessage(error) });
      }
      if (consecutiveWriteErrors >= MAX_CONSECUTIVE_WRITE_FAILURES) pauseFlusher();
      // 写失败即丢弃这一批（不重排队）：坏库上重排队等于无限失败循环，而遥测宁可丢。
      return;
    }
    deliverToExports(batch);
  };

  const drainOneBatch = (): void => {
    const batch = queue.take(TELEMETRY_FLUSH_BATCH);
    if (batch.length === 0) return;
    writeBatch(batch);
  };

  /** 显式排空（flush / 关闭 / 清空）：同步做完，因为 `node:sqlite` 本身就是同步 API。 */
  const drainAll = (): void => {
    while (queue.size > 0) {
      const before = queue.size;
      drainOneBatch();
      if (queue.size >= before) break; // 防御：写入路径没有消费队列时不要死循环。
    }
  };

  const scheduleDrain = (): void => {
    if (pendingDrain !== null || closed) return;
    // 用 `setImmediate` 而不是就地写：`emit` 在业务路径上，必须立即返回（design D7）。
    pendingDrain = setImmediate(() => {
      pendingDrain = null;
      drainOneBatch();
    });
    pendingDrain.unref?.();
  };

  const startFlusher = (): void => {
    if (flushTimer !== null || closed || !store) return;
    flushTimer = setInterval(() => drainOneBatch(), TELEMETRY_FLUSH_INTERVAL_MS);
    // unref：遥测的定时器不该拦住进程退出；关闭时由宿主显式 `close()` flush 一次。
    flushTimer.unref?.();
  };

  const pauseFlusher = (): void => {
    if (flusherPaused) return;
    flusherPaused = true;
    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    log({ event: "telemetry-flusher-paused", failures: consecutiveWriteErrors });
  };

  const resumeFlusher = (): void => {
    if (!flusherPaused) return;
    flusherPaused = false;
    startFlusher();
    log({ event: "telemetry-flusher-resumed" });
  };

  // ---- 出口（TelemetryExport）：只搬运，永不重试 ----

  const recordExportFailure = (entry: ExportEntry, code: unknown, droppedCount: number): void => {
    const stable = sanitizeExportCode(code);
    entry.dropped += droppedCount;
    entry.lastError = stable;
    if (entry.loggedError === stable) return;
    entry.loggedError = stable;
    log({ event: "telemetry-export-failed", exportId: entry.provider.exportId, code: stable, dropped: droppedCount });
  };

  const deliver = async (entry: ExportEntry, batch: readonly TelemetryEvent[]): Promise<void> => {
    try {
      const result = await entry.provider.send(batch);
      if (result.ok) {
        entry.loggedError = undefined;
        return;
      }
      recordExportFailure(entry, result.code, batch.length);
    } catch {
      // 出口实现抛错与返回失败同待遇：吞掉并计数。重试会让服务端计数翻倍（design D8）。
      recordExportFailure(entry, FALLBACK_EXPORT_ERROR_CODE, batch.length);
    }
  };

  const deliverToExports = (batch: readonly TelemetryEvent[]): void => {
    if (batch.length === 0 || exportRegistry.size === 0) return;
    // 关闭时根本不调用：不是"发出去但被拒"（design D8）。
    if (!readExportEnabled()) return;
    // 投递给**所有**已注册且自述可用的出口：core 不挑选目的地——"发到哪"是出口自己的配置。
    for (const entry of exportRegistry.values()) {
      const provider = entry.provider;
      if (provider.available === false) continue;
      void deliver(entry, batch);
    }
  };

  const toExportStatus = (entry: ExportEntry): TelemetryExportStatus => ({
    exportId: entry.provider.exportId,
    ...(entry.provider.label === undefined ? {} : { label: entry.provider.label }),
    available: entry.provider.available !== false,
    ...(entry.lastError === undefined ? {} : { lastError: entry.lastError }),
    dropped: entry.dropped
  });

  // ---- 公开读面 ----

  const windowSince = (window: TelemetryWindow | undefined, until: number): number =>
    Math.max(until - TELEMETRY_WINDOW_MS[window ?? DEFAULT_WINDOW], retentionCutoff(until));

  const emit = (input: TelemetryEventInput): void => {
    try {
      // 存储不可用或本机记录关闭：静默丢弃。业务不该因此拿到异常，也不该被要求判断。
      if (closed || !store || !readLocalEnabled()) return;
      const event = normalizeTelemetryEvent(input, { now: now() });
      if (event === null) {
        droppedInvalid += 1;
        return;
      }
      queue.enqueue(event);
      if (queue.size >= TELEMETRY_FLUSH_BATCH) scheduleDrain();
    } catch (error) {
      // 归一或入队路径上的任何意外都不能冒泡到业务代码（design D7）。
      log({ event: "telemetry-emit-failed", message: errorMessage(error) });
    }
  };

  const query = async (filter: TelemetryEventFilter = {}): Promise<TelemetryEventPage> => {
    if (!store) return { events: [] };
    const until = now();
    return store.listEvents({
      since: windowSince(filter.window, until),
      until,
      ...(filter.names === undefined ? {} : { names: filter.names }),
      ...(filter.results === undefined ? {} : { results: filter.results }),
      ...(filter.errorCode === undefined ? {} : { errorCode: filter.errorCode }),
      ...(filter.attributeKey === undefined ? {} : { attributeKey: filter.attributeKey }),
      ...(filter.attributeValue === undefined ? {} : { attributeValue: filter.attributeValue }),
      ...(filter.cursor === undefined ? {} : { cursor: filter.cursor }),
      ...(filter.limit === undefined ? {} : { limit: filter.limit })
    });
  };

  const summary = async (
    window: TelemetryWindow,
    bucket?: TelemetryBucket,
    options: TelemetryReadOptions = {}
  ): Promise<TelemetrySummary> => {
    const resolvedBucket = bucket ?? defaultTelemetryBucket(window);
    const until = now();
    const since = windowSince(window, until);
    const scope = attributeScope(options);
    const base = {
      window,
      bucket: resolvedBucket,
      since,
      until,
      ...(scope.groupBy === undefined ? {} : { groupBy: scope.groupBy })
    };
    if (!store) return { ...base, total: 0, rows: [], series: [] };
    const stored = store.summary({ since, until, bucket: resolvedBucket, ...scope });
    return { ...base, total: stored.total, rows: stored.rows, series: stored.series };
  };

  const anomalies = async (
    window: TelemetryWindow,
    options: TelemetryReadOptions = {}
  ): Promise<readonly TelemetryAnomaly[]> => {
    if (!store) return [];
    const until = now();
    return collectAnomalies(store, {
      window,
      until,
      retentionSince: retentionCutoff(until),
      ...attributeScope(options)
    });
  };

  const status = async (): Promise<TelemetryStatus> => {
    let eventCount = 0;
    let bytes = 0;
    if (store) {
      try {
        eventCount = store.count(retentionCutoff(now()));
      } catch (error) {
        writeErrors += 1;
        log({ event: "telemetry-count-failed", message: errorMessage(error) });
      }
      try {
        bytes = store.sizeBytes();
      } catch {
        // 读不到文件大小时按 0 显示：占用信息不该让整个状态面 500。
      }
    }
    return {
      enabled: readLocalEnabled(),
      exportEnabled: readExportEnabled(),
      store: store ? "ok" : "unavailable",
      // 始终给出库文件位置：复盘时"占用到底落在哪个文件"是真问题（用户要自己核对/清理），
      // 而且这个读面在启用访问控制时受 `telemetry.inspect` 保护，不是公开信息。
      storePath: path.resolve(options.path),
      queued: queue.size,
      droppedInvalid,
      droppedOverflow: queue.droppedOverflow,
      writeErrors,
      eventCount,
      bytes,
      exports: [...exportRegistry.values()].map(toExportStatus)
    };
  };

  const clear = async (): Promise<number> => {
    if (!store) return 0;
    // 先把队列写进库再删：否则"清空"之后队列里的旧事件还会冒出来，用户会以为没清掉。
    drainAll();
    queue.clear();
    return store.clear();
  };

  const flush = async (): Promise<void> => {
    if (closed) return;
    drainAll();
  };

  const registerExport = (provider: TelemetryExport): (() => void) => {
    // 同 id 注册视为"替换"（出口重建时幂等）；丢弃计数随新实例重置，避免把上一代实现的
    // 失败算到新实例头上。
    exportRegistry.set(provider.exportId, { provider, dropped: 0 });
    return () => {
      const current = exportRegistry.get(provider.exportId);
      // 只有仍指向自己时才删除：同 id 被新出口顶替后，旧出口的回滚不得注销新的。
      if (current?.provider === provider) exportRegistry.delete(provider.exportId);
    };
  };

  const unregisterExport = (exportId: string): void => {
    exportRegistry.delete(exportId);
  };

  const listExports = (): readonly TelemetryExport[] =>
    [...exportRegistry.values()].map((entry) => entry.provider);

  const close = (): void => {
    if (closed) return;
    closed = true;
    if (flushTimer !== null) {
      clearInterval(flushTimer);
      flushTimer = null;
    }
    if (sweepTimer !== null) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    if (pendingDrain !== null) {
      clearImmediate(pendingDrain);
      pendingDrain = null;
    }
    // best-effort：关闭前把队列写盘一次；失败只记账单，不阻塞卸载。
    drainAll();
    queue.clear();
    try {
      store?.close();
    } catch (error) {
      log({ event: "telemetry-store-close-failed", message: errorMessage(error) });
    }
    store = null;
  };

  if (store) {
    // 启动时先清一次（design D4：小时级 sweep + 启动时一次），再启动定时器。
    runSweep();
    startFlusher();
  }
  sweepTimer = setInterval(runSweep, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();

  return {
    emit,
    query,
    summary,
    anomalies,
    registerExport,
    unregisterExport,
    listExports,
    status,
    clear,
    flush,
    close
  };
}

/** 出口错误码只接受稳定短标识的形状；其余归为 `send-failed`（不把外部正文带进状态面）。 */
function sanitizeExportCode(code: unknown): string {
  return typeof code === "string" && EXPORT_CODE_PATTERN.test(code) ? code : FALLBACK_EXPORT_ERROR_CODE;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把读面的可选口径整理成存储层认的形状。
 *
 * 三件事：只要 `groupBy` 时不动筛选；只要筛选时不动分组；两样都要时同时生效。""空字符串"" 一律
 * 当作未给（URL 里删掉值很常见），避免 `attributeValue=""` 变成"筛空值"。
 */
function attributeScope(options: TelemetryReadOptions): {
  groupBy?: TelemetryAttributeKey;
  attributeKey?: TelemetryAttributeKey;
  attributeValue?: string;
} {
  const scope: {
    groupBy?: TelemetryAttributeKey;
    attributeKey?: TelemetryAttributeKey;
    attributeValue?: string;
  } = {};
  if (options.groupBy !== undefined) scope.groupBy = options.groupBy;
  if (options.attributeKey !== undefined && options.attributeValue !== undefined && options.attributeValue !== "") {
    scope.attributeKey = options.attributeKey;
    scope.attributeValue = options.attributeValue;
  }
  return scope;
}
