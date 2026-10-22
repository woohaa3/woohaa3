/**
 * C01–C03 只读 dry-run 兼容盘点（change: 2026-10-09-refactor-large-source-files-and-remove-compatibility，任务 6.1）。
 *
 * **只读**：只打开数据库/归档读取，绝不移除或重写任何记录。输出结构化 JSON 与人类可读摘要。
 * 覆盖结构化记录（canvas_json）、节点历史 payload、权威 Yjs projection 与归档。
 *
 * 用法（仓库根）：
 *   node web/scripts/inventory-canvas-compat.mjs --sqlite <canvas.db> [--sqlite <node-history.db>]
 *        [--yjs <yjs.db>] [--archive <archive.json>] [--out <dir>]
 *
 * 本环境不访问生产数据；对真实库运行需显式授权并先备份。缺省不自动发现库文件。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const args = process.argv.slice(2);
function flagValues(name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]);
  }
  return values;
}
const sqlitePaths = flagValues("--sqlite");
const yjsPaths = flagValues("--yjs");
const archivePaths = flagValues("--archive");
const outIndex = args.indexOf("--out");
const OUT_DIR = path.resolve(REPO_ROOT, outIndex >= 0 ? args[outIndex + 1] : "reports");

if (sqlitePaths.length === 0 && yjsPaths.length === 0 && archivePaths.length === 0) {
  console.error("至少提供一个 --sqlite / --yjs / --archive 路径；本工具只读，不自动发现生产库。");
  process.exit(2);
}

const { inventoryCanvas, inventoryNodeHistoryPayload, summarizeCompatInventory } = await import(
  "../services/canvas-service/src/storage/core/compat-inventory.ts"
);
const { loadNodeSqlite } = await import("../services/canvas-service/src/storage/sqlite/sqlite-loader.ts");

const findings = [];
const scanned = { structuredCanvases: 0, historyEntries: 0, yjsProjections: 0, archiveCanvases: 0, files: [] };

function listTables(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return new Set(rows.map((row) => String(row.name)));
}

function scanStructuredDb(file) {
  const sqlite = loadNodeSqlite();
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const tables = listTables(db);
    if (tables.has("canvases")) {
      const rows = db.prepare("SELECT id, canvas_json FROM canvases").all();
      for (const row of rows) {
        scanned.structuredCanvases += 1;
        let canvas;
        try {
          canvas = JSON.parse(row.canvas_json);
        } catch {
          findings.push({ category: "C01", location: String(row.id), code: "structured-json-parse-failed", confirmedLegacy: false, detail: "canvas_json 无法解析" });
          continue;
        }
        findings.push(...inventoryCanvas(canvas));
      }
    }
    if (tables.has("node_generation_history")) {
      const rows = db.prepare("SELECT canvas_id, node_id, entry_id, payload_json FROM node_generation_history").all();
      for (const row of rows) {
        scanned.historyEntries += 1;
        let payload = null;
        try {
          payload = JSON.parse(row.payload_json);
        } catch {
          findings.push({ category: "C02", location: `${row.canvas_id}/${row.node_id}/${row.entry_id}`, code: "history-json-parse-failed", confirmedLegacy: false, detail: "payload_json 无法解析" });
          continue;
        }
        findings.push(...inventoryNodeHistoryPayload({ canvasId: row.canvas_id, nodeId: row.node_id, entryId: row.entry_id, payload }));
      }
    }
    scanned.files.push({ path: path.relative(REPO_ROOT, file), tables: [...tables].sort() });
  } finally {
    db.close();
  }
}

function scanYjsDb(file) {
  const sqlite = loadNodeSqlite();
  const db = new sqlite.DatabaseSync(file, { readOnly: true });
  try {
    const tables = listTables(db);
    // 权威 Yjs projection 是过时快照；只统计存在性，不据此改写真值。
    if (tables.has("canvas_yjs_documents")) {
      const rows = db.prepare("SELECT canvas_id, projection_json FROM canvas_yjs_documents").all();
      for (const row of rows) {
        scanned.yjsProjections += 1;
        if (!row.projection_json) continue;
        let canvas;
        try {
          canvas = JSON.parse(row.projection_json);
        } catch {
          findings.push({ category: "C01", location: String(row.canvas_id), code: "yjs-projection-json-parse-failed", confirmedLegacy: false, detail: "projection_json 无法解析" });
          continue;
        }
        findings.push(...inventoryCanvas(canvas));
      }
    }
    scanned.files.push({ path: path.relative(REPO_ROOT, file), tables: [...tables].sort() });
  } finally {
    db.close();
  }
}

function scanArchive(file) {
  const archive = JSON.parse(readFileSync(file, "utf8"));
  if (!archive || !Array.isArray(archive.canvases)) {
    findings.push({ category: "C01", location: path.relative(REPO_ROOT, file), code: "archive-shape-invalid", confirmedLegacy: false, detail: "归档缺少 canvases" });
    return;
  }
  for (const record of archive.canvases) {
    if (!record || !record.canvas) continue;
    scanned.archiveCanvases += 1;
    findings.push(...inventoryCanvas(record.canvas));
  }
  scanned.files.push({ path: path.relative(REPO_ROOT, file), tables: [] });
}

for (const file of sqlitePaths) {
  if (!existsSync(file)) {
    console.error(`找不到 SQLite 文件：${file}`);
    process.exit(2);
  }
  scanStructuredDb(file);
}
for (const file of yjsPaths) {
  if (!existsSync(file)) {
    console.error(`找不到 Yjs SQLite 文件：${file}`);
    process.exit(2);
  }
  scanYjsDb(file);
}
for (const file of archivePaths) {
  if (!existsSync(file)) {
    console.error(`找不到归档文件：${file}`);
    process.exit(2);
  }
  scanArchive(file);
}

const report = { ...summarizeCompatInventory(findings), scanned };
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(path.join(OUT_DIR, "canvas-compat-inventory.json"), `${JSON.stringify(report, null, 2)}\n`);

const codeCounts = new Map();
for (const finding of findings) codeCounts.set(finding.code, (codeCounts.get(finding.code) ?? 0) + 1);
const lines = [
  "# C01–C03 只读兼容盘点报告",
  "",
  `扫描：结构化画布 ${scanned.structuredCanvases}，历史条目 ${scanned.historyEntries}，Yjs projection ${scanned.yjsProjections}，归档画布 ${scanned.archiveCanvases}。`,
  "",
  "| 类别 | 总数 | 确定旧默认（可迁移候选） | 未覆盖（无法确认） |",
  "|---|---:|---:|---:|",
  ...["C01", "C02", "C03"].map((category) => {
    const count = report.counts[category];
    return `| ${category} | ${count.total} | ${count.confirmed} | ${count.unconfirmed} |`;
  }),
  "",
  "## 按机器码",
  "",
  "| 码 | 数量 |",
  "|---|---:|",
  ...[...codeCounts.entries()].sort().map(([code, count]) => `| ${code} | ${count} |`),
  "",
  "> 说明：本报告只读、不迁移。「未覆盖」项（无法区分旧默认与人工 resize / 无法解析）必须报告，",
  "> 不在读取路径自动改写；严格化需单独 change 与显式迁移工具。"
];
writeFileSync(path.join(OUT_DIR, "canvas-compat-inventory.md"), `${lines.join("\n")}\n`);

console.log(`扫描完成：findings ${findings.length}；输出 ${path.relative(REPO_ROOT, OUT_DIR)}/canvas-compat-inventory.{json,md}`);
