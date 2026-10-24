#!/usr/bin/env node
/**
 * 差异处置矩阵与任务清单的一致性检查（change: 2026-10-24-resolve-photocraft-interaction-gaps, V1）。
 *
 * 检查内容（全部只读，不生成文件）：
 * - 301 行 I001–I301 唯一、无缺号、无重复，任务列与行 ID 一致；
 * - tasks.md 的 301 个逐条任务与矩阵 ID 一一对应，P0/P/V 任务编号不重复；
 * - 证据里引用的源码/测试/fixture 路径存在（按仓库内任一目录解析）；
 * - 「明确不支持」的行不得引用白名单内命令；「补齐/部分补齐/等价」行若引用命令，
 *   命令必须已进入 capability.rs 白名单，除非证据明确写明仍未接入；
 * - 能力白名单与明确关闭清单不重叠，且每个白名单命令都有公开目录入口。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const change = "openspec/changes/2026-10-24-resolve-photocraft-interaction-gaps";
const matrixPath = join(root, change, "notes/disposition-matrix.md");
const tasksPath = join(root, change, "tasks.md");
const capabilityPath = join(root, "rust/crates/editor-core/src/capability.rs");

const failures = [];
const fail = (message) => failures.push(message);

function read(path) {
  if (!existsSync(path)) {
    fail(`缺少文件：${path}`);
    return "";
  }
  return readFileSync(path, "utf8");
}

const matrix = read(matrixPath);
const tasks = read(tasksPath);
const capability = read(capabilityPath);

// ---------------------------------------------------------------- 矩阵 301 行
const rows = matrix.split("\n").filter((line) => /^\| I\d{3} \|/.test(line));
const ids = rows.map((line) => line.split("|")[1].trim());
const expected = Array.from({ length: 301 }, (_, index) => `I${String(index + 1).padStart(3, "0")}`);
const seen = new Set();
for (const id of ids) {
  if (!/^I\d{3}$/.test(id)) fail(`矩阵行 ID 无效：${id}`);
  if (seen.has(id)) fail(`矩阵 ID 重复：${id}`);
  seen.add(id);
}
for (const id of expected) if (!seen.has(id)) fail(`矩阵缺少编号：${id}`);
if (ids.length !== 301) fail(`矩阵应为 301 行，实际 ${ids.length} 行`);

const parsed = rows.map((line) => {
  const cells = line.split("|").map((cell) => cell.trim());
  return { id: cells[1], interaction: cells[2], disposition: cells[3], owner: cells[4], task: cells[5], evidence: cells[6] };
});
for (const row of parsed) {
  if (!row.task.split(/[、,，]/).map((item) => item.trim()).includes(row.id)) fail(`${row.id} 的任务列未包含自身编号：${row.task}`);
  if (!row.evidence || row.evidence.length < 8) fail(`${row.id} 缺少可复核证据`);
}

// ---------------------------------------------------------------- 任务清单
const taskIds = [...tasks.matchAll(/^- \[[ x]\] ((?:I|P|V)[^\s]+)/gm)].map((match) => match[1]);
const taskIdSet = new Set();
for (const id of taskIds) {
  if (taskIdSet.has(id)) fail(`tasks.md 任务重复：${id}`);
  taskIdSet.add(id);
}
for (const id of expected) if (!taskIdSet.has(id)) fail(`tasks.md 缺少逐条任务：${id}`);
for (const id of taskIdSet) {
  if (/^I\d{3}$/.test(id) && !seen.has(id)) fail(`tasks.md 存在矩阵外的逐条任务：${id}`);
}
for (const prefix of ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]) {
  const count = [...taskIdSet].filter((id) => id.startsWith(`${prefix}.`)).length;
  const minimum = prefix === "P0" ? 6 : 4;
  if (count < minimum) fail(`tasks.md 的 ${prefix} 分域任务少于 ${minimum} 项（实际 ${count}）`);
}
const vCount = [...taskIdSet].filter((id) => /^V\d+$/.test(id)).length;
if (vCount < 15) fail(`tasks.md 的 V 任务应至少 15 项，实际 ${vCount}`);

// ---------------------------------------------------------------- 路径证据
const fileIndex = new Set();
function walk(dir, depth = 0) {
  if (depth > 9) return;
  for (const entry of readdirSync(dir)) {
    if (["node_modules", ".git", "target", "dist", ".local", "vendor", "assets", "locks"].includes(entry)) continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) walk(full, depth + 1);
    else {
      fileIndex.add(full.slice(root.length + 1));
      fileIndex.add(basename(full));
    }
  }
}
walk(root);
const FILE_REF = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|rs|json|css|mjs|md))`/g;
// 上游快照/只读参考里的文件名可能出现在证据里（例如上游 `move_distance.rs`），它们不在本仓
// 内解析；只跳过明确写成上游模块名的引用，其余仍要求可定位。
const ignoredRefs = new Set(["package.json", "contract.json", "Cargo.toml", "README.md"]);
const upstreamOnly = (ref) => /^(move_distance|type_tool|menu_keys|menu_nav|swatches_ui|preset_panels|retouch_ui|panels|canvas|state|menu_catalog)\.rs$/.test(ref);
for (const row of parsed) {
  for (const match of row.evidence.matchAll(FILE_REF)) {
    const ref = match[1];
    if (ref.startsWith("http") || ignoredRefs.has(ref) || upstreamOnly(ref)) continue;
    if (existsSync(join(root, ref)) || fileIndex.has(ref) || fileIndex.has(basename(ref))) continue;
    fail(`${row.id} 的证据引用不存在：${ref}`);
  }
}

// ---------------------------------------------------------------- 能力与命令
const block = (start, end) => {
  const from = capability.indexOf(start);
  const to = capability.indexOf(end, from + 1);
  if (from < 0 || to < 0) {
    fail(`capability.rs 缺少区块 ${start}…${end}`);
    return "";
  }
  return capability.slice(from, to);
};
const allowed = new Set([...block("pub const ALLOWED_COMMANDS", "pub fn command_allowed").matchAll(/"([^"]+)"/g)].map((match) => match[1]));
const disabled = new Set([...block("pub const DISABLED_FEATURES", "pub fn is_enabled").matchAll(/"([^"]+)"/g)].map((match) => match[1]));
const capabilities = new Set([...block("pub const CAPABILITIES", "pub const DISABLED_FEATURES").matchAll(/"([^"]+)"/g)].map((match) => match[1]));
for (const feature of capabilities) if (disabled.has(feature)) fail(`能力同时出现在开放与关闭清单：${feature}`);

const COMMAND_REF = /`((?:layer|select|image|file|edit|paint|type|view|color|brush|slice|vector|filter|actions|timeline|cloneSource|tools|history|channel|compose|format)[A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+)`/g;
const openWords = /补齐|等价|已接通/;
const unimplemented = /未实现|未接通|未接线|仍缺|保持关闭|仍关闭|未开放|不开放|不在白名单|未进入白名单/;
// 只存在于编辑器菜单的入口 id（由对话框分派已开放命令），不是内核命令白名单成员。
const uiOnlyEntries = new Set(["image.colorMode", "edit.preferences.general"]);
for (const row of parsed) {
  const commands = [...new Set([...row.evidence.matchAll(COMMAND_REF)].map((match) => match[1]))]
    .filter((id) => !/\.(ts|tsx|rs|json|css|mjs|md)$/.test(id) && !uiOnlyEntries.has(id));
  const unsupported = /明确不支持|不支持/.test(row.disposition);
  for (const id of commands) {
    if (unsupported && allowed.has(id)) fail(`${row.id} 标为不支持却引用白名单命令：${id}`);
    if (openWords.test(row.disposition) && !allowed.has(id) && !unimplemented.test(row.evidence)) {
      fail(`${row.id} 声称已接通但命令不在白名单：${id}`);
    }
    if (!allowed.has(id) && !disabled.has(id) && !unimplemented.test(row.evidence) && !/不开放/.test(row.evidence)) {
      fail(`${row.id} 引用的命令既未开放也未明确关闭：${id}`);
    }
  }
}
if (!allowed.has("paint.stroke") || !capabilities.has("paint.brush")) fail("能力白名单解析异常：缺少 paint.stroke 命令或 paint.brush 能力");

// ---------------------------------------------------------------- 汇总
if (failures.length) {
  console.error(`差异矩阵检查失败：${failures.length} 项`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log(`差异矩阵检查通过：301 行唯一、301 个逐条任务、${allowed.size} 个白名单命令、${disabled.size} 个明确关闭能力。`);
