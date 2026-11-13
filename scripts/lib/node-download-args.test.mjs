import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeDownloadArgs } from './node-download-args.mjs';

const base = ['-sS', '--fail', '--location', '--retry', '5', '--retry-delay', '2'];

test('新版 curl：带上 --retry-all-errors，让传输中断也能重试', () => {
  const args = nodeDownloadArgs('https://example.test/a.tgz', '/tmp/a.tgz', { probe: () => true });
  assert.deepEqual(args, [...base, '--retry-all-errors', '--continue-at', '-', 'https://example.test/a.tgz', '-o', '/tmp/a.tgz']);
});

test('旧版 curl（Windows Server 自带 7.55）：不传它不认识的选项', () => {
  const args = nodeDownloadArgs('https://example.test/a.tgz', '/tmp/a.tgz', { probe: () => false });
  assert.ok(!args.includes('--retry-all-errors'));
  // 静默进度与断点续传仍然保留：老版本 curl 都支持。
  assert.ok(args.includes('-sS'));
  assert.deepEqual(args.slice(-5), ['--continue-at', '-', 'https://example.test/a.tgz', '-o', '/tmp/a.tgz']);
});

test('探测结果按 curl 路径传入探测函数', () => {
  let probed = null;
  nodeDownloadArgs('https://example.test/a.tgz', '/tmp/a.tgz', { curl: 'curl.exe', probe: (binary) => { probed = binary; return false; } });
  assert.equal(probed, 'curl.exe');
});
