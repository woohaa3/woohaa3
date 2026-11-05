import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/webview-performance.js', import.meta.url), 'utf8');
function boot(enabled = true, fetch = async () => ({ ok: true, json: async () => ({ ok: true }) }), extra = {}) {
  const calls = [], timers = [];
  const window = { __WOOHAA_NATIVE__: { token: 'test-token', platform: 'macos', performanceCapture: enabled }, addEventListener() {} };
  window.top = window; window.self = window;
  const context = { window, fetch: (...args) => { calls.push(args); return fetch(...args); }, setInterval: fn => timers.push(fn), setTimeout: () => 0, clearTimeout() {}, AbortController, JSON, Error, ...extra };
  vm.runInNewContext(source, context);
  return { window, calls, timers, context };
}
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
test('disabled capture installs no sink or timer', () => {
  const b = boot(false); assert.equal(b.window.__woohaaPerformance, undefined); assert.equal(b.timers.length, 0);
});
test('bounded batches carry the token and report overflow without concurrent uploads', async () => {
  let finish;
  const b = boot(true, () => new Promise(resolve => { finish = resolve; }));
  for (let i = 0; i < 1200; i++) b.window.__woohaaPerformance({ frame: i });
  b.timers[0](); b.timers[0](); assert.equal(b.calls.length, 1);
  const payload = JSON.parse(b.calls[0][1].body);
  assert.equal(payload.samples.length, 128); assert.equal(payload.dropped, 176);
  assert.equal(b.calls[0][1].headers['X-Woohaa-Token'], 'test-token');
  finish({ ok: true, json: async () => ({ ok: true }) }); await settle();
  b.timers[0](); assert.equal(b.calls.length, 2);
  vm.runInNewContext(source, b.context); assert.equal(b.timers.length, 1);
});
test('failed delivery is counted on the next batch instead of blocking editing', async () => {
  const b = boot(true, async () => { throw Error('offline'); });
  b.window.__woohaaPerformance({ frame: 1 }); b.timers[0](); await settle();
  b.window.__woohaaPerformance({ frame: 2 }); b.timers[0]();
  assert.equal(JSON.parse(b.calls[1][1].body).dropped, 1);
});
test('unsupported APIs and empty capture emit explicit metadata', async () => {
  const b = boot(); b.timers[0](); await settle();
  const payload = JSON.parse(b.calls[0][1].body);
  assert.equal(payload.samples.length, 0);
  assert.equal(payload.capabilities.performance, 'unsupported');
  assert.equal(payload.capabilities.longtask, 'unsupported');
  assert.equal(payload.capabilities.clockPair, 'not-collected');
});
test('transport failure with no samples retries metadata', async () => {
  const b = boot(true, async () => { throw Error('offline'); });
  b.timers[0](); await settle(); b.timers[0]();
  assert.equal(b.calls.length, 2);
});

test('runtime clock pairing records roundtrip uncertainty and supported API states', async () => {
  let now = 10;
  const b = boot(true, async url => ({ ok: true, json: async () => url.endsWith('performance-clock')
    ? { epochMs: 10000, monotonicMs: 30, uncertaintyMs: .1 } : { ok: true } }),
  { performance: { timeOrigin: 10000, now: () => now++ }, requestAnimationFrame() {}, PerformanceObserver: { supportedEntryTypes: ['longtask'] } });
  await settle(); b.timers[0](); await settle();
  const payload = JSON.parse(b.calls.find(([url]) => url.endsWith('/performance'))[1].body);
  assert.equal(payload.capabilities.clockPair, 'collected');
  assert.equal(payload.capabilities.longtask, 'not-collected');
  assert.equal(payload.clockPair.uncertaintyMs, .6);
  assert.equal(payload.clockPair.webviewEpochMs, 10010.5);
});
