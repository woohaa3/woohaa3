/**
 * task_records 存量瘦身（一次性运维，2026-10-28）。
 *
 * 背景：pptask 会把 provider 输出归一成 `Uint8Array`，旧实现直接 `JSON.stringify` 落库，
 * 每个字节展开成 `{"0":137,...}`（约 13 倍），且 worker 的恢复快照 `state.record.result`
 * 与任务 `result` 各存一份 —— 单张 7MB 图占 187MB。代码侧已改成落库前归档成 Media 引用
 * （`worker/result-archive.ts`），但**终态记录不会再 save()**，存量不会自己变小。
 *
 * 本模块只做一件事：把终态记录里的二进制数组删掉，能对上 Media 对象的补一条稳定引用。
 * 规则（宁可少清，不可清错）：
 * - 只动 `completed / failed / cancelled` 的记录，以及超过阈值（默认 1MB）的行；
 * - `completed`（provider 真的产出了东西）必须有 history `succeeded` 且带 `storageKey`
 *   才清；history 是 failed（典型是 `MediaImportError`）时字节就是唯一副本，跳过；
 * - `failed / cancelled` 的任务没有产物，直接删字节（能对上稳定对象时顺手补引用）；
 * - history 缺失或仍未终结的记录一律跳过（留给重启终态对账）。
 *
 * SQL 里用 `json_remove / json_set` 完成，避免把 90MB 文本读进 JS（C 实现约 0.4s/行）。
 */
import { DatabaseSync } from "node:sqlite";

/** task_records.status 的终态集合（scheduling 视角）。 */
export const TERMINAL_TASK_STATUSES = ["completed", "failed", "cancelled"];

/** 打开 task store；`readOnly` 用于 dry-run（不会写锁）。 */
export function openTaskStore(path, options = {}) {
  const db = new DatabaseSync(path, options.readOnly ? { readOnly: true } : {});
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

/**
 * 扫描可瘦身的行（只读）。
 *
 * @param {DatabaseSync} db
 * @param {{ minBytes?: number }} [options]
 */
export function planCompaction(db, options = {}) {
  const minBytes = options.minBytes ?? 1024 * 1024;
  const rows = db
    .prepare(
      `SELECT t.key AS key,
              t.status AS status,
              COALESCE(length(t.state_json), 0) AS state_bytes,
              COALESCE(length(t.result_json), 0) AS result_bytes,
              h.state AS history_state,
              h.result_json AS history_result
         FROM task_records t
         LEFT JOIN task_execution_records h ON h.task_key = t.key
        WHERE t.status IN ('completed', 'failed', 'cancelled')
          AND (COALESCE(length(t.state_json), 0) + COALESCE(length(t.result_json), 0)) >= ?
        ORDER BY (COALESCE(length(t.state_json), 0) + COALESCE(length(t.result_json), 0)) DESC`
    )
    .all(minBytes);

  const compactable = [];
  const skipped = [];
  for (const row of rows) {
    const entry = {
      key: String(row.key),
      status: String(row.status),
      stateBytes: Number(row.state_bytes ?? 0),
      resultBytes: Number(row.result_bytes ?? 0),
      historyState: row.history_state === null ? null : String(row.history_state)
    };
    const decision = decide(entry, row.history_result);
    if (decision.compact) compactable.push({ ...entry, media: decision.media });
    else skipped.push({ ...entry, reason: decision.reason });
  }
  return { minBytes, compactable, skipped };
}

/**
 * 单行决策：返回 { compact, media?, reason? }。
 *
 * 关键分界是**调度侧状态**而不是 history：`completed` 说明 provider 真的产出了东西，
 * 它的字节必须确认已进 Media（history succeeded + storageKey）才允许删；而任务本身
 * `failed / cancelled` 时没有可用产物，字节只是回退来源。
 *
 * 反例（真实数据里有）：调度侧 completed、history 是 failed +
 * `MediaImportError` —— 转存失败，字节就是这张图的唯一副本，绝不能删。
 */
function decide(entry, historyResult) {
  const media = mediaRefFromHistory(historyResult);

  if (entry.status === "completed") {
    if (entry.historyState === null) {
      return { compact: false, reason: "没有执行历史（提交前失败或孤儿记录），不动" };
    }
    if (entry.historyState !== "succeeded") {
      return {
        compact: false,
        reason: `任务已完成但 history 是 ${entry.historyState}（转存失败时字节是唯一副本）`
      };
    }
    if (!media) {
      return { compact: false, reason: "history 没有 storageKey，字节可能是唯一副本" };
    }
    return { compact: true, media };
  }

  // failed / cancelled：这次执行没有可用产物；若能对上稳定对象就顺手补一条引用。
  return { compact: true, media };
}

/** 从 history 的 result_json 提取稳定媒体引用（形状对齐 GenerationStableMediaResult.media）。 */
export function mediaRefFromHistory(historyResult) {
  if (typeof historyResult !== "string" || historyResult === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(historyResult);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const storageKey = parsed.storageKey;
  if (typeof storageKey !== "string" || storageKey === "") return null;
  const media = { storageKey };
  if (typeof parsed.contentType === "string" && parsed.contentType !== "") media.contentType = parsed.contentType;
  if (typeof parsed.size === "number" && Number.isFinite(parsed.size)) media.size = parsed.size;
  if (typeof parsed.checksum === "string" && parsed.checksum !== "") media.checksum = parsed.checksum;
  return media;
}

const UPDATE_WITH_MEDIA = `UPDATE task_records
   SET result_json = CASE
         WHEN result_json IS NULL THEN NULL
         WHEN json_valid(result_json) = 0 THEN result_json
         ELSE json_set(json_remove(result_json, '$.images', '$.audios', '$.videos'), '$.media', json(?))
       END,
       state_json = CASE
         WHEN state_json IS NULL THEN NULL
         WHEN json_valid(state_json) = 0 THEN state_json
         WHEN json_type(state_json, '$.record.result') IS NULL THEN state_json
         ELSE json_set(json_remove(state_json, '$.record.result.images', '$.record.result.audios', '$.record.result.videos'),
                       '$.record.result.media', json(?))
       END
 WHERE key = ? AND status IN ('completed', 'failed', 'cancelled')`;

const UPDATE_WITHOUT_MEDIA = `UPDATE task_records
   SET result_json = CASE
         WHEN result_json IS NULL THEN NULL
         WHEN json_valid(result_json) = 0 THEN result_json
         ELSE json_remove(result_json, '$.images', '$.audios', '$.videos')
       END,
       state_json = CASE
         WHEN state_json IS NULL THEN NULL
         WHEN json_valid(state_json) = 0 THEN state_json
         ELSE json_remove(state_json, '$.record.result.images', '$.record.result.audios', '$.record.result.videos')
       END
 WHERE key = ? AND status IN ('completed', 'failed', 'cancelled')`;

/**
 * 执行瘦身（写）。单事务：要么整批改完，要么不改。
 *
 * @returns {{ changed: Array<{key, beforeBytes, afterBytes}>, failed: Array<{key, reason}> }}
 */
export function applyCompaction(db, plan) {
  const withMedia = db.prepare(UPDATE_WITH_MEDIA);
  const withoutMedia = db.prepare(UPDATE_WITHOUT_MEDIA);
  const measure = db.prepare(
    "SELECT COALESCE(length(state_json), 0) AS s, COALESCE(length(result_json), 0) AS r FROM task_records WHERE key = ?"
  );
  const changed = [];
  const failed = [];

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const entry of plan.compactable) {
      try {
        if (entry.media) {
          const mediaJson = JSON.stringify(entry.media);
          withMedia.run(mediaJson, mediaJson, entry.key);
        } else {
          withoutMedia.run(entry.key);
        }
        const after = measure.get(entry.key);
        changed.push({
          key: entry.key,
          beforeBytes: entry.stateBytes + entry.resultBytes,
          afterBytes: Number(after?.s ?? 0) + Number(after?.r ?? 0),
          media: entry.media ?? null
        });
      } catch (error) {
        // 单行失败不毒化整批：记下来，继续下一行。
        failed.push({ key: entry.key, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 事务可能已经被 SQLite 回滚。
    }
    throw error;
  }
  return { changed, failed };
}

/** `VACUUM INTO` 一份一致性快照（同时也能当备份）。 */
export function backupDatabase(db, targetPath) {
  db.prepare("VACUUM INTO ?").run(targetPath);
}

/** 把 WAL 并回主库并截断（失败不致命：下一次写入会重新长出来）。 */
export function checkpoint(db) {
  try {
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").all();
    return true;
  } catch {
    return false;
  }
}

/**
 * 收缩文件（需要独占：`pnpm dev` 还开着就会 SQLITE_BUSY）。
 *
 * @throws 带有可读原因的 Error
 */
export function vacuum(db) {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // checkpoint 失败就让 VACUUM 自己报错。
  }
  try {
    db.exec("VACUUM");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`VACUUM 失败（数据库被其它连接占用？先停掉 pnpm dev）：${message}`);
  }
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {
    // ignore
  }
}

/** 空闲页占用的字节数（`auto_vacuum` 关闭时，删掉的内容仍占着文件）。 */
export function freePageBytes(db) {
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size ?? 0);
  const free = Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0);
  return pageSize * free;
}

/** 库文件与 WAL 的当前大小（字节）。 */
export function fileSizes(fs, dbPath) {
  const size = (file) => {
    try {
      return fs.statSync(file).size;
    } catch {
      return 0;
    }
  };
  return { database: size(dbPath), wal: size(`${dbPath}-wal`), shm: size(`${dbPath}-shm`) };
}

/** `plan` 的汇总：预计回收多少、跳过原因分布。 */
export function summarize(plan) {
  const reclaimBytes = plan.compactable.reduce((sum, entry) => sum + entry.stateBytes + entry.resultBytes, 0);
  const reasons = new Map();
  for (const entry of plan.skipped) {
    reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  }
  return {
    compactableCount: plan.compactable.length,
    skippedCount: plan.skipped.length,
    reclaimBytes,
    skippedReasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count }))
  };
}
