import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createRuntimeComponentManager } from './index.mjs';
import { extractNpmTarball, planLayout, registryTarballUrl, verifyIntegrity } from './npm-registry.mjs';

const BLOCK = 512;
function header({ name, mode = 0o755, size = 0, type = '0' }) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write('00000000000\0', 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return block;
}
function pad(bytes) {
  const rest = (BLOCK - (bytes.length % BLOCK)) % BLOCK;
  return rest ? Buffer.concat([bytes, Buffer.alloc(rest)]) : bytes;
}
function paxRecord(name, value) {
  const body = ` ${name}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (true) {
    const record = `${length}${body}`;
    if (Buffer.byteLength(record) === length) return Buffer.from(record);
    length += 1;
  }
}
/** npm 风格 tarball：所有文件在 `package/` 下。 */
function npmTarball(files) {
  const chunks = [];
  for (const file of files) {
    let name = `package/${file.path}`;
    if (Buffer.byteLength(name) > 100) {
      const record = paxRecord('path', name);
      chunks.push(header({ name: 'PaxHeader', size: record.length, type: 'x' }), pad(record));
      name = `package/${file.path.slice(-90)}`;
    }
    const data = Buffer.from(file.content ?? '');
    if (file.path.endsWith('/')) chunks.push(header({ name, type: '5', size: 0 }));
    else chunks.push(header({ name, size: data.length, mode: file.mode ?? 0o644 }), pad(data));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(chunks));
}
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

function packageJson(name, version, extra = {}) {
  return JSON.stringify({ name, version, ...extra });
}

function fixtureLock({ id = 'tool', platform = process.platform, arch = process.arch } = {}) {
  const key = `${platform}-${arch}`;
  const exe = platform === 'win32' ? '.exe' : '';
  const packages = {
    '@fixture/tool@1.0.0': {
      name: '@fixture/tool', version: '1.0.0', integrity: '',
      dependencies: [
        { name: '@fixture/a', target: '@fixture/a@1.0.0', optional: false },
        { name: '@fixture/b', target: '@fixture/b@1.0.0', optional: false },
        { name: '@fixture/bin', target: '@fixture/bin@1.0.0', optional: true }
      ]
    },
    '@fixture/a@1.0.0': { name: '@fixture/a', version: '1.0.0', integrity: '', dependencies: [{ name: '@fixture/c', target: '@fixture/c@1.0.0', optional: false }] },
    '@fixture/b@1.0.0': { name: '@fixture/b', version: '1.0.0', integrity: '', dependencies: [{ name: '@fixture/c', target: '@fixture/c@2.0.0', optional: false }] },
    '@fixture/c@1.0.0': { name: '@fixture/c', version: '1.0.0', integrity: '', dependencies: [] },
    '@fixture/c@2.0.0': { name: '@fixture/c', version: '2.0.0', integrity: '', dependencies: [] },
    '@fixture/bin@1.0.0': { name: '@fixture/bin', version: '1.0.0', integrity: '', dependencies: [], os: [platform], cpu: [arch] }
  };
  const files = new Map([
    ['@fixture/tool@1.0.0', [{ path: 'package.json', content: packageJson('@fixture/tool', '1.0.0', { dependencies: { '@fixture/a': '1.0.0', '@fixture/b': '1.0.0' } }) }]],
    ['@fixture/a@1.0.0', [{ path: 'package.json', content: packageJson('@fixture/a', '1.0.0', { dependencies: { '@fixture/c': '1.0.0' } }) }]],
    ['@fixture/b@1.0.0', [{ path: 'package.json', content: packageJson('@fixture/b', '1.0.0', { dependencies: { '@fixture/c': '2.0.0' } }) }]],
    ['@fixture/c@1.0.0', [{ path: 'package.json', content: packageJson('@fixture/c', '1.0.0') }]],
    ['@fixture/c@2.0.0', [{ path: 'package.json', content: packageJson('@fixture/c', '2.0.0') }]],
    ['@fixture/bin@1.0.0', [
      { path: 'package.json', content: packageJson('@fixture/bin', '1.0.0') },
      { path: 'bin/tool', content: '#!/bin/sh\necho "tool 1.0.0"\n', mode: 0o755 }
    ]]
  ]);
  const tarballs = new Map();
  for (const [packageId, list] of files) {
    const bytes = npmTarball(list);
    packages[packageId].integrity = integrity(bytes);
    tarballs.set(packageId, bytes);
  }
  return {
    key,
    packages,
    tarballs,
    lock: {
      schemaVersion: 1,
      kind: 'woohaa-runtime-npm-lock',
      registry: { default: 'https://registry.npmjs.org/' },
      platforms: [key],
      engines: {
        [id]: {
          id, engine: 'claude-agent-sdk', package: '@fixture/tool', version: '1.0.0', kind: 'executable',
          spaceBytes: 64 * 1024 * 1024,
          entry: { type: 'package-file', package: '@fixture/bin', pattern: 'bin/tool{exe}', probeVersion: '1.0.0' },
          platforms: { [key]: { packages: Object.keys(packages), requests: Object.keys(packages).length } },
          packages,
          scripts: { policy: 'allowlist', ignoredLifecycles: ['prepare'], allowed: [], denied: [] }
        }
      }
    },
    file: { path: `bin/tool${exe}` }
  };
}

async function managerFixture(t, options = {}) {
  const f = fixtureLock(options);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'woohaa-npm-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const toolsDir = path.join(root, 'tools');
  await fs.mkdir(path.join(toolsDir, 'npm/bin'), { recursive: true });
  await fs.writeFile(path.join(toolsDir, 'npm/bin/npm-cli.js'), "process.stdout.write('10.0.0');\n");
  const defaultsPath = path.join(root, 'defaults.json');
  const lockPath = path.join(root, 'lock.json');
  const npmLockPath = path.join(root, 'runtime-npm-lock.json');
  await fs.writeFile(defaultsPath, JSON.stringify({ schemaVersion: 1, components: {} }));
  await fs.writeFile(lockPath, JSON.stringify({ schemaVersion: 1, components: { tool: { version: '1.0.0' } } }));
  await fs.writeFile(npmLockPath, JSON.stringify(f.lock, null, 2));
  const requests = [];
  const urls = new Map();
  for (const [id, bytes] of f.tarballs) {
    const entry = f.packages[id];
    urls.set(registryTarballUrl('https://registry.npmjs.org/', entry.name, entry.version), bytes);
  }
  const fetchImpl = options.fetchImpl ?? (async (url) => {
    requests.push(String(url));
    const bytes = urls.get(String(url));
    return bytes ? new Response(bytes) : new Response('', { status: 404 });
  });
  const manager = createRuntimeComponentManager({
    dataDir: root, defaultsPath, lockPath, npmLockPath, toolsDir,
    platform: process.platform, arch: process.arch,
    fetchImpl
  });
  return { manager, root, toolsDir, f, requests, urls, npmLockPath, lockPath, defaultsPath,
    rebuild: async (changes = {}) => {
      Object.assign(f.lock.engines.tool, changes.lock ?? {});
      await fs.writeFile(npmLockPath, JSON.stringify(f.lock, null, 2));
      return createRuntimeComponentManager({ dataDir: root, defaultsPath, lockPath, npmLockPath, toolsDir, platform: process.platform, arch: process.arch,
        fetchImpl: changes.fetchImpl ?? fetchImpl });
    }
  };
}

test('npm layout keeps conflicting versions resolvable and hoists shared packages', () => {
  const f = fixtureLock();
  const plan = planLayout(f.lock.engines.tool, f.key);
  const byDir = new Map(plan.placements.map((placement) => [placement.dir, placement.id]));
  assert.equal(byDir.get('node_modules/@fixture/tool'), '@fixture/tool@1.0.0');
  assert.equal(byDir.get('node_modules/@fixture/a'), '@fixture/a@1.0.0');
  assert.equal(byDir.get('node_modules/@fixture/b'), '@fixture/b@1.0.0');
  assert.equal(byDir.get('node_modules/@fixture/c'), '@fixture/c@1.0.0');
  assert.equal(byDir.get('node_modules/@fixture/b/node_modules/@fixture/c'), '@fixture/c@2.0.0');
});

test('npm tarball URLs are exact and PAX paths are honoured', async (t) => {
  assert.equal(registryTarballUrl('https://registry.npmjs.org/', '@fixture/tool', '1.0.0'), 'https://registry.npmjs.org/@fixture/tool/-/tool-1.0.0.tgz');
  assert.throws(() => registryTarballUrl('https://registry.npmjs.org/', '@fixture/tool', '^1.0.0'), { code: 'INVALID_CONFIG' });
  assert.throws(() => registryTarballUrl('http://registry.npmjs.org/', '@fixture/tool', '1.0.0'), { code: 'INVALID_CONFIG' });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'woohaa-npm-pax-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const longPath = `${'deep/'.repeat(24)}file.txt`;
  const bytes = npmTarball([{ path: longPath, content: 'pax' }]);
  const file = path.join(root, 'package.tgz');
  await fs.writeFile(file, bytes);
  const destination = path.join(root, 'out');
  await fs.mkdir(destination);
  await extractNpmTarball(file, destination, { maxBytes: 1024 * 1024 });
  assert.equal(await fs.readFile(path.join(destination, longPath), 'utf8'), 'pax');
  assert.throws(() => verifyIntegrity(bytes, 'sha512-AAAA'), { code: 'INVALID_HASH' });
});

test('npm registry install is locked, atomic and reusable offline', async (t) => {
  const f = await managerFixture(t);
  assert.equal((await f.manager.inspect('tool')).status, 'missing');
  const state = await f.manager.install('tool');
  assert.equal(state.status, 'ready', state.error);
  assert.equal(state.source, 'npm-registry');
  assert.equal(f.requests.length, Object.keys(f.f.packages).length);
  assert.ok(f.requests.every((url) => url.startsWith('https://registry.npmjs.org/@fixture/')));
  const handle = await f.manager.resolve('tool');
  assert.match(await fs.readFile(handle.entry, 'utf8'), /tool 1.0.0/);
  const offline = createRuntimeComponentManager({
    dataDir: f.root, defaultsPath: f.defaultsPath, lockPath: f.lockPath, npmLockPath: f.npmLockPath,
    fetchImpl: () => { throw new Error('must be offline'); }
  });
  assert.equal((await offline.inspect('tool')).status, 'ready');
  handle.release();
  assert.equal((await f.manager.remove('tool')).status, 'missing');
});

test('npm registry install shares one job and one set of downloads', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await managerFixture(t);
  const delayed = await f.rebuild({ fetchImpl: async (url) => {
    f.requests.push(String(url));
    await gate;
    return new Response(f.urls.get(String(url)));
  } });
  const first = delayed.install('tool');
  const second = delayed.install('tool');
  release();
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.status, 'ready', left.error);
  assert.equal(right.status, 'ready', right.error);
  assert.equal(f.requests.length, Object.keys(f.f.packages).length);
});

test('npm registry integrity failure never activates a version', async (t) => {
  const f = await managerFixture(t, {
    fetchImpl: async () => new Response(Buffer.from('not a tarball'))
  });
  await assert.rejects(f.manager.install('tool'), { code: 'INVALID_HASH' });
  assert.notEqual((await f.manager.inspect('tool')).status, 'ready');
  await assert.rejects(f.manager.resolve('tool'), { code: 'RUNTIME_COMPONENT_MISSING' });
});

test('npm registry 404 reports the registry and keeps the engine unavailable', async (t) => {
  const f = await managerFixture(t, { fetchImpl: async () => new Response('', { status: 404 }) });
  await assert.rejects(f.manager.install('tool'), { code: 'REGISTRY_UNAVAILABLE' });
  const state = await f.manager.inspect('tool');
  assert.equal(state.status, 'failed');
  assert.match(state.error, /404/);
});

test('npm registry disabled by deployment reports an actionable unavailable state', async (t) => {
  const f = await managerFixture(t);
  const disabled = createRuntimeComponentManager({ dataDir: f.root, defaultsPath: f.defaultsPath, lockPath: f.lockPath, npmLockPath: f.npmLockPath, installEnabled: false });
  const state = await disabled.inspect('tool');
  assert.equal(state.status, 'unavailable');
  assert.match(state.error, /管理员未启用运行时安装/);
  assert.deepEqual(disabled.policy().sources, ['managed', 'local']);
  assert.equal(disabled.policy().installEnabled, false);
});

test('corrupted npm cache is detected offline and repair reinstalls', async (t) => {
  const f = await managerFixture(t);
  await f.manager.install('tool');
  const handle = await f.manager.resolve('tool');
  await fs.writeFile(handle.entry, '#!/bin/sh\necho altered\n');
  handle.release();
  await assert.rejects(f.manager.resolve('tool'), { code: 'INVALID_CACHE' });
  assert.equal((await f.manager.install('tool')).status, 'ready');
});

test('approved lifecycle scripts run with the app node and denied scripts never run', async (t) => {
  const f = await managerFixture(t);
  const engine = f.f.lock.engines.tool;
  const bytes = npmTarball([
    { path: 'package.json', content: packageJson('@fixture/a', '1.0.0', { dependencies: { '@fixture/c': '1.0.0' }, scripts: { postinstall: 'node scripts/touch.mjs', install: 'node scripts/denied.mjs' } }) },
    { path: 'scripts/touch.mjs', content: "import fs from 'node:fs';fs.writeFileSync('ran.txt', process.env.PATH ?? '');\n" },
    { path: 'scripts/denied.mjs', content: "import fs from 'node:fs';fs.writeFileSync('denied.txt', 'ran');\n" }
  ]);
  engine.packages['@fixture/a@1.0.0'].integrity = integrity(bytes);
  f.f.tarballs.set('@fixture/a@1.0.0', bytes);
  f.urls.set(registryTarballUrl('https://registry.npmjs.org/', '@fixture/a', '1.0.0'), bytes);
  engine.scripts.allowed.push({ package: '@fixture/a', lifecycle: 'postinstall', command: 'node scripts/touch.mjs', reason: 'test' });
  engine.scripts.denied.push({ package: '@fixture/a', lifecycle: 'install', command: 'node scripts/denied.mjs', reason: 'test' });
  const rebuilt = await f.rebuild();
  const state = await rebuilt.install('tool');
  assert.equal(state.status, 'ready', state.error);
  const directory = path.join(f.root, 'runtimes/tool/1.0.0', `${process.platform}-${process.arch}`, 'node_modules/@fixture/a');
  assert.equal(await fs.readFile(path.join(directory, 'ran.txt'), 'utf8'), f.toolsDir);
  await assert.rejects(fs.stat(path.join(directory, 'denied.txt')), { code: 'ENOENT' });
});
