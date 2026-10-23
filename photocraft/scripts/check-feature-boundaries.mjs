/**
 * 功能边界等价性检查（重构门禁）。
 *
 * 基线 `tests/fixtures/feature-boundary-baseline.json` 与 `tests/fixtures/feature-boundary-wasm-baseline.json` 是
 * 重构前提交 `bdc3c084` 的**冻结证据**：它们证明 `2026-10-22-refactor-photocraft-feature-boundaries`
 * 只重组了代码，没有顺手改变命令白名单、能力握手、错误文案、内容 hash、撤销/重做或导出的 PNG 字节。
 *
 * 后续 change 若**有意**新增命令/能力，或必须改动共享文件，只能登记在
 * `tests/fixtures/feature-boundary-additions.json`。本脚本因此同时断言三件事：
 *
 * 1. 基线没有被改写（命令、能力、错误、8 组状态/内容快照、导出摘要、PNG 字节逐项相等）；
 * 2. 运行时的命令表 = 基线命令 + 登记的命令，且顺序插入后仍是同一序列（纯增量，无删除/改序）；
 * 3. 能力握手 = 基线能力 + 登记的能力（同一前缀、同一尾部），共享文件只在登记处允许换哈希。
 *
 * 这样「增量」是来源可查的账，而不是把基线改成当前状态后自证等价。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'packages/editor/dist/wasm');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/feature-boundary-wasm-baseline.json'), 'utf8'));
const contract = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/feature-boundary-baseline.json'), 'utf8'));
// `sharedFiles` 锁定的是「域外共享核心不应被功能域顺手改动」。
// 一次**已发布**的能力批次必须同步 `identity.rs`（新增内容身份）与
// `tests/fixtures/contract.json`（能力清单），重新锚定基线属该批次的收尾动作，
// 不是漂移；除此之外这些文件仍必须逐字节保持不变。
const additions = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/feature-boundary-additions.json'), 'utf8'));

// 冻结证据只允许登记其原始摘要，不能用当前输出重写基线。
for (const [file, expected] of Object.entries(additions.frozenBaselines)) {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'tests/fixtures', file))).digest('hex'), expected, `${file} 冻结证据被改写`);
}

const hashOf = (file) =>
  crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.resolve(root, '..', file), 'utf8').replaceAll('\r\n', '\n'))
    .digest('hex');

// 1) 共享文件：未登记的必须与重构前基线逐字节相同；登记的必须等于登记后的哈希且写了理由。
const allowed = additions.sharedFiles ?? {};
for (const [file, expected] of Object.entries(contract.sharedFiles)) {
  const entry = allowed[file];
  if (entry === undefined) {
    assert.equal(hashOf(file), expected, `${file} drifted from the pre-refactor baseline`);
    continue;
  }
  assert.ok(entry.reason && entry.reason.trim().length > 0, `${file} 的基线漂移必须写明理由`);
  assert.equal(hashOf(file), entry.sha256, `${file} 与登记的新哈希不一致`);
}
for (const file of Object.keys(allowed)) {
  if (file === '$comment') continue;
  assert.ok(file in contract.sharedFiles, `${file} 不是基线的共享文件，不该登记为漂移`);
}

const mod = await import(pathToFileURL(path.join(source, 'photocraft_editor.js')));
mod.initSync({ module: fs.readFileSync(path.join(source, 'photocraft_editor_bg.wasm')) });
const e = new mod.WasmEditor();
const snap = {
  build: JSON.parse(mod.WasmEditor.buildInfoJson()),
  commands: JSON.parse(e.allowedCommandIdsJson()),
  capabilities: JSON.parse(e.capabilityHandshakeJson()),
  steps: []
};
const capture = (name) => {
  const state = JSON.parse(e.stateJson());
  snap.steps.push({ name, hash: e.contentHash(), state });
};
e.execute('file.new', JSON.stringify({ width: 32, height: 24, name: 'Boundary baseline' }));
capture('new');
e.execute('select.rect', JSON.stringify({ x: 2, y: 3, width: 10, height: 8, mode: 'replace' }));
capture('selection');
e.execute('layer.new.layer', JSON.stringify({ name: 'paint' }));
capture('layer');
e.execute('paint.stroke', JSON.stringify({
  points: [[4, 5], [7, 9]], size: 3, hardness: 1, opacity: 1, flow: 1, color: '#ff0000', target: 'pixels'
}));
capture('stroke');
e.undo();
capture('undo');
e.redo();
capture('redo');
e.beginSelectionModify(JSON.stringify({ operation: 'expand', radius: 2 }));
e.cancelSelectionModify();
capture('cancel-selection');
const before = e.contentHash();
e.beginFilter('filter.blur.gaussianBlur', JSON.stringify({ radius: 2 }));
e.cancelFilter();
capture('cancel-filter');
if (e.contentHash() !== before) throw Error('cancel changed content');
snap.errors = [];
for (const id of ['unknown.command', 'filter.liquify', 'file.automate.batch']) {
  try {
    e.execute(id, '{}');
    throw Error('unexpected success');
  } catch (error) {
    snap.errors.push({ id, error: String(error) });
  }
}
const bundle = e.exportBundle();
snap.output = {
  hash: bundle.documentContentHash,
  revision: bundle.revision,
  projectLength: bundle.project.length,
  png: crypto.createHash('sha256').update(bundle.output).digest('hex')
};
bundle.free();
e.free();

// 2) 除「命令」与「能力」两处登记增量外，快照必须与冻结基线逐项相同。
assert.deepEqual(snap.build, baseline.build, 'buildInfo 变了');
assert.deepEqual(snap.steps, baseline.steps, '8 组内容/状态快照或内容 hash 变了');
assert.deepEqual(snap.errors, baseline.errors, '错误文案变了（错误是契约的一部分）');
assert.deepEqual(snap.output, baseline.output, '导出摘要或 PNG 字节变了');

// 3) 命令表 = 基线 + 登记，且在保留基线顺序的前提下仍按同一排序插入。
const registeredCommands = [...additions.commands].sort();
const baselineCommands = new Set(baseline.commands);
const addedCommands = snap.commands.filter((id) => !baselineCommands.has(id)).sort();
const removedCommands = baseline.commands.filter((id) => !snap.commands.includes(id));
assert.deepEqual(removedCommands, [], '不得删除基线命令');
assert.deepEqual(addedCommands, registeredCommands, '新增命令必须与登记清单完全一致');
assert.deepEqual(
  snap.commands.filter((id) => baselineCommands.has(id)),
  baseline.commands,
  '既有命令的相对顺序不得改变'
);
assert.deepEqual(snap.commands, [...snap.commands].sort(), '命令表必须保持排序');

// 4) 能力握手 = 基线 + 登记（前缀不变，尾部是登记项，其余字段逐项相同）。
const registered = new Set(additions.capabilities);
const baselineCapabilities = new Set(baseline.capabilities.capabilities);
const addedCapabilities = snap.capabilities.capabilities.filter((id) => !baselineCapabilities.has(id));
assert.deepEqual(addedCapabilities, additions.capabilities, '新增能力必须与登记清单完全一致');
assert.deepEqual(
  snap.capabilities.capabilities.filter((id) => baselineCapabilities.has(id)),
  baseline.capabilities.capabilities,
  '既有能力的相对顺序不得改变'
);
assert.deepEqual(
  { ...snap.capabilities, capabilities: null },
  { ...baseline.capabilities, capabilities: null },
  '能力握手的阶段/非目标清单变了'
);
assert.equal(registered.size, additions.capabilities.length, '登记的能力 id 不能重复');

console.log(
  `Feature boundary equivalence: build info, errors, 8 content/state snapshots, undo/redo/cancel and PNG bytes match bdc3c084; ` +
    `${additions.commands.length} commands and ${additions.capabilities.length} capabilities are the registered ${additions.change} increment.`
);
