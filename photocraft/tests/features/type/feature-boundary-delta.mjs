/**
 * 文字域对重构基线的增量核对（change: 2026-10-22-add-photocraft-typography-workflows）。
 *
 * `pnpm -C photocraft features:check` 的断言是**全等**基线快照：`tests/fixtures/feature-boundary-wasm-baseline.json`
 * 记录重构当时的命令白名单、能力握手、8 组状态/内容 hash、撤销/重做/取消、拒绝错误与 PNG 字节。
 * 本 change 有意新增文字域命令，所以该脚本必然在全等比较上失败；而基线快照属共享冻结文件，
 * 本域不能改。为了不把「已知且预期的差异」和「悄悄改坏的东西」混在一起，这里独立跑同一场景，逐项报告：
 *
 * - 共享文件摘要（limits / fixture / identity / 两个锁文件）必须与基线一致；
 * - 构建信息、能力握手、8 组状态与内容 hash、撤销/重做/取消、拒绝错误、导出摘要与 PNG 字节
 *   必须与基线逐字节一致；
 * - 命令白名单只允许**增加**本域 48 个 id，不允许减少或改动其它域的命令。
 *
 * 用法（先构建真实 WASM）：
 *
 *   pnpm -C photocraft run wasm
 *   node photocraft/tests/features/type/feature-boundary-delta.mjs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");
const source = path.join(root, "packages/editor/dist/wasm");
const glue = path.join(source, "photocraft_editor.js");
const wasm = path.join(source, "photocraft_editor_bg.wasm");
if (!fs.existsSync(glue) || !fs.existsSync(wasm)) {
  console.error("缺少已构建内核：先运行 pnpm -C photocraft run wasm");
  process.exit(2);
}

/**
 * 本 change 新增的域命令（与 `features/type/params.rs` 两张白名单一致）。
 * 与 `typecraft-smoke.mjs` 共用同一份清单：冒烟脚本据此核对每条命令都在真实内核上真的执行过，
 * 避免「清单里登记了但没人跑」。
 */
const TYPE_COMMANDS = JSON.parse(fs.readFileSync(path.join(here, "type-commands.json"), "utf8")).commands;

const failures = [];
const fail = (message) => failures.push(message);
const same = (label, actual, expected) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} 与基线不一致`);
};

// 1. 共享文件摘要：本域不得改动冻结文件。
//
// 例外只有两个，且是本 change 任务 3.2 明确授权的「内容身份」接入点：
//
// - `tests/fixtures/contract.json`：新增排版内容的跨语言基线（`contentHashes.typography*`）。
//   原有基线项一律未动，Rust 与 TS 仍复现 `projectContentHash`。
// - `crates/editor-core/src/identity.rs`：`canonicalize_text` 放行本域新增的排版键（含逐 run
//   摘要 `charRuns`/`paragraphRuns`），`canonicalize` 放行文档级 `textStyles` 行。
//   取值与默认值折叠都在 `features/type/content.rs`，这里只做校验与拼接。
//
// 两者的新摘要固定在下面；除此之外的任何漂移（顺序、空白、别的键）仍然失败——
// 这样「已授权的共享接入」和「悄悄改坏共享文件」不会混在一起。
const AUTHORIZED_SHARED = {
  "photocraft/tests/fixtures/contract.json": "9332f7c7d840c93505be4454c040b3bbc537171fc8744c52e003abb8892076a1",
  "photocraft/rust/crates/editor-core/src/identity.rs": "f0f3848e1440d29672bed60204ea354285eedbd208f40bbe9b78c2ce794fbfec"
};
const contract = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/feature-boundary-baseline.json"), "utf8"));
for (const [file, expected] of Object.entries(contract.sharedFiles)) {
  const bytes = fs.readFileSync(path.resolve(root, "..", file), "utf8").replaceAll("\r\n", "\n");
  const actual = crypto.createHash("sha256").update(bytes).digest("hex");
  if (actual === expected) continue;
  const authorized = AUTHORIZED_SHARED[file];
  if (authorized === undefined) {
    fail(`共享文件 ${file} 相对基线漂移，且不属于本 change 的授权接入点`);
  } else if (actual !== authorized) {
    fail(`共享文件 ${file} 已授权变更后又继续漂移`);
  }
}

const baseline = JSON.parse(fs.readFileSync(path.join(root, "tests/fixtures/feature-boundary-wasm-baseline.json"), "utf8"));
const mod = await import(glue);
mod.initSync({ module: fs.readFileSync(wasm) });
const editor = new mod.WasmEditor();

// 2. 与 scripts/check-feature-boundaries.mjs 完全同一个场景。
const snapshot = {
  build: JSON.parse(mod.WasmEditor.buildInfoJson()),
  commands: JSON.parse(editor.allowedCommandIdsJson()),
  capabilities: JSON.parse(editor.capabilityHandshakeJson()),
  steps: []
};
const capture = (name) => snapshot.steps.push({ name, hash: editor.contentHash(), state: JSON.parse(editor.stateJson()) });
editor.execute("file.new", JSON.stringify({ width: 32, height: 24, name: "Boundary baseline" }));
capture("new");
editor.execute("select.rect", JSON.stringify({ x: 2, y: 3, width: 10, height: 8, mode: "replace" }));
capture("selection");
editor.execute("layer.new.layer", JSON.stringify({ name: "paint" }));
capture("layer");
editor.execute("paint.stroke", JSON.stringify({ points: [[4, 5], [7, 9]], size: 3, hardness: 1, opacity: 1, flow: 1, color: "#ff0000", target: "pixels" }));
capture("stroke");
editor.undo();
capture("undo");
editor.redo();
capture("redo");
editor.beginSelectionModify(JSON.stringify({ operation: "expand", radius: 2 }));
editor.cancelSelectionModify();
capture("cancel-selection");
const beforeCancel = editor.contentHash();
editor.beginFilter("filter.blur.gaussianBlur", JSON.stringify({ radius: 2 }));
editor.cancelFilter();
capture("cancel-filter");
if (editor.contentHash() !== beforeCancel) fail("取消滤镜改变了内容身份");
snapshot.errors = [];
for (const id of ["unknown.command", "filter.liquify", "file.automate.batch"]) {
  try {
    editor.execute(id, "{}");
    fail(`未开放命令 ${id} 意外成功`);
  } catch (error) {
    snapshot.errors.push({ id, error: String(error) });
  }
}
const bundle = editor.exportBundle();
snapshot.output = {
  hash: bundle.documentContentHash,
  revision: bundle.revision,
  projectLength: bundle.project.length,
  png: crypto.createHash("sha256").update(bundle.output).digest("hex")
};
bundle.free();
editor.free();

same("构建信息", snapshot.build, baseline.build);
same("能力握手", snapshot.capabilities, baseline.capabilities);
same("8 组状态与内容 hash", snapshot.steps, baseline.steps);
same("拒绝错误", snapshot.errors, baseline.errors);
same("导出摘要与 PNG 字节", snapshot.output, baseline.output);

// 3. 命令白名单：只允许加入本域 48 个 id，不得减少或替换其它域命令。
const added = snapshot.commands.filter((id) => !baseline.commands.includes(id)).sort();
const removed = baseline.commands.filter((id) => !snapshot.commands.includes(id));
const expected = [...TYPE_COMMANDS].sort();
if (JSON.stringify(added) !== JSON.stringify(expected)) {
  fail(`新增命令与预期不一致：多出 ${JSON.stringify(added.filter((id) => !expected.includes(id)))}，缺少 ${JSON.stringify(expected.filter((id) => !added.includes(id)))}`);
}
if (removed.length) fail(`命令白名单被移除：${JSON.stringify(removed)}`);
if (snapshot.commands.length !== baseline.commands.length + expected.length) {
  fail(`命令总数 ${snapshot.commands.length} != 基线 ${baseline.commands.length} + 本域 ${expected.length}`);
}

if (failures.length) {
  console.error(`文字域基线增量核对失败 ${failures.length} 项：`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log(
  `文字域基线增量核对通过：共享文件未漂移，构建/能力/8 组状态与 hash/撤销重做取消/拒绝错误/PNG 与基线全等，` +
    `命令白名单仅新增本域 ${expected.length} 个（${baseline.commands.length} → ${snapshot.commands.length}），无移除。`
);
