import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { createRuntimeComponentManager, getRuntimeComponentManager } from './index.mjs';
function archive(name = 'bin/codex', type = '0') {
  const data = Buffer.from('#!/bin/sh\necho codex 1.2.3\n'), h = Buffer.alloc(512);
  function put(offset, value) { h.write(value, offset); }
  put(0, name); put(100, '0000755\0'); put(124, `${data.length.toString(8).padStart(11, '0')}\0`); put(148, '        '); put(156, type); put(257, 'ustar\0'); put(263, '00');
  put(148, `${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0')}\0 `);
  return gzipSync(Buffer.concat([h, data, Buffer.alloc((512 - data.length % 512) % 512), Buffer.alloc(1024)]));
}
async function fixture(t, changes = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'woohaa-runtime-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const body = changes.body || archive(changes.name, changes.type);
  const component = { id: 'codex', version: '1.2.3', platform: process.platform, arch: process.arch, url: 'codex.tar.gz', bytes: body.length, unpackedBytes: 1024, sha256: createHash('sha256').update(body).digest('hex'), entry: 'bin/codex', kind: 'executable', ...changes.component };
  const catalog = Buffer.from(JSON.stringify({ schemaVersion: changes.schemaVersion || 1, components: [component, ...(changes.otherComponents || [])] }));
  const signature = sign(null, catalog, privateKey).toString('base64');
  const defaultsPath = path.join(root, 'defaults.json'), lockPath = path.join(root, 'lock.json');
  await fs.writeFile(defaultsPath, JSON.stringify({ schemaVersion: 1, cdn: { baseUrl: changes.baseUrl || 'https://cdn.example.test/' }, trustKeys: [publicKey.export({ type: 'spki', format: 'pem' })] }));
  await fs.writeFile(lockPath, JSON.stringify({ schemaVersion: 1, components: { codex: { version: '1.2.3' } } }));
  let calls = 0;
  const urls = [];
  const options = { dataDir: root, defaultsPath, lockPath, fetchImpl: async (url, { signal }) => { calls++; urls.push(String(url)); if (String(url).endsWith('catalog.signed.json')) return changes.envelope ? new Response(JSON.stringify({ schemaVersion: 1, catalog: catalog.toString('base64'), signature: changes.badSignature ? Buffer.alloc(64).toString('base64') : signature })) : new Response('', { status: 404 }); if (changes.delay) await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 40); signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); }); signal.throwIfAborted(); return new Response(String(url).endsWith('catalog.json') ? catalog : String(url).endsWith('catalog.sig') ? (changes.badSignature ? 'bad' : signature) : body); } };
  return { manager: createRuntimeComponentManager(options), options, root, body, catalog, signature, urls, calls: () => calls };
}
test('inspection/resolve never network; signed install, offline reuse, lease prevents remove', async t => {
  const f = await fixture(t); assert.equal((await f.manager.inspect('codex')).status, 'missing'); await assert.rejects(f.manager.resolve('codex'), { code: 'RUNTIME_COMPONENT_MISSING' }); assert.equal(f.calls(), 0);
  assert.equal((await f.manager.install('codex')).status, 'ready'); const handle = await f.manager.resolve('codex'); assert.equal(await fs.readFile(handle.entry, 'utf8'), '#!/bin/sh\necho codex 1.2.3\n');
  await assert.rejects(f.manager.remove('codex'), { code: 'COMPONENT_IN_USE' }); handle.release(); handle.release();
  const offline = createRuntimeComponentManager({ ...f.options, fetchImpl: () => { throw new Error('must be offline'); } }); assert.equal((await offline.inspect('codex')).status, 'ready'); assert.equal((await offline.install('codex')).status, 'ready');
  assert.equal((await f.manager.remove('codex')).status, 'missing');
});
test('signature and hash failures never activate content; retry recovers', async t => {
  for (const changes of [{ badSignature: true }, { component: { sha256: '0'.repeat(64) } }]) {
    const f = await fixture(t, changes); await assert.rejects(f.manager.install('codex'), { code: changes.badSignature ? 'INVALID_SIGNATURE' : 'INVALID_HASH' }); await assert.rejects(f.manager.resolve('codex'), { code: 'RUNTIME_COMPONENT_MISSING' });
  }
});
test('archive traversal rejected', async t => { const f = await fixture(t, { name: '../escape' }); await assert.rejects(f.manager.install('codex'), { code: 'UNSAFE_ARCHIVE' }); await assert.rejects(fs.stat(path.join(f.root, 'escape'))); });
test('shared install deduplicates network and cancellation affects only one waiter', async t => {
  const f = await fixture(t, { delay: true }); const controller = new AbortController(); const first = f.manager.install('codex', { signal: controller.signal }); const second = f.manager.install('codex'); controller.abort(new Error('cancelled')); await assert.rejects(first, /cancelled/); assert.equal((await second).status, 'ready'); assert.equal(f.calls(), 4);
});
test('last cancellation cleans staging and retry installs', async t => {
  const f = await fixture(t, { delay: true }); const controller = new AbortController(); const attempt = f.manager.install('codex', { signal: controller.signal }); controller.abort(new Error('cancel')); await assert.rejects(attempt, /cancel/); await new Promise(r => setTimeout(r, 20)); assert.equal((await f.manager.install('codex')).status, 'ready');
});
test('local configuration validates exact version and never downloads', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const cli = path.join(f.root, 'codex'); await fs.writeFile(cli, '#!/bin/sh\necho codex 1.2.3\n', { mode: 0o755 }); assert.equal((await f.manager.configure('codex', { source: 'local', path: cli })).status, 'ready'); const h = await f.manager.resolve('codex'); assert.equal(h.source, 'local'); h.release(); assert.equal(f.calls(), 0);
  await fs.writeFile(cli, '#!/bin/sh\necho codex 1.2.30\n'); assert.equal((await f.manager.inspect('codex')).status, 'incompatible'); await assert.rejects(f.manager.configure('codex', { source: 'local', path: 'relative' }), { code: 'INVALID_CONFIG' });
});
test('configuration rejects unknown fields and user trust root replacement', async t => {
  const f = await fixture(t); await fs.mkdir(path.join(f.root, 'config')); await fs.writeFile(f.manager.configPath, JSON.stringify({ trustKeys: [] })); await assert.rejects(f.manager.list(), { code: 'INVALID_CONFIG' });
});
test('interrupted archive resumes only with matching ETag and verified whole-file hash', async t => {
  const f = await fixture(t); let attempts = 0; const split = Math.floor(f.body.length / 2); let range;
  const fetchImpl = async (url, options) => {
    if (!String(url).endsWith('.tar.gz')) return f.options.fetchImpl(url, options);
    attempts++;
    if (attempts === 1) return new Response(new ReadableStream({ async start(controller) { controller.enqueue(f.body.subarray(0, split)); await new Promise(r => setTimeout(r, 5)); controller.error(new Error('connection lost')); } }), { headers: { etag: '"fixture"' } });
    range = options.headers.Range;
    return new Response(f.body.subarray(split), { status: 206, headers: { etag: '"fixture"', 'content-range': `bytes ${split}-${f.body.length - 1}/${f.body.length}` } });
  };
  const manager = createRuntimeComponentManager({ ...f.options, fetchImpl }); await assert.rejects(manager.install('codex'), /connection lost/);
  assert.equal((await manager.install('codex')).status, 'ready'); assert.equal(range, `bytes=${split}-`);
});
test('cross-process leases block removal and stale installation locks recover', async t => {
  const f = await fixture(t), root = path.join(f.root, 'runtimes/codex/1.2.3', `${process.platform}-${process.arch}`); await fs.mkdir(`${root}.lock`, { recursive: true }); await fs.writeFile(path.join(`${root}.lock`, 'owner.json'), JSON.stringify({ pid: 2147483647 })); await f.manager.install('codex');
  await fs.mkdir(path.join(root, '.leases')); await fs.writeFile(path.join(root, '.leases/external.json'), JSON.stringify({ pid: process.pid })); await assert.rejects(f.manager.remove('codex'), { code: 'COMPONENT_BUSY' });
  await fs.writeFile(path.join(root, '.leases/external.json'), JSON.stringify({ pid: 2147483647 })); assert.equal((await f.manager.remove('codex')).status, 'missing');
});
test('cached receipt tamper, entry corruption and linked entry are rejected offline', async t => {
  const f = await fixture(t); await f.manager.install('codex'); const handle = await f.manager.resolve('codex'); const entry = handle.entry; handle.release();
  await fs.writeFile(entry, '#!/bin/sh\necho altered\n'); await assert.rejects(f.manager.resolve('codex'), { code: 'INVALID_CACHE' });
  const receiptFile = path.join(path.dirname(path.dirname(entry)), '.runtime-receipt.json'), receipt = JSON.parse(await fs.readFile(receiptFile)); receipt.entry = '../escape'; await fs.writeFile(receiptFile, JSON.stringify(receipt));
  assert.equal((await f.manager.inspect('codex')).status, 'incompatible'); await assert.rejects(f.manager.resolve('codex'), { code: 'INVALID_CACHE' });
});
test('archive links, PAX and Windows path aliases are refused', async t => {
  for (const changes of [{ type: '2' }, { type: 'x' }, { name: 'dir/NUL' }, { name: 'dir/alias.' }, { name: 'dir/file:stream' }]) { const f = await fixture(t, changes); await assert.rejects(f.manager.install('codex'), { code: 'UNSAFE_ARCHIVE' }); }
});
test('signed archive URLs cannot escape configured CDN', async t => {
  for (const url of ['https://other.test/file.tar.gz', '../escape.tar.gz', '//other.test/file.tar.gz']) { const f = await fixture(t, { component: { url } }); await assert.rejects(f.manager.install('codex')); assert.equal(f.calls(), 3); }
});
test('configuration and removal reject an active install', async t => {
  const f = await fixture(t, { delay: true }); const installing = f.manager.install('codex'); await assert.rejects(f.manager.configure('codex', { source: 'managed' }), { code: 'COMPONENT_IN_USE' }); await assert.rejects(f.manager.remove('codex'), { code: 'COMPONENT_IN_USE' }); await installing;
});
test('singleton is absent outside desktop and changes with desktop data directory', async t => {
  const names = ['WOOHAA3_RUNTIME_DATA_DIR', 'WOOHAA3_RUNTIME_DEFAULTS_FILE', 'WOOHAA3_RUNTIME_LOCK_FILE'], saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; }));
  for (const name of names) delete process.env[name]; assert.equal(getRuntimeComponentManager(), undefined);
  const f = await fixture(t); process.env[names[0]] = f.root; process.env[names[1]] = f.options.defaultsPath; process.env[names[2]] = f.options.lockPath;
  const manager = getRuntimeComponentManager(); assert.equal(getRuntimeComponentManager(), manager); assert.equal((await manager.inspect('codex')).status, 'missing'); process.env[names[0]] += '/other'; assert.notEqual(getRuntimeComponentManager(), manager);
});
test('Claude local CLI compatibility is independent from SDK artifact version', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t); const cli = path.join(f.root, 'claude'); await fs.writeFile(cli, '#!/bin/sh\necho "2.1.120 (Claude Code)"\n', { mode: 0o755 });
  await fs.writeFile(f.options.lockPath, JSON.stringify({ schemaVersion: 1, components: { claude: { version: '0.3.301', localVersions: ['2.1.120'] } } }));
  const state = await f.manager.configure('claude', { source: 'local', path: cli }); assert.equal(state.status, 'ready'); assert.equal(state.version, '2.1.120');
  await fs.writeFile(cli, '#!/bin/sh\necho "2.1.121 (Claude Code)"\n'); assert.equal((await f.manager.inspect('claude')).status, 'incompatible');
  await fs.writeFile(f.options.lockPath, JSON.stringify({ schemaVersion: 1, components: { claude: { version: '0.3.301' } } })); await fs.writeFile(cli, '#!/bin/sh\necho "0.3.301 (Claude Code)"\n'); assert.equal((await f.manager.inspect('claude')).status, 'incompatible'); assert.equal(f.calls(), 0);
});
test('asset components resolve with a resource lease without spawning a process', async t => {
  const f = await fixture(t, { component: { kind: 'asset' } }); await f.manager.install('codex'); const handle = await f.manager.resolve('codex'); assert.equal(handle.kind, 'asset'); await assert.rejects(f.manager.remove('codex'), { code: 'COMPONENT_IN_USE' }); handle.release(); assert.equal((await f.manager.remove('codex')).status, 'missing');
});

test('real packaging USTAR output installs through signed catalog boundary', async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'woohaa-ustar-')); t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source'); await fs.mkdir(path.join(source, 'bin'), { recursive: true }); await fs.writeFile(path.join(source, 'bin/codex'), '#!/bin/sh\necho codex 1.2.3\n', { mode: 0o755 });
  const { createComponentArchive } = await import('../../scripts/package-runtime-components.mjs');
  const archivePath = path.join(temporary, 'artifact.tar.gz'); await createComponentArchive(source, archivePath);
  const f = await fixture(t, { body: await fs.readFile(archivePath) }); assert.equal((await f.manager.install('codex')).status, 'ready');
});
test('idle native consumer cooperatively releases its lease on removal request', async t => {
  const f = await fixture(t); await f.manager.install('codex'); const root = path.join(f.root, 'runtimes/codex/1.2.3', `${process.platform}-${process.arch}`); const leases = path.join(root, '.leases'); await fs.mkdir(leases); const lease = path.join(leases, 'native.json'); await fs.writeFile(lease, JSON.stringify({ pid: process.pid }));
  const timer = setInterval(async () => { try { await fs.stat(path.join(root, '.release-requested')); await fs.rm(lease, { force: true }); } catch { /* waiting for request */ } }, 20); t.after(() => clearInterval(timer));
  assert.equal((await f.manager.remove('codex')).status, 'missing'); await assert.rejects(fs.stat(root), { code: 'ENOENT' });
});
test('busy native consumer remains installed and removal marker is cleared', async t => {
  const f = await fixture(t); await f.manager.install('codex'); const root = path.join(f.root, 'runtimes/codex/1.2.3', `${process.platform}-${process.arch}`); await fs.mkdir(path.join(root, '.leases')); await fs.writeFile(path.join(root, '.leases/native.json'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(f.manager.remove('codex'), { code: 'COMPONENT_BUSY' }); assert.equal((await f.manager.inspect('codex')).status, 'ready'); await assert.rejects(fs.stat(path.join(root, '.release-requested')), { code: 'ENOENT' }); assert.equal((await fs.readdir(path.join(root, '.leases'))).length, 1);
});
test('archives cannot seed runtime leases or removal coordination markers', async t => {
  for (const name of ['.release-requested', '.leases/foreign.json', '.runtime-catalog.json', 'ready.json']) { const f = await fixture(t, { name }); await assert.rejects(f.manager.install('codex'), { code: 'UNSAFE_ARCHIVE' }); }
});

test('atomic signed catalog installs without legacy reads and preserves offline signature bytes', async t => {
  const f = await fixture(t, { envelope: true });
  assert.equal((await f.manager.install('codex')).status, 'ready');
  assert.equal(f.urls.some(url => url.endsWith('catalog.json') || url.endsWith('catalog.sig')), false);
  const root = path.join(f.root, 'runtimes/codex/1.2.3', `${process.platform}-${process.arch}`);
  assert.deepEqual(await fs.readFile(path.join(root, '.runtime-catalog.json')), f.catalog);
  assert.equal(await fs.readFile(path.join(root, '.runtime-catalog.sig'), 'utf8'), f.signature);
  const offline = createRuntimeComponentManager({ ...f.options, fetchImpl: () => { throw Error('offline'); } });
  assert.equal((await offline.inspect('codex')).status, 'ready');
});
test('atomic catalog bad signature cannot downgrade to legacy catalog', async t => {
  const f = await fixture(t, { envelope: true, badSignature: true });
  await assert.rejects(f.manager.install('codex'), { code: 'INVALID_SIGNATURE' });
  assert.equal(f.calls(), 1);
});
test('only atomic catalog HTTP 404 permits legacy fallback', async t => {
  const f = await fixture(t); await f.manager.install('codex');
  assert.deepEqual(f.urls.slice(0, 3).map(url => new URL(url).pathname), ['/catalog.signed.json', '/catalog.json', '/catalog.sig']);
  for (const outcome of [new Response('', { status: 403 }), new Response('invalid'), new Error('network failed')]) {
    let calls = 0;
    const manager = createRuntimeComponentManager({ ...f.options, dataDir: path.join(f.root, `failure-${calls}-${Math.random()}`), fetchImpl: async () => { calls++; if (outcome instanceof Error) throw outcome; return outcome; } });
    await assert.rejects(manager.install('codex')); assert.equal(calls, 1);
  }
});

test('atomic merged catalog selects the locked platform while preserving other platforms', async t => {
  const f = await fixture(t, { envelope: true, otherComponents: [{ id: 'codex', version: '1.2.3', platform: process.platform === 'win32' ? 'darwin' : 'win32', arch: 'x64', url: 'other-platform.tar.gz' }] });
  assert.equal((await f.manager.install('codex')).status, 'ready');
  assert.equal(f.urls.at(-1), 'https://cdn.example.test/codex.tar.gz');
  assert.equal(f.calls(), 2);
});

test('app release CDN directory changes reuse unchanged installed components without network',async t=>{
 const f=await fixture(t,{envelope:true});
 assert.equal((await f.manager.install('codex')).status,'ready');
 const defaults=JSON.parse(await fs.readFile(f.options.defaultsPath,'utf8'));
 defaults.cdn.baseUrl='https://cdn.example.test/woohaa/runtimes/darwin-aarch64/9.9.9/';
 await fs.writeFile(f.options.defaultsPath,JSON.stringify(defaults));
 const next=createRuntimeComponentManager({...f.options,fetchImpl:()=>{throw new Error('unchanged runtime must not download after App upgrade');}});
 assert.equal((await next.install('codex')).status,'ready');
 const handle=await next.resolve('codex');assert.equal(handle.version,'1.2.3');handle.release();
});

test('schema 2 resolves shared blobs under runtime root and rejects other paths', async t => {
 const body=archive(), sha256=createHash('sha256').update(body).digest('hex');
 const baseUrl='https://cdn.example.test/woohaa/runtimes/darwin-aarch64/0.2.0/';
 const url=`blobs/sha256/${sha256}.tar.gz`;
 const f=await fixture(t,{body,schemaVersion:2,baseUrl,envelope:true,component:{url}});
 assert.equal((await f.manager.install('codex')).status,'ready');
 assert(f.urls.includes(`https://cdn.example.test/woohaa/runtimes/${url}`));
 for(const bad of ['../escape.tar.gz',`blobs/sha256/${'0'.repeat(64)}.tar.gz`,'https://other.test/archive']){
  const f=await fixture(t,{body,schemaVersion:2,baseUrl,envelope:true,component:{url:bad}});
  await assert.rejects(f.manager.install('codex'),{code:'INVALID_CATALOG'});
  assert(!f.urls.some(u=>u.endsWith('.tar.gz')));
 }
});
