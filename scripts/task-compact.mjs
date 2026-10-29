#!/usr/bin/env node
/**
 * `pnpm task:compact` —— 清理 task_records 里的存量二进制负载。
 *
 * 用法（在 client/ 或父仓根目录）：
 *   pnpm task:compact                          # dry-run：列出可清理的行与预计回收空间
 *   pnpm task:compact -- --apply               # 执行（单事务），并把 WAL checkpoint 回去
 *   pnpm task:compact -- --apply --vacuum      # 再 VACUUM 收缩文件（需先停 pnpm dev）
 *   pnpm task:compact -- --apply --backup      # 先 VACUUM INTO 一份快照备份
 *   pnpm task:compact -- --db /path/task.sqlite --min-mb 5 --json
 *
 * 库路径解析顺序：`--db` → `WOOHAA3_TASK_STORE_PATH` 环境变量 → `web/.env` 里的同名键
 * （与 `scripts/dev.mjs` 读的是同一份文件）。
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadServiceEnv } from "./lib/service-env.mjs";
import {
  applyCompaction,
  backupDatabase,
  checkpoint,
  fileSizes,
  freePageBytes,
  openTaskStore,
  planCompaction,
  summarize,
  vacuum
} from "./lib/task-store-compact.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage());
  process.exit(0);
}

const dbPath = resolveDbPath();
const apply = args.includes("--apply");
const doVacuum = args.includes("--vacuum");
const doBackup = args.includes("--backup");
const json = args.includes("--json");
const minMb = numberArg("--min-mb", 1);
const minBytes = Math.max(1, Math.round(minMb * 1024 * 1024));

if (!fs.existsSync(dbPath)) {
  fail(`数据库不存在：${dbPath}`, 2);
}
if (!hasTaskTable(dbPath)) {
  fail(`${dbPath} 里没有 task_records 表，确认这是 task store`, 2);
}

const before = fileSizes(fs, dbPath);
const db = openTaskStore(dbPath, { readOnly: !apply });

let backupPath = null;
try {
  const plan = planCompaction(db, { minBytes });
  const summary = summarize(plan);

  if (!apply) {
    reportPlan(plan, summary, before);
    console.log("");
    console.log(
      plan.compactable.length > 0
        ? "dry-run：加 --apply 执行；要收缩文件再加 --vacuum（需先停掉 pnpm dev）"
        : "没有需要清理的行"
    );
    if (json) emitJson({ dbPath, mode: "dry-run", before, plan, summary, backupPath: null });
    db.close();
    process.exit(0);
  }

  if (plan.compactable.length === 0) {
    reportPlan(plan, summary, before);
    console.log("");
    console.log("没有需要清理的行");
    // 已经清过、只想收缩文件也允许：`--apply --vacuum` 可以直接跑第二遍。
    let vacuumError = null;
    let afterVacuum = before;
    if (doVacuum) {
      try {
        vacuum(db);
        afterVacuum = fileSizes(fs, dbPath);
        console.log(`VACUUM 完成：${mb(before.database)} → ${mb(afterVacuum.database)}`);
      } catch (error) {
        vacuumError = error instanceof Error ? error.message : String(error);
        console.log(`VACUUM 未完成：${vacuumError}`);
      }
    } else {
      console.log(`文件保持 ${mb(before.database)}；加 --vacuum 可收缩（需先停掉 pnpm dev）`);
    }
    if (json) {
      emitJson({ dbPath, mode: "apply", before, after: before, afterVacuum, plan, summary, result: null, backupPath, vacuumError });
    }
    db.close();
    process.exit(vacuumError ? 1 : 0);
  }

  if (doBackup) {
    backupPath = `${dbPath}.bak-${timestamp()}`;
    refuseWhenLowOnDisk(before.database, backupPath);
    backupDatabase(db, backupPath);
  }

  const result = applyCompaction(db, plan);
  checkpoint(db);
  const afterApply = fileSizes(fs, dbPath);
  // 删掉的内容变成空闲页：`auto_vacuum` 关闭，文件不会自己变小。
  const freedBytes = freePageBytes(db);

  let vacuumError = null;
  let afterVacuum = afterApply;
  if (doVacuum) {
    try {
      vacuum(db);
      afterVacuum = fileSizes(fs, dbPath);
    } catch (error) {
      vacuumError = error instanceof Error ? error.message : String(error);
    }
  }

  if (!json) {
    reportPlan(plan, summary, before);
    console.log("");
    console.log(`已清理 ${result.changed.length} 行`);
    for (const entry of top(result.changed, 10)) {
      console.log(
        `  ${shortKey(entry.key)}  ${mb(entry.beforeBytes)} → ${kb(entry.afterBytes)}` +
          (entry.media ? `  → ${entry.media.storageKey}` : "  （无产物，只删字节）")
      );
    }
    if (result.changed.length > 10) console.log(`  …另外 ${result.changed.length - 10} 行`);
    if (result.failed.length > 0) {
      console.log("");
      console.log(`${result.failed.length} 行更新失败（已回滚该行，未影响其它行）：`);
      for (const entry of result.failed) console.log(`  ${shortKey(entry.key)}  ${entry.reason}`);
    }
    console.log("");
    if (doVacuum && !vacuumError) {
      console.log(
        `文件：${mb(before.database)} → ${mb(afterVacuum.database)}（释放 ${mb(before.database - afterVacuum.database)}，WAL ${mb(afterVacuum.wal)}）`
      );
    } else if (vacuumError) {
      console.log(`已释放 ${mb(freedBytes)} 到空闲页；VACUUM 未完成：${vacuumError}`);
    } else {
      console.log(
        `已释放 ${mb(freedBytes)} 到空闲页（auto_vacuum 关闭，文件暂时仍是 ${mb(afterApply.database)}）` +
          "；加 --vacuum 收缩，需先停掉 pnpm dev"
      );
    }
    if (backupPath) console.log(`备份：${backupPath}`);
  }

  emitJson({
    dbPath,
    mode: "apply",
    before,
    after: afterApply,
    afterVacuum,
    freedBytes,
    plan,
    summary,
    result,
    backupPath,
    vacuumError
  });

  db.close();
  process.exit(result.failed.length > 0 || vacuumError ? 1 : 0);
} catch (error) {
  try {
    db.close();
  } catch {
    // ignore
  }
  fail(error instanceof Error ? error.message : String(error), 1);
}

function resolveDbPath() {
  const explicit = argValue("--db");
  if (explicit) return path.resolve(explicit);
  const env = loadServiceEnv(root, process.env.WOOHAA3_SERVICE_ENV_FILE);
  const configured = (env.WOOHAA3_TASK_STORE_PATH ?? "").trim();
  if (configured === "") {
    fail(
      "缺少数仓库路径：用 --db <path>，或设置 WOOHAA3_TASK_STORE_PATH（web/.env 里已有该键时可直接 pnpm task:compact）",
      2
    );
  }
  return path.resolve(root, configured);
}

function hasTaskTable(file) {
  let probe;
  try {
    probe = openTaskStore(file, { readOnly: true });
    const row = probe.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'task_records'").get();
    return row !== undefined;
  } catch {
    return false;
  } finally {
    try {
      probe?.close();
    } catch {
      // ignore
    }
  }
}

/** 备份 / VACUUM 都要求能再放下一份库（VACUUM 走临时文件，备份走新文件）。 */
function refuseWhenLowOnDisk(databaseBytes, target) {
  let free = 0;
  try {
    const stat = fs.statfsSync(path.dirname(target));
    free = stat.bavail * stat.bsize;
  } catch {
    return;
  }
  if (free < databaseBytes * 2.2) {
    fail(
      `磁盘剩余 ${mb(free)}，不足 ${mb(databaseBytes)} 库的 2.2 倍；先腾空间或去掉 --backup`,
      1
    );
  }
}

function reportPlan(plan, summary, sizes) {
  console.log(`task store：${dbPath}`);
  console.log(`当前：文件 ${mb(sizes.database)} · WAL ${mb(sizes.wal)} · 阈值 ${mb(plan.minBytes)}/行`);
  console.log(
    `可清理 ${summary.compactableCount} 行，预计回收 ${mb(summary.reclaimBytes)}` +
      (summary.skippedCount > 0 ? `；跳过 ${summary.skippedCount} 行` : "")
  );
  for (const entry of top(plan.compactable, 10)) {
    console.log(
      `  ${shortKey(entry.key)}  ${entry.status.padEnd(9)}  ${mb(entry.stateBytes + entry.resultBytes)}` +
        (entry.media ? `  → ${entry.media.storageKey}` : "  （history " + entry.historyState + "）")
    );
  }
  if (plan.compactable.length > 10) console.log(`  …另外 ${plan.compactable.length - 10} 行`);
  for (const skipped of summary.skippedReasons) {
    console.log(`  跳过 ${skipped.count} 行：${skipped.reason}`);
  }
}

function emitJson(payload) {
  if (json) console.log(JSON.stringify(payload, null, 2));
}

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : undefined;
}

function numberArg(name, fallback) {
  const raw = argValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) fail(`${name} 需要一个正数`, 2);
  return value;
}

function top(list, count) {
  return list.slice(0, count);
}

function shortKey(key) {
  return key.length > 28 ? `${key.slice(0, 25)}…` : key;
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function kb(bytes) {
  return bytes >= 1024 * 1024 ? mb(bytes) : `${(bytes / 1024).toFixed(1)}KB`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function fail(message, code) {
  console.error(message);
  process.exit(code);
}

function usage() {
  return [
    "用法：pnpm task:compact [-- [--db <path>] [--apply] [--vacuum] [--backup] [--min-mb N] [--json]]",
    "",
    "  （无参数）     dry-run：列出可清理的终态记录与预计回收空间",
    "  --apply        执行清理（单事务）；history 缺 storageKey 的行不动",
    "  --vacuum       清理后 VACUUM 收缩文件（需先停掉 pnpm dev）",
    "  --backup       VACUUM INTO 一份 <db>.bak-<时间> 快照",
    "  --db <path>    指定库文件（缺省读 WOOHAA3_TASK_STORE_PATH，再缺省读 web/.env）",
    "  --min-mb N     只处理超过 N MB 的行（默认 1）",
    "  --json         机器可读输出",
    "  --help         显示本帮助"
  ].join("\n");
}
