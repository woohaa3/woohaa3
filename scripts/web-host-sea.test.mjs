import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { createPayload, seaConfig, PAYLOAD_ASSET } from './lib/web-host-sea.mjs';

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-host-payload-'));
  fs.writeFileSync(path.join(root, 'web-host.mjs'), 'export {};\n');
  fs.writeFileSync(path.join(root, 'backend.cjs'), 'module.exports={};\n');
  fs.mkdirSync(path.join(root, 'frontend'));
  fs.writeFileSync(path.join(root, 'frontend/index.html'), '<html></html>');
  fs.mkdirSync(path.join(root, 'extensions/demo/dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'extensions/demo/extension.json'), '{}');
  fs.writeFileSync(path.join(root, 'extensions/demo/dist/backend.js'), 'export {};\n');
  fs.mkdirSync(path.join(root, 'scripts/lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts/lib/x.mjs'), 'export {};\n');
  // 这两项绝不能进 payload：运行时（承载它的可执行文件本身）与运行期数据。
  fs.mkdirSync(path.join(root, 'node'));
  fs.writeFileSync(path.join(root, 'node/woohaa-node'), 'binary');
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/task.sqlite'), 'user-data');
  return root;
};

/** 读 tar 里的条目名（payload 用系统 tar 生成，这里只做一次列表校验）。 */
function listArchive(file) {
  return execFileSync('tar', ['-tzf', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
}

test('payload carries the runtime layout but never node runtime or user data', () => {
  const root = fixture();
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'web-host-out-')), 'payload.tar.gz');
  try {
    const payload = createPayload(root, out);
    assert.ok(payload.bytes > 0);
    assert.match(payload.sha256, /^[0-9a-f]{64}$/);
    const entries = listArchive(out);
    const has = (suffix) => entries.some((entry) => entry.replace(/^\.\//, '').endsWith(suffix));
    assert.ok(has('web-host.mjs'), '启动器必须进 payload');
    assert.ok(has('backend.cjs'), '后端产物必须进 payload');
    assert.ok(has('frontend/index.html'));
    assert.ok(has('extensions/demo/extension.json'), '扩展声明必须在 payload 里，否则解压后会被扫描器跳过');
    assert.ok(has('scripts/lib/x.mjs'), '扩展宿主脚本必须进 payload');
    // 这两条是关键回归：带上 node/ 会让产物翻倍，带上 data/ 会把用户数据打进分发包。
    assert.ok(!has('node/woohaa-node'), 'node/ 不能进 payload');
    assert.ok(!has('data/task.sqlite'), 'data/ 不能进 payload');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('payload rejects an incomplete resource layout', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-host-bad-'));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'web-host-out2-')), 'p.tar.gz');
  try {
    fs.writeFileSync(path.join(root, 'web-host.mjs'), 'export {};\n');
    assert.throws(() => createPayload(root, out), /资源目录不完整/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('sea config embeds exactly one compressed payload asset', () => {
  const config = seaConfig({ main: '/tmp/main.cjs', payload: '/tmp/payload.tar.gz', output: '/tmp/x.blob' });
  assert.equal(config.main, '/tmp/main.cjs');
  assert.deepEqual(Object.keys(config.assets), [PAYLOAD_ASSET]);
  assert.equal(config.assets[PAYLOAD_ASSET], '/tmp/payload.tar.gz');
  // 实验性告警必须关掉：它会把 stderr 弄脏，干扰运维判断日志。
  assert.equal(config.disableExperimentalSEAWarning, true);
});

test('payload is gzip so embedding does not inflate the binary', () => {
  const root = fixture();
  // 塞一段高压缩比内容，确认确实走了 gzip（tar 未压缩时体积会接近原始大小）。
  fs.writeFileSync(path.join(root, 'frontend/big.js'), 'x'.repeat(2 * 1024 * 1024));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'web-host-out3-')), 'p.tar.gz');
  try {
    const payload = createPayload(root, out);
    assert.ok(payload.bytes < 512 * 1024, `2MB 重复内容压缩后应远小于 512KB，实际 ${payload.bytes}`);
    // gzip 魔数
    const head = fs.readFileSync(out).subarray(0, 2);
    assert.equal(head[0], 0x1f);
    assert.equal(head[1], 0x8b);
    assert.ok(zlib.gunzipSync(fs.readFileSync(out)).length > 2 * 1024 * 1024);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('sea main is CommonJS because SEA cannot run an ESM entry', () => {
  const file = path.resolve(import.meta.dirname, 'sea-main.cjs');
  const source = fs.readFileSync(file, 'utf8');
  // SEA 对 .mjs main 会当 CJS 解析并抛 "Cannot use import statement outside a module"。
  assert.ok(!/^\s*import\s/m.test(source), 'sea-main.cjs 不能使用 import 语句');
  assert.ok(!/\bexport\s+(?:default|const|function)\b/.test(source), 'sea-main.cjs 不能使用 export');
  assert.match(source, /require\('node:sea'\)/);
  // 必须用 pathToFileURL + 绝对路径动态 import：SEA 里相对 import() 一律找不到模块。
  assert.match(source, /pathToFileURL/);
});
