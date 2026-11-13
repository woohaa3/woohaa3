import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizedTextSha256 } from './text-sha256.mjs';

test('CRLF 与 LF 得到同一摘要：Windows checkout 不会让 lock 指纹失效', () => {
  const lf = 'lockfileVersion: \'9.0\'\nsettings:\n  autoInstallPeers: true\n';
  assert.equal(normalizedTextSha256(lf), normalizedTextSha256(lf.replace(/\n/g, '\r\n')));
});

test('孤立 CR 也归一化', () => {
  assert.equal(normalizedTextSha256('a\rb'), normalizedTextSha256('a\nb'));
});

test('其它字节变化仍会改变摘要', () => {
  assert.notEqual(normalizedTextSha256('a: 1\n'), normalizedTextSha256('a: 2\n'));
});
