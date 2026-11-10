import * as fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { createHash, verify, randomUUID } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  extractNpmTarball, planLayout, packageDirectory, platformKey, probeNpmToolchain, registryTarballUrl,
  runAllowedScripts, selectPlatformPackages, tarballCacheName, verifyEntry, verifyIntegrity, verifyLayout
} from './npm-registry.mjs';
const exec = promisify(execFile);
export class RuntimeComponentError extends Error {
  constructor(code, message) { super(message); this.name = 'RuntimeComponentError'; this.code = code; }
}
const fail = (code, message) => { throw new RuntimeComponentError(code, message); };
const segment = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) && value !== '..';
async function json(file, optional = false) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (optional && error.code === 'ENOENT') return {}; throw error; }
}
function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name) || /^[a-zA-Z]:/.test(name) || name.split('/').some(part => part === '..' || /[. ]$/.test(part) && part !== '.' || /[:<>"|?*\x00-\x1f]/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('UNSAFE_ARCHIVE', `Unsafe archive path: ${name}`);
  return name.replace(/^\.\//, '');
}
async function fileHash(file) {
  const hash = createHash('sha256');
  const input = (await fs.open(file)).createReadStream();
  for await (const bytes of input) hash.update(bytes);
  return hash.digest('hex');
}
function validateConfig(value, user = false) {
  const allowed = new Set(['schemaVersion', 'cdn', 'registry', 'components', user ? 'additionalTrustKeys' : 'trustKeys']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('INVALID_CONFIG', `Unknown runtime configuration field: ${key}`);
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) fail('INVALID_CONFIG', 'Unsupported runtime configuration schema');
  if (value.cdn) {
    if (Object.keys(value.cdn).some(k => k !== 'baseUrl')) fail('INVALID_CONFIG', 'Unknown CDN configuration field');
    if (value.cdn.baseUrl) validateUrl(value.cdn.baseUrl);
  }
  // The npm registry is deployment-managed (default or enterprise mirror); users cannot type an
  // arbitrary registry any more than they can type an arbitrary package name.
  if (value.registry) {
    if (user) fail('INVALID_CONFIG', 'The npm registry is managed by the deployment');
    if (Object.keys(value.registry).some(k => k !== 'baseUrl')) fail('INVALID_CONFIG', 'Unknown registry configuration field');
    if (value.registry.baseUrl) validateUrl(value.registry.baseUrl);
  }
  for (const [id, config] of Object.entries(value.components || {})) {
    if (!segment(id) || Object.keys(config).some(k => !['source', 'path'].includes(k)) || !['managed', 'npm-registry', 'local'].includes(config.source)) fail('INVALID_CONFIG', `Invalid component configuration: ${id}`);
    if (config.source === 'local' && (!config.path || !path.isAbsolute(config.path))) fail('INVALID_CONFIG', `Local ${id} needs an absolute executable path`);
  }
  for (const key of ['trustKeys', 'additionalTrustKeys']) if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some(k => typeof k !== 'string'))) fail('INVALID_CONFIG', `Invalid ${key}`);
}
function validateUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) fail('INVALID_CONFIG', 'Runtime CDN requires HTTPS (HTTP is allowed only on loopback)');
  return url;
}
// A streaming, deliberately narrow USTAR reader: only regular files/directories.
// Links and extension records are rejected rather than delegated to a platform tar.
async function extract(archive, destination, maxBytes, signal) {
  let pending = Buffer.alloc(0), current, remaining = 0, padding = 0, total = 0, count = 0, expanded = 0;
  const input = (await fs.open(archive)).createReadStream();
  const stream = input.pipe(createGunzip());
  const abort = () => stream.destroy(signal.reason || new Error('Cancelled'));
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted(); expanded += chunk.length; if (expanded > maxBytes + 100000 * 1024 + 10240) fail('ARCHIVE_LIMIT', 'Runtime tar overhead exceeds limit'); pending = Buffer.concat([pending, chunk]);
      while (true) {
        if (remaining) {
          const size = Math.min(remaining, pending.length); if (!size) break;
          await current.write(pending.subarray(0, size)); pending = pending.subarray(size); remaining -= size;
          if (!remaining) { await current.close(); current = undefined; } continue;
        }
        if (padding) { const size = Math.min(padding, pending.length); padding -= size; pending = pending.subarray(size); if (padding) break; }
        if (pending.length < 512) break;
        const header = pending.subarray(0, 512); pending = pending.subarray(512);
        if (header.every(b => b === 0)) continue;
        const string = (offset, size) => header.subarray(offset, offset + size).toString().split('\0')[0];
        const expected = parseInt(string(148, 8).trim(), 8);
        let sum = 0; for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
        if (sum !== expected) fail('UNSAFE_ARCHIVE', 'Invalid tar header checksum');
        const name = safeRelative([string(345, 155), string(0, 100)].filter(Boolean).join('/'));
        const first = name.split('/').find(part => part && part !== '.');
        if (first === '.leases' || first === 'ready.json' || first === '.release-requested' || first?.startsWith('.runtime-')) fail('UNSAFE_ARCHIVE', `Reserved runtime coordination path: ${name}`);
        const size = parseInt(string(124, 12).trim() || '0', 8), type = string(156, 1);
        if (!Number.isSafeInteger(size) || size < 0 || !['', '0', '5'].includes(type)) fail('UNSAFE_ARCHIVE', `Unsupported archive entry: ${name}`);
        total += size; if (total > maxBytes || ++count > 100000) fail('ARCHIVE_LIMIT', 'Runtime archive exceeds declared size or file count');
        const target = path.join(destination, name);
        if (type === '5') { if (size) fail('UNSAFE_ARCHIVE', 'Directory with content'); await fs.mkdir(target, { recursive: true }); }
        else { await fs.mkdir(path.dirname(target), { recursive: true }); current = await fs.open(target, 'wx', parseInt(string(100, 8).trim() || '644', 8) & 0o777); remaining = size; padding = (512 - size % 512) % 512; if (!size) { await current.close(); current = undefined; } }
      }
    }
    if (remaining || padding || pending.length) fail('UNSAFE_ARCHIVE', 'Truncated tar archive');
  } finally { signal.removeEventListener('abort', abort); await current?.close(); stream.destroy(); input.destroy(); }
}
export function createRuntimeComponentManager({
  dataDir, defaultsPath, lockPath,
  npmLockPath = null, toolsDir = null, registryUrl = null, installEnabled = true,
  nodeExecPath = process.execPath,
  platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch
}) {
  if (!dataDir || !defaultsPath || !lockPath) fail('INVALID_CONFIG', 'Runtime data directory, defaults and lock paths are required');
  const configFile = path.join(dataDir, 'config/runtime-downloads.json');
  const jobs = new Map(), states = new Map(), leases = new Map();
  const key = `${platform}-${arch}`;
  let npmCache;
  async function npmLock() {
    if (!npmLockPath) return undefined;
    let info;
    try { info = await fs.stat(npmLockPath); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    if (npmCache && npmCache.mtimeMs === info.mtimeMs && npmCache.size === info.size) return npmCache.value;
    const value = await json(npmLockPath);
    if (value.schemaVersion !== 1 || value.kind !== 'woohaa-runtime-npm-lock' || !value.engines || typeof value.engines !== 'object') fail('INVALID_CONFIG', 'Invalid runtime npm registry lock');
    for (const [id, engine] of Object.entries(value.engines)) {
      if (!segment(id) || !segment(engine.version) || !engine.packages || !engine.packages[`${engine.package}@${engine.version}`]) fail('INVALID_CONFIG', `Invalid npm runtime lock entry: ${id}`);
      for (const [packageId, entry] of Object.entries(engine.packages)) {
        if (typeof entry.integrity !== 'string' || !/^(?:sha512|sha256|sha1)-/.test(entry.integrity) || typeof entry.name !== 'string' || typeof entry.version !== 'string') fail('INVALID_CONFIG', `Invalid npm runtime package: ${packageId}`);
        if (!Array.isArray(entry.dependencies)) entry.dependencies = [];
      }
    }
    npmCache = { mtimeMs: info.mtimeMs, size: info.size, value };
    return value;
  }
  async function settings(id) {
    const defaults = await json(defaultsPath), user = await json(configFile, true), lock = await json(lockPath);
    const npm = await npmLock();
    validateConfig(defaults); validateConfig(user, true);
    if (lock.schemaVersion !== 1 || !lock.components || Object.keys(lock.components).some(k => !segment(k) || !segment(lock.components[k].version))) fail('INVALID_CONFIG', 'Invalid runtime component lock');
    if (id && !lock.components[id] && !npm?.engines?.[id]) fail('UNKNOWN_COMPONENT', `Unknown runtime component: ${id}`);
    const item = id ? lock.components[id] : undefined;
    if (item?.platforms && (!Array.isArray(item.platforms) || !item.platforms.includes(key))) fail('INCOMPATIBLE_COMPONENT', `${id} is unavailable on ${key}`);
    const engine = id ? npm?.engines?.[id] : undefined;
    if (engine && !engine.platforms?.[key]) fail('INCOMPATIBLE_COMPONENT', `${id} has no npm registry runtime for ${key}`);
    const requested = user.components?.[id]?.source || defaults.components?.[id]?.source;
    // A build that ships a registry lock defaults to it even when the deployment disables
    // installation: users then see the real administrator reason instead of a missing CDN.
    const fallback = engine ? 'npm-registry' : 'managed';
    const source = requested ?? fallback;
    const blocked = source === 'npm-registry' && (!installEnabled || !engine)
      ? (installEnabled ? `${id} has no locked npm registry runtime` : '管理员未启用运行时安装')
      : undefined;
    return {
      lock, item, engine, npm,
      version: source === 'npm-registry' ? engine?.version ?? item?.version : item?.version,
      config: { ...defaults.components?.[id], ...user.components?.[id], source },
      baseUrl: user.cdn?.baseUrl ?? defaults.cdn?.baseUrl,
      registryUrl: registryUrl || defaults.registry?.baseUrl || npm?.registry?.default || 'https://registry.npmjs.org/',
      blocked,
      keys: [...defaults.trustKeys || [], ...user.additionalTrustKeys || []]
    };
  }
  const directory = (id, version) => path.join(dataDir, 'runtimes', id, version, `${platform}-${arch}`);
  function reportedCodexVersion(output) {
    return output.match(/codex(?:-cli)?\s+v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)/i)?.[1];
  }
  const codexExecutableName = platform === 'win32' ? 'codex.exe' : 'codex';
  // npm/pnpm/nvm/fnm global installs put a `#!/usr/bin/env node` shim on PATH and the real
  // architecture binary in the optional `@openai/codex-<platform>-<arch>` package. A packaged
  // App inherits only the launchd PATH (`/usr/bin:/bin:...`), which has no node, so the shim
  // always fails with `env: node: No such file or directory`. Resolve the vendored binary instead.
  async function isNodeShim(file) {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const first = buffer.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0];
      return /^#!/.test(first) && /(?:^|[\s/\\])(?:node|nodejs)(?:\.exe)?(?:$|\s)/.test(first);
    } finally { await handle.close(); }
  }
  async function vendoredCodexNative(executable) {
    const real = await fs.realpath(executable).catch(() => executable);
    let directory = path.dirname(real);
    // npm global layout is `<prefix>/bin/<name>` next to `<prefix>/lib/node_modules`;
    // version managers (fnm/nvm) symlink `bin/<name>` into the package itself.
    const moduleRoots = base => path.basename(base) === 'node_modules' ? [base] : [path.join(base, 'node_modules'), path.join(base, 'lib', 'node_modules')];
    for (let depth = 0; depth < 10; depth += 1) {
      for (const modules of moduleRoots(directory)) {
        let packages = [];
        try { packages = await fs.readdir(path.join(modules, '@openai')); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
        for (const name of packages) {
          if (!/^codex-[a-z0-9-]+$/.test(name)) continue;
          const vendor = path.join(modules, '@openai', name, 'vendor');
          let targets = [];
          try { targets = await fs.readdir(vendor); } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
          for (const target of targets) {
            const candidate = path.join(vendor, target, 'bin', codexExecutableName);
            try {
              if (!(await fs.stat(candidate)).isFile()) continue;
              if (await isNodeShim(candidate)) continue;
              return candidate;
            } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
          }
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  // Shebang shims cannot run without `node` on the launchd PATH; a resolved vendored binary keeps
  // the selection usable without asking the user to know their package manager's internal layout.
  async function nativeCodex(executable) {
    if (!(await isNodeShim(executable))) return executable;
    return (await vendoredCodexNative(executable)) ?? executable;
  }
  async function resolveCodexExecutable(executable) {
    const info = await fs.stat(executable);
    if (info.isFile()) return executable;
    if (!(info.isDirectory() && executable.toLowerCase().endsWith('.app'))) fail('INCOMPATIBLE_COMPONENT', 'Selected runtime is not a file');
    const names = platform === 'win32' ? ['codex.exe'] : ['codex'];
    const relatives = [['Contents', 'Resources', 'codex-cli', 'CodexCLI.app', 'Contents', 'MacOS'], ['Contents', 'MacOS']];
    for (const relative of relatives) for (const name of names) {
      const candidate = path.join(executable, ...relative, name);
      try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    fail('INCOMPATIBLE_COMPONENT', 'Selected app does not contain a Codex executable');
  }
  async function local(id, executable, version, localVersions, blockedVersions = []) {
    const compatible = localVersions ?? (id === 'claude' ? [] : [version]);
    if (id !== 'codex' && (!Array.isArray(compatible) || compatible.some(value => !segment(value)) || !compatible.length)) fail('INCOMPATIBLE_COMPONENT', `No compatible local CLI versions are declared for ${id}`);
    if (!path.isAbsolute(executable) || /\.(cmd|bat)$/i.test(executable)) fail('INCOMPATIBLE_COMPONENT', 'Choose an absolute native executable (Windows .cmd/.bat launchers are not supported)');
    if (id === 'codex') executable = await nativeCodex(await resolveCodexExecutable(executable));
    else { const info = await fs.stat(executable); if (!info.isFile()) fail('INCOMPATIBLE_COMPONENT', 'Selected runtime is not a file'); }
    const cwd = path.join(dataDir, 'runtime-probes', id); await fs.mkdir(cwd, { recursive: true });
    const env = { PATH: process.env.PATH, HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd, TEMP: cwd, SystemRoot: process.env.SystemRoot };
    let stdout, stderr;
    try { ({ stdout, stderr } = await exec(executable, ['--version'], { cwd, env, timeout: 5000, maxBuffer: 16384, windowsHide: true })); }
    catch (error) {
      // A shebang launcher whose vendored binary is missing fails with `env: node: No such file or
      // directory`, which says nothing about what the user should do.
      if (/env: node|node: No such file|ENOENT/i.test(String(error?.message ?? ''))) fail('INCOMPATIBLE_COMPONENT', `Selected ${id} cannot run without \`node\` on this App's PATH; choose the native ${id} binary or the ChatGPT app instead`);
      throw error;
    }
    const output = `${stdout}\n${stderr}`;
    if (['codex', 'claude'].includes(id) && !new RegExp(id, 'i').test(output)) fail('INCOMPATIBLE_COMPONENT', `Selected program does not identify as ${id}`);
    if (id === 'codex') {
      const actualVersion = reportedCodexVersion(output);
      if (!actualVersion) fail('INCOMPATIBLE_COMPONENT', 'Selected codex did not report a version');
      if ((Array.isArray(blockedVersions) ? blockedVersions : []).includes(actualVersion)) fail('INCOMPATIBLE_COMPONENT', `Selected codex ${actualVersion} is blocked`);
      return { entry: executable, version: actualVersion, source: 'local', kind: 'executable' };
    }
    const actualVersion = compatible.find(candidate => new RegExp(`(?:^|[^\\d.])${candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[^\\w.+-])`).test(output));
    if (!actualVersion) fail('INCOMPATIBLE_COMPONENT', `Selected ${id} must report one of: ${compatible.join(', ')}`);
    return { entry: executable, version: actualVersion, source: 'local', kind: 'executable' };
  }
  async function installedManaged(id, setting, verifyEntry = false) {
    const root = directory(id, setting.item.version);
    try {
      const receipt = await json(path.join(root, '.runtime-receipt.json'));
      const catalogBytes = await fs.readFile(path.join(root, '.runtime-catalog.json'));
      const signatureBytes = await fs.readFile(path.join(root, '.runtime-catalog.sig'));
      if (!setting.keys.some(key => { try { return verify(null, catalogBytes, key, Buffer.from(signatureBytes.toString().trim(), 'base64')); } catch { return false; } })) fail('INVALID_CACHE', `Cached ${id} catalog signature is invalid`);
      const catalog = JSON.parse(catalogBytes.toString());
      const matches = catalog.components?.filter(x => x.id === id && x.version === setting.item.version && x.platform === platform && x.arch === arch) || [];
      const { entrySha256, ...metadata } = receipt;
      if (matches.length !== 1 || JSON.stringify(matches[0]) !== JSON.stringify(metadata)) fail('INVALID_CACHE', `Cached ${id} receipt differs from signed catalog`);
      if (receipt.id !== id || receipt.version !== setting.item.version || receipt.platform !== platform || receipt.arch !== arch || receipt.protocol !== setting.item.protocol) return;
      const entry = path.join(root, safeRelative(receipt.entry));
      if (!(await fs.lstat(entry)).isFile()) fail('INVALID_CACHE', `Cached ${id} entry is not a regular file`);
      const realRoot = await fs.realpath(root), realEntry = await fs.realpath(entry);
      if (!realEntry.startsWith(realRoot + path.sep)) fail('INVALID_CACHE', `Cached ${id} entry escapes its directory`);
      if (verifyEntry && (await fileHash(entry)) !== entrySha256) fail('INVALID_CACHE', `Cached ${id} entry checksum differs`);
      return { entry, version: receipt.version, source: 'managed', kind: receipt.kind };
    } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  }
  async function installedNpm(id, setting, verifyEntry = false) {
    const root = directory(id, setting.engine.version);
    try {
      const receipt = await json(path.join(root, '.runtime-receipt.json'));
      const ready = await json(path.join(root, 'ready.json'));
      if (receipt.id !== id || receipt.source !== 'npm-registry' || receipt.version !== setting.engine.version || receipt.platform !== platform || receipt.arch !== arch) return;
      const entry = path.join(root, safeRelative(receipt.entry));
      if (ready.schemaVersion !== 1 || typeof ready.entry !== 'string' || path.resolve(ready.entry) !== path.resolve(entry) || !Number.isInteger(receipt.packages)) fail('INVALID_CACHE', `Cached ${id} ready marker is invalid`);
      const lockBytes = await fs.readFile(npmLockPath);
      const lockSha256 = createHash('sha256').update(lockBytes).digest('hex');
      if (receipt.lockSha256 !== lockSha256) fail('INVALID_CACHE', `Cached ${id} was installed from a different runtime lock`);
      if (!(await fs.lstat(entry)).isFile()) fail('INVALID_CACHE', `Cached ${id} entry is not a regular file`);
      const realRoot = await fs.realpath(root), realEntry = await fs.realpath(entry);
      if (!realEntry.startsWith(realRoot + path.sep)) fail('INVALID_CACHE', `Cached ${id} entry escapes its directory`);
      if (verifyEntry && (await fileHash(entry)) !== receipt.entrySha256) fail('INVALID_CACHE', `Cached ${id} entry checksum differs`);
      return { entry, version: receipt.version, source: 'npm-registry', kind: receipt.kind };
    } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  }
  const installed = (id, setting, verifyEntry = false) => setting.config.source === 'npm-registry'
    ? installedNpm(id, setting, verifyEntry)
    : installedManaged(id, setting, verifyEntry);
  async function inspect(id) {
    const s = await settings(id);
    const base = {
      id, version: s.version, source: s.config.source, status: 'missing',
      configured: s.config.source === 'npm-registry' ? Boolean(s.registryUrl) : Boolean(s.baseUrl),
      ...(s.config.source === 'local' && s.config.path ? { path: s.config.path } : {}),
      ...(s.engine ? { engine: s.engine.engine, registry: s.registryUrl, requests: s.engine.platforms?.[key]?.requests } : {}),
      ...(s.blocked ? { error: s.blocked } : {}),
      ...states.get(id)
    };
    if (s.blocked) return { ...base, status: 'unavailable', error: s.blocked };
    if (jobs.has(id)) return base;
    try {
      const found = s.config.source === 'local' ? await local(id, s.config.path, s.version, s.item.localVersions, s.item.blockedVersions) : await installed(id, s);
      return { ...base, status: found ? 'ready' : base.status === 'failed' ? 'failed' : 'missing', ...found };
    } catch (error) { return { ...base, status: error.code === 'RUNTIME_INSTALL_DISABLED' ? 'unavailable' : 'incompatible', error: error.message }; }
  }
  async function resolve(id) {
    const s = await settings(id);
    if (s.blocked) fail('RUNTIME_INSTALL_DISABLED', s.blocked);
    const found = s.config.source === 'local' ? await local(id, s.config.path, s.version, s.item.localVersions, s.item.blockedVersions) : await installed(id, s, true);
    if (!found) fail('RUNTIME_COMPONENT_MISSING', `Runtime ${id} is not installed; install or retry it from Settings → Runtime components`);
    const leaseKey = `${id}/${found.version}`; leases.set(leaseKey, (leases.get(leaseKey) || 0) + 1); let released = false;
    let leaseFile;
    if (found.source === 'managed' || found.source === 'npm-registry') {
      const leaseDir = path.join(directory(id, found.version), '.leases');
      try {
        await fs.mkdir(leaseDir).catch(e => { if (e.code !== 'EEXIST') throw e; });
        leaseFile = path.join(leaseDir, `${process.pid}-${randomUUID()}.json`);
        await fs.writeFile(leaseFile, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
        if (!await installed(id, s)) fail('RUNTIME_COMPONENT_MISSING', `Runtime ${id} was removed during acquisition`);
      } catch (error) { leases.set(leaseKey, leases.get(leaseKey) - 1); if (leaseFile) await fs.rm(leaseFile, { force: true }); throw error; }
    }
    return { ...found, release() { if (!released) { released = true; leases.set(leaseKey, leases.get(leaseKey) - 1); if (leaseFile) { try { unlinkSync(leaseFile); } catch (error) { if (error.code !== 'ENOENT') throw error; } } } } };
  }
  async function response(url, signal, max, allowMissing = false) {
    const r = await fetchImpl(validateUrl(url), { signal, redirect: 'error' });
    if (allowMissing && r.status === 404) return undefined;
    if (!r.ok) fail('DOWNLOAD_FAILED', `Runtime download HTTP ${r.status}`);
    const chunks = []; let size = 0;
    for await (const chunk of r.body) { size += chunk.length; if (size > max) fail('DOWNLOAD_LIMIT', 'Runtime metadata exceeds limit'); chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  async function perform(id, signal) {
    let staging, lockDir, ownsLock = false;
    try {
      signal.throwIfAborted(); const s = await settings(id); signal.throwIfAborted();
      if (s.blocked) fail('RUNTIME_INSTALL_DISABLED', s.blocked);
      if (s.config.source === 'local') return await inspect(id);
      if (s.config.source === 'npm-registry') return await performNpm(id, s, signal);
      if (await installed(id, s)) return await inspect(id);
      if (!s.baseUrl) fail('CDN_NOT_CONFIGURED', 'Runtime download CDN is not configured');
      const base = new URL(s.baseUrl.endsWith('/') ? s.baseUrl : `${s.baseUrl}/`);
      states.set(id, { status: 'checking' });
      const envelopeBytes = await response(new URL('catalog.signed.json', base).href, signal, 6 * 1024 * 1024, true);
      let bytes, signature;
      if (envelopeBytes === undefined) {
        bytes = await response(new URL('catalog.json', base).href, signal, 4 * 1024 * 1024);
        signature = await response(new URL('catalog.sig', base).href, signal, 16384);
      } else {
        let envelope;
        try { envelope = JSON.parse(envelopeBytes.toString()); } catch { fail('INVALID_CATALOG', 'Invalid signed runtime catalog envelope'); }
        const base64 = value => typeof value === 'string' && value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value) && Buffer.from(value, 'base64').toString('base64') === value;
        if (envelope?.schemaVersion !== 1 || !base64(envelope.catalog) || !base64(envelope.signature)) fail('INVALID_CATALOG', 'Invalid signed runtime catalog envelope');
        bytes = Buffer.from(envelope.catalog, 'base64'); signature = Buffer.from(envelope.signature);
        if (bytes.length > 4 * 1024 * 1024 || signature.length > 16384) fail('DOWNLOAD_LIMIT', 'Runtime metadata exceeds limit');
      }
      if (!s.keys.some(key => { try { return verify(null, bytes, key, Buffer.from(signature.toString().trim(), 'base64')); } catch { return false; } })) fail('INVALID_SIGNATURE', 'Runtime catalog signature is invalid or untrusted');
      const catalog = JSON.parse(bytes.toString());
      if (![1, 2].includes(catalog.schemaVersion) || !Array.isArray(catalog.components)) fail('INVALID_CATALOG', 'Invalid runtime catalog');
      const matches = catalog.components.filter(x => x.id === id && x.version === s.item.version && x.platform === platform && x.arch === arch);
      if (matches.length !== 1) fail('COMPONENT_NOT_PUBLISHED', `No unique locked ${id} ${s.item.version} for ${platform}-${arch}`);
      const component = matches[0];
      if (component.protocol !== s.item.protocol || !['executable', 'node', 'asset'].includes(component.kind) || !/^[a-f0-9]{64}$/.test(component.sha256) || !Number.isSafeInteger(component.bytes) || component.bytes <= 0 || !Number.isSafeInteger(component.unpackedBytes) || component.unpackedBytes <= 0) fail('INVALID_CATALOG', 'Invalid component metadata or protocol');
      safeRelative(component.entry); if (!component.entry.replace(/\./g, '').replace(/\//g, '')) fail('INVALID_CATALOG', 'Runtime entry must name a file');
      const root = directory(id, s.item.version); await fs.mkdir(path.dirname(root), { recursive: true });
      lockDir = `${root}.lock`;
      for (;;) {
        signal.throwIfAborted();
        try { await fs.mkdir(lockDir); ownsLock = true; await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid })); break; }
        catch (e) {
          if (e.code !== 'EEXIST') throw e;
          const owner = await json(path.join(lockDir, 'owner.json'), true);
          let alive = Boolean(owner.pid) || Date.now() - (await fs.stat(lockDir)).mtimeMs < 30000; try { if (owner.pid) process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
          if (!alive) { await fs.rm(lockDir, { recursive: true, force: true }); continue; }
          if (await installed(id, s)) { lockDir = undefined; return; }
          await new Promise((r, reject) => { const timer = setTimeout(done, 200); function done() { signal.removeEventListener('abort', abort); r(); } function abort() { clearTimeout(timer); reject(signal.reason); } signal.addEventListener('abort', abort, { once: true }); });
        }
      }
      if (await installed(id, s)) return;
      const space = await fs.statfs(path.dirname(root));
      if (space.bavail * space.bsize < component.bytes + component.unpackedBytes + 1024 * 1024) fail('INSUFFICIENT_SPACE', 'Insufficient space for runtime installation');
      staging = `${root}.staging-${randomUUID()}`; await fs.mkdir(staging);
      const archive = `${root}.partial`, partialInfo = `${root}.partial.json`;
      let archiveBase = base;
      if (catalog.schemaVersion === 2) {
        if (!/^[a-f0-9]{64}$/.test(component.sha256) || component.url !== `blobs/sha256/${component.sha256}.tar.gz` || !/\/(darwin-aarch64|windows-x86_64)\/[^/]+\/$/.test(base.pathname) || base.search || base.hash) fail('INVALID_CATALOG', 'Invalid shared runtime blob or release directory');
        archiveBase = new URL('../../', base);
      }
      safeRelative(component.url);
      const url = validateUrl(new URL(component.url, archiveBase).href);
      if (url.origin !== base.origin || !url.pathname.startsWith(archiveBase.pathname) || url.search || url.hash) fail('INVALID_CATALOG', 'Runtime archive URL must remain under the configured CDN directory');
      let received = 0, handle, keepPartial = true;
      const prior = await json(partialInfo, true);
      if (prior.sha256 === component.sha256 && prior.url === url.href && prior.etag) {
        try { received = (await fs.stat(archive)).size; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      if (received >= component.bytes) received = 0;
      try {
        const headers = received ? { Range: `bytes=${received}-`, 'If-Range': prior.etag } : {};
        const r = await fetchImpl(url, { signal, redirect: 'error', headers });
        if (!r.ok) fail('DOWNLOAD_FAILED', `Runtime download HTTP ${r.status}`);
        if (received && !(r.status === 206 && r.headers.get('content-range') === `bytes ${received}-${component.bytes - 1}/${component.bytes}` && r.headers.get('etag') === prior.etag)) {
          if (r.status === 206) { keepPartial = false; fail('DOWNLOAD_FAILED', 'Invalid CDN partial response'); }
          received = 0;
        }
        const etag = r.headers.get('etag');
        await fs.writeFile(partialInfo, JSON.stringify({ sha256: component.sha256, url: url.href, etag }));
        handle = await fs.open(archive, received ? 'a' : 'w');
        const hash = createHash('sha256');
        if (received) { const existing = (await fs.open(archive)).createReadStream(); for await (const chunk of existing) hash.update(chunk); }
        states.set(id, { status: 'downloading', progress: { received, total: component.bytes } });
        for await (const chunk of r.body) { signal.throwIfAborted(); received += chunk.length; if (received > component.bytes) { keepPartial = false; fail('DOWNLOAD_LIMIT', 'Runtime archive exceeds declared size'); } hash.update(chunk); await handle.write(chunk); states.set(id, { status: 'downloading', progress: { received, total: component.bytes } }); }
        states.set(id, { status: 'verifying' });
        if (received !== component.bytes || hash.digest('hex') !== component.sha256) { keepPartial = false; fail('INVALID_HASH', 'Runtime archive size or SHA-256 mismatch'); }
        keepPartial = false;
        await handle.close(); states.set(id, { status: 'extracting' });
        await extract(archive, staging, component.unpackedBytes, signal);
        const entry = path.join(staging, component.entry); if (!(await fs.stat(entry)).isFile()) fail('INVALID_ENTRY', 'Runtime entry is missing');
        if (component.kind === 'executable' && platform !== 'win32') await fs.access(entry, 1);
        await fs.writeFile(path.join(staging, '.runtime-catalog.json'), bytes, { flag: 'wx' });
        await fs.writeFile(path.join(staging, '.runtime-catalog.sig'), signature, { flag: 'wx' });
        await fs.writeFile(path.join(staging, '.runtime-receipt.json'), JSON.stringify({ ...component, entrySha256: await fileHash(entry) }), { flag: 'wx' });
        await fs.writeFile(path.join(staging, 'ready.json'), JSON.stringify({ schemaVersion: 1, entry: path.join(root, component.entry), version: component.version, kind: component.kind }), { flag: 'wx' });
        signal.throwIfAborted(); await fs.rename(staging, root); staging = undefined;
        states.set(id, { status: 'ready' });
      } finally { await handle?.close().catch(() => {}); if (!keepPartial) { await fs.rm(archive, { force: true }); await fs.rm(partialInfo, { force: true }); } }
    } catch (error) { states.set(id, { status: 'failed', error: error.message || 'Installation cancelled' }); throw error; }
    finally { if (staging) await fs.rm(staging, { recursive: true, force: true }); if (ownsLock) await fs.rm(lockDir, { recursive: true, force: true }); }
  }
  /**
   * npm registry 安装：锁定 tarball → integrity → staging → 布局/入口/脚本探针 → 原子发布。
   * 与 CDN 安装共用 `install()` 的 single-flight、租约、取消和版本目录约定。
   */
  async function performNpm(id, s, signal) {
    const engine = s.engine;
    if (!engine) fail('UNKNOWN_COMPONENT', `Unknown npm registry runtime: ${id}`);
    const root = directory(id, engine.version);
    await fs.mkdir(path.dirname(root), { recursive: true });
    for (const name of await fs.readdir(path.dirname(root)).catch(() => [])) {
      // 上次中断留下的 staging/partial 不参与就绪判断；这里只清理本版本的残留。
      if (name.startsWith(`${engine.version}.staging-`) || name.startsWith(`${engine.version}.partial`)) {
        await fs.rm(path.join(path.dirname(root), name), { recursive: true, force: true });
      }
    }
    const lockDir = `${root}.lock`;
    let ownsLock = false;
    const releaseLock = async () => { if (ownsLock) { ownsLock = false; await fs.rm(lockDir, { recursive: true, force: true }); } };
    try {
      for (;;) {
        signal.throwIfAborted();
        try {
          await fs.mkdir(lockDir);
          ownsLock = true;
          await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid }));
          break;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const owner = await json(path.join(lockDir, 'owner.json'), true);
          let alive = Boolean(owner.pid) || Date.now() - (await fs.stat(lockDir)).mtimeMs < 30000;
          try { if (owner.pid) process.kill(owner.pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
          if (!alive) { await fs.rm(lockDir, { recursive: true, force: true }); continue; }
          if (await installedNpm(id, s)) return await inspect(id);
          await new Promise((resolve, reject) => {
            const timer = setTimeout(done, 200);
            function done() { signal.removeEventListener('abort', abort); resolve(); }
            function abort() { clearTimeout(timer); reject(signal.reason); }
            signal.addEventListener('abort', abort, { once: true });
          });
        }
      }
      if (await installedNpm(id, s)) return await inspect(id);
      const plan = planLayout(engine, key);
      const space = await fs.statfs(path.dirname(root));
      if (space.bavail * space.bsize < engine.spaceBytes) fail('INSUFFICIENT_SPACE', 'Insufficient space for runtime installation');
      const cacheDir = path.join(dataDir, 'cache/npm');
      await fs.mkdir(cacheDir, { recursive: true });
      const tools = toolsDir ? await probeNpmToolchain({ toolsDir, env: { HOME: cacheDir, TMPDIR: cacheDir, TEMP: cacheDir, SystemRoot: process.env.SystemRoot }, node: nodeExecPath }) : undefined;
      const staging = `${root}.staging-${randomUUID()}`;
      await fs.mkdir(staging);
      const directories = new Map();
      try {
        states.set(id, { status: 'downloading', progress: { received: 0, total: plan.selected.size } });
        let done = 0;
        for (const packageId of plan.selected) {
          signal.throwIfAborted();
          const entry = engine.packages[packageId];
          const file = path.join(cacheDir, tarballCacheName(entry));
          let bytes;
          try {
            bytes = await fs.readFile(file);
            verifyIntegrity(bytes, entry.integrity);
          } catch {
            const target = registryTarballUrl(s.registryUrl, entry.name, entry.version);
            const response = await fetchImpl(target, { signal, redirect: 'error' });
            if (!response.ok) fail('REGISTRY_UNAVAILABLE', `npm registry HTTP ${response.status} for ${entry.name}@${entry.version}`);
            bytes = Buffer.from(await response.arrayBuffer());
            verifyIntegrity(bytes, entry.integrity);
            const temporary = `${file}.${randomUUID()}.partial`;
            await fs.writeFile(temporary, bytes);
            await fs.rename(temporary, file);
          }
          done += 1;
          states.set(id, { status: 'downloading', progress: { received: done, total: plan.selected.size } });
        }
        states.set(id, { status: 'extracting' });
        const extraction = plan.placements;
        const directoryOf = new Map(extraction.map((placement) => [placement.id, packageDirectory(staging, placement)]));
        const extracted = new Set();
        for (const packageId of plan.selected) {
          const entry = engine.packages[packageId];
          const file = path.join(cacheDir, tarballCacheName(entry));
          const placements = extraction.filter((placement) => placement.id === packageId);
          for (const placement of placements) {
            const destination = packageDirectory(staging, placement);
            await fs.mkdir(destination, { recursive: true });
            await extractNpmTarball(file, destination, { maxBytes: engine.spaceBytes, signal });
            extracted.add(packageId);
          }
        }
        states.set(id, { status: 'verifying' });
        await verifyLayout({ root: staging, engine, key });
        states.set(id, { status: 'preparing' });
        const entry = await verifyEntry({
          root: staging, engine, key, toolsDir: toolsDir ?? path.dirname(process.execPath),
          env: { HOME: staging, TMPDIR: staging, TEMP: staging, SystemRoot: process.env.SystemRoot }, signal
        });
        // `verifyEntry` writes the dsh launcher; map every placement for script execution.
        for (const placement of extraction) directories.set(placement.id, packageDirectory(staging, placement));
        const executed = await runAllowedScripts({
          root: staging, engine, selected: plan.selected, key, directories,
          toolsDir: toolsDir ?? path.dirname(process.execPath),
          env: { HOME: staging, TMPDIR: staging, TEMP: staging, SystemRoot: process.env.SystemRoot },
          signal, states
        });
        const relativeEntry = path.relative(staging, entry.file).split(path.sep).join('/');
        const lockBytes = await fs.readFile(npmLockPath);
        const receipt = {
          id, source: 'npm-registry', version: engine.version, platform, arch,
          protocol: 'npm-registry', kind: entry.kind, entry: relativeEntry,
          entrySha256: await fileHash(entry.file),
          lockSha256: createHash('sha256').update(lockBytes).digest('hex'),
          registry: s.registryUrl,
          packages: extracted.size,
          ...(executed.length ? { scripts: executed } : {}),
          installedAt: new Date().toISOString()
        };
        await fs.writeFile(path.join(staging, '.runtime-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
        await fs.writeFile(path.join(staging, '.runtime-npm-lock.json'), lockBytes, { flag: 'wx' });
        await fs.writeFile(path.join(staging, 'ready.json'), JSON.stringify({
          schemaVersion: 1, entry: path.join(root, relativeEntry), version: engine.version, kind: entry.kind, source: 'npm-registry'
        }), { flag: 'wx' });
        signal.throwIfAborted();
        try { await fs.rename(staging, root); }
        catch (error) {
          // A concurrent process published the same version first; keep that version.
          if (error.code !== 'EEXIST' && error.code !== 'ENOTEMPTY') throw error;
        }
        states.set(id, { status: 'ready' });
      } finally {
        await fs.rm(staging, { recursive: true, force: true });
      }
    } catch (error) {
      states.set(id, { status: 'failed', error: error.message || 'Installation cancelled' });
      throw error;
    } finally { await releaseLock(); }
  }
  async function rejectLiveLeases(root, id) {
    let names; try { names = await fs.readdir(path.join(root, '.leases')); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const name of names) {
      const lease = await json(path.join(root, '.leases', name), true);
      if (!Number.isInteger(lease.pid) || lease.pid <= 0) continue;
      try { process.kill(lease.pid, 0); } catch (e) { if (e.code === 'ESRCH') continue; }
      fail('COMPONENT_IN_USE', `${id} is in use by process ${lease.pid}`);
    }
  }
  async function requestIdleRelease(root, id) {
    try { await rejectLiveLeases(root, id); return; } catch (error) { if (error.code !== 'COMPONENT_IN_USE') throw error; }
    await fs.writeFile(path.join(root, '.release-requested'), JSON.stringify({ pid: process.pid, requestedAt: Date.now() }), { flag: 'w' });
    const deadline = Date.now() + 1500;
    for (;;) {
      try { await rejectLiveLeases(root, id); return; } catch (error) { if (error.code !== 'COMPONENT_IN_USE') throw error; }
      if (Date.now() >= deadline) fail('COMPONENT_BUSY', `${id} has active operations; finish or cancel them before removing it`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  function install(id, { signal } = {}) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    let job = jobs.get(id);
    if (job?.controller.signal.aborted) return job.promise.catch(() => {}).then(() => install(id, { signal }));
    if (!job) { job = { controller: new AbortController(), waiters: 0 }; jobs.set(id, job); job.promise = perform(id, job.controller.signal).finally(() => jobs.delete(id)); }
    job.waiters++;
    return new Promise((resolvePromise, reject) => {
      let finished = false;
      const finish = (fn, value) => { if (finished) return; finished = true; signal?.removeEventListener('abort', abort); job.waiters--; fn(value); };
      const abort = () => { finish(reject, signal.reason); if (!job.waiters) job.controller.abort(signal.reason); };
      signal?.addEventListener('abort', abort, { once: true });
      job.promise.then(() => inspect(id).then(value => finish(resolvePromise, value), e => finish(reject, e)), e => finish(reject, e));
    });
  }
  // A packaged App inherits the launchd PATH only, so PATH alone never finds user installs.
  // These are the conventional locations of Node version managers and package managers on macOS,
  // plus the ChatGPT desktop app, which ships a native Codex. Discovery is read-only.
  function searchDirectories() {
    const seen = new Set(), add = value => { if (typeof value === 'string' && value.trim() && path.isAbsolute(value)) seen.add(path.resolve(value)); };
    for (const directory of (process.env.PATH || '').split(path.delimiter)) add(directory);
    const home = process.env.HOME || process.env.USERPROFILE;
    if (home) for (const relative of [
      ['bin'],
      ['.local', 'bin'],
      ['.bun', 'bin'],
      ['.opencode', 'bin'],
      ['.cargo', 'bin'],
      ['.npm-global', 'bin'],
      ['.volta', 'bin'],
      ['Library', 'pnpm'],
      ['Library', 'Application Support', 'fnm', 'aliases', 'default', 'bin'],
      ['.local', 'share', 'fnm', 'aliases', 'default', 'bin'],
      ['.nvm', 'current', 'bin'],
    ]) add(path.join(home, ...relative));
    if (platform === 'darwin') {
      add('/opt/homebrew/bin'); add('/usr/local/bin');
      add('/Applications/ChatGPT.app');
      if (home) add(path.join(home, 'Applications', 'ChatGPT.app'));
    }
    if (platform === 'win32') for (const name of ['LOCALAPPDATA', 'ProgramFiles', 'APPDATA']) {
      const root = process.env[name];
      if (!root) continue;
      add(path.join(root, 'Programs', 'codex'));
      add(path.join(root, 'Codex'));
    }
    return [...seen];
  }
  const isChatGptApp = candidate => platform === 'darwin' && candidate.toLowerCase().endsWith('.app');
  async function discovered(id, candidate, version, localVersions, blockedVersions) {
    try { return await local(id, candidate, version, localVersions, blockedVersions); }
    catch (error) { if (isChatGptApp(candidate)) return undefined; throw error; }
  }
  // Resolves to a ready state for a selected program, or explains why it cannot run.
  async function diagnose(id, executable) {
    const s = await settings(id);
    try { return await local(id, executable, s.item.version, s.item.localVersions, s.item.blockedVersions); }
    catch (error) { return { error: error.message }; }
  }
  async function discoverLocal(id) {
    const s = await settings(id); const found = [];
    for (const directory of searchDirectories()) {
      // `.app` bundles are directories, so they cannot match a file name and are probed directly.
      const candidates = isChatGptApp(directory) ? [directory] : (platform === 'win32' ? [`${id}.exe`] : [id]).map(name => path.join(directory, name));
      for (const candidate of candidates) {
        try {
          const result = await discovered(id, candidate, s.version, s.item.localVersions, s.item.blockedVersions);
          if (result && !found.some(x => x.entry === result.entry)) found.push(result);
        } catch { /* discovery only returns compatible candidates */ }
      }
    }
    return found;
  }
  return {
    configPath: configFile, inspect, resolve, install, diagnose,
    async list() {
      const s = await settings();
      const ids = [...new Set([...Object.keys(s.lock.components), ...Object.keys(s.npm?.engines ?? {})])];
      return Promise.all(ids.map(inspect));
    },
    /** 部署侧可观察的安装策略（Web host 关闭安装时用于明确报不可用）。 */
    policy() { return { installEnabled, sources: installEnabled && npmLockPath ? ['npm-registry', 'managed', 'local'] : ['managed', 'local'], registry: registryUrl || null }; },
    async configure(id, config) { if (jobs.has(id)) fail('COMPONENT_IN_USE', `${id} is installing; cancel or wait before changing its source`); await settings(id); validateConfig({ components: { [id]: config } }, true); const user = await json(configFile, true); validateConfig(user, true); user.schemaVersion = 1; user.components = { ...user.components, [id]: config }; await fs.mkdir(path.dirname(configFile), { recursive: true }); const temporary = `${configFile}.${randomUUID()}.tmp`; await fs.writeFile(temporary, JSON.stringify(user, null, 2)); await fs.rename(temporary, configFile); states.delete(id); return inspect(id); },
    async remove(id) { const s = await settings(id); if (jobs.has(id) || leases.get(`${id}/${s.version}`)) fail('COMPONENT_IN_USE', `${id} is in use`); const root = directory(id, s.version);
      await fs.mkdir(path.dirname(root), { recursive: true });
      const mutationLock = `${root}.lock`;
      try { await fs.mkdir(mutationLock); } catch (e) { if (e.code === 'EEXIST') fail('COMPONENT_IN_USE', `${id} is being installed or removed by another process`); throw e; }
      try {
      await fs.writeFile(path.join(mutationLock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      await requestIdleRelease(root, id);
      const tombstone = `${root}.removing-${randomUUID()}`;
      try { await fs.rename(root, tombstone); } catch (e) { if (e.code === 'ENOENT') { states.delete(id); return inspect(id); } throw e; }
      try {
        await rejectLiveLeases(tombstone, id);
        await fs.rm(tombstone, { recursive: true, force: true });
      } catch (e) { await fs.rename(tombstone, root); throw e; }
      states.delete(id); return inspect(id);
      } finally { await fs.rm(path.join(root, '.release-requested'), { force: true }); await fs.rm(mutationLock, { recursive: true, force: true }); } },
    discoverLocal,
  };
}
let singleton, singletonKey;
export function getRuntimeComponentManager() {
  const {
    WOOHAA3_RUNTIME_DATA_DIR: dataDir, WOOHAA3_RUNTIME_DEFAULTS_FILE: defaultsPath, WOOHAA3_RUNTIME_LOCK_FILE: lockPath,
    WOOHAA3_RUNTIME_NPM_LOCK_FILE: npmLockPath, WOOHAA3_RUNTIME_TOOLS_DIR: toolsDir, WOOHAA3_RUNTIME_REGISTRY: registryUrl,
    WOOHAA3_RUNTIME_INSTALL: install
  } = process.env;
  if (!dataDir || !defaultsPath || !lockPath) return undefined;
  const installEnabled = install !== 'disabled';
  const key = JSON.stringify([dataDir, defaultsPath, lockPath, npmLockPath ?? null, toolsDir ?? null, registryUrl ?? null, installEnabled]);
  if (key !== singletonKey) {
    singletonKey = key;
    singleton = createRuntimeComponentManager({
      dataDir, defaultsPath, lockPath,
      ...(npmLockPath ? { npmLockPath } : {}),
      ...(toolsDir ? { toolsDir } : {}),
      ...(registryUrl ? { registryUrl } : {}),
      installEnabled
    });
  }
  return singleton;
}
