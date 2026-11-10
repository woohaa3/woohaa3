import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertRuntimeNpmLockCurrent, auditRuntimeNpmScripts, buildRuntimeNpmLock, resolveDependencySpec
} from './runtime-npm-manifest.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function lockfile(packages, snapshots) {
  return `lockfileVersion: '9.0'\n\npackages:\n${packages}\n\nsnapshots:\n${snapshots}\n`;
}

const PACKAGES = `  '@deepseek-ai/dsh@1.0.0':
    resolution: {integrity: sha512-DDDD}
  '@deepseek-ai/dsh-other@1.0.0':
    resolution: {integrity: sha512-EEEE}
  'node-addon-require-builtin-darwin-arm64@1.0.0':
    resolution: {integrity: sha512-NNNN}
    cpu: [arm64]
    os: [darwin]
  '@anthropic-ai/claude-agent-sdk@1.0.0':
    resolution: {integrity: sha512-AAAA}
  '@anthropic-ai/claude-agent-sdk-darwin-arm64@1.0.0':
    resolution: {integrity: sha512-CCCC}
    cpu: [arm64]
    os: [darwin]
  '@openai/codex@1.0.0':
    resolution: {integrity: sha512-BBBB}
  '@openai/codex@1.0.0-darwin-arm64':
    resolution: {integrity: sha512-FFFF}
    cpu: [arm64]
    os: [darwin]`;

const SNAPSHOTS = `  '@deepseek-ai/dsh@1.0.0':
    dependencies:
      '@deepseek-ai/dsh-other': 1.0.0
      'node-addon-require-builtin-darwin-arm64': 1.0.0
  '@deepseek-ai/dsh-other@1.0.0': {}
  'node-addon-require-builtin-darwin-arm64@1.0.0': {}
  '@anthropic-ai/claude-agent-sdk@1.0.0':
    optionalDependencies:
      '@anthropic-ai/claude-agent-sdk-darwin-arm64': 1.0.0
  '@anthropic-ai/claude-agent-sdk-darwin-arm64@1.0.0': {}
  '@openai/codex@1.0.0':
    optionalDependencies:
      '@openai/codex-darwin-arm64': '@openai/codex@1.0.0-darwin-arm64'
  '@openai/codex@1.0.0-darwin-arm64': {}`;

async function fixture(t, { packages = PACKAGES, snapshots = SNAPSHOTS, scripts } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'woohaa-npm-lock-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'locks/web'), { recursive: true });
  await fs.mkdir(path.join(root, 'desktop'), { recursive: true });
  await fs.writeFile(path.join(root, 'locks/web/pnpm-lock.yaml'), lockfile(packages, snapshots));
  await fs.writeFile(path.join(root, 'desktop/runtime-components.lock.json'), JSON.stringify({
    schemaVersion: 1,
    components: { dsh: { version: '1.0.0' }, claude: { version: '1.0.0', localVersions: ['2.1.0'] }, codex: { version: '1.0.0' } }
  }));
  await fs.writeFile(path.join(root, 'desktop/runtime-npm-scripts.json'), JSON.stringify(scripts ?? { allowed: [], denied: [] }));
  return root;
}

test('dependency specs must be exact versions or npm aliases', () => {
  assert.deepEqual(resolveDependencySpec('a', '1.2.3(beta)'), { name: 'a', version: '1.2.3' });
  assert.deepEqual(resolveDependencySpec('a', '@scope/pkg@1.2.3-darwin-arm64'), { name: '@scope/pkg', version: '1.2.3-darwin-arm64' });
  for (const value of ['^1.2.3', '~1.2.3', 'latest', '>=1', 'workspace:*', 'github:user/repo', 'https://example.test/a.tgz']) {
    assert.throws(() => resolveDependencySpec('a', value), { code: 'UNLOCKED_DEPENDENCY' }, value);
  }
});

test('lock build records exact integrity, entry rules and per-platform package sets', async (t) => {
  const root = await fixture(t);
  const lock = buildRuntimeNpmLock({ clientRoot: root, platforms: ['darwin-arm64'] });
  assert.equal(lock.engines.dsh.packages['@deepseek-ai/dsh@1.0.0'].integrity, 'sha512-DDDD');
  assert.deepEqual(lock.engines.claude.entry, { type: 'package-file', package: '@anthropic-ai/claude-agent-sdk-{platform}', pattern: 'claude{exe}', probeVersion: '2.1.0' });
  assert.deepEqual(lock.engines.codex.entry, { type: 'package-file', package: '@openai/codex-{platform}', pattern: 'vendor/*/bin/codex{exe}', probeVersion: '1.0.0' });
  assert.equal(lock.engines.dsh.entry.type, 'module-generator');
  // Codex publishes its platform binary as an alias; the install path keeps the alias name.
  const edge = lock.engines.codex.packages['@openai/codex@1.0.0'].dependencies[0];
  assert.deepEqual(edge, { name: '@openai/codex-darwin-arm64', target: '@openai/codex@1.0.0-darwin-arm64', optional: true });
  assert.ok(lock.engines.dsh.platforms['darwin-arm64'].packages.includes('@deepseek-ai/dsh-other@1.0.0'));
  assert.equal(lock.engines.dsh.scripts.policy, 'allowlist');
  assert.equal(lock.engines.dsh.spaceBytes > 0, true);
});

test('build fails when a dependency resolves to a range or tag', async (t) => {
  const root = await fixture(t, { snapshots: SNAPSHOTS.replace("'@deepseek-ai/dsh-other': 1.0.0", "'@deepseek-ai/dsh-other': ^1.0.0") });
  assert.throws(() => buildRuntimeNpmLock({ clientRoot: root, platforms: ['darwin-arm64'] }), { code: 'UNLOCKED_DEPENDENCY' });
});

test('build fails when the platform entry package is missing', async (t) => {
  const root = await fixture(t, {
    packages: PACKAGES.replace(/  '@anthropic-ai\/claude-agent-sdk-darwin-arm64@1\.0\.0':\n    resolution: \{integrity: sha512-CCCC\}\n    cpu: \[arm64\]\n    os: \[darwin\]/, ''),
    snapshots: SNAPSHOTS.replace(/      '@anthropic-ai\/claude-agent-sdk-darwin-arm64': 1\.0\.0\n/, '').replace(/  '@anthropic-ai\/claude-agent-sdk-darwin-arm64@1\.0\.0': \{\}/, '')
  });
  assert.throws(() => buildRuntimeNpmLock({ clientRoot: root, platforms: ['darwin-arm64'] }), { code: 'MISSING_PLATFORM_PACKAGE' });
});

test('platform packages for another OS/arch never enter this platform set', async (t) => {
  const root = await fixture(t);
  const lock = buildRuntimeNpmLock({ clientRoot: root, platforms: ['darwin-arm64'] });
  const darwin = lock.engines.claude.platforms['darwin-arm64'].packages;
  assert.ok(darwin.includes('@anthropic-ai/claude-agent-sdk-darwin-arm64@1.0.0'));
  assert.equal(lock.engines.claude.platforms['win32-x64'], undefined, 'a platform without a locked entry package must fail coverage, not reuse another OS');
});

test('unapproved lifecycle scripts fail the build audit; denied scripts are recorded', async (t) => {
  const root = await fixture(t, {
    scripts: {
      allowed: [{ package: '@deepseek-ai/dsh-other', lifecycle: 'postinstall', command: 'node scripts/ok.mjs', reason: 'fixture' }],
      denied: [{ package: '@deepseek-ai/dsh', lifecycle: 'install', command: 'node scripts/no.mjs', reason: 'fixture' }]
    }
  });
  const lock = {
    engines: {
      dsh: {
        packages: {
          '@deepseek-ai/dsh@1.0.0': { name: '@deepseek-ai/dsh', version: '1.0.0', integrity: 'sha512-DDDD', dependencies: [] },
          '@deepseek-ai/dsh-other@1.0.0': { name: '@deepseek-ai/dsh-other', version: '1.0.0', integrity: 'sha512-EEEE', dependencies: [] }
        },
        scripts: {
          policy: 'allowlist',
          allowed: [{ package: '@deepseek-ai/dsh-other', lifecycle: 'postinstall', command: 'node scripts/ok.mjs' }],
          denied: [{ package: '@deepseek-ai/dsh', lifecycle: 'install', command: 'node scripts/no.mjs', reason: 'fixture' }]
        }
      }
    }
  };
  const manifests = new Map([
    ['@deepseek-ai/dsh@1.0.0', { name: '@deepseek-ai/dsh', version: '1.0.0', scripts: { install: 'node scripts/no.mjs' } }],
    ['@deepseek-ai/dsh-other@1.0.0', { name: '@deepseek-ai/dsh-other', version: '1.0.0', scripts: { postinstall: 'node scripts/ok.mjs', prepare: 'node scripts/prepare.mjs' } }]
  ]);
  const audit = auditRuntimeNpmScripts({ clientRoot: root, lock, readInstalled: (name, version) => manifests.get(`${name}@${version}`) });
  assert.deepEqual(audit.allowed.map((entry) => `${entry.package}:${entry.lifecycle}`), ['@deepseek-ai/dsh-other:postinstall']);
  assert.deepEqual(audit.denied.map((entry) => `${entry.package}:${entry.lifecycle}`), ['@deepseek-ai/dsh:install']);
  assert.deepEqual(audit.ignored.map((entry) => entry.lifecycle), ['prepare']);
  manifests.set('@deepseek-ai/dsh@1.0.0', { name: '@deepseek-ai/dsh', version: '1.0.0', scripts: { preinstall: 'node scripts/surprise.mjs' } });
  assert.throws(() => auditRuntimeNpmScripts({ clientRoot: root, lock, readInstalled: (name, version) => manifests.get(`${name}@${version}`) }), { code: 'UNAPPROVED_LIFECYCLE_SCRIPT' });
});

test('committed lock matches the repository pnpm lock and covers every platform', async (t) => {
  const lock = assertRuntimeNpmLockCurrent({ clientRoot: REPO_ROOT });
  for (const engineId of ['dsh', 'claude', 'codex']) {
    const engine = lock.engines[engineId];
    assert.ok(Object.keys(engine.packages).length > 0, engineId);
    for (const key of lock.platforms) {
      assert.ok(engine.platforms[key].requests > 0, `${engineId}/${key}`);
      for (const id of engine.platforms[key].packages) assert.equal(engine.packages[id].integrity.split('-')[0], 'sha512', id);
    }
  }
  const measurements = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'desktop/runtime-npm-measurements.json'), 'utf8'));
  for (const [engineId, engine] of Object.entries(measurements.engines)) {
    for (const [key, platform] of Object.entries(engine.platforms)) {
      assert.equal(platform.requests, lock.engines[engineId].platforms[key].requests);
      assert.equal(platform.networkBytes, null, 'network bytes must be measured, never inferred');
    }
  }
});
