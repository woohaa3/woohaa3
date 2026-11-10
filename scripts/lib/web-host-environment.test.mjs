import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWebHostEnvironment } from './web-host-environment.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'woohaa-web-host-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { resourceRoot: root, dataDir: path.join(root, 'data') };
}

test('web host injects the same npm registry runtime manager inputs as the desktop host', (t) => {
  const { resourceRoot, dataDir } = fixture(t);
  const env = buildWebHostEnvironment({
    resourceRoot, dataDir, host: '0.0.0.0', port: 4173, basePath: '/tools/',
    runtimeInstall: 'enabled',
    baseEnv: { PATH: '/usr/bin', WOOHAA3_RUNTIME_DATA_DIR: '/inherited', VITE_SECRET: 'x', WOOHAA_WEB_HOST_RUNTIME_REGISTRY: 'https://npm.example.test/' }
  });
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.WOOHAA3_RUNTIME_DATA_DIR, dataDir);
  assert.equal(env.WOOHAA3_RUNTIME_NPM_LOCK_FILE, path.join(resourceRoot, 'runtime-npm-lock.json'));
  assert.equal(env.WOOHAA3_RUNTIME_TOOLS_DIR, path.join(resourceRoot, 'tools'));
  assert.equal(env.WOOHAA3_RUNTIME_INSTALL, 'enabled');
  assert.equal(env.WOOHAA3_RUNTIME_REGISTRY, 'https://npm.example.test/');
  assert.equal(env.WOOHAA3_REPO_ROOT, resourceRoot);
  assert.equal(env.VITE_SECRET, undefined);
  for (const dir of ['stores', 'media', 'config', 'secrets', 'extension-data', 'extensions', 'logs', 'cache']) assert.ok(fs.existsSync(path.join(dataDir, dir)), dir);
  // 主密钥首次生成后固定，重启沿用同一凭据根。
  const master = fs.readFileSync(path.join(dataDir, 'secrets/master.key'), 'utf8');
  const again = buildWebHostEnvironment({ resourceRoot, dataDir, host: '127.0.0.1', port: 4173, basePath: '/', baseEnv: {} });
  assert.equal(again.WOOHAA3_PLUGIN_SECRET_MASTER_KEY, master);
});

test('web host can explicitly disable runtime installation', (t) => {
  const { resourceRoot, dataDir } = fixture(t);
  const env = buildWebHostEnvironment({ resourceRoot, dataDir, host: '127.0.0.1', port: 4173, basePath: '/', runtimeInstall: 'disabled', baseEnv: {} });
  assert.equal(env.WOOHAA3_RUNTIME_INSTALL, 'disabled');
});
