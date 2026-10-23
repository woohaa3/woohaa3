/**
 * 特征边界漂移检测：把重构前基线 `tests/fixtures/feature-boundary-wasm-baseline.json` 与当前真实产物
 * 逐字段比对，并列出差异。
 *
 * 为什么需要它：`pnpm run features:check` 在基线刷新前**必然失败**（基线是重构前快照），失败信息
 * 只打印断言 diff，无法一眼看出「差异是否只该是本 change 新增的命令」。这个脚本把差异归因打印出来：
 * `build` / `capabilities` / `steps` / `errors` / `output` 必须完全一致，`commands` 只允许多出
 * 本 change 新增的命令、不允许删除。
 *
 * 用法（在 photocraft/ 下，先 `pnpm run wasm`）：
 *   node scripts/evidence/feature-boundary-drift.mjs
 * 退出码：0 = 漂移仅限新增命令；1 = 出现不该有的漂移（字段不一致或有命令被删）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
const root = process.cwd();
const source = path.join(root, 'packages/editor/dist/wasm');
const baseline = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/feature-boundary-wasm-baseline.json'), 'utf8'));
const mod = await import(pathToFileURL(path.join(source, 'photocraft_editor.js')));
mod.initSync({ module: fs.readFileSync(path.join(source, 'photocraft_editor_bg.wasm')) });
const e = new mod.WasmEditor();
const snap = { build: JSON.parse(mod.WasmEditor.buildInfoJson()), commands: JSON.parse(e.allowedCommandIdsJson()), capabilities: JSON.parse(e.capabilityHandshakeJson()), steps: [] };
const capture = (name) => { const state = JSON.parse(e.stateJson()); snap.steps.push({ name, hash: e.contentHash(), state }); };
e.execute('file.new', JSON.stringify({ width: 32, height: 24, name: 'Boundary baseline' })); capture('new');
e.execute('select.rect', JSON.stringify({ x: 2, y: 3, width: 10, height: 8, mode: 'replace' })); capture('selection');
e.execute('layer.new.layer', JSON.stringify({ name: 'paint' })); capture('layer');
e.execute('paint.stroke', JSON.stringify({ points: [[4, 5], [7, 9]], size: 3, hardness: 1, opacity: 1, flow: 1, color: '#ff0000', target: 'pixels' })); capture('stroke');
e.undo(); capture('undo'); e.redo(); capture('redo');
e.beginSelectionModify(JSON.stringify({ operation: 'expand', radius: 2 })); e.cancelSelectionModify(); capture('cancel-selection');
const before = e.contentHash(); e.beginFilter('filter.blur.gaussianBlur', JSON.stringify({ radius: 2 })); e.cancelFilter(); capture('cancel-filter');
snap.errors = []; for (const id of ['unknown.command', 'filter.liquify', 'file.automate.batch']) { try { e.execute(id, '{}'); throw Error('unexpected success'); } catch (error) { snap.errors.push({ id, error: String(error) }); } }
const bundle = e.exportBundle();
snap.output = { hash: bundle.documentContentHash, revision: bundle.revision, projectLength: bundle.project.length, png: crypto.createHash('sha256').update(bundle.output).digest('hex') };
bundle.free(); e.free();
const cmp = (k) => JSON.stringify(snap[k]) === JSON.stringify(baseline[k]);
console.log('build equal:', cmp('build'));
console.log('commands equal:', cmp('commands'), '| baseline', baseline.commands.length, '| now', snap.commands.length);
console.log('capabilities equal:', cmp('capabilities'));
console.log('steps equal:', cmp('steps'));
console.log('errors equal:', cmp('errors'));
console.log('output equal:', cmp('output'));
const added = snap.commands.filter((c) => !baseline.commands.includes(c));
const removed = baseline.commands.filter((c) => !snap.commands.includes(c));
console.log('added:', added.length, '(filter.*:', added.filter((c) => c.startsWith('filter.')).length + ')', '| removed:', removed.length);
if (!cmp('capabilities')) {
  const a = new Set(baseline.capabilities.capabilities ?? baseline.capabilities);
  const b = new Set(snap.capabilities.capabilities ?? snap.capabilities);
  console.log('  caps added:', [...b].filter((c) => !a.has(c)));
  console.log('  caps removed:', [...a].filter((c) => !b.has(c)));
}
if (!cmp('output')) console.log('  baseline output:', JSON.stringify(baseline.output), '\n  now output:', JSON.stringify(snap.output));

const bad = !cmp('build') || !cmp('capabilities') || !cmp('steps') || !cmp('errors') || !cmp('output') || removed.length > 0;
process.exit(bad ? 1 : 0);
