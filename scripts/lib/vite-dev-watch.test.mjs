import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { devWatchResilience } from './vite-dev-watch.mjs';

const require = createRequire(new URL('../../web/frontend/package.json', import.meta.url));
const { createServer } = await import(pathToFileURL(path.join(path.dirname(require.resolve('vite/package.json')), 'dist/node/index.js')));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

test('构建目录重写与 EBUSY 不关闭 Vite，源码仍能热更新', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'woohaa-watch-'));
  const outDir = path.join(root, 'dist');
  const source = path.join(root, 'source.js');
  await fs.mkdir(outDir);
  await fs.writeFile(path.join(root, 'index.html'), '<script type="module" src="/source.js"></script>');
  await fs.writeFile(source, 'export const value = 1;');
  await fs.writeFile(path.join(outDir, 'font.otf'), 'old output');
  const warnings = [];
  const plugin = devWatchResilience({ outDir });
  const server = await createServer({ root, configFile: false, plugins: [plugin], logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(async () => { await server.close(); await fs.rm(root, { recursive: true, force: true }); });
  server.config.logger.warn = message => warnings.push(message);
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await fetch(origin + '/source.js');
  const changes = [];
  server.watcher.on('change', file => changes.push(file));
  server.watcher.emit('error', Object.assign(new Error('locked font'), { code: 'EBUSY', filename: path.join(outDir, 'font.otf') }));
  server.watcher.emit('error', Object.assign(new Error('locked source'), { code: 'EBUSY', path: source }));
  // Give the source watch retry time to reattach before checking real filesystem events.
  await pause(250);
  await fs.rm(outDir, { recursive: true });
  await fs.mkdir(outDir);
  await fs.writeFile(path.join(outDir, 'font.otf'), 'new output');
  await fs.writeFile(source, 'export const value = 2;');
  for (let attempt = 0; attempt < 30 && !changes.includes(source); attempt++) await pause(50);
  assert.ok(changes.includes(source), 'source watching must survive the transient error');
  assert.ok(changes.every(file => !file.startsWith(outDir + path.sep)));
  assert.equal(warnings.length, 2);
  assert.equal((await fetch(origin)).status, 200);
  assert.match(await (await fetch(origin + '/source.js')).text(), /value = 2/);
});

test('EBUSY 重试有上限，关闭清理；其它错误不伪装成临时文件锁', async () => {
  const watcher = new EventEmitter();
  let additions = 0;
  watcher.unwatch = async () => {};
  watcher.add = () => additions++;
  const errors = [];
  const plugin = devWatchResilience({ outDir: path.resolve('dist') });
  plugin.configureServer({ watcher, config: { logger: { warn() {}, error: message => errors.push(message) } } });
  const busy = Object.assign(new Error('locked'), { code: 'EBUSY', path: path.resolve('source.js') });
  for (let index = 0; index < 4; index++) watcher.emit('error', busy);
  assert.equal(errors.length, 1);
  assert.throws(() => watcher.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' })), /denied/);
  plugin.closeBundle();
  await pause(150);
  assert.equal(additions, 0);
  assert.equal(watcher.listenerCount('error'), 0);
});
