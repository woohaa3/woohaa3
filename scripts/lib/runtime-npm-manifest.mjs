/**
 * 构建期生成「按 npm registry 安装」的运行期锁。
 *
 * 运行期只接受本文件产出的精确 `name@version` + integrity，不做 semver / dist-tag 解析。
 * 依赖图来自工作区已安装的 pnpm lock（`snapshots` 给出精确版本与 peer 变体，`packages`
 * 给出 integrity 与平台约束）。任何范围号、tag、git/URL 依赖、缺失的平台包或未审核的
 * lifecycle script 都会让构建失败，而不是留到用户机器上再决定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { normalizedTextSha256 } from './text-sha256.mjs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export const RUNTIME_NPM_SCHEMA_VERSION = 1;
export const RUNTIME_NPM_SUPPORTED_PLATFORMS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'linux-arm64',
  'win32-x64',
  'win32-arm64'
];
/** 官方源之外的候选：下载前并行探测，按 TTFB 选最快，失败再按顺序回退。 */
export const RUNTIME_NPM_MIRRORS = [
  'https://repo.huaweicloud.com/repository/npm/',
  'https://mirrors.cloud.tencent.com/npm/'
];
/** 运行期安装会执行的 lifecycle；`prepare` 只在 git/本地依赖安装时触发，registry tarball 不执行。 */
const LIFECYCLE_KEYS = ['preinstall', 'install', 'postinstall'];
const IGNORED_LIFECYCLE_KEYS = ['prepare', 'prepublish', 'prepublishOnly'];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z.-]+)?$/;

export class RuntimeNpmManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RuntimeNpmManifestError';
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new RuntimeNpmManifestError(code, message);
};

function loadYaml(clientRoot) {
  for (const root of [clientRoot, REPO_ROOT]) {
    try {
      return createRequire(path.join(root, 'web/backend/package.json'))('yaml');
    } catch {
      // Fall through to the repository's own workspace install (temp fixtures use one).
    }
  }
  throw new RuntimeNpmManifestError('MISSING_YAML', 'Cannot load the yaml parser from web/backend');
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function scriptDigest(name, version, lifecycle, command) {
  return createHash('sha256').update(`${name}@${version}:${lifecycle}:${command}`).digest('hex');
}

/** `1.2.3(peer@1)` → `1.2.3`；保留 `npm:@scope/pkg@1.2.3` 的别名语义。 */
export function stripPeerSuffix(value) {
  const index = value.indexOf('(');
  return index < 0 ? value : value.slice(0, index);
}

/** 依赖值只能是精确版本或 `npm:` 别名；范围、tag、git、URL 一律拒绝。 */
export function resolveDependencySpec(name, raw) {
  if (typeof raw !== 'string' || raw.trim() === '') fail('UNLOCKED_DEPENDENCY', `${name} has no resolved version`);
  const value = stripPeerSuffix(raw.trim());
  if (value.startsWith('link:') || value.startsWith('workspace:')) fail('UNLOCKED_DEPENDENCY', `${name} uses a workspace link (${value})`);
  const alias = /^(?:npm:)?(@?[^@]+)@(.+)$/.exec(value);
  if (alias) {
    const version = alias[2];
    if (!EXACT_VERSION.test(version)) fail('UNLOCKED_DEPENDENCY', `${name} alias ${alias[1]}@${version} is not an exact version`);
    // pnpm encodes `npm:` aliases without the prefix when the dependency name differs.
    if (alias[1] === name) return { name, version };
    return { name: alias[1], version };
  }
  if (!EXACT_VERSION.test(value)) fail('UNLOCKED_DEPENDENCY', `${name} resolves to a range or tag (${value}); publish an exact lock`);
  return { name, version: value };
}

export function loadRuntimeNpmLockfile(clientRoot) {
  const file = path.join(clientRoot, 'locks/web/pnpm-lock.yaml');
  const text = fs.readFileSync(file, 'utf8');
  const lock = loadYaml(clientRoot).parse(text);
  if (lock.lockfileVersion !== '9.0' || !lock.packages || !lock.snapshots) fail('INVALID_LOCK', 'Only pnpm lockfile v9 is supported');
  return { file, text, lock };
}

function snapshotEntriesByVersion(snapshots) {
  const map = new Map();
  for (const key of Object.keys(snapshots)) {
    const name = key.startsWith('@') ? key.slice(0, key.indexOf('@', 1)) : key.slice(0, key.indexOf('@'));
    const version = key.slice(name.length + 1);
    const base = stripPeerSuffix(version);
    const id = `${name}@${base}`;
    if (!map.has(id)) map.set(id, { name, version: base, snapshots: [] });
    map.get(id).snapshots.push(key);
  }
  return map;
}

function packageMeta(lock, id) {
  return lock.packages?.[id];
}

function integrityOf(lock, id) {
  const integrity = packageMeta(lock, id)?.resolution?.integrity;
  if (typeof integrity !== 'string' || !/^(?:sha512|sha256|sha1)-[A-Za-z0-9+/=]+$/.test(integrity)) fail('MISSING_INTEGRITY', `${id} has no usable integrity in the lockfile`);
  return integrity;
}

/**
 * 已安装闭包扫描：从 sdk-agent 的三个引擎根出发，按 package.json 依赖（含平台可选包）走一遍。
 * 只用于审计 lifecycle、体积测量和生成图的种子；版本事实仍以 lockfile 为准。
 */
export function scanInstalledClosure(clientRoot, names = ['@deepseek-ai/dsh', '@anthropic-ai/claude-agent-sdk', '@openai/codex']) {
  const found = new Map();
  for (const name of names) {
    let start;
    try {
      start = createRequire(path.join(clientRoot, 'web/extensions/sdk-agent/package.json')).resolve(`${name}/package.json`);
    } catch {
      continue;
    }
    const stack = [start];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      let real;
      try {
        real = fs.realpathSync(current);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(real, 'utf8'));
      } catch {
        continue;
      }
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue;
      const id = `${manifest.name}@${manifest.version}`;
      if (!found.has(id)) found.set(id, { manifest, root: path.dirname(real) });
      const deps = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}), ...(manifest.peerDependencies ?? {}) };
      for (const dep of Object.keys(deps)) {
        try {
          stack.push(createRequire(real).resolve(`${dep}/package.json`));
        } catch {
          // Optional/platform-specific dependency not installed on this machine.
        }
      }
    }
  }
  return found;
}

/** 从已安装依赖树读取单个包（仅用于审计 lifecycle 与体积测量，不参与版本解析）。 */
export function createInstalledReader(clientRoot) {
  let cache;
  return function read(name, version) {
    cache ??= scanInstalledClosure(clientRoot);
    return cache.get(`${name}@${version}`)?.manifest;
  };
}

/** 已安装闭包的包 id（作为生成图的种子；缺少的平台变体会由 lock 边补齐）。 */
export function installedRuntimePackageIds({ clientRoot, names } = {}) {
  return [...scanInstalledClosure(clientRoot, names).keys()].sort();
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  return value === undefined ? undefined : [value];
}

function platformMatches(meta, key) {
  const [os, cpu] = key.split('-');
  const osList = normalizeList(meta?.os);
  const cpuList = normalizeList(meta?.cpu);
  const libcList = normalizeList(meta?.libc);
  const allow = (list, value) => list === undefined || (list.includes(value) && !list.includes(`!${value}`));
  if (osList !== undefined && !allow(osList, os)) return false;
  if (cpuList !== undefined && !allow(cpuList, cpu)) return false;
  // The key names the glibc variant; musl-only builds are not part of the desktop/web matrix.
  if (libcList !== undefined && !libcList.includes('glibc')) return false;
  return true;
}

function scriptsFor(manifest) {
  const scripts = manifest?.scripts ?? {};
  return {
    lifecycle: LIFECYCLE_KEYS.filter((key) => typeof scripts[key] === 'string' && scripts[key].trim()).map((key) => ({ lifecycle: key, command: scripts[key].trim() })),
    ignored: IGNORED_LIFECYCLE_KEYS.filter((key) => typeof scripts[key] === 'string' && scripts[key].trim()).map((key) => ({ lifecycle: key, command: scripts[key].trim() }))
  };
}

/** 把审核清单规范化为运行期 lock 里的策略（版本无关；运行期按实际版本校验摘要）。 */
export function normalizePolicy(policy) {
  const normalize = (list) => (Array.isArray(list) ? list : []).map((entry) => ({
    package: String(entry.package),
    lifecycle: String(entry.lifecycle),
    command: String(entry.command),
    ...(entry.reason ? { reason: String(entry.reason) } : {})
  }));
  for (const entry of normalize(policy.allowed)) if (!LIFECYCLE_KEYS.includes(entry.lifecycle)) fail('INVALID_SCRIPT_POLICY', `Allowed script must use ${LIFECYCLE_KEYS.join('/')}: ${entry.package}`);
  return { policy: 'allowlist', ignoredLifecycles: [...IGNORED_LIFECYCLE_KEYS], allowed: normalize(policy.allowed), denied: normalize(policy.denied) };
}

/**
 * 构建期扫描当前平台已安装闭包的 lifecycle script。未在审核清单里出现的脚本会让构建失败；
 * 明确拒绝的脚本记录在 lock 里且运行期永不执行。
 */
export function auditRuntimeNpmScripts({ clientRoot, lock, readInstalled } = {}) {
  const read = readInstalled ?? createInstalledReader(clientRoot);
  const result = { schemaVersion: 1, kind: 'woohaa-runtime-npm-script-audit', platform: `${process.platform}-${process.arch}`, allowed: [], denied: [], ignored: [], unverified: [] };
  for (const [engineId, engine] of Object.entries(lock.engines)) {
    const policy = engine.scripts ?? lock.scripts ?? { allowed: [], denied: [] };
    const allowed = new Map((policy.allowed ?? []).map((entry) => [`${entry.package}:${entry.lifecycle}:${entry.command}`, entry]));
    const denied = new Map((policy.denied ?? []).map((entry) => [`${entry.package}:${entry.lifecycle}:${entry.command}`, entry]));
    for (const entry of Object.values(engine.packages)) {
      const manifest = read(entry.name, entry.version);
      if (!manifest) {
        result.unverified.push({ engine: engineId, package: entry.name, version: entry.version });
        continue;
      }
      const { lifecycle, ignored } = scriptsFor(manifest);
      for (const script of ignored) result.ignored.push({ engine: engineId, package: entry.name, version: entry.version, ...script });
      for (const script of lifecycle) {
        const key = `${entry.name}:${script.lifecycle}:${script.command}`;
        const digest = scriptDigest(entry.name, entry.version, script.lifecycle, script.command);
        if (allowed.has(key)) result.allowed.push({ engine: engineId, package: entry.name, version: entry.version, ...script, sha256: digest });
        else if (denied.has(key)) result.denied.push({ engine: engineId, package: entry.name, version: entry.version, ...script, sha256: digest, reason: denied.get(key).reason });
        else fail('UNAPPROVED_LIFECYCLE_SCRIPT', `Unexpected lifecycle script ${entry.name}@${entry.version} ${script.lifecycle}: ${script.command}. Review it in client/desktop/runtime-npm-scripts.json.`);
      }
    }
  }
  return result;
}


function closureFor(roots, lock) {
  const byVersion = snapshotEntriesByVersion(lock.snapshots);
  const packages = {};
  const queue = [];
  for (const root of Object.values(roots)) {
    const id = `${root.package}@${root.version}`;
    if (!byVersion.has(id)) fail('MISSING_DEPENDENCY', `${id} is missing from the lockfile snapshots`);
    if (!queue.includes(id)) queue.push(id);
  }
  while (queue.length) {
    const id = queue.shift();
    if (packages[id]) continue;
    const record = byVersion.get(id);
    const meta = packageMeta(lock, id);
    if (!record || !meta) fail('MISSING_DEPENDENCY', `${id} is missing from the lockfile`);
    const entry = {
      name: record.name,
      version: record.version,
      integrity: integrityOf(lock, id),
      ...(normalizeList(meta.os) ? { os: normalizeList(meta.os) } : {}),
      ...(normalizeList(meta.cpu) ? { cpu: normalizeList(meta.cpu) } : {}),
      ...(normalizeList(meta.libc) ? { libc: normalizeList(meta.libc) } : {}),
      ...(meta.optional === true ? { optional: true } : {}),
      dependencies: []
    };
    packages[id] = entry;
    for (const snapshotKey of record.snapshots) {
      const snapshot = lock.snapshots[snapshotKey] ?? {};
      const optional = new Set(Object.keys(snapshot.optionalDependencies ?? {}));
      // Peer edges are already materialised into `dependencies` by pnpm's resolver; installing them
      // again would pull unrelated variants. Runtime layout verification checks peers instead.
      const all = { ...(snapshot.dependencies ?? {}), ...(snapshot.optionalDependencies ?? {}) };
      for (const [name, raw] of Object.entries(all)) {
        const target = resolveDependencySpec(name, raw);
        const targetId = `${target.name}@${target.version}`;
        if (!byVersion.has(targetId)) fail('MISSING_DEPENDENCY', `${id} → ${name}@${target.version} is not present in the lockfile snapshots`);
        const edge = { name, target: targetId, optional: optional.has(name) };
        if (!entry.dependencies.some((existing) => existing.name === edge.name && existing.target === edge.target)) entry.dependencies.push(edge);
        queue.push(targetId);
      }
    }
    entry.dependencies.sort((left, right) => left.name.localeCompare(right.name));
  }
  return packages;
}

function selectPlatformPackages(packages, platformKey) {
  const selected = [];
  for (const [id, entry] of Object.entries(packages)) {
    if (platformMatches(entry, platformKey)) selected.push(id);
  }
  return selected.sort();
}

/** 入口规则用 `{platform}` / `{exe}` 模板，运行期按实际平台展开。 */
function engineEntry(engine, components) {
  if (engine === 'dsh') {
    return { type: 'module-generator', file: 'entry.mjs', module: '@deepseek-ai/dsh/lib/bin.js', export: 'runCli' };
  }
  if (engine === 'claude') {
    return { type: 'package-file', package: '@anthropic-ai/claude-agent-sdk-{platform}', pattern: 'claude{exe}', probeVersion: components.claude.localVersions?.[0] };
  }
  return { type: 'package-file', package: '@openai/codex-{platform}', pattern: 'vendor/*/bin/codex{exe}', probeVersion: components.codex.version };
}

export function expandEntry(entry, platformKey) {
  const exe = platformKey.startsWith('win32') ? '.exe' : '';
  const expand = (value) => typeof value === 'string' ? value.split('{platform}').join(platformKey).split('{exe}').join(exe) : value;
  return Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, expand(value)]));
}

function validatePlatform(engine, packages, platformKey, entry, rootId) {
  const ids = selectPlatformPackages(packages, platformKey);
  if (!ids.length) fail('MISSING_PLATFORM_PACKAGE', `${engine} has no installable packages for ${platformKey}`);
  if (entry.type === 'package-file') {
    // The platform binary can be published under an alias (Codex uses `@openai/codex-<platform>`
    // → `@openai/codex@<version>-<platform>`), so match the root's dependency edge, not the name.
    const edge = packages[rootId]?.dependencies.find((item) => item.name === entry.package);
    const target = edge && ids.includes(edge.target) ? packages[edge.target] : undefined;
    if (!target || !platformMatches(target, platformKey)) fail('MISSING_PLATFORM_PACKAGE', `${engine} ${platformKey} is missing ${entry.package}`);
  }
  if (engine === 'dsh') {
    // dsh 的原生加载器按平台分发；缺少对应包会在首轮工具调用时炸在深处。
    const native = [...ids].some((id) => /^node-addon-require-builtin-.+/.test(packages[id].name) && platformMatches(packages[id], platformKey));
    if (!native) fail('MISSING_PLATFORM_PACKAGE', `dsh ${platformKey} is missing its native loader package`);
  }
  return ids;
}

/**
 * 生成并校验 runtime npm lock。
 *
 * @param {object} options
 * @param {string} options.clientRoot
 * @param {string[]} [options.platforms] 需要覆盖的平台键（默认桌面 + web host 矩阵）。
 * @param {object[]} [options.policy] lifecycle 审核清单。
 * @param {(name: string, version: string) => object | undefined} [options.readInstalled] 测试注入。
 */
export function buildRuntimeNpmLock({ clientRoot, platforms = RUNTIME_NPM_SUPPORTED_PLATFORMS, policy, readInstalled } = {}) {
  const { file, text, lock } = loadRuntimeNpmLockfile(clientRoot);
  lock.clientRoot = clientRoot;
  const componentsFile = path.join(clientRoot, 'desktop/runtime-components.lock.json');
  const components = JSON.parse(fs.readFileSync(componentsFile, 'utf8'));
  const roots = {
    dsh: { package: '@deepseek-ai/dsh', version: components.components.dsh.version },
    claude: { package: '@anthropic-ai/claude-agent-sdk', version: components.components.claude.version },
    codex: { package: '@openai/codex', version: components.components.codex.version }
  };
  const policyFile = policy ?? JSON.parse(fs.readFileSync(path.join(clientRoot, 'desktop/runtime-npm-scripts.json'), 'utf8'));
  const audit = normalizePolicy(policyFile);
  const engines = {};
  for (const [engineId, root] of Object.entries(roots)) {
    const packages = closureFor({ [engineId]: root }, lock);
    const perPlatform = {};
    for (const platformKey of platforms) {
      const entry = expandEntry(engineEntry(engineId, components.components), platformKey);
      const ids = validatePlatform(engineId, packages, platformKey, entry, `${root.package}@${root.version}`);
      perPlatform[platformKey] = { packages: ids, requests: ids.length };
    }
    const nodeRange = packageMeta(lock, `${root.package}@${root.version}`)?.engines?.node;
    engines[engineId] = {
      id: engineId,
      engine: engineId === 'dsh' ? 'dsh-agent-sdk' : engineId === 'claude' ? 'claude-agent-sdk' : 'codex-agent-sdk',
      package: root.package,
      version: root.version,
      kind: engineId === 'dsh' ? 'node' : 'executable',
      node: nodeRange,
      // 解压 + 缓存的保守上限；用于安装前磁盘检查，不是网络流量估算。
      // 实测最大的平台解压体积分别约 635MB / 296MB / 435MB；留出 tarball 缓存与收尾余量。
      spaceBytes: engineId === 'dsh' ? 1500 * 1024 * 1024 : engineId === 'claude' ? 800 * 1024 * 1024 : 1000 * 1024 * 1024,
      entry: engineEntry(engineId, components.components),
      platforms: perPlatform,
      packages,
      scripts: audit
    };
  }
  const body = {
    schemaVersion: RUNTIME_NPM_SCHEMA_VERSION,
    kind: 'woohaa-runtime-npm-lock',
    generatedFrom: { lockfile: 'client/locks/web/pnpm-lock.yaml', lockfileSha256: normalizedTextSha256(text) },
    registry: { default: 'https://registry.npmjs.org/', mirrors: RUNTIME_NPM_MIRRORS },
    node: { version: readDesktopNodeVersion(clientRoot) },
    platforms,
    engines
  };
  return body;
}

function readDesktopNodeVersion(clientRoot) {
  let text;
  for (const root of [clientRoot, REPO_ROOT]) {
    try {
      text = fs.readFileSync(path.join(root, 'scripts/lib/desktop-host-package.mjs'), 'utf8');
      break;
    } catch {
      // Temp fixtures fall back to the repository's own packaging constant.
    }
  }
  if (!text) fail('INVALID_NODE_VERSION', 'Cannot read DESKTOP_NODE_VERSION');
  const match = /DESKTOP_NODE_VERSION='([^']+)'/.exec(text);
  if (!match) fail('INVALID_NODE_VERSION', 'Cannot read DESKTOP_NODE_VERSION');
  return match[1];
}

/** 体积与请求数基线；解压字节不是网络流量，发布前必须在目标平台重新测量。 */
export function measureRuntimeNpmLock({ clientRoot, lock, scan } = {}) {
  const installed = scan ?? scanInstalledClosure(clientRoot);
  const measurements = { schemaVersion: 1, kind: 'woohaa-runtime-npm-measurements', engines: {} };
  for (const [engineId, engine] of Object.entries(lock.engines)) {
    const perPlatform = {};
    for (const [platformKey, platform] of Object.entries(engine.platforms)) {
      let unpackedBytes = 0;
      let measured = 0;
      const missing = [];
      for (const id of platform.packages) {
        const entry = engine.packages[id];
        const found = installed.get(`${entry.name}@${entry.version}`);
        if (!found) {
          missing.push(id);
          continue;
        }
        unpackedBytes += directoryBytes(found.root);
        measured += 1;
      }
      perPlatform[platformKey] = {
        requests: platform.requests,
        measuredPackages: measured,
        unpackedBytes,
        // Network bytes are only known by a real registry install; never infer them from unpacked size.
        networkBytes: null,
        ...(missing.length ? { unmeasured: missing.sort() } : {})
      };
    }
    measurements.engines[engineId] = { version: engine.version, platforms: perPlatform };
  }
  return measurements;
}

function directoryBytes(root) {
  let total = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) total += fs.statSync(file).size;
    }
  };
  walk(root);
  return total;
}

/**
 * 校验已提交 lock 与仓库输入一致（`--check`）。
 *
 * 不做「重新推导 + 全量 JSON 比较」：`platforms` 里的包集合按构建机实际平台裁剪，
 * 不同 OS 的构建机重算出的对象本来就可能不同（2026-11-12 Windows 分发现场：
 * Linux 上生成、Windows 上校验被判 STALE_LOCK）。这里只校验**与平台无关**的事实：
 *
 * - `generatedFrom.lockfileSha256` 与当前 pnpm lockfile 一致（依赖变了没重新生成）；
 * - 每个引擎的版本与 `desktop/runtime-components.lock.json` 一致（引擎升级没同步）；
 * - 平台集合覆盖声明的全部平台，且每个平台的包集合非空、integrity 齐全；
 * - `registry` 与 Node 版本存在。
 *
 * 返回**已提交**的 lock（运行期消费的就是它），而不是本机重新推导的结果。
 */
export function assertRuntimeNpmLockCurrent({ clientRoot, committed } = {}) {
  const actual = committed ?? JSON.parse(fs.readFileSync(path.join(clientRoot, 'desktop/runtime-npm-lock.json'), 'utf8'));
  const { text } = loadRuntimeNpmLockfile(clientRoot);
  const { components } = JSON.parse(fs.readFileSync(path.join(clientRoot, 'desktop/runtime-components.lock.json'), 'utf8'));

  // 行尾归一化后再求摘要：Windows checkout 的 CRLF 不应让指纹失效。
  const expectedLockfile = normalizedTextSha256(text);
  if (actual.generatedFrom?.lockfileSha256 !== expectedLockfile) {
    fail('STALE_LOCK', 'desktop/runtime-npm-lock.json 与 pnpm lockfile 不一致；先运行 node scripts/build-runtime-npm-manifest.mjs');
  }

  for (const engineId of ['dsh', 'claude', 'codex']) {
    const engine = actual.engines?.[engineId];
    if (!engine) fail('STALE_LOCK', `desktop/runtime-npm-lock.json 缺少引擎 ${engineId}；先运行 node scripts/build-runtime-npm-manifest.mjs`);
    const declared = components[engineId]?.version;
    if (declared && engine.version !== declared) {
      fail(
        'STALE_LOCK',
        `desktop/runtime-npm-lock.json 里 ${engineId} 是 ${engine.version}，runtime-components.lock.json 已声明 ${declared}；先运行 node scripts/build-runtime-npm-manifest.mjs`
      );
    }
    for (const platformKey of actual.platforms ?? []) {
      const platform = engine.platforms?.[platformKey];
      if (!platform || !Array.isArray(platform.packages) || platform.packages.length === 0) {
        fail('STALE_LOCK', `desktop/runtime-npm-lock.json 缺少 ${engineId} 在 ${platformKey} 的包集合；先运行 node scripts/build-runtime-npm-manifest.mjs`);
      }
      for (const id of platform.packages) {
        if (!engine.packages?.[id]) fail('STALE_LOCK', `desktop/runtime-npm-lock.json 缺少 ${id} 的完整条目；先运行 node scripts/build-runtime-npm-manifest.mjs`);
      }
    }
  }
  if (!actual.registry?.default) fail('STALE_LOCK', 'desktop/runtime-npm-lock.json 缺少 registry 声明');
  if (!Array.isArray(actual.registry.mirrors) || actual.registry.mirrors.some((mirror) => {
    if (typeof mirror !== 'string') return true;
    try { return new URL(mirror).protocol !== 'https:'; } catch { return true; }
  })) fail('STALE_LOCK', 'desktop/runtime-npm-lock.json 的 registry.mirrors 必须是 HTTPS 地址数组');
  if (!actual.node?.version) fail('STALE_LOCK', 'desktop/runtime-npm-lock.json 缺少 Node 版本');
  return actual;
}
